import { error, log, warn } from './log';
import { areSettingsLoaded, getSettings, onSettingsChanged } from './settings';
import * as steam from './steam';
import {
	BUTTON_ACTIVE_CLASS,
	BUTTON_CSS,
	FLYOUT_ATTACHED_CLASS,
	FLYOUT_CHAT_CLASS,
	FLYOUT_CSS,
	FLYOUT_ROOT_ID,
	FLYOUT_STYLE_ID,
	FLYOUT_TITLE_BAR_CLASS,
	UNREAD_STYLE_ID,
	unreadDotCss,
} from './styles';
import { hasUnreadChats, newestUnreadChat, onUnreadChanged, scheduleUnreadUpdate } from './unread';

const EDGE_GAP = 6; // px between the flyout, the button and the window edges
const TOP_GAP = 40; // keeps Steam's title bar and menu reachable
const MIN_HEIGHT = 260;
const FALLBACK_BOTTOM = 48; // when the bottom bar button cannot be found
const VIEW_NAME = 'BetterFriendsChat';
const MAKE_ROOM_TIMEOUT = 250; // ms a chat waits at most for the flyout to grow
const PAGE_READY_TIMEOUT = 2000; // ms the friends list waits at most for the flyout's page
const PAGE_READY_POLL = 16; // ms

type FocusCallback = () => void;

interface Bounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

function copyAttributes(from: Element, to: Element) {
	for (const { name, value } of Array.from(from.attributes)) to.setAttribute(name, value);
}

const MENU_GAP = 4; // px between a menu and the edges of the flyout

interface MenuKeeper {
	start(): void;
	stop(): void;
}

/**
 * Menus of the friends list open inside the flyout's page (patch #8). Steam places a menu
 * next to the cursor and only flips it to the other side, so in the narrow flyout a menu
 * that fits on neither side would be cut off. This moves such a menu back into the page.
 * It only watches the page while the flyout is open: the friends list of a closed flyout
 * keeps changing (status, games), and every change would wake the observer.
 */
