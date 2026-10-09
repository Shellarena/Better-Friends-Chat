import { definePlugin } from 'millennium';
import { initChatTabs } from './chatTabs';
import { initDockedChat } from './dockedChat';
import { flyout, initFlyout } from './flyout';
import { bfcHooks } from './hooks';
import { log, setDebugLogging } from './log';
import { getSettings, loadSettings, onSettingsChanged } from './settings';
import { SettingsPanel } from './SettingsPanel';
import { initSorting } from './sorting';
import { initUnread } from './unread';

// The code injected by backend/patches.lua calls these hooks. The short global keeps
// the patch list small (see there). Set right away: Steam calls some while it starts.
window.__bfcHooks = bfcHooks;

const PluginIcon = () => (
	<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
		<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.4 9.4 0 0 1-3.9-.8L3 21l1.6-4.4A8.1 8.1 0 0 1 3 11.5 8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z" />
		<path d="M8 10.5h8M8 14h5" />
	</svg>
);

export default definePlugin(() => {
	setDebugLogging(getSettings().debugLogging);
	onSettingsChanged((settings) => setDebugLogging(settings.debugLogging));
	initSorting();
	initDockedChat();
	initChatTabs();
	initFlyout();
	initUnread();
	loadSettings().then(() => log('ready'));

	return {
		title: 'Better Friends Chat',
		icon: <PluginIcon />,
		content: <SettingsPanel />,
		onDismount: () => {
			flyout.dispose();
			// A restarted plugin may already have put its own hooks there.
			if (window.__bfcHooks === bfcHooks) delete window.__bfcHooks;
		},
	};
});
