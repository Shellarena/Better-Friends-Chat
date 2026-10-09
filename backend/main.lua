local logger     = require("logger")
local millennium = require("millennium")
local fs         = require("fs")
local patches    = require("patches")

-- Used when the "debugLogging" setting was never changed.
local DEBUG_LOG_DEFAULT = false
-- When the debug log would grow beyond this, its older half is dropped.
local DEBUG_LOG_MAX_BYTES = 1024 * 1024
-- Start of a log entry ("\n2026-10-09 16:54:38 ["). Entries can span several lines.
local ENTRY_START = "\n%d%d%d%d%-%d%d%-%d%d %d%d:%d%d:%d%d %["
-- frontend_log can be called by any script in Steam's JS context, not only by this
-- plugin's frontend: it only accepts these levels and keeps at most this much of a message.
local LOG_LEVELS = { info = true, warn = true, error = true }
local MAX_MESSAGE_BYTES = 6 * 1024
local TRUNCATED = " [truncated]"

local debug_log_path = nil

local function debug_logging_enabled()
    local ok, value = pcall(millennium.config.get, "debugLogging")
    if ok and type(value) == "boolean" then
        return value
    end
    return DEBUG_LOG_DEFAULT
end

local function log_level(level)
    return LOG_LEVELS[level] and level or "info"
end

--- Shortens a message to MAX_MESSAGE_BYTES (marker included) without splitting a UTF-8 character.
local function limit_message(message)
    if #message <= MAX_MESSAGE_BYTES then
        return message
    end
    local cut = MAX_MESSAGE_BYTES - #TRUNCATED
    -- Byte cut + 1 is the first one dropped: back up while it continues a character.
    while cut > 0 do
        local byte = message:byte(cut + 1)
        if byte < 0x80 or byte >= 0xC0 then
            break
        end
        cut = cut - 1
    end
    return message:sub(1, cut) .. TRUNCATED
end

--- Keeps the newer half of the log, starting with a complete entry.
local function trim_debug_log(path)
    local file = io.open(path, "rb")
    if not file then
        return
    end
    local size = file:seek("end") or 0
    file:seek("set", math.max(0, size - DEBUG_LOG_MAX_BYTES / 2))
    local tail = file:read("*a") or ""
    file:close()
    local start = tail:find(ENTRY_START)
    tail = start and tail:sub(start + 1) or ""
    file = io.open(path, "wb")
    if file then
        file:write(tail)
        file:close()
    end
end

local function append_debug_log(path, entry)
    local file = io.open(path, "ab")
    if not file then
        return
    end
    local size = file:seek("end") or 0
    if size + #entry > DEBUG_LOG_MAX_BYTES then
        file:close()
        trim_debug_log(path)
        file = io.open(path, "ab")
        if not file then
            return
        end
    end
    file:write(entry)
    file:close()
end

local function write_debug_log(level, text)
    if not debug_logging_enabled() then
        return
    end
    if not debug_log_path then
        local dir = millennium.get_install_path() .. "/logs"
        fs.create_directories(dir)
        debug_log_path = dir .. "/better-friends-chat.log"
    end
    append_debug_log(debug_log_path, os.date("%Y-%m-%d %H:%M:%S") .. " [" .. level .. "] " .. text .. "\n")
end

---@ffi
--- Writes a message from the frontend to the plugin log (Millennium's log viewer and,
--- with the "debugLogging" setting, logs/better-friends-chat.log).
---@param level string "info", "warn" or "error" (anything else counts as "info")
---@param message string at most 6 KB are kept
---@return boolean
function frontend_log(level, message)
    level = log_level(level)
    local text = "[frontend] " .. limit_message(tostring(message))
    if level == "error" then
        logger:error(text)
    elseif level == "warn" then
        logger:warn(text)
    else
        logger:info(text)
    end
    write_debug_log(level, text)
    return true
end

local function on_load()
    local text = "Better Friends Chat loaded (Millennium " .. millennium.version() .. ")"
    logger:info(text)
    write_debug_log("info", text)
    millennium.ready()
end

local function on_unload()
    logger:info("Better Friends Chat unloaded")
    write_debug_log("info", "Better Friends Chat unloaded")
end

local function on_frontend_loaded()
    logger:info("Steam UI loaded")
    write_debug_log("info", "Steam UI loaded")
end

return {
    on_load = on_load,
    on_unload = on_unload,
    on_frontend_loaded = on_frontend_loaded,
    patches = patches.get(),
}
