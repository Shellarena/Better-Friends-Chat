# Better Friends Chat

A [Millennium](https://steambrew.app) plugin that adds more settings to Steam's **Friends & Chat**.

## Features

All features can be switched on and off in Millennium → Plugins → Better Friends Chat.

- **Friends & Chat as a flyout** – the friends list opens right on top of the bottom bar, above the “Friends & Chat” button, inside the Steam window instead of in a separate window. It lies on top of every page, store and community pages included. Click the button again, press Esc or click elsewhere to close it. With docked chats, conversations open to the left of the list. Width, chat width and height are adjustable.
- **New messages on the “Friends & Chat” button** – a small glowing yellow dot on the button shows that a chat has new messages (from friends, or group chat messages Steam notifies about, such as mentions). Clicking the button then opens the friends list together with the chat that received the newest message. This also works without the flyout.
- **Sort offline friends by last online** – the “Offline” group starts sorted by when friends were last online instead of alphabetically. The sort button in the list still switches back.
- **Only show the docked chat when a conversation is open** – with “Dock chats to the friends list” enabled, Steam always shows a large empty “Click on a friend or group chat to get started!” area. With this option the friends window (or flyout) stays as narrow as the list and only grows when you open a chat. It shrinks back when you close the last chat.
- **Only show the list of open chats with three or more chats** – Steam shows an arrow next to the chat tabs that lists all open chats as soon as it guesses the tabs do not fit, often with a single chat. With this option the arrow only appears when more than two chats are open.

## Requirements

- [Millennium](https://github.com/SteamClientHomebrew/Millennium) v3.4.0 or newer (developed with v3.5.0)
- Node.js 16+ (to build)

## Building and installing

```sh
npm install        # also generates the Millennium type definitions (.millennium/)
npm run build      # builds the plugin and installs it into the local Millennium installation
```

Then enable **Better Friends Chat** under Millennium → Plugins if Millennium did not already. The patches below only take effect once Steam reloads its UI.

Other scripts:

| Script | Purpose |
| --- | --- |
| `npm run dev` | Rebuild on changes, restart the plugin and reload Steam's UI |
| `npm run typecheck` | Type-check the frontend |
| `npm test` | Check the patches against the Steam client installed on this machine |

With **Write a debug log** enabled (Troubleshooting section of the settings, off by default), the plugin writes `millennium/logs/better-friends-chat.log` in the Steam folder. When the file would grow beyond 1 MB, its older half is dropped.

## How it works

Steam's UI is a React app running in Chromium. The plugin combines two Millennium mechanisms:

1. **Patches** (`backend/patches.lua`): Millennium rewrites Steam's JavaScript while Steam loads it. Eight small patches in Steam's friends UI bundle and one in its shared UI library (`library.js`) call into the plugin:
   1. the initial sort order of the “Offline” group,
   2. whether the friends window renders the chat area,
   3. every request to show the friends list (button, tray menu, `steam://open/friends`, notifications), so the flyout can take over,
   4. access to the two components Steam uses to render the friends list into a web page,
   5. the window container those components use, so Steam never treats the flyout like a separate friends window,
   6. the browser context of the friends list in the flyout, which always belongs to the desktop (not the in-game overlay),
   7. whether the chat tab bar shows the arrow that lists all open chats,
   8. (`library.js`) whether a menu opens as a popup window of its own: menus of the friends list in the flyout (such as the own status) stay inside the flyout,
   9. every update of Steam's unread message counters, for the dot on the button.
2. **Frontend** (`frontend/`): the hooks the patches call, the flyout, the dot for new messages, the window resizing for docked chats and the settings page. Store and community pages are native views that Steam draws on top of its window's own UI, so the flyout is such a view as well (the way Steam shows its notification toasts on top of those pages): a page of its own inside the Steam window, which the friends list renders into like into Steam's own friends window, as a portal from Steam's friends UI.

Steam waits for the patched bundle while it starts, so the patterns are kept cheap: plain ASCII character classes and no wide wildcards. The patch list must also stay small: before Steam starts its browser process, Millennium (v3.5) writes the patch lists of all plugins into a pipe with a 4 KB buffer that nothing reads yet, and a longer list keeps Steam from starting at all (only on a cold start, restarting the plugin works). `npm test` enforces both, keeps the list below 3500 bytes and checks every patch against the installed Steam client. If a patch stops matching after a Steam update, the affected feature falls back to Steam's normal behaviour.

## Limitations

- The flyout uses Steam's friends list as is, including its own header and settings. Only the button that collapses the list into the docked chat is hidden.
- Being a native view, the flyout has no drop shadow or opening animation.
- When the first docked chat opens, the flyout grows to the left. For about two frames, until Steam has drawn the new size, the friends list briefly shows at the left edge of the flyout. The flyout makes room before Steam renders the chat, which keeps this as short as possible.
- The flyout is only used by the desktop client; the in-game overlay and Big Picture mode keep Steam's behaviour.
- Undocumented Steam internals can change with any Steam update.

## License

[MIT](LICENSE)
