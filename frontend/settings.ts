import { pluginConfig, subscribePluginConfig } from 'millennium';
import { useEffect, useState } from 'react';
import { warn } from './log';

export interface Settings {
	/** Open Friends & Chat as a flyout inside the Steam window. */
	flyoutEnabled: boolean;
	flyoutCloseOnOutsideClick: boolean;
	/** Width of the friends list column in the flyout (px). */
	flyoutFriendsWidth: number;
	/** Width of the docked chat area in the flyout (px). */
	flyoutChatWidth: number;
	/** Height of the flyout in percent of the Steam window height. */
	flyoutHeightPercent: number;
	/** Start the "Offline" group sorted by last online instead of alphabetically. */
	sortOfflineByRecent: boolean;
	/** Docked chats: only show the chat area while a chat is open. */
	hideEmptyDockedChat: boolean;
	/** Only show the arrow that lists all open chats when more than two are open. */
	chatTabSelectorOnlyForManyChats: boolean;
	/** A dot on the "Friends & Chat" button for new messages; the button then opens the newest chat. */
	unreadIndicator: boolean;
	/** Internal: last width of the docked friends window while a chat was open (px). */
	dockedExpandedWidth: number;
	/** Write logs/better-friends-chat.log in the Millennium folder (read by the backend). */
	debugLogging: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
	flyoutEnabled: true,
	flyoutCloseOnOutsideClick: true,
	flyoutFriendsWidth: 320,
	flyoutChatWidth: 640,
	flyoutHeightPercent: 75,
	sortOfflineByRecent: true,
	hideEmptyDockedChat: true,
	chatTabSelectorOnlyForManyChats: true,
	unreadIndicator: true,
	dockedExpandedWidth: 0,
	debugLogging: false, // keep in sync with DEBUG_LOG_DEFAULT in backend/main.lua
};

const NUMBER_RANGES: { [K in keyof Settings]?: [number, number] } = {
	flyoutFriendsWidth: [240, 600],
	flyoutChatWidth: [360, 1200],
	flyoutHeightPercent: [30, 100],
	dockedExpandedWidth: [0, 10000],
};

type Listener = (settings: Readonly<Settings>, changedKey: keyof Settings | null) => void;

// Millennium's config arrives asynchronously, but Steam may open the friends list
// before that. A local copy makes the last known settings available right away.
const CACHE_KEY = 'better-friends-chat:settings';

function isSettingKey(key: string): key is keyof Settings {
	return Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key);
}

function sanitize<K extends keyof Settings>(key: K, value: unknown): Settings[K] {
	const fallback = DEFAULT_SETTINGS[key];
	if (typeof fallback === 'boolean') {
		return (typeof value === 'boolean' ? value : fallback) as Settings[K];
	}
	const number = typeof value === 'number' && Number.isFinite(value) ? value : (fallback as number);
	const [min, max] = NUMBER_RANGES[key] ?? [-Infinity, Infinity];
	return Math.round(Math.min(max, Math.max(min, number))) as Settings[K];
}

function fromStored(stored: Record<string, unknown>): Settings {
	const settings = { ...DEFAULT_SETTINGS } as Settings;
	for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
		(settings as any)[key] = sanitize(key, stored[key]);
	}
	return settings;
}

function readCache(): Record<string, unknown> | undefined {
	try {
		const raw = window.localStorage.getItem(CACHE_KEY);
		return raw ? JSON.parse(raw) : undefined;
	} catch {
		return undefined;
	}
}

function writeCache() {
	try {
		window.localStorage.setItem(CACHE_KEY, JSON.stringify(current));
	} catch {
		/* storage unavailable */
	}
}

const cached = readCache();
let current: Readonly<Settings> = fromStored(cached ?? {});
let loaded = cached !== undefined;
const listeners = new Set<Listener>();

function emit(changedKey: keyof Settings | null) {
	for (const listener of listeners) {
		try {
			listener(current, changedKey);
		} catch (e) {
			warn('settings listener failed', e);
		}
	}
}

function apply<K extends keyof Settings>(key: K, value: unknown, persist: boolean) {
	const next = sanitize(key, value ?? DEFAULT_SETTINGS[key]);
	if (next === current[key]) return;
	current = { ...current, [key]: next };
	writeCache();
	if (persist) {
		// starlight adds the plugin name as first argument at build time, so this is set(key, value).
		pluginConfig.set(key, next as never).catch((e: unknown) => warn(`could not save setting ${key}`, e));
	}
	emit(key);
}

/** Synchronous snapshot, safe to use from patched Steam code. */
export function getSettings(): Readonly<Settings> {
	return current;
}

/** False until stored settings are known (local copy or Millennium's config). */
export function areSettingsLoaded(): boolean {
	return loaded;
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
	apply(key, value, true);
}

export function onSettingsChanged(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export async function loadSettings() {
	// Changes made by this frontend are not echoed back by Millennium, so this only
	// picks up changes from other sources (backend, dev tooling).
	subscribePluginConfig((key: string, value: unknown) => {
		if (isSettingKey(key)) apply(key, value, false);
	});

	try {
		const stored: Record<string, unknown> = (await pluginConfig.getAll()) ?? {};
		current = fromStored(stored);
		writeCache();
		// Drop keys this plugin does not use (anymore).
		for (const key of Object.keys(stored)) {
			if (!isSettingKey(key)) pluginConfig.delete(key).catch(() => undefined);
		}
	} catch (e) {
		warn('could not load settings, using the last known ones', e);
	}
	loaded = true;
	emit(null);
}

export function useSettings(): Readonly<Settings> {
	const [settings, setSettings] = useState(current);
	useEffect(() => {
		setSettings(current);
		return onSettingsChanged((next) => setSettings(next));
	}, []);
	return settings;
}
