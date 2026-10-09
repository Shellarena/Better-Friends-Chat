import { log, warn } from './log';

// Store and community pages in the Steam window are a native browser view. Where the
// PC supports it, Steam draws the view below the window's own UI (an "underlay"), so
// the flyout simply lies on top of the page. Otherwise the view is drawn on top of the
// UI and would hide the flyout: while the flyout is open, the view is narrowed to end
// left of it, and Steam's bounds are restored when it closes.

interface Bounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface BrowserView {
	GetBounds?(): Bounds | undefined;
	SetBounds?(x: number, y: number, width: number, height: number): void;
}

const GAP = 8;

let steamBounds: Bounds | undefined; // last bounds Steam gave the view
let ourBounds: Bounds | undefined; // bounds this module set
let viewBelowUI = false;

/**
 * Asks Steam whether it draws the view in the Steam window `win` below the window's UI.
 * The Steam window does so whenever the window reports underlay support.
 */
export async function readBrowserViewPlacement(win: Window) {
	try {
		const details = await (win as any).SteamClient?.Window?.GetWindowDetails?.();
		viewBelowUI = !!details?.bUnderlaySupported;
		log(`store/community pages are drawn ${viewBelowUI ? 'below' : 'on top of'} the Steam window's UI`, details);
	} catch (e) {
		warn('could not read the Steam window details', e);
	}
}

function mainBrowserView(): BrowserView | undefined {
	return (window as any).MainWindowBrowserManager?.m_browser;
}

/** Steam only shows the view on its /browser/ route; elsewhere it keeps stale bounds. */
function isBrowserViewShown(): boolean {
	const pathname: unknown = (window as any).MainWindowBrowserManager?.m_history?.location?.pathname;
	return typeof pathname === 'string' && pathname.startsWith('/browser');
}

// Bounds may come back rounded, so allow a little slack.
function sameBounds(a?: Bounds, b?: Bounds) {
	const near = (x: number, y: number) => Math.abs(x - y) <= 1.5;
	return !!a && !!b && near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);
}

/** The area the view gave up for the flyout (CSS pixels), if any. */
export interface FreedArea {
	left: number;
	top: number;
	width: number;
	height: number;
}

/**
 * Keeps the browser view clear of the flyout, unless the view is drawn below the UI.
 * `flyout` is the flyout's rectangle in the Steam window (CSS pixels, like the view's
 * bounds), or undefined when closed. Returns the area the view gave up, so the flyout
 * can fill it.
 */
export function makeRoomForFlyout(flyout: DOMRect | undefined): FreedArea | undefined {
	const view = mainBrowserView();
	if (!view?.GetBounds || !view.SetBounds) return undefined;
	try {
		const current = view.GetBounds();
		if (!current) return undefined;
		if (!sameBounds(current, ourBounds)) {
			// Steam changed the bounds since (resize, navigation): that is the new full size.
			steamBounds = { ...current };
			ourBounds = undefined;
		}
		if (!steamBounds) return undefined;
		const full = steamBounds;
		const restore = () => {
			if (ourBounds && sameBounds(view.GetBounds?.(), ourBounds)) view.SetBounds!(full.x, full.y, full.width, full.height);
			ourBounds = undefined;
		};

		const right = flyout ? Math.round(flyout.left - GAP) : 0;
		const overlaps =
			!!flyout &&
			!viewBelowUI &&
			isBrowserViewShown() &&
			flyout.top < full.y + full.height &&
			flyout.bottom > full.y &&
			full.x + full.width > right;
		if (!overlaps) {
			restore();
			return undefined;
		}
		const next = { x: full.x, y: full.y, width: Math.max(0, right - full.x), height: full.height };
		if (!sameBounds(current, next)) view.SetBounds(next.x, next.y, next.width, next.height);
		ourBounds = next;
		return { left: right, top: full.y, width: full.x + full.width - right, height: full.height };
	} catch (e) {
		warn('could not adjust the store/community view', e);
		return undefined;
	}
}
