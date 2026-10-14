import { findClassModule, findModuleExport } from 'millennium';
import { warn } from './log';

// Access to Steam client internals. Everything here is undocumented, so callers
// must treat every lookup as optional.

declare global {
	interface Window {
		g_FriendsUIApp?: any;
		g_PopupManager?: any;
		__FriendsUIBrowserContext?: BrowserContext;
	}
}

export interface BrowserContext {
	m_unPID: number;
	m_nBrowserID: number;
	m_eUIMode?: number;
	[key: string]: unknown;
}

/** Steam's own desktop context, see steamui/sp.js: {m_unPID: 0, m_nBrowserID: -1}. */
export const DESKTOP_CONTEXT: BrowserContext = { m_unPID: 0, m_nBrowserID: -1 };

export const friendsApp = (): any => window.g_FriendsUIApp;
export const desktopApp = (): any => window.g_FriendsUIApp?.m_DesktopApp;
export const uiStore = (): any => window.g_FriendsUIApp?.UIStore;

export function isSameContext(a?: BrowserContext, b?: BrowserContext): boolean {
	return !!a && !!b && a.m_unPID == b.m_unPID && a.m_nBrowserID == b.m_nBrowserID;
}

/** True for the desktop client's context, false for in-game overlays and Big Picture. */
export function isDesktopContext(context?: BrowserContext): boolean {
	if (friendsApp()?.IsGamepadUIActive?.()) return false;
	return isSameContext(context, DESKTOP_CONTEXT);
}

/** The context object Steam itself uses for the desktop friends list. */
export function desktopContext(): BrowserContext {
	const current = friendsApp()?.GetDefaultBrowserContext?.();
	if (isSameContext(current, DESKTOP_CONTEXT)) return current;
	return { ...DESKTOP_CONTEXT, m_eUIMode: desktopApp()?.m_eUIMode };
}

export function isFriendsListBlocked(): boolean {
	const app = friendsApp();
	return !!(app?.ParentalStore?.BIsFriendsBlocked?.() || app?.SettingsStore?.IsSteamInTournamentMode?.());
}

/** The popup object of the Steam main window ("SP Desktop_..."), if it exists. */
export function getMainWindowPopup(): any {
	const manager = window.g_PopupManager;
	if (!manager?.GetPopups) return undefined;
	for (const popup of manager.GetPopups()) {
		const name: string = popup?.GetName?.() ?? popup?.m_strName ?? '';
		if (/^SP Desktop(_|$)/.test(name) && popup.window && !popup.window.closed) return popup;
	}
	return undefined;
}

/** Shows, restores and focuses a Steam window. */
export function bringWindowToFront(win: Window) {
	const steamWindow = (win as any).SteamClient?.Window;
	try {
		if (win.document.visibilityState !== 'visible') steamWindow?.ShowWindow?.();
		if (steamWindow?.BringToFront) steamWindow.BringToFront(1 /* k_EWindowBringToFrontAndForceOS */);
		else win.focus();
	} catch (e) {
		warn('could not bring the Steam window to front', e);
	}
}

/** Gives the keyboard to a Steam window's own UI, or takes it away for a view inside it. */
export function setWindowKeyFocus(win: Window, focused: boolean) {
	(win as any).SteamClient?.Window?.SetKeyFocus?.(focused);
}

/**
 * A native view inside a Steam window: store and community pages, Steam's notification
 * toasts on top of them, or a page of our own (see createBrowserView).
 */
export interface BrowserView {
	GetBounds?(): { x: number; y: number; width: number; height: number } | undefined;
	SetBounds(x: number, y: number, width: number, height: number): void;
	SetVisible(visible: boolean): void;
	SetFocus(focused: boolean): void;
	SetWindowStackingOrder(order: number): void;
	on?(event: string, callback: (...args: any[]) => void): void;
	off?(event: string, callback: (...args: any[]) => void): void;
}

/** k_EWindowStackingOrder_Top: in front of the window's own UI. */
export const STACKING_ORDER_TOP = 1;

/** The view with the store and community pages of the Steam window. */
export function storePageView(): BrowserView | undefined {
	return (window as any).MainWindowBrowserManager?.m_browser;
}

/** Steam only shows the store/community view on its /browser/ route. */
export function isStorePageShown(): boolean {
	const pathname: unknown = (window as any).MainWindowBrowserManager?.m_history?.location?.pathname;
	return typeof pathname === 'string' && pathname.startsWith('/browser');
}

