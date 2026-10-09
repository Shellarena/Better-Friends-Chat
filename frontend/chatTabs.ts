import { warn } from './log';
import { getSettings, onSettingsChanged } from './settings';

// The arrow next to the chat tabs opens a list of all open chats. Steam shows it as soon
// as it guesses the tabs do not fit, which in a narrow chat is already the case with one.
const MIN_CHATS_FOR_SELECTOR = 3;

// Tab bars report themselves on every render (patch #7), so a changed setting also
// applies to chats that are already open.
const tabBars = new Set<WeakRef<any>>();

/** Patch #7: whether the tab bar shows the arrow. undefined keeps Steam's rule. */
export function showChatTabSelector(tabBar: any): boolean | undefined {
	remember(tabBar);
	if (!getSettings().chatTabSelectorOnlyForManyChats) return undefined;
	return (tabBar?.props?.tabSet?.tabCount ?? 0) >= MIN_CHATS_FOR_SELECTOR;
}

function remember(tabBar: any) {
	if (!tabBar) return;
	for (const ref of tabBars) {
		const known = ref.deref();
		if (known === tabBar) return;
		// Forget tab bars that are gone, every chat window brings a new one.
		if (!known) tabBars.delete(ref);
	}
	tabBars.add(new WeakRef(tabBar));
}

function refreshTabBars() {
	for (const ref of tabBars) {
		const tabBar = ref.deref();
		if (!tabBar || tabBar.updater?.isMounted?.(tabBar) === false) {
			tabBars.delete(ref);
			continue;
		}
		try {
			tabBar.forceUpdate();
		} catch (e) {
			warn('could not refresh a chat tab bar', e);
		}
	}
}

export function initChatTabs() {
	onSettingsChanged((_settings, key) => {
		if (key === 'chatTabSelectorOnlyForManyChats' || key === null) refreshTabBars();
	});
}
