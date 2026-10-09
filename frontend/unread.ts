import { log, warn } from './log';
import { getSettings, onSettingsChanged } from './settings';
import * as steam from './steam';

// Chats with new messages, for the dot on the "Friends & Chat" button and for opening the
// chat with the newest message from it. Steam reports every change of its unread counters
// (patch #9). Chats that are on screen do not count.

type Listener = (hasUnread: boolean) => void;

interface Arrival {
	/** Number of the update that noticed the message: tells apart messages of the same second. */
	round: number;
	/** time_last_message of the chat then (seconds) */
	time: number;
}

const listeners = new Set<Listener>();
let arrivals = new Map<any, Arrival>();
let rounds = 0;
let hasUnread = false;
let scheduled = false;

/** Patch #9: Steam updated its unread counters. */
export function onUnreadMessagesChanged() {
	scheduleUnreadUpdate();
}

/** Also for changes Steam does not report, such as a chat that is no longer on screen. */
export function scheduleUnreadUpdate() {
	if (scheduled) return;
	scheduled = true;
	// Steam reports from the middle of its own work, and often several times in a row.
	window.setTimeout(() => {
		scheduled = false;
		update();
	}, 0);
}

/** The unread chat that received the newest message, if there is one. */
export function newestUnreadChat(): any {
	return update();
}

export function hasUnreadChats(): boolean {
	return hasUnread;
}

export function onUnreadChanged(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function update(): any {
	const chats = (getSettings().unreadIndicator && steam.getUnreadChats(steam.desktopContext())) || [];
	const round = ++rounds;
	const next = new Map<any, Arrival>();
	let newest: any;
	let newestArrival: Arrival | undefined;
	for (const chat of chats) {
		const time = Number(chat.time_last_message) || 0;
		let arrival = arrivals.get(chat);
		// Every message of a friend counts. A group chat only counts for the message Steam
		// notified about, its other messages do not make it the newest chat.
		if (!arrival || (time !== arrival.time && !steam.isGroupChat(chat))) arrival = { round, time };
		next.set(chat, arrival);
		if (!newestArrival || arrival.round > newestArrival.round || (arrival.round === newestArrival.round && arrival.time > newestArrival.time)) {
			newest = chat;
			newestArrival = arrival;
		}
	}
	// Chats that were read are forgotten, so their next message is new again.
	arrivals = next;

	if (hasUnread !== chats.length > 0) {
		hasUnread = chats.length > 0;
		log(hasUnread ? 'new chat messages' : 'all chat messages read');
		for (const listener of listeners) {
			try {
				listener(hasUnread);
			} catch (e) {
				warn('unread listener failed', e);
			}
		}
	}
	return newest;
}

export function initUnread() {
	onSettingsChanged((_settings, key) => {
		if (key === 'unreadIndicator' || key === null) scheduleUnreadUpdate();
	});
	// Messages that arrived before the plugin was loaded.
	scheduleUnreadUpdate();
}
