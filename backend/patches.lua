-- Patches for Steam's UI bundle (sp.js), which holds the friends UI and the shared UI
-- library. (Until Steam's update of October 2026 they were chunk~<hash>.js and
-- library.js; a definition can still name another `file`.) Millennium applies them
-- while Steam serves the file, so the patched code is in place before it runs.
--
-- Every injected call goes through @HOOKS@, the `bfcHooks` object the plugin frontend
-- puts on window. The optional chaining keeps Steam's original behaviour whenever the
-- frontend is not loaded (yet) or the hook returns nothing.
--
-- Regex syntax is Rust's `regex` crate. The bundle is ~16 MB and Steam waits for it,
-- so patterns must stay cheap: @ID@ (a minified identifier) is an ASCII class, never
-- \w (Unicode-aware and very slow on large inputs), and no pattern spans arbitrary
-- text with .* or large counted repetitions.
--
-- The patch list must also stay small. Before Steam starts its browser process,
-- Millennium (v3.5) writes the patch lists of all plugins into a pipe with a 4 KB
-- buffer that nothing reads yet: a longer list blocks Steam's start for good (only a
-- cold start, a plugin restart is fine). So a `find` is only as long as it needs to be
-- unique, and spans between landmarks use classes like [^;]* instead of spelling out
-- the code. tests/patches.test.mjs enforces all of this and checks every patch against
-- the installed Steam client.
--
-- Replacements: Millennium turns "\1" into "$1", and Rust reads "$1abc" as the group
-- named "1abc", so a backreference must never be followed by [A-Za-z0-9_].

local HOOKS = "window.__bfcHooks"
local ID = "[A-Za-z0-9_$]+"
local UI_FILE = [==[sp\.js]==]

