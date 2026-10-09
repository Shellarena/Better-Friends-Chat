const PREFIX = '[Better Friends Chat]';

type Level = 'info' | 'warn' | 'error';

let debugLogging = false;

/** Info messages only reach the plugin log with the "debugLogging" setting. */
export function setDebugLogging(enabled: boolean) {
	debugLogging = enabled;
}

function format(args: unknown[]): string {
	return args
		.map((arg) => {
			if (typeof arg === 'string') return arg;
			if (arg instanceof Error) return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack}` : ''}`;
			try {
				return JSON.stringify(arg);
			} catch {
				return String(arg);
			}
		})
		.join(' ');
}

// Frontend console output does not reliably reach Millennium's log viewer, so messages
// also go through the backend logger.
function forward(level: Level, args: unknown[]) {
	if (level === 'info' && !debugLogging) return;
	try {
		backend.frontend_log(level, format(args)).catch(() => undefined);
	} catch {
		/* backend not available */
	}
}

export const log = (...args: unknown[]) => {
	console.log(PREFIX, ...args);
	forward('info', args);
};

export const warn = (...args: unknown[]) => {
	console.warn(PREFIX, ...args);
	forward('warn', args);
};

export const error = (...args: unknown[]) => {
	console.error(PREFIX, ...args);
	forward('error', args);
};