/**
 * Creates a view inside the Steam window `parent` with an empty page of our own, the
 * way Steam shows its notification toasts on top of store pages. The page belongs to
 * this JS context, so React can render into it. Bounds are in CSS pixels of `parent`.
 */
export function createBrowserView(parent: Window, name: string): { view: BrowserView; window: Window } | undefined {
	const api = (window as any).SteamClient?.BrowserView;
	const parentID: number | undefined = (parent as any).SteamClient?.Browser?.GetBrowserID?.();
	if (!api?.CreatePopup || !parentID) return undefined;
	// Unique per creation: window.open() would reuse a window that still has the name.
	const strName = `${name}_uid${parentID}_${Date.now().toString(36)}`;
	const { strCreateURL, browserView } = api.CreatePopup({ parentPopupBrowserID: parentID, strName });
	const win = window.open(strCreateURL, strName, 'top=0,left=0,width=540,height=700,resizable=yes,status=0,toolbar=0,menubar=0,location=0');
	if (!win) {
		api.Destroy?.(browserView);
		return undefined;
	}
	return { view: browserView, window: win };
}

export function destroyBrowserView(view: BrowserView) {
	(window as any).SteamClient?.BrowserView?.Destroy?.(view);
}

export interface FriendsListComponents {
	/** Provides the window the friends UI renders into (menus, dialogs, focus). */
	OwnerWindow: (props: { ownerWindow: Window; children?: unknown }) => unknown;
	/** The friends list (and docked chats) for an element, as used by the web chat. */
	EmbeddedFriendsList: (props: { friends: unknown; chats: unknown; browserContext: BrowserContext; elTarget: HTMLElement }) => unknown;
}

let friendsListComponents: FriendsListComponents | null | undefined;

/** Source of the webpack module that contains `marker` (patched code included). */
function findModuleSource(marker: string): string | undefined {
	const chunks: unknown[] = (window as any).webpackChunksteamui ?? [];
	for (const chunk of chunks) {
		const factories = Array.isArray(chunk) ? chunk[1] : undefined;
		if (!factories || typeof factories !== 'object') continue;
		for (const factory of Object.values(factories as Record<string, unknown>)) {
			if (typeof factory !== 'function') continue;
			const source = Function.prototype.toString.call(factory);
			if (source.includes(marker)) return source;
		}
	}
	return undefined;
}

/**
 * Internal friends UI components, exposed by patch #4 in backend/patches.lua. Only
 * returned when patches #5 and #6 reached the same module too: without them the
 * friends list would treat the flyout like a separate friends window and use the
 * in-game overlay's context while a game runs.
 */
export function getFriendsListComponents(): FriendsListComponents | null {
	if (friendsListComponents !== undefined) return friendsListComponents;
	friendsListComponents = null;
	try {
		const source = findModuleSource('"bfc-components"');
		const missing = ['CreateEmbeddedContainer', 'FriendsListContext'].filter((hook) => !source?.includes(hook));
		if (!source || missing.length) {
			warn(`friends UI patches incomplete (missing: ${source ? missing.join(', ') : 'all'}), the flyout is unavailable`);
			return null;
		}
		const accessor = findModuleExport(
			(exported: unknown) => typeof exported === 'function' && Function.prototype.toString.call(exported).includes('"bfc-components"'),
		);
		const components = accessor?.('bfc-components');
		// Components are functions, or objects when wrapped in memo()/observer().
		if (components?.OwnerWindow && components?.EmbeddedFriendsList) friendsListComponents = components;
	} catch (e) {
		warn('looking up the friends list components failed', e);
	}
	if (!friendsListComponents) warn('friends list components not found (patch missing?), the flyout is unavailable');
	return friendsListComponents ?? null;
}

export interface TitleBarProps {
	className?: string;
	hideMin?: boolean;
	hideMax?: boolean;
	onClose?: () => void;
}

let titleBar: ((props: TitleBarProps) => unknown) | null | undefined;

/**
 * Steam's title bar with the window buttons (steamui/sp.js), as in the friends window.
 * Without a popup it only works with handlers such as onClose.
 */
export function getTitleBarComponent(): ((props: TitleBarProps) => unknown) | null {
	if (titleBar !== undefined) return titleBar;
	let found = null;
	try {
		found =
			findModuleExport(
				(exported: unknown) =>
					typeof exported === 'function' && Function.prototype.toString.call(exported).includes('"title-bar-actions window-controls"'),
			) ?? null;
	} catch (e) {
		warn('looking up the title bar failed', e);
	}
	if (!found) warn('Steam title bar not found, the flyout uses its own close button');
	return (titleBar = found);
}

