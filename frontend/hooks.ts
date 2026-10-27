import { showChatTabSelector } from './chatTabs';
import { onFriendsListRender } from './dockedChat';
import { FlyoutContainer, flyout } from './flyout';
import { error, log } from './log';
import { onFriendGroupCreated } from './sorting';
import type { BrowserContext } from './steam';
import { onUnreadMessagesChanged } from './unread';

// Entry points for the code injected by backend/patches.lua. They run inside Steam's
// friends UI, so they must never throw: any failure falls back to Steam's behaviour.

declare global {
	interface Window {
		/** @HOOKS@ in backend/patches.lua */
		__bfcHooks?: typeof bfcHooks;
	}
}
function safe<Args extends unknown[], Result>(name: string, fallback: Result, fn: (...args: Args) => Result) {
	return (...args: Args): Result => {
		try {
			return fn(...args);
		} catch (e) {
			error(`hook ${name} failed`, e);
			return fallback;
		}
	};
}

const isFlyoutFriendsList = (friendsList: any) => friendsList?.props?.container instanceof FlyoutContainer;

export const bfcHooks = {
	/** Patch #1: initial sort order of a friends group ("Offline" uses it). */
	SortOfflineByRecent: safe('SortOfflineByRecent', false, (group: any) => onFriendGroupCreated(group)),

	/** Patch #2: true hides the docked chat area (empty, or waiting for the flyout to make room). */
	OnFriendsListRender: safe('OnFriendsListRender', false, (friendsList: any) => onFriendsListRender(friendsList)),

	/** Patch #3: true means the flyout handled the request and Steam opens no window. */
	ShowFriendsList: safe(
		'ShowFriendsList',
		false,
		(_desktopApp: unknown, context: BrowserContext | undefined, startMinimized: boolean, takeFocus: boolean) => {
			// Steam reopens the friends list and docked chats it had at the last exit. Method
			// names survive minification, so the call stack tells such restores apart from
			// user requests. Restores go deeper than V8's default 10 stack frames.
			const V8Error = Error as ErrorConstructor & { stackTraceLimit: number };
			const limit = V8Error.stackTraceLimit;
			V8Error.stackTraceLimit = 50;
			const stack = new Error().stack ?? '';
			V8Error.stackTraceLimit = limit;
			const restoring = /ShowPopupFriendsListAtStartup|RestorePopupState|RestoreFromStateObject/.test(stack);
			if (restoring) log('friends list restored by Steam, keeping the flyout closed');
			return flyout.handleShowRequest(context, !!startMinimized, !!takeFocus && !restoring);
		},
	),

	/** Patch #5: container for the friends list rendered into the flyout. */
	CreateEmbeddedContainer: safe('CreateEmbeddedContainer', undefined, (element: HTMLElement) => flyout.containerFor(element)),

	/** Patch #6: browser context of the friends list inside the flyout (always the desktop). */
	FriendsListContext: safe('FriendsListContext', undefined, (friendsList: any) =>
		isFlyoutFriendsList(friendsList) ? flyout.friendsContext() : undefined,
	),

	/** Patch #7: whether the arrow listing all open chats is shown (undefined: Steam decides). */
	ShowChatTabSelector: safe('ShowChatTabSelector', undefined, (tabBar: any) => showChatTabSelector(tabBar)),

	/** Patch #8: true keeps a menu inside the page it belongs to instead of a popup window. */
	InlineMenus: safe('InlineMenus', false, (ownerWindow: Window | undefined) => flyout.showsMenusInline(ownerWindow)),

	/** Patch #9: Steam updated its unread message counters. */
	UnreadMessagesChanged: safe('UnreadMessagesChanged', undefined, () => onUnreadMessagesChanged()),

	/** Patch #10: Steam showed a view (store page) in front of the other views of its window. */
	ViewShown: safe('ViewShown', undefined, () => flyout.onViewShown()),
};