function keepMenusInPage(viewWindow: Window): MenuKeeper {
	const className = steam.getContextMenuPositionClass();
	if (!className) return { start() {}, stop() {} };
	const selector = `.${CSS.escape(className)}`;
	const fitMenus = () => {
		for (const menu of Array.from(viewWindow.document.querySelectorAll<HTMLElement>(selector))) fitIntoPage(menu, viewWindow.innerWidth);
	};
	const observer = new MutationObserver(fitMenus);
	return {
		start() {
			observer.observe(viewWindow.document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
			fitMenus();
		},
		stop() {
			observer.disconnect();
		},
	};
}

function fitIntoPage(menu: HTMLElement, pageWidth: number) {
	const { left, width } = menu.getBoundingClientRect();
	if (!width) return;
	const shift = Math.round(Math.max(MENU_GAP, Math.min(left, pageWidth - MENU_GAP - width)) - left);
	if (!shift) return;
	// Steam positions a menu by either its left or its right edge.
	if (menu.style.left) menu.style.left = `${parseFloat(menu.style.left) + shift}px`;
	else if (menu.style.right) menu.style.right = `${parseFloat(menu.style.right) - shift}px`;
}

/** Markup of Steam's title bar with only the close button, for when its component is not found. */
function FallbackTitleBar({ className, onClose }: steam.TitleBarProps) {
	return (
		<div className={`TitleBar title-area ${className ?? ''}`}>
			<div className="title-bar-actions window-controls">
				<div className="title-area-icon closeButton windowControlButton" onClick={onClose}>
					<div className="title-area-icon-inner">
						<svg className="SVGIcon_Button SVGIcon_X_Line" viewBox="0 0 256 256" width="256px" height="256px">
							<line fill="none" stroke="#FFFFFF" strokeWidth="45" x1="212" y1="212" x2="44" y2="44" />
							<line fill="none" stroke="#FFFFFF" strokeWidth="45" x1="44" y1="212" x2="212" y2="44" />
						</svg>
					</div>
				</div>
			</div>
		</div>
	);
}

/**
 * The friends UI talks to the window that hosts the friends list through a small
 * container interface (Steam wraps the separate friends window in one). This is the
 * flyout's version: visibility and focus follow the flyout, so Steam keeps showing
 * notifications and unread markers while the flyout is closed, and nothing here
 * renames, resizes or closes the Steam main window.
 */
export class FlyoutContainer {
	private m_title = '';

	constructor(private readonly flyout: Flyout) {}

	BringToFront() {
		// Steam calls this e.g. right after moving docked chats into new windows; show the
		// flyout without pulling the Steam window over those windows.
		this.flyout.open(false);
	}

	FlashWindow(flash: boolean) {
		this.flyout.flash(flash);
	}

	Close() {
		this.flyout.unmount('closed by Steam');
	}

	get title() {
		return this.m_title;
	}

	set title(value: string) {
		this.m_title = value;
	}

	BIsClosed() {
		return !this.flyout.isMounted();
	}

	BIsVisible() {
		return this.flyout.isOpen() && this.flyout.isWindowVisible();
	}

	BIsFocused() {
		return this.flyout.isOpen() && this.flyout.isWindowFocused();
	}

	IsMinimized(): Promise<boolean> {
		return this.flyout.isOpen() ? this.flyout.isWindowMinimized() : Promise.resolve(true);
	}

	OnFocus(callback: FocusCallback) {
		return this.flyout.addFocusCallback(callback);
	}

	GetWindow() {
		return this.flyout.window;
	}
}

/**
 * Store and community pages are native views that Steam draws on top of its window's
 * own UI. So the flyout is such a view as well, with a page of its own that the friends
 * list renders into: Steam draws it on top of the window, pages included, the way it
 * shows its notifications there.
 */
class Flyout {
	/** The Steam window the flyout belongs to. */
	window: Window | undefined;
	private doc: Document | undefined;
	private view: steam.BrowserView | undefined;
	private viewDoc: Document | undefined;
	private root: HTMLDivElement | undefined;
	private host: HTMLDivElement | undefined;
	private bounds: Bounds | undefined;
	private container: FlyoutContainer | undefined;
	private context: steam.BrowserContext | undefined;
	private mounted = false;
	private opened = false;
	/** The flyout has room for the docked chat area. */
	private chatVisible = false;
	/** The flyout grows for a chat that waits until the page has drawn the new size. */
	private makingRoom = false;
	private roomToken = 0;
	private containerRequested = false;
	private unavailable = false;
	private readonly focusCallbacks = new Set<FocusCallback>();
	private detachWindowListeners: (() => void) | undefined;
	private menuKeeper: MenuKeeper | undefined;
	private unregisterElement: (() => void) | undefined;
	private watchedStorePage: steam.BrowserView | undefined;
	private storePageTimer: number | undefined;
	private storePageShown = false;
	private mountToken = 0;
	private readonly buttonListeners = new Map<Window, (event: MouseEvent) => void>();
	private popupCreatedRegistration: { Unregister?: () => void } | undefined;

	isMounted() {
		return this.mounted;
	}

	isOpen() {
		return this.mounted && this.opened;
	}

	isWindowVisible() {
		return !!this.doc && this.doc.visibilityState === 'visible';
	}

	/** The Steam window or the flyout inside it has the keyboard. */
	isWindowFocused() {
		return !!this.doc?.hasFocus() || !!this.viewDoc?.hasFocus();
	}

	isWindowMinimized(): Promise<boolean> {
		const steamWindow = (this.window as any)?.SteamClient?.Window;
		return steamWindow?.IsWindowMinimized ? steamWindow.IsWindowMinimized() : Promise.resolve(false);
	}

	addFocusCallback(callback: FocusCallback) {
		this.focusCallbacks.add(callback);
		// Registered after the flyout opened (first render): it already has the focus.
		if (this.isOpen() && this.isWindowFocused()) this.window?.setTimeout(() => this.focusCallbacks.has(callback) && callback(), 0);
		return { unregister: () => this.focusCallbacks.delete(callback) };
	}

	/** Browser context of the friends list in the flyout (patch #6). */
	friendsContext(): steam.BrowserContext | undefined {
		return this.context;
	}

	/** Patch #8: a menu of the friends list in the flyout opens inside the flyout's page, not as a popup window. */
	showsMenusInline(ownerWindow: Window | undefined): boolean {
		if (!this.mounted || !ownerWindow || ownerWindow !== this.viewDoc?.defaultView) return false;
		log('menu opened inside the flyout');
		return true;
	}

	/**
	 * Patch #10: Steam showed a view such as the store page and put it in front of the other
	 * views of its window. It also does that when the Steam window comes back from the tray
	 * or is restored, e.g. for a click on a message notification: without this, the flyout
	 * opened for the chat would end up behind the page.
	 */
	onViewShown() {
		if (!this.isOpen()) return;
		log('flyout back in front of a page Steam showed');
		this.showView();
	}

	/** Patch #3: called for every request to show the friends list. */
	handleShowRequest(context: steam.BrowserContext | undefined, startMinimized: boolean, takeFocus: boolean): boolean {
		log('show request', { pid: context?.m_unPID, browser: context?.m_nBrowserID, startMinimized, takeFocus, mounted: this.mounted, opened: this.opened });
		// Until the stored settings are known, Steam opens its own window.
		if (!areSettingsLoaded() || !getSettings().flyoutEnabled || this.unavailable) return false;
		if (!steam.isDesktopContext(context) || steam.isFriendsListBlocked()) return false;
		const win = steam.getMainWindowPopup()?.window as Window | undefined;
		if (!win) {
			log('Steam window not found, using the separate friends window');
			return false;
		}
		if (!this.ensureMounted(win, context!)) return false;
		// Restores at Steam startup come without focus (or minimized): prepare the flyout,
		// including restored docked chats, but leave it closed until the user opens it.
		if (this.opened || (takeFocus && !startMinimized)) this.open(takeFocus);
		return true;
	}

	/** Patch #5: the friends list asks for the container of the element it renders into. */
	containerFor(element: HTMLElement): FlyoutContainer | undefined {
		if (!this.mounted || element !== this.host) return undefined;
		if (!this.containerRequested) log('friends list rendered into the flyout');
		this.containerRequested = true;
		return this.container;
	}

	/**
	 * Patch #2 (through onFriendsListRender), while Steam renders the friends list: whether
	 * it shows its docked chat area. Returns true while the chat has to wait.
	 *
	 * The chat area opens to the left, so the view grows to the left. Until its page has
	 * drawn the new size, such a view shows its old picture at its new left edge and the
	 * page background (styles.ts) elsewhere: the friends list leaves its place for a moment.
	 * With Steam building the chat at the same time, that took three frames. So the open
	 * flyout first makes room and lets Steam render the chat once the page has drawn its new
	 * size, which leaves about two frames (the time Steam and Chromium take to resize).
	 */
	updateChat(visible: boolean, rerender: () => void): boolean {
		if (!visible) {
			this.stopMakingRoom();
			this.setChatVisible(false);
			return false;
		}
		if (this.chatVisible) return this.makingRoom;
		this.setChatVisible(true);
		const viewWindow = this.viewDoc?.defaultView;
		if (!this.isOpen() || !viewWindow) return false;
		this.makeRoom(viewWindow, rerender);
		return true;
	}

	private setChatVisible(visible: boolean) {
		if (visible === this.chatVisible) return;
		this.chatVisible = visible;
		// Called while Steam renders; touch the DOM afterwards.
		queueMicrotask(() => this.layout());
	}

	/** Calls `rerender` once the flyout's page has drawn the size with the chat area. */
	private makeRoom(viewWindow: Window, rerender: () => void) {
		const token = ++this.roomToken;
		this.makingRoom = true;
		const done = () => {
			if (token !== this.roomToken || !this.makingRoom) return;
			this.makingRoom = false;
			try {
				rerender();
			} catch (e) {
				warn('could not show the chat in the flyout', e);
			}
		};
		// Also when the page never reports the new size, e.g. because the flyout closed.
		this.window?.setTimeout(done, MAKE_ROOM_TIMEOUT);
		const check = () => {
			// Also stops after the timeout: a page that never reports the width would keep it running every frame.
			if (token !== this.roomToken || !this.makingRoom) return;
			const width = this.bounds?.width;
			// This frame is the first one in the new size: render the chat once it is drawn.
			if (width && Math.abs(viewWindow.innerWidth - width) <= 1) viewWindow.setTimeout(done, 0);
			else viewWindow.requestAnimationFrame(check);
		};
		viewWindow.requestAnimationFrame(check);
	}

	private stopMakingRoom() {
		this.roomToken++;
		this.makingRoom = false;
	}

	open(takeFocus: boolean) {
		if (!this.mounted || !this.window || !this.view) return;
		this.registerContainer();
		if (takeFocus) steam.bringWindowToFront(this.window);
		if (!this.opened) {
			this.opened = true;
			this.layout();
			this.showView();
			this.menuKeeper?.start();
			this.setButtonClass(BUTTON_ACTIVE_CLASS, true);
			this.stopFlashing();
			this.watchStorePage(true);
			scheduleUnreadUpdate();
			log('flyout opened', { ...this.bounds, chat: this.chatVisible, scale: this.viewDoc?.defaultView?.devicePixelRatio, windowScale: this.window.devicePixelRatio });
		}
		if (takeFocus) this.focusView();
		if (this.isWindowFocused()) this.notifyFocus();
	}

	close() {
		if (!this.opened || !this.view) return;
		this.opened = false;
		this.watchStorePage(false);
		this.menuKeeper?.stop();
		this.releaseFocus();
		this.view.SetVisible(false);
		this.setButtonClass(BUTTON_ACTIVE_CLASS, false);
		// Docked chats are no longer on screen, unread ones count again.
		scheduleUnreadUpdate();
	}

	flash(flash: boolean) {
		if (!this.mounted) return;
		if (flash && this.opened && this.isWindowFocused()) return;
		// Only the taskbar entry flashes; on the button, new messages show as the unread dot.
		const steamWindow = (this.window as any)?.SteamClient?.Window;
		if (flash && !this.isWindowFocused()) steamWindow?.SetWindowFlashing?.(true);
		if (!flash) this.stopFlashing();
	}

	unmount(reason: string) {
		if (!this.mounted) return;
		log(`closing flyout (${reason})`);
		const { view, container, context } = this;
		this.watchStorePage(false);
		try {
			this.releaseFocus();
			view?.SetVisible(false);
		} catch (e) {
			warn('could not hide the flyout', e);
		}
		this.mounted = false;
		this.opened = false;
		this.chatVisible = false;
		this.stopMakingRoom();
		this.detachWindowListeners?.();
		this.detachWindowListeners = undefined;
		this.menuKeeper?.stop();
		this.menuKeeper = undefined;
		this.setButtonClass(BUTTON_ACTIVE_CLASS, false);
		this.host = undefined;

		const chatData = context ? steam.uiStore()?.GetPerContextChatData?.(context) : undefined;
		if (chatData && chatData.friends_list_window === container) chatData.SetFriendsListWindow(undefined);

		// Unmount outside of whatever Steam is doing right now (Close() can come from a render).
		const unregisterElement = this.unregisterElement;
		this.unregisterElement = undefined;
		setTimeout(() => {
			try {
				unregisterElement?.();
			} catch (e) {
				warn('unmounting the friends list failed', e);
			}
			// Give React a moment to remove the portal before the page goes away.
			setTimeout(() => {
				try {
					if (view) steam.destroyBrowserView(view);
				} catch (e) {
					warn('could not remove the flyout view', e);
				}
			}, 100);
		}, 0);

		this.view = undefined;
		this.viewDoc = undefined;
		this.root = undefined;
		this.bounds = undefined;
		this.container = undefined;
		this.context = undefined;
		this.focusCallbacks.clear();
	}

	/** Re-reads the settings: disabling the flyout removes it, size changes apply directly. */
	applySettings() {
		if (!getSettings().flyoutEnabled) this.unmount('disabled in settings');
		else if (this.opened) this.layout();
	}

	/**
	 * Installs the click handler and the dot for new messages on the Steam main window,
	 * now and whenever it is (re)created. Without it the button still works through
	 * Steam's own path (patch #3), but clicking it again would not close the flyout.
	 */
	watchMainWindow(attempt = 0) {
		const manager = window.g_PopupManager;
		if (!manager?.AddPopupCreatedCallback) {
			if (attempt < 60) window.setTimeout(() => this.watchMainWindow(attempt + 1), 1000);
			else warn('Steam popup manager not found, the button cannot close the flyout');
			return;
		}
		const attach = (popup: any) => {
			const name: string = popup?.GetName?.() ?? popup?.m_strName ?? '';
			const win: Window | undefined = popup?.window;
			if (!win || !/^SP Desktop(_|$)/.test(name) || this.buttonListeners.has(win)) return;
			const listener = (event: MouseEvent) => this.onButtonClick(win, event);
			this.buttonListeners.set(win, listener);
			win.addEventListener('click', listener, true);
			win.addEventListener('unload', () => this.buttonListeners.delete(win), { once: true });
			this.renderUnreadDot(win);
		};
		try {
			for (const popup of manager.GetPopups?.() ?? []) attach(popup);
			this.popupCreatedRegistration = manager.AddPopupCreatedCallback(attach);
		} catch (e) {
			warn('could not watch the Steam window', e);
		}
	}

	/** Removes everything the plugin added (plugin unloaded). */
	dispose() {
		this.unmount('plugin unloaded');
		this.popupCreatedRegistration?.Unregister?.();
		this.popupCreatedRegistration = undefined;
		for (const [win, listener] of this.buttonListeners) {
			win.removeEventListener('click', listener, true);
			win.document.getElementById(UNREAD_STYLE_ID)?.remove();
		}
		this.buttonListeners.clear();
	}

	/** Shows or hides the dot for new messages on the button, in every Steam window. */
	renderUnreadDots() {
		for (const win of this.buttonListeners.keys()) this.renderUnreadDot(win);
	}

	private renderUnreadDot(win: Window) {
		const className = steam.getFriendsButtonClass();
		this.injectStyle(win.document, hasUnreadChats() && className ? unreadDotCss(className) : '', UNREAD_STYLE_ID);
	}

	private onButtonClick(win: Window, event: MouseEvent) {
		if (!areSettingsLoaded()) return;
		const className = steam.getFriendsButtonClass();
		const button = className ? (event.target as Element | null)?.closest?.(`.${CSS.escape(className)}`) : null;
		if (!button) return;
		// A disabled button (family view) keeps Steam's own unlock dialog.
		if (steam.isFriendsButtonDisabled(button) || steam.isFriendsListBlocked()) return;

		const context = this.context ?? steam.desktopContext();
		// With new messages, the button opens the friends list together with the newest chat.
		const chat = this.opened ? undefined : newestUnreadChat();
		const useFlyout = getSettings().flyoutEnabled && !this.unavailable && (this.opened || this.ensureMounted(win, context));
		if (!useFlyout && !chat) return; // Steam opens its own window
		event.stopPropagation();
		event.preventDefault();
		if (this.opened) {
			this.close();
			return;
		}
		if (useFlyout) this.open(true);
		else steam.showFriendsList(context);
		if (chat) {
			log('opening the chat with the newest message');
			steam.showChat(context, chat);
		}
	}

	private ensureMounted(win: Window, context: steam.BrowserContext): boolean {
		if (this.mounted && this.window === win && !win.closed) return true;
		if (this.mounted) this.unmount('Steam window changed');

		const app = steam.friendsApp();
		const desktopApp = steam.desktopApp();
		const components = steam.getFriendsListComponents();
		if (!app || !desktopApp?.RegisterPopupElement || !components) {
			this.unavailable = true;
			return false;
		}
		const created = steam.createBrowserView(win, VIEW_NAME);
		if (!created) {
			warn('could not create a view in the Steam window, the flyout is unavailable');
			this.unavailable = true;
			return false;
		}
		const { view, window: viewWindow } = created;
		view.SetVisible(false);

		// Only one friends list per context: close the separate friends window first. When
		// it is gone, Steam unregisters "the" friends list window, so register the flyout's
		// container again afterwards.
		const popup = desktopApp.GetFriendsListPopup?.(context);
		if (popup) {
			log('closing the separate friends window in favour of the flyout');
			const previousOnClose = popup.m_fnOnClose;
			popup.SetOnClose?.(() => {
				previousOnClose?.();
				this.registerContainer();
			});
			popup.Close?.();
		}

		const doc = win.document;
		this.injectStyle(doc, BUTTON_CSS);
		const viewDoc = this.writeViewPage(viewWindow.document, doc);
		const root = viewDoc.createElement('div');
		root.id = FLYOUT_ROOT_ID;
		const host = viewDoc.createElement('div');
		host.className = 'bfc-host friendsui-container client_chat_frame fullheight';
		root.appendChild(host);
		viewDoc.body.appendChild(root);
		// Friend entries look up their browser context from the window they are rendered
		// in. The separate friends window uses the desktop context, so the flyout does as
		// well, otherwise chats opened from the flyout would land in another context.
		viewWindow.__FriendsUIBrowserContext = context;

		this.window = win;
		this.doc = doc;
		this.view = view;
		this.viewDoc = viewDoc;
		this.root = root;
		this.host = host;
		this.context = context;
		this.container = new FlyoutContainer(this);
		this.containerRequested = false;
		this.chatVisible = false;
		this.stopMakingRoom();
		this.mounted = true;

		// Rendered like Steam's own friends windows: a portal from the friends UI tree in
		// SharedJSContext, which already provides everything the friends list needs. Its
		// menus and dialogs belong to the flyout's page. Steam only gives the friends list
		// its title bar in a window of its own, so the flyout adds one with the close button.
		const OwnerWindow = components.OwnerWindow as any;
		const EmbeddedFriendsList = components.EmbeddedFriendsList as any;
		const TitleBar = (steam.getTitleBarComponent() ?? FallbackTitleBar) as any;
		const onClose = () => this.close();

		this.detachWindowListeners = this.attachWindowListeners(win, viewWindow);
		this.menuKeeper = keepMenusInPage(viewWindow);
		this.layout();
		const token = ++this.mountToken;
		this.whenPageReady(win, viewWindow, token, () => {
			try {
				this.unregisterElement = desktopApp.RegisterPopupElement(host, () => (
					<OwnerWindow ownerWindow={viewWindow}>
						<EmbeddedFriendsList friends={app.FriendStore} chats={app.ChatStore} browserContext={context} elTarget={host} />
						<TitleBar className={`chatTitleBar ${FLYOUT_TITLE_BAR_CLASS}`} hideMin hideMax onClose={onClose} />
					</OwnerWindow>
				));
			} catch (e) {
				error('rendering the friends list into the flyout failed', e);
				this.unavailable = true;
				this.unmount('render failed');
			}
		});
		log('friends list mounted in the Steam window');
		win.setTimeout(() => this.verifyContainer(token), 10000);
		return true;
	}

	/**
	 * Calls `ready` once the flyout's page has its size and Steam's style sheets, at the latest
	 * after PAGE_READY_TIMEOUT. A new view starts at 0×0 without styles, and Steam measures parts
	 * of the friends list when it mounts and keeps the values: in such a page, the group chat
	 * list measured 0px and could not be expanded anymore.
	 */
	private whenPageReady(win: Window, viewWindow: Window, token: number, ready: () => void) {
		const doc = viewWindow.document;
		const pendingStyles = new Set(Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).filter((link) => !link.sheet));
		for (const link of pendingStyles) {
			const settle = () => pendingStyles.delete(link);
			link.addEventListener('load', settle, { once: true });
			link.addEventListener('error', settle, { once: true });
		}
		const start = Date.now();
		// Timers of the Steam window: the hidden page gets neither animation frames nor resize events.
		const check = () => {
			if (token !== this.mountToken || !this.mounted) return;
			const bounds = this.bounds;
			const sized = !!bounds && Math.abs(viewWindow.innerWidth - bounds.width) <= 1 && Math.abs(viewWindow.innerHeight - bounds.height) <= 1;
			const waited = Date.now() - start;
			if ((sized && !pendingStyles.size) || waited >= PAGE_READY_TIMEOUT) {
				log('flyout page ready', { waited, sized, pendingStyles: pendingStyles.size });
				ready();
			} else win.setTimeout(check, PAGE_READY_POLL);
		};
		check();
	}

	/**
	 * The flyout's page gets the Steam window's classes and style sheets, so the friends list
	 * looks the same. Except for the desktop UI class, which Steam's friends windows do not
	 * have: with it, the friends list's menus take the style of the Steam window's menus and
	 * the descriptions of the status menu end up next to the entries instead of below them.
	 */
	private writeViewPage(doc: Document, windowDoc: Document): Document {
		doc.open();
		doc.write('<!DOCTYPE html><html><head><title></title></head><body></body></html>');
		doc.close();
		copyAttributes(windowDoc.documentElement, doc.documentElement);
		copyAttributes(windowDoc.body, doc.body);
		doc.documentElement.classList.remove(steam.DESKTOP_UI_CLASS);
		doc.body.classList.remove(steam.DESKTOP_UI_CLASS);
		for (const sheet of Array.from(windowDoc.head.querySelectorAll('link[rel="stylesheet"], style'))) {
			if (sheet.id !== FLYOUT_STYLE_ID && sheet.id !== UNREAD_STYLE_ID) doc.head.appendChild(doc.importNode(sheet, true));
		}
		this.injectStyle(doc, FLYOUT_CSS);
		return doc;
	}

	/** Diagnostics only: getFriendsListComponents() already checked that the patches are in place. */
	private verifyContainer(token: number) {
		if (token !== this.mountToken || !this.mounted || this.containerRequested) return;
		warn('the friends list has not rendered into the flyout yet');
	}

	private registerContainer() {
		if (!this.containerRequested || !this.context) return;
		const chatData = steam.uiStore()?.GetPerContextChatData?.(this.context);
		// A separate friends window that was closed for the flyout unregisters itself late.
		if (chatData && chatData.friends_list_window !== this.container) chatData.SetFriendsListWindow(this.container);
	}

	private attachWindowListeners(win: Window, viewWindow: Window) {
		// The flyout's own clicks happen in its page, so these are all clicks elsewhere.
		const onMouseDown = (event: MouseEvent) => {
			if (!this.opened || !getSettings().flyoutCloseOnOutsideClick) return;
			const target = event.target as Node | null;
			const button = steam.findFriendsButton(win.document);
			if (!target || button?.contains(target)) return; // the button is handled by the click handler
			// Only clicks into Steam's own UI.
			const appRoot = button?.closest('body > *');
			if (appRoot && !appRoot.contains(target)) return;
			this.close();
		};
		// Bubble phase: dialogs, menus and the chat input get Esc first.
		const onKeyDown = (event: KeyboardEvent) => {
			if (!this.opened || event.key !== 'Escape' || event.defaultPrevented) return;
			event.preventDefault();
			this.close();
		};
		const onResize = () => {
			if (this.opened) this.layout();
		};
		const onFocus = () => {
			if (this.opened) this.notifyFocus();
		};
		const onUnload = () => this.unmount('Steam window closed');
		const onViewUnload = () => this.unmount('flyout page closed');

		win.addEventListener('mousedown', onMouseDown, true);
		win.addEventListener('resize', onResize);
		win.addEventListener('unload', onUnload);
		viewWindow.addEventListener('unload', onViewUnload);
		for (const target of [win, viewWindow]) {
			target.addEventListener('keydown', onKeyDown);
			target.addEventListener('focus', onFocus);
		}
		return () => {
			win.removeEventListener('mousedown', onMouseDown, true);
			win.removeEventListener('resize', onResize);
			win.removeEventListener('unload', onUnload);
			viewWindow.removeEventListener('unload', onViewUnload);
			for (const target of [win, viewWindow]) {
				target.removeEventListener('keydown', onKeyDown);
				target.removeEventListener('focus', onFocus);
			}
		};
	}

	/** In front of everything in the Steam window, store and community pages included. */
	private showView() {
		this.view?.SetWindowStackingOrder(steam.STACKING_ORDER_TOP);
		this.view?.SetVisible(true);
	}

	/** Gives the keyboard to the flyout, like Steam does for its own views. */
	private focusView() {
		if (!this.window || !this.view) return;
		steam.setWindowKeyFocus(this.window, false);
		this.view.SetFocus(true);
	}

	/** Hands the keyboard back to the Steam window. */
	private releaseFocus() {
		if (!this.view || !this.viewDoc?.hasFocus()) return;
		this.view.SetFocus(false);
		if (this.window) steam.setWindowKeyFocus(this.window, true);
	}

	/**
	 * While the flyout is open, a click into a store or community page closes it like
	 * any other click elsewhere, and the flyout stays in front of a page that Steam shows
	 * meanwhile (Steam brings that page's view to the front when it shows it). Patch #10
	 * already does that; the poll is the fallback for newly opened pages without it.
	 */
	private watchStorePage(watch: boolean) {
		this.watchedStorePage?.off?.('focus-changed', this.onStorePageFocus);
		this.watchedStorePage = undefined;
		if (this.storePageTimer !== undefined) this.window?.clearInterval(this.storePageTimer);
		this.storePageTimer = undefined;
		if (!watch || !this.window) return;

		this.watchedStorePage = steam.storePageView();
		this.watchedStorePage?.on?.('focus-changed', this.onStorePageFocus);
		this.storePageShown = steam.isStorePageShown();
		this.storePageTimer = this.window.setInterval(() => {
			const shown = steam.isStorePageShown();
			if (shown && !this.storePageShown) this.showView();
			this.storePageShown = shown;
		}, 500);
	}

	private readonly onStorePageFocus = (focused: boolean) => {
		if (focused && this.opened && getSettings().flyoutCloseOnOutsideClick) this.close();
	};

	/** Places the flyout on top of the bottom bar, right above the "Friends & Chat" button. */
	private layout() {
		const { window: win, doc, root, view } = this;
		if (!win || !doc || !root || !view) return;
		const settings = getSettings();
		const viewportWidth = win.innerWidth;
		const viewportHeight = win.innerHeight;

		let bottom = FALLBACK_BOTTOM;
		let right = EDGE_GAP;
		let attached = false;
		const button = steam.findFriendsButton(doc)?.getBoundingClientRect();
		const bar = steam.findBottomBar(doc)?.getBoundingClientRect();
		if (button && button.width > 0 && button.height > 0) {
			bottom = Math.max(0, viewportHeight - button.top) + EDGE_GAP;
			right = Math.max(EDGE_GAP, viewportWidth - button.right);
		}
		if (bar && bar.height > 0) {
			// Flush with the bar, without covering it.
			bottom = Math.max(0, viewportHeight - bar.top);
			attached = true;
		}

		const maxHeight = Math.max(MIN_HEIGHT, viewportHeight - bottom - TOP_GAP);
		const height = Math.min(maxHeight, Math.max(MIN_HEIGHT, Math.round((viewportHeight * settings.flyoutHeightPercent) / 100)));
		const maxWidth = Math.max(settings.flyoutFriendsWidth, viewportWidth - right - EDGE_GAP);
		const width = Math.min(maxWidth, settings.flyoutFriendsWidth + (this.chatVisible ? settings.flyoutChatWidth : 0));

		root.classList.toggle(FLYOUT_CHAT_CLASS, this.chatVisible);
		root.classList.toggle(FLYOUT_ATTACHED_CLASS, attached);
		root.style.setProperty('--bfc-friends-width', `${settings.flyoutFriendsWidth}px`);
		// View bounds are in CSS pixels of the Steam window, like Steam's own views.
		const bounds = {
			x: Math.round(viewportWidth - right - width),
			y: Math.round(viewportHeight - bottom - height),
			width: Math.round(width),
			height: Math.round(height),
		};
		this.bounds = bounds;
		view.SetBounds(bounds.x, bounds.y, bounds.width, bounds.height);
	}

	private notifyFocus() {
		for (const callback of this.focusCallbacks) {
			try {
				callback();
			} catch (e) {
				warn('focus callback failed', e);
			}
		}
	}

	private stopFlashing() {
		(this.window as any)?.SteamClient?.Window?.SetWindowFlashing?.(false);
	}

	private setButtonClass(className: string, enabled: boolean) {
		if (!this.doc) return;
		steam.findFriendsButton(this.doc)?.classList.toggle(className, enabled);
	}

	private injectStyle(doc: Document, css: string, id = FLYOUT_STYLE_ID) {
		let style = doc.getElementById(id) as HTMLStyleElement | null;
		if (!style) {
			style = doc.createElement('style');
			style.id = id;
			doc.head.appendChild(style);
		}
		style.textContent = css;
	}
}

export const flyout = new Flyout();

export function initFlyout() {
	flyout.watchMainWindow();
	onSettingsChanged((_settings, key) => {
		if (key === null || key.startsWith('flyout')) flyout.applySettings();
	});
	onUnreadChanged(() => flyout.renderUnreadDots());
}
