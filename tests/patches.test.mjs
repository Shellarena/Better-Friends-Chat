// Checks backend/patches.lua against the Steam client installed on this machine.
//
// It emulates Millennium's patch engine (src/instrumentation/loopback/src/engine.rs):
// the first match of `find` is the patch region, every transform runs replace_all
// inside that region, replacements use Rust's `$name` rules after Millennium's
// "\1" -> "$1" conversion, and the patched file must still parse.
//
// Usage: npm test            (Steam path from the registry or STEAM_PATH)

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function steamPath() {
	if (process.env.STEAM_PATH) return process.env.STEAM_PATH;
	if (process.platform === 'win32') {
		try {
			const out = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'utf8' });
			const match = out.match(/SteamPath\s+REG_SZ\s+(.+)/);
			if (match) return match[1].trim();
		} catch {
			/* fall through */
		}
	}
	return process.platform === 'win32' ? 'C:\\Program Files (x86)\\Steam' : join(process.env.HOME ?? '', '.steam/steam');
}

function longString(source, key) {
	const match = source.match(new RegExp(`${key}\\s*=\\s*\\[(=*)\\[([\\s\\S]*?)\\]\\1\\]`));
	return match?.[2];
}

function parsePatches(source) {
	const pluginId = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name;
	const id = source.match(/local ID = "([^"]+)"/)[1];
	const hooks = source.match(/local HOOKS = "([^"]+)"/)[1];
	// Definitions without `file = <NAME>_FILE` patch UI_FILE.
	const fileNames = Object.fromEntries([...source.matchAll(/local ([A-Z]+_FILE) =/g)].map(([, name]) => [name, longString(source, `local ${name}`)]));
	const patches = [];
	const re = /(find|match|replace)\s*=\s*\[(=*)\[([\s\S]*?)\]\2\]|\bfile = ([A-Z]+_FILE),/g;
	let file;
	for (let m; (m = re.exec(source)); ) {
		const [, key, , value, fileName] = m;
		if (fileName) file = fileNames[fileName];
		else if (key === 'find') {
			patches.push({ label: `patch #${patches.length + 1}`, file: file ?? fileNames.UI_FILE, find: value.replaceAll('@ID@', id), transforms: [] });
			file = undefined;
		} else if (key === 'match') patches.at(-1).transforms.push({ match: value.replaceAll('@ID@', id) });
		else patches.at(-1).transforms.at(-1).replace = value.replaceAll('@HOOKS@', hooks);
	}
	return { pluginId, hooks, patches };
}

// Steam waits for the patched 16 MB bundle. In Rust's regex crate \w, \d, \s and \b
// are Unicode-aware and slow, and spans like .* or .{0,n} can make the search crawl,
// which once made Steam's UI time out while loading.
const SLOW_PATTERN_PARTS = [/\\[wWdDsSbB]/, /\.[*+]/, /\.\{/, /\(\?[a-z-]*s/];

function lintPattern(pattern) {
	return SLOW_PATTERN_PARTS.filter((re) => re.test(pattern)).map((re) => `pattern uses ${re} (slow in Rust's regex crate): ${pattern.slice(0, 80)}`);
}

// Before Steam starts its browser process, Millennium writes the patch lists of all
// plugins as one msgpack frame into a pipe with Windows' default 4 KB buffer, and
// nothing reads it yet (src/instrumentation/internal/steam_hooks.cc,
// register_loopback_conn). A larger frame blocks Steam's start for good. The budget
// leaves room for the patches of other plugins.
const PIPE_BUFFER = 4096;
const PATCH_LIST_BUDGET = 3500;

// Size of nlohmann::json::to_msgpack for strings, arrays and objects.
function msgpackSize(value) {
	if (typeof value === 'string') {
		const n = Buffer.byteLength(value);
		return n + (n < 32 ? 1 : n < 256 ? 2 : n < 65536 ? 3 : 5);
	}
	const entries = Array.isArray(value) ? value : Object.entries(value).flat();
	const count = Array.isArray(value) ? value.length : entries.length / 2;
	return (count < 16 ? 1 : count < 65536 ? 3 : 5) + entries.reduce((sum, v) => sum + msgpackSize(v), 0);
}

// The frame Millennium sends: patch_registry_to_json() in a "patch_list" message.
function patchListSize(spec) {
	const patches = spec.patches.map(({ file, find, transforms }) => ({ plugin: spec.pluginId, file, find, transforms }));
	return 4 /* frame length */ + msgpackSize({ type: 'patch_list', patches });
}

// Rust regex -> JS RegExp for the subset used in patches.lua.
function toJsRegExp(pattern, global = false) {
	let flags = global ? 'g' : '';
	if (pattern.startsWith('(?s)')) {
		pattern = pattern.slice(4);
		flags += 's';
	}
	if (pattern.includes('(?')) throw new Error(`unsupported inline flag in ${pattern}`);
	return new RegExp(pattern, flags);
}

// engine.rs: re2_to_rust_rep
function re2ToRustRep(s) {
	let out = '';
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === '$') {
			out += '$$';
			continue;
		}
		if (c === '\\' && /\d/.test(s[i + 1] ?? '')) {
			out += '$' + s[++i];
			continue;
		}
		out += c;
	}
	return out;
}

