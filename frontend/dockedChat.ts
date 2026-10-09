import { FlyoutContainer, flyout } from './flyout';
import { warn } from './log';
import { getSettings, onSettingsChanged, setSetting } from './settings';
import * as steam from './steam';

// Steam's own limits for the friends window (see the friends list popup in Steam's code).
const MIN_HEIGHT = 400;
const MIN_WIDTH_FRIENDS_ONLY = 226;
const MIN_WIDTH_DOCKED = 678;
const DEFAULT_DOCKED_WIDTH = 1280; // what Steam uses when docking is switched on

interface WindowState {
	/** undefined until the first docked render of this window */
	collapsed?: boolean;
	/** x position before the window was moved to keep the chat on screen */
	shiftedFromX?: number;
}

const windowStates = new WeakMap<Window, WindowState>();
const friendsLists = new Set<WeakRef<any>>();

/**
 * Patch #2: runs at the start of every render of the friends list window (popup or
 * flyout). Returns true when the chat area should be left out.
 */
export function onFriendsListRender(friendsList: any): boolean {
	remember(friendsList);
	const props = friendsList?.props ?? {};
	const docked = !!steam.uiStore()?.BIsFriendsListSingleWindow?.(friendsList.m_browserContext);
	const hasChats = (props.tabset?.tabCount ?? 0) > 0;
	const hideChat = docked && !hasChats && getSettings().hideEmptyDockedChat;
	let chatWaits = false;

	if (props.container instanceof FlyoutContainer) {
		// The open flyout makes room before the chat appears in it.
		chatWaits = flyout.updateChat(docked && !hideChat, () => friendsList.forceUpdate());
		// The flyout has no button to collapse the friends list (see styles.ts), so a
		// collapsed list from Steam's own window opens again. Called while Steam renders;
		// change the state afterwards.
		const context = friendsList.m_browserContext;
		if (docked && steam.isFriendsListCollapsed(context)) queueMicrotask(() => steam.expandFriendsList(context));
	} else if (props.popup?.window) {
		updateWindowSize(props.popup.window, docked, hideChat);
	}
	return hideChat || chatWaits;
}

function remember(friendsList: any) {
	if (!friendsList) return;
	for (const ref of friendsLists) {
		const known = ref.deref();
		if (known === friendsList) return;
		// Forget friends lists that are gone (closed windows, earlier flyouts).
		if (!known) friendsLists.delete(ref);
	}
	friendsLists.add(new WeakRef(friendsList));
}

/** Re-render open friends lists so a changed setting applies immediately. */
function refreshFriendsLists() {
	for (const ref of friendsLists) {
		const friendsList = ref.deref();
		if (!friendsList || !friendsList.m_refRoot?.current?.isConnected) {
			friendsLists.delete(ref);
			continue;
		}
		try {
			friendsList.forceUpdate();
		} catch (e) {
			warn('could not refresh the friends list', e);
		}
	}
}

function updateWindowSize(win: Window, docked: boolean, collapse: boolean) {
	let state = windowStates.get(win);
	if (!state) windowStates.set(win, (state = {}));
	if (!docked) {
		// Steam resizes the window itself when docking is switched off.
		state.collapsed = undefined;
		state.shiftedFromX = undefined;
		return;
	}
	if (state.collapsed === collapse) return;
	const previous = state.collapsed;
	state.collapsed = collapse;
	// A window that opens with a chat keeps the size Steam restored for it, unless that
	// is the narrow friends-only size saved after the last chat was closed.
	if (previous === undefined && !collapse && win.outerWidth >= MIN_WIDTH_DOCKED) return;
	// Resize once React has committed the new layout.
	win.setTimeout(() => {
		resizeWindow(win, state!, collapse, previous).catch((e) => warn('resizing the friends window failed', e));
	}, 0);
}

async function resizeWindow(win: Window, state: WindowState, collapse: boolean, previous: boolean | undefined) {
	const steamWindow = (win as any).SteamClient?.Window;
	if (win.closed || !steamWindow?.ResizeTo) return;

	// Work in the units of Steam's window API, whatever the display scaling is.
	const dimensions = steamWindow.GetWindowDimensions ? await steamWindow.GetWindowDimensions().catch((): undefined => undefined) : undefined;
	const unit = dimensions?.width > 0 && win.outerWidth > 0 ? dimensions.width / win.outerWidth : 1;
	const height = dimensions?.height > 0 ? dimensions.height : Math.round(win.outerHeight * unit);
	const x = typeof dimensions?.x === 'number' ? dimensions.x : Math.round(win.screenX * unit);
	const y = typeof dimensions?.y === 'number' ? dimensions.y : Math.round(win.screenY * unit);
	const screen = win.screen as Screen & { availLeft?: number };
	const screenLeft = Math.round((screen.availLeft ?? 0) * unit);
	const screenRight = Math.round(((screen.availLeft ?? 0) + screen.availWidth) * unit);

	if (collapse) {
		if (previous !== true && win.outerWidth >= MIN_WIDTH_DOCKED) setSetting('dockedExpandedWidth', win.outerWidth);
		steamWindow.SetMinSize?.(MIN_WIDTH_FRIENDS_ONLY, MIN_HEIGHT);
		steamWindow.ResizeTo(Math.round(steam.getDockedFriendsListWidth() * unit), height, false);
		if (state.shiftedFromX !== undefined) {
			steamWindow.MoveTo?.(state.shiftedFromX, y, false);
			state.shiftedFromX = undefined;
		}
		return;
	}

	const width = Math.round(Math.max(MIN_WIDTH_DOCKED, getSettings().dockedExpandedWidth || DEFAULT_DOCKED_WIDTH) * unit);
	steamWindow.ResizeTo(width, height, false);
	steamWindow.SetMinSize?.(MIN_WIDTH_DOCKED, MIN_HEIGHT);
	// Keep the chat on screen when the friends list sits at the right edge of the screen.
	if (steamWindow.MoveTo && x + width > screenRight) {
		state.shiftedFromX = x;
		steamWindow.MoveTo(Math.max(screenLeft, screenRight - width), y, false);
	}
}

export function initDockedChat() {
	onSettingsChanged((_settings, key) => {
		if (key === 'hideEmptyDockedChat' || key === null) refreshFriendsLists();
	});
}
