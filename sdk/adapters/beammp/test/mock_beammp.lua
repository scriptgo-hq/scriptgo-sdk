-- MOCK of the BeamMP-Server Lua API, for unit tests only. It is NOT BeamMP and a run on it never
-- counts as a verification: `scriptgo verify --env beammp` runs the real BeamMP-Server.
--
-- It reproduces what the plugin relies on, as read in BeamMP-Server v3.9.3 (src/TLuaEngine.cpp,
-- src/LuaAPI.cpp, src/TServer.cpp, src/TConsole.cpp):
--   - handlers are registered by global function NAME (MP.RegisterEvent(event, "FnName"));
--   - MP.CreateEventTimer(event, ms) triggers `event` with no arguments every `ms`;
--   - player ids start at 0; MP.GetPlayers() maps id -> name; identifiers carry beammp/ip;
--   - onChatMessage handlers return 1 to stop the broadcast; onConsoleInput handlers return text;
--   - a client can trigger any non-reserved server event by name, with (playerId, data);
--   - MP.CreateTimer() measures seconds since its creation or its last Start();
--   - FS.* lists one level and returns names, FS.CreateDirectory creates parents.
-- Time is simulated: mock.advance(ms) moves the clock and fires due timers.
local M = { now = 0, timers = {}, events = {}, players = {}, chat = {}, notifications = {}, clientEvents = {}, logs = {}, exited = false }
local isWindows = package.config:sub(1, 1) == "\\"

local function native(p) return isWindows and tostring(p):gsub("/", "\\") or tostring(p) end
local function q(p) return '"' .. native(p) .. '"' end
local function run(cmd)
    local r1, _, r3 = os.execute(cmd)
    if type(r1) == "number" then return r1 == 0 end -- Lua 5.1
    return r1 == true and (r3 == nil or r3 == 0)
end
local function lines(cmd)
    local p = io.popen(cmd)
    local out = {}
    if not p then return out end
    for line in p:lines() do
        line = line:gsub("\r$", "")
        if line ~= "" then out[#out + 1] = line end
    end
    p:close()
    return out
end

function M.exists(path)
    if isWindows then return run("if exist " .. q(path) .. " (exit 0) else (exit 1)") end
    return run("test -e '" .. path .. "'")
end

FS = {
    Exists = function(p) return M.exists(p) end,
    CreateDirectory = function(p)
        if M.exists(p) then return true, "" end
        local ok = isWindows and run("mkdir " .. q(p) .. " >NUL 2>NUL") or run("mkdir -p '" .. p .. "'")
        return ok, ok and "" or "mkdir failed"
    end,
    ListFiles = function(p)
        if not M.exists(p) then return nil end
        return isWindows and lines("dir /b /a-d " .. q(p) .. " 2>NUL")
            or lines("find '" .. p .. "' -mindepth 1 -maxdepth 1 -type f -exec basename {} \\; 2>/dev/null")
    end,
    ListDirectories = function(p)
        if not M.exists(p) then return nil end
        return isWindows and lines("dir /b /ad " .. q(p) .. " 2>NUL")
            or lines("find '" .. p .. "' -mindepth 1 -maxdepth 1 -type d -exec basename {} \\; 2>/dev/null")
    end,
    -- std::filesystem::rename replaces an existing target.
    Rename = function(a, b)
        os.remove(b)
        local ok, err = os.rename(a, b)
        return ok and true or false, err or ""
    end,
    Remove = function(p)
        local ok, err = os.remove(p)
        return ok and true or false, err or ""
    end,
}

local function log(level, ...)
    local parts = {}
    for i = 1, select("#", ...) do parts[#parts + 1] = tostring((select(i, ...))) end
    M.logs[#M.logs + 1] = { level = level, text = table.concat(parts, "\t") }
end

Util = {
    LogDebug = function(...) log("DEBUG", ...) end,
    LogInfo = function(...) log("INFO", ...) end,
    LogWarn = function(...) log("WARN", ...) end,
    LogError = function(...) log("ERROR", ...) end,
}

MP = {
    Settings = { Debug = 0, Private = 1, MaxCars = 2, MaxPlayers = 3, Map = 4, Name = 5, Description = 6, InformationPacket = 7 },
    CallStrategy = { BestEffort = 0, Precise = 1 },
    GetOSName = function() return isWindows and "Windows" or "Linux" end,
    GetServerVersion = function() return 3, 9, 3 end,
    CreateTimer = function()
        local t = { started = M.now }
        function t:GetCurrent() return (M.now - self.started) / 1000 end
        function t:Start() self.started = M.now end
        return t
    end,
    RegisterEvent = function(event, fnName)
        M.events[event] = M.events[event] or {}
        M.events[event][fnName] = true
    end,
    CreateEventTimer = function(event, ms) M.timers[#M.timers + 1] = { event = event, ms = ms, due = M.now + ms } end,
    CancelEventTimer = function(event)
        for i = #M.timers, 1, -1 do if M.timers[i].event == event then table.remove(M.timers, i) end end
    end,
    GetPlayers = function()
        local t = {}
        for id, p in pairs(M.players) do t[id] = p.name end
        return t
    end,
    GetPlayerCount = function()
        local n = 0
        for _ in pairs(M.players) do n = n + 1 end
        return n
    end,
    GetPlayerName = function(id)
        local p = M.players[id]
        return p and p.name or ""
    end,
    GetPlayerIdentifiers = function(id)
        local p = M.players[id]
        return p and p.identifiers or nil
    end,
    IsPlayerGuest = function(id)
        local p = M.players[id]
        return p and p.guest or false
    end,
    SendChatMessage = function(id, message) M.chat[#M.chat + 1] = { id = id, message = message } end,
    SendNotification = function(id, message) M.notifications[#M.notifications + 1] = { id = id, message = message } end,
    TriggerClientEvent = function(id, name, data) M.clientEvents[#M.clientEvents + 1] = { id = id, name = name, data = data } return true end,
}

function exit() M.exited = true end

-- Calls every handler of `event` (by global name), returns their results in a list.
function M.trigger(event, ...)
    local out = {}
    local names = {}
    for name in pairs(M.events[event] or {}) do names[#names + 1] = name end
    table.sort(names)
    for _, name in ipairs(names) do
        local fn = rawget(_G, name)
        if type(fn) == "function" then out[#out + 1] = fn(...) end
    end
    return out
end

-- Advances the simulated clock in 5 ms steps, firing due timers (no arguments, like BeamMP).
function M.advance(ms)
    local target = M.now + ms
    while M.now < target do
        M.now = math.min(target, M.now + 5)
        for _, t in ipairs(M.timers) do
            if M.now >= t.due then
                t.due = M.now + t.ms
                M.trigger(t.event)
            end
        end
    end
end

-- Player lifecycle, as the server reports it to plugins.
function M.join(id, name, opts)
    opts = opts or {}
    M.players[id] = { name = name, guest = opts.guest or false, identifiers = opts.identifiers }
    M.trigger("onPlayerJoin", id)
end

function M.leave(id)
    M.trigger("onPlayerDisconnect", id)
    M.players[id] = nil
end

return M