// regex crate: Captures::expand
function rustExpand(replacement, groups, problems) {
	let out = '';
	for (let i = 0; i < replacement.length; i++) {
		const c = replacement[i];
		if (c !== '$') {
			out += c;
			continue;
		}
		if (replacement[i + 1] === '$') {
			out += '$';
			i++;
			continue;
		}
		let name = '';
		let j = i + 1;
		if (replacement[j] === '{') {
			const end = replacement.indexOf('}', j);
			name = replacement.slice(j + 1, end);
			i = end;
		} else {
			while (j < replacement.length && /[_0-9a-zA-Z]/.test(replacement[j])) name += replacement[j++];
			i = j - 1;
		}
		if (!name) {
			out += '$';
		} else if (/^\d+$/.test(name)) {
			if (groups[Number(name)] === undefined) problems.push(`replacement references missing group $${name}`);
			out += groups[Number(name)] ?? '';
		} else {
			problems.push(`replacement references named group "${name}" (backreference followed by an identifier character?)`);
		}
	}
	return out;
}

function countMatches(re, text) {
	return [...text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))].length;
}

function checkFile(path, patches) {
	let buf = readFileSync(path, 'utf8');
	const results = [];

	patches.forEach((patch) => {
		const { label } = patch;
		const problems = [...lintPattern(patch.find), ...patch.transforms.flatMap((t) => lintPattern(t.match))];
		const find = toJsRegExp(patch.find);
		const started = performance.now();
		const hits = countMatches(find, buf);
		const searchMs = performance.now() - started;
		if (searchMs > 250) problems.push(`find pattern took ${searchMs.toFixed(0)} ms in JS`);
		const m = find.exec(buf);
		if (!m) {
			results.push({ label, matched: false, problems: ['find pattern had no match'] });
			return;
		}
		if (hits > 1) problems.push(`find pattern matches ${hits} times (only the first is patched)`);

		const from = m.index;
		let region = m[0];
		const before = region;
		for (const t of patch.transforms) {
			const re = toJsRegExp(t.match, true);
			const n = countMatches(re, region);
			if (n !== 1) problems.push(`transform /${t.match.slice(0, 60)}.../ matched ${n} times in the region (expected 1)`);
			const rep = re2ToRustRep(t.replace);
			region = region.replace(re, (...args) => {
				const groupCount = args.length - 3 - (typeof args.at(-1) === 'object' ? 1 : 0);
				return rustExpand(rep, args.slice(0, groupCount + 1), problems);
			});
		}
		buf = buf.slice(0, from) + region + buf.slice(from + before.length);
		results.push({ label, matched: true, from, size: before.length, delta: region.length - before.length, after: region, problems, searchMs });
	});

	let syntaxError = null;
	try {
		new vm.Script(buf, { filename: path });
	} catch (e) {
		syntaxError = e;
	}
	return { results, syntaxError, patched: buf };
}

const spec = parsePatches(readFileSync(join(root, 'backend', 'patches.lua'), 'utf8'));
const steamui = join(steamPath(), 'steamui');
if (!existsSync(steamui)) {
	console.error(`steamui folder not found: ${steamui} (set STEAM_PATH)`);
	process.exit(2);
}

console.log(`plugin ${spec.pluginId}: ${spec.patches.length} patches`);
const listSize = patchListSize(spec);
const listOk = listSize <= PATCH_LIST_BUDGET;
console.log(
	`patch list sent at Steam's start: ${listSize} B (budget ${PATCH_LIST_BUDGET} B, Steam hangs above ${PIPE_BUFFER} B for all plugins together)${listOk ? '' : ' PROBLEM'}`,
);
const filePatterns = [...new Set(spec.patches.map((p) => p.file))];
const steamFiles = readdirSync(steamui);
const checks = filePatterns.flatMap((pattern) => {
	const fileRe = toJsRegExp(pattern);
	const files = steamFiles.filter((f) => fileRe.test(f));
	const patches = spec.patches.filter((p) => p.file === pattern);
	console.log(`files matching /${pattern}/ (${patches.map((p) => p.label.slice(6)).join(', ')}): ${files.join(', ')}`);
	return files.map((f) => ({ f, patches }));
});

let failed = !listOk;
const matchedPatches = new Set();
for (const { f, patches } of checks) {
	const { results, syntaxError, patched } = checkFile(join(steamui, f), patches);
	const anyMatch = results.some((r) => r.matched);
	console.log(`\n${f}: ${anyMatch ? 'patched' : 'no patch matched (Millennium logs this as skipped, harmless)'}`);
	if (!anyMatch) continue;
	for (const r of results) {
		if (!r.matched) {
			console.log(`  ${r.label}: no match in this file`);
			continue;
		}
		matchedPatches.add(r.label);
		const status = r.problems.length ? 'PROBLEM' : 'ok';
		console.log(`  ${r.label}: ${status} @${r.from} (${r.size} B, ${r.delta >= 0 ? '+' : ''}${r.delta} B, search ${r.searchMs.toFixed(1)} ms)`);
		for (const p of r.problems) console.log(`    - ${p}`);
		if (process.env.VERBOSE) console.log(`    after: ${r.after.length > 600 ? r.after.slice(0, 300) + ' ... ' + r.after.slice(-300) : r.after}`);
		if (r.problems.length) failed = true;
	}
	if (syntaxError) {
		failed = true;
		console.log(`  SYNTAX ERROR after patching: ${syntaxError.message}`);
	} else {
		console.log('  syntax ok');
	}
	const injected = patched.split(spec.hooks).length - 1;
	console.log(`  hook call sites injected: ${injected}`);
}

for (const { label } of spec.patches) {
	if (!matchedPatches.has(label)) {
		failed = true;
		console.log(`\n${label} did not match any file`);
	}
}

console.log(failed ? '\nFAILED' : '\nall patches ok');
process.exit(failed ? 1 : 0);