/** Looks up class names in the CSS module `filter` picks, once. */
function classModule(filter: (module: any) => boolean) {
	let classes: Record<string, string> | null | undefined;
	return (name: string): string | undefined => {
		if (classes === undefined) {
			try {
				classes = (findClassModule(filter) as Record<string, string>) ?? null;
			} catch {
				classes = null;
			}
		}
		return classes?.[name]?.split(' ')[0];
	};
}

/** Body class of Steam's desktop windows (main window, settings, ...), not of its friends windows. */
export const DESKTOP_UI_CLASS = 'DesktopUI';

const contextMenuClass = classModule((m) => m.ContextMenuPosition && m.contextMenuContents && m.ContextMenuMouseOverlay);

/** CSS class of the element that Steam positions a menu with, inside the page that shows the menu. */
export function getContextMenuPositionClass(): string | undefined {
	return contextMenuClass('ContextMenuPosition');
}

const bottomBarClass = classModule((m) => m.FriendsButton && m.BottomBar && m.AddGameButton);

/** CSS class of the "Friends & Chat" button in the bottom bar of the Steam window. */
export function getFriendsButtonClass(): string | undefined {
	return bottomBarClass('FriendsButton');
}

export function findFriendsButton(doc: Document): HTMLElement | null {
	const className = getFriendsButtonClass();
	return className ? doc.querySelector<HTMLElement>(`.${CSS.escape(className)}`) : null;
}

/** The area at the bottom of the Steam window that holds the "Friends & Chat" button. */
export function findBottomBar(doc: Document): HTMLElement | null {
	const className = bottomBarClass('BottomBarContainer');
	return (className && findFriendsButton(doc)?.closest<HTMLElement>(`.${CSS.escape(className)}`)) || null;
}

/** The button is disabled while family view locks the friends list. */
export function isFriendsButtonDisabled(button: Element): boolean {
	const className = bottomBarClass('Disabled');
	return !!className && button.classList.contains(className);
}

/** Width of the friends list column in Steam's docked layout. */
export function getDockedFriendsListWidth(): number {
	const width = desktopApp()?.UIDisplayPrefs?.nFriendsListSingleWindowWidthPx;
	return typeof width === 'number' && width > 0 ? width : 300;
}

/** Docked chats: true while the friends list is collapsed into a tab of the chats. */
export function isFriendsListCollapsed(context: BrowserContext): boolean {
	return !!uiStore()?.BIsFriendsListCollapsed?.(context);
}

export function expandFriendsList(context: BrowserContext) {
	uiStore()?.SetFriendsListCollapsed?.(context, false);
}

/** Visibility of a chat from which on it is on screen (maybe without the keyboard). */
const CHAT_VISIBLE = 2;

/**
 * Chats with new messages that are not on screen in `context`: friend chats with unread
 * messages and other chats Steam showed a notification for, such as mentions in group
 * chats. Steam's chat objects have `time_last_message` (seconds). undefined until the
 * chat store exists.
 */
export function getUnreadChats(context: BrowserContext): any[] | undefined {
	const chatStore = friendsApp()?.ChatStore;
	if (!chatStore?.FriendChatStore) return undefined;
	const chats = new Set<any>(chatStore.FriendChatStore.GetFriendsWithUnreadMessages?.(context) ?? []);
	for (const chat of chatStore.GetChatsWithUnreadPriorityMessages?.() ?? []) {
		if (!chat.is_blocked_friend && chat.GetVisibilityState?.(context) < CHAT_VISIBLE) chats.add(chat);
	}
	return Array.from(chats);
}

/** A chat of a group chat (a "room"), not one with a friend. */
export function isGroupChat(chat: any): boolean {
	return typeof chat?.GetRoomID === 'function';
}

/** Opens a chat with the keyboard in it, like a click on its notification. */
export function showChat(context: BrowserContext, chat: any) {
	uiStore()?.ShowAndOrActivateChat?.(context, chat, true);
}

/** Opens the friends list the way the "Friends & Chat" button does. */
export function showFriendsList(context: BrowserContext) {
	friendsApp()?.ShowPopupFriendsList?.(context, false, true);
}

export function isDockedChatsEnabled(): boolean {
	return !!friendsApp()?.SettingsStore?.BSingleWindowModeEnabled?.();
}

export function setDockedChatsEnabled(enabled: boolean) {
	desktopApp()?.ToggleSingleWindowMode?.(enabled);
}