local definitions = {
    -- 1) Start the "Offline" friends group sorted by "last online".
    --    Steam hardcodes the initial state of the friend group component to
    --    alphabetical (bSortOfflineByRecent: false); the sort button keeps working.
    --    The group is passed along so a changed setting can apply right away.
    {
        find = [==[bLocalCollapsed:this\.props\.collapsed,bSortOfflineByRecent:!1\}]==],
        transforms = {
            {
                match = [==[bSortOfflineByRecent:!1]==],
                replace = [==[bSortOfflineByRecent:!!@HOOKS@?.SortOfflineByRecent?.(this)]==],
            },
        },
    },

    -- 2) Docked chats: let the plugin hide the empty chat area.
    --    In the render method of the friends list window, `t` decides whether the
    --    chat area (the tab set with "Click on a friend or group chat to get
    --    started!") is rendered next to the friends list.
    {
        find = [==[BIsFriendsListSingleWindow\(this\.m_browserContext\),[^;]*;if\(!@ID@\)if\(this\.m_ResponsiveWindowState\)\{[^}]*\}else @ID@=!1;]==],
        transforms = {
            {
                match = [==[\}else (@ID@)=!1;$]==],
                replace = [==[}else \1=!1;@HOOKS@?.OnFriendsListRender?.(this)&&(\1=!1);]==],
            },
        },
    },

    -- 3) Every way of opening the friends list (bottom bar button, tray menu,
    --    steam://open/friends, notifications, ...) ends up here. The plugin can
    --    take over and open the flyout instead of the separate window.
    {
        find = [==[ShowPopupFriendsList\([^)]*\)\{if\(this\.m_FriendsUIApp\.ParentalStore\.BIsFriendsBlocked\(\)]==],
        transforms = {
            {
                match = [==[^ShowPopupFriendsList\(([^)]*)\)\{]==],
                replace = [==[ShowPopupFriendsList(\1){if(@HOOKS@?.ShowFriendsList?.(this,\1))return;]==],
            },
        },
    },

    -- 4) Expose the components the flyout renders.
    --    Steam's web chat renders the whole friends list into a page element with a
    --    function that references the owner window provider and the "embedded friends
    --    list". Called with "bfc-components" it now returns those two, and the plugin
    --    renders them like Steam renders its friends windows: as a portal from the
    --    existing friends UI tree. (The function itself is not usable here: it creates
    --    a second React root that re-initializes global caches.)
    {
        find = [==[\{const @ID@=window,[^;]*;\(0,@ID@\.createRoot\)[^{]*\{children:[^{]*\{ownerWindow:[^\[]*\[[^\]]*\{friends:]==],
        transforms = {
            {
                match = [==[^\{(const [^;]*;[^{]*\{children:\(0,@ID@\.jsxs\)\((@ID@),\{ownerWindow:[^\[]*\[[^\]]*\((@ID@),\{friends:)$]==],
                replace = [==[{if(arguments[0]==="bfc-components")return{OwnerWindow:\2,EmbeddedFriendsList:\3};\1]==],
            },
        },
    },

    -- 5) The embedded friends list takes its window container from the plugin, so
    --    Steam never treats the flyout like a separate friends window (title,
    --    resize, close). The frontend only uses #4 when this patch is present too.
    {
        find = [==[\.useState\(\(\)=>new @ID@\.@ID@\(@ID@\.ownerDocument\.defaultView\)\)]==],
        transforms = {
            {
                match = [==[\(\)=>new (@ID@\.@ID@)\((@ID@)\.ownerDocument\.defaultView\)\)$]==],
                replace = [==[()=>@HOOKS@?.CreateEmbeddedContainer?.(\2)||new \1(\2.ownerDocument.defaultView))]==],
            },
        },
    },

    -- 6) Without a popup, the friends list window falls back to Steam's default
    --    browser context, which is the in-game overlay while a game runs. The flyout
    --    always belongs to the desktop. The frontend only uses #4 when this patch is
    --    present too.
    {
        find = [==[browser_info:@ID@\.@ID@\.GetDefaultBrowserContext\(\);]==],
        transforms = {
            {
                match = [==[:(@ID@\.@ID@\.GetDefaultBrowserContext\(\));$]==],
                replace = [==[:@HOOKS@?.FriendsListContext?.(this)||\1;]==],
            },
        },
    },

    -- 7) The arrow next to the chat tabs that lists all open chats. Steam shows it
    --    whenever 180px per tab (+168px) exceed the width of the tab bar, often with a
    --    single chat. The plugin can decide instead; undefined keeps Steam's rule.
    {
        find = [==[=this\.m_elchatTabDiv&&[^,]*clientWidth\|\|!1,]==],
        transforms = {
            {
                match = [==[=(this\.m_elchatTabDiv&&[^,]*\|\|!1),$]==],
                replace = [==[=@HOOKS@?.ShowChatTabSelector?.(this)??(\1),]==],
            },
        },
    },

    -- 8) Menus of the friends list in the flyout (e.g. the own status: Online, Away,
    --    Invisible, ...) open inside the flyout. Steam turns a menu into a popup
    --    window of its own when the page it belongs to is narrower than 400px, which
    --    the flyout's page usually is, and such popups did not show up from the
    --    flyout's view. The plugin can keep the menu in the page instead.
    {
        find = [==[\.innerWidth<400\|\|@ID@\?\.BOnlyPopups\(\)\)&&!!@ID@\.SteamClient\?\.Window\)]==],
        transforms = {
            {
                match = [==[&&!!(@ID@)\.SteamClient\?\.Window\)$]==],
                replace = [==[&&!!\1.SteamClient?.Window&&!@HOOKS@?.InlineMenus?.(\1))]==],
            },
        },
    },

    -- 9) Steam updates its unread message counters (and the badge of its taskbar
    --    icon) here whenever a chat gets new messages or is read. The plugin shows
    --    a dot on the "Friends & Chat" button for them.
    {
        find = [==[UpdateUnreadMessagesGlobal\(\)\{]==],
        transforms = {
            {
                match = [==[\{$]==],
                replace = [==[{@HOOKS@?.UnreadMessagesChanged?.();]==],
            },
        },
    },

    -- 10) Steam shows the native views of its windows here (store and community
    --     pages) and puts them in front of the window's other views: when such a page
    --     opens, and again whenever its window comes back from the tray, is restored
    --     or maximized. The open flyout then goes back on top.
    {
        find = [==[return @ID@\(\),@ID@\.SetVisible\(!0\),\(\)=>]==],
        transforms = {
            {
                match = [==[,\(\)=>$]==],
                replace = [==[,@HOOKS@?.ViewShown?.(),()=>]==],
            },
        },
    },
}

local function expand(text, placeholders)
    for name, value in pairs(placeholders) do
        text = text:gsub("@" .. name .. "@", function()
            return value
        end)
    end
    return text
end

local M = {}

function M.get()
    local patches = {}
    for _, definition in ipairs(definitions) do
        local transforms = {}
        for _, transform in ipairs(definition.transforms) do
            transforms[#transforms + 1] = {
                match = expand(transform.match, { ID = ID }),
                replace = expand(transform.replace, { HOOKS = HOOKS }),
            }
        end
        patches[#patches + 1] = {
            file = definition.file or UI_FILE,
            find = expand(definition.find, { ID = ID }),
            transforms = transforms,
        }
    end
    return patches
end

return M
