import { useEffect, useState } from 'react';

// Texts of the settings panel in the language of the Steam client. English is the
// source of truth and the fallback; to add a language, add an entry to TRANSLATIONS
// (the compiler lists every missing text) and its Steam name to LANGUAGE_NAMES.

const en = {
	sectionFlyout: 'Friends & Chat flyout',
	flyoutEnabled: 'Open Friends & Chat as a flyout',
	flyoutEnabledDesc: 'Opens the friends list above the “Friends & Chat” button inside the Steam window instead of a separate window. Docked chats open next to it.',
	flyoutCloseOnOutsideClick: 'Close when clicking elsewhere',
	flyoutCloseOnOutsideClickDesc: 'Closes the flyout when you click somewhere else in the Steam window. Esc and the “Friends & Chat” button always close it.',
	flyoutFriendsWidth: 'Friends list width',
	flyoutChatWidth: 'Docked chat width',
	flyoutHeight: 'Height',
	flyoutHeightDesc: 'In percent of the Steam window. The flyout never covers the title bar.',

	sectionFriendsList: 'Friends list',
	sortOfflineByRecent: 'Sort offline friends by last online',
	sortOfflineByRecentDesc: 'Offline friends are sorted by when they were last online instead of alphabetically. The sort button in the list still switches back.',

	sectionChats: 'Chats',
	unreadIndicator: 'Show new messages on the “Friends & Chat” button',
	unreadIndicatorDesc:
		'A yellow dot on the button shows that a chat has new messages. Clicking the button then opens the friends list with the chat that received the newest message.',
	chatTabSelector: 'Only show the list of open chats with three or more chats',
	chatTabSelectorDesc:
		'Steam shows an arrow next to the chat tabs that lists all open chats, often even with a single chat. With this option it only appears when more than two chats are open.',

	sectionDockedChats: 'Docked chats',
	dockedChats: 'Dock chats to the friends list',
	dockedChatsDesc: "Steam's own setting (Friends List → Settings → Chat), available here for convenience.",
	hideEmptyDockedChat: 'Only show the chat when a conversation is open',
	hideEmptyDockedChatDesc:
		'Hides the empty “Click on a friend or group chat to get started!” area. The chat appears when you click a friend and disappears again when you close the last chat.',

	sectionTroubleshooting: 'Troubleshooting',
	debugLogging: 'Write a debug log',
	debugLoggingDesc: 'Writes what the plugin does to millennium/logs/better-friends-chat.log in your Steam folder. Useful when reporting a problem.',
};

export type Messages = typeof en;

// Wording follows Steam's own German texts (e.g. "Freunde & Chat", "Gruppenchat").
const de: Messages = {
	sectionFlyout: 'Flyout „Freunde & Chat“',
	flyoutEnabled: 'Freunde & Chat als Flyout öffnen',
	flyoutEnabledDesc:
		'Öffnet die Freundesliste im Steam-Fenster über dem Button „Freunde & Chat“, statt in einem eigenen Fenster. Angedockte Chats öffnen sich daneben.',
	flyoutCloseOnOutsideClick: 'Beim Klick daneben schließen',
	flyoutCloseOnOutsideClickDesc:
		'Schließt das Flyout, wenn du irgendwo anders im Steam-Fenster klickst. Esc und der Button „Freunde & Chat“ schließen es immer.',
	flyoutFriendsWidth: 'Breite der Freundesliste',
	flyoutChatWidth: 'Breite des angedockten Chats',
	flyoutHeight: 'Höhe',
	flyoutHeightDesc: 'In Prozent des Steam-Fensters. Das Flyout verdeckt nie die Titelleiste.',

	sectionFriendsList: 'Freundesliste',
	sortOfflineByRecent: 'Offline-Freunde nach letzter Aktivität sortieren',
	sortOfflineByRecentDesc:
		'Offline-Freunde werden danach sortiert, wann sie zuletzt online waren, statt alphabetisch. Mit dem Sortier-Button in der Liste kannst du weiterhin zurückwechseln.',

	sectionChats: 'Chats',
	unreadIndicator: 'Neue Nachrichten am Button „Freunde & Chat“ anzeigen',
	unreadIndicatorDesc:
		'Ein gelber Punkt am Button zeigt, dass ein Chat neue Nachrichten hat. Ein Klick auf den Button öffnet dann die Freundesliste mit dem Chat, in dem die neueste Nachricht eingegangen ist.',
	chatTabSelector: 'Liste der offenen Chats erst ab drei Chats anzeigen',
	chatTabSelectorDesc:
		'Steam zeigt neben den Chat-Tabs einen Pfeil mit allen offenen Chats, oft schon bei einem einzigen Chat. Mit dieser Option erscheint er erst, wenn mehr als zwei Chats offen sind.',

	sectionDockedChats: 'Angedockte Chats',
	dockedChats: 'Chats an die Freundesliste andocken',
	dockedChatsDesc: 'Steams eigene Einstellung (Freundesliste → Einstellungen → Chat), hier zur Bequemlichkeit ebenfalls verfügbar.',
	hideEmptyDockedChat: 'Chat nur anzeigen, wenn eine Unterhaltung offen ist',
	hideEmptyDockedChatDesc:
		'Blendet den leeren Bereich „Klicken Sie auf einen Freund oder Gruppenchat, um loszulegen!“ aus. Der Chat erscheint, sobald du einen Freund anklickst, und verschwindet, wenn du den letzten Chat schließt.',

	sectionTroubleshooting: 'Fehlersuche',
	debugLogging: 'Debug-Protokoll schreiben',
	debugLoggingDesc:
		'Schreibt, was das Plugin macht, in millennium/logs/better-friends-chat.log im Steam-Ordner. Nützlich, wenn du ein Problem meldest.',
};

const TRANSLATIONS: Record<string, Messages> = { english: en, german: de };

/** Steam's names for the languages above (SteamClient.Settings.GetCurrentLanguage) and their locale codes. */
const LANGUAGE_NAMES: Record<string, string> = { german: 'german', de: 'german' };

/** Steam's language name ("german") or locale ("de-DE", "de") -> a language we have, else English. */
export function resolveLanguage(steamLanguage: unknown): string {
	if (typeof steamLanguage !== 'string') return 'english';
	const name = steamLanguage.toLowerCase();
	return LANGUAGE_NAMES[name] ?? LANGUAGE_NAMES[name.split(/[-_]/)[0]] ?? 'english';
}

/** The language from Steam's localization, known at once once Steam's UI is up. */
function languageFromLocalization(): string {
	return resolveLanguage((window as any).LocalizationManager?.m_rgLocalesToUse?.[0]);
}

export function getMessages(language: string): Messages {
	return TRANSLATIONS[language] ?? en;
}

/** The texts in Steam's current language (English where there is no translation). */
export function useMessages(): Messages {
	const [language, setLanguage] = useState(languageFromLocalization);
	useEffect(() => {
		let cancelled = false;
		// The setting itself is the authority; the localization above only avoids a flash of English.
		(window as any).SteamClient?.Settings?.GetCurrentLanguage?.()
			?.then((name: unknown) => {
				if (!cancelled) setLanguage(resolveLanguage(name));
			})
			?.catch?.(() => {});
		return () => {
			cancelled = true;
		};
	}, []);
	return getMessages(language);
}
