export const FLYOUT_ROOT_ID = 'bfc-flyout';
export const FLYOUT_STYLE_ID = 'bfc-flyout-style';
export const UNREAD_STYLE_ID = 'bfc-unread-style';
export const FLYOUT_CHAT_CLASS = 'bfc-chat-visible';
export const FLYOUT_ATTACHED_CLASS = 'bfc-attached';
export const FLYOUT_TITLE_BAR_CLASS = 'bfc-title-bar';
export const BUTTON_ACTIVE_CLASS = 'bfc-friends-button-active';

/**
 * The page inside the flyout's view: the friends list fills it. The background is the colour
 * of the friends list and the chat area. It shows in the room made for a chat before Steam
 * renders it, and in the part of the growing view that the page has not drawn yet.
 */
export const FLYOUT_CSS = `
html,
body {
	width: 100%;
	height: 100%;
	margin: 0;
	overflow: hidden;
	background: rgb(30, 32, 37);
}

#${FLYOUT_ROOT_ID} {
	--bfc-friends-width: 320px;
	position: fixed;
	inset: 0;
	display: flex;
	flex-direction: column;
	box-sizing: border-box;
	background: rgb(30, 32, 37);
	border: 1px solid rgba(255, 255, 255, 0.1);
}

/* Sits right on top of the bottom bar. */
#${FLYOUT_ROOT_ID}.${FLYOUT_ATTACHED_CLASS} {
	border-bottom: none;
}

#${FLYOUT_ROOT_ID} > .bfc-host {
	position: relative;
	flex: 1 1 auto;
	min-height: 0;
	width: 100%;
}

/* Steam's title bar of the friends window, reduced to the close button in the top right
   corner. It must not move the Steam window or catch clicks meant for the header below. */
#${FLYOUT_ROOT_ID} .${FLYOUT_TITLE_BAR_CLASS} {
	bottom: auto;
	height: 32px;
	z-index: 10;
	pointer-events: none;
	-webkit-app-region: no-drag;
}

/* Docked chats open to the left, so the friends list stays above the button. */
#${FLYOUT_ROOT_ID} .chat_main_flex {
	flex-direction: row-reverse;
}

/* The width is a plugin setting here, Steam's drag handle would resize the wrong way. */
#${FLYOUT_ROOT_ID} .singleWindowDivider {
	pointer-events: none;
	cursor: default;
}

#${FLYOUT_ROOT_ID}.${FLYOUT_CHAT_CLASS} .friendsListContainer {
	flex: 0 0 var(--bfc-friends-width);
	width: var(--bfc-friends-width) !important;
}

#${FLYOUT_ROOT_ID}:not(.${FLYOUT_CHAT_CLASS}) .friendsListContainer {
	width: 100% !important;
}

/* Steam's footer below the friends list only holds a debug button that is never shown, which
   leaves an empty bar between the groups and the bottom bar. */
#${FLYOUT_ROOT_ID} .friendListFooter {
	display: none;
}

/* No button that collapses the friends list into the chat. */
#${FLYOUT_ROOT_ID} .friendListCollapse {
	display: none;
}
`;

/** The "Friends & Chat" button in the Steam window. New messages only show as the dot below. */
export const BUTTON_CSS = `
.${BUTTON_ACTIVE_CLASS} {
	background-color: rgba(255, 255, 255, 0.12) !important;
}
`;

/**
 * The glowing dot for new messages, at the top right corner of the button's icon. A style
 * of its own instead of a class on the button: Steam renders the button again whenever it
 * likes, while this element stays until the plugin removes it.
 */
export const unreadDotCss = (buttonClass: string) => {
	const button = `.${CSS.escape(buttonClass)}`;
	return `
${button} {
	position: relative;
}

${button}::after {
	content: '';
	position: absolute;
	top: 2px;
	right: 1px;
	width: 7px;
	height: 7px;
	border-radius: 50%;
	background: #ffd43b;
	box-shadow: 0 0 3px 1px rgba(255, 212, 59, 0.9), 0 0 9px 2px rgba(255, 212, 59, 0.45);
	pointer-events: none;
}
`;
};
