-- SCRIPT//GO on FiveM: maps the portable `ScriptGo` namespace onto FiveM (FXServer and the
-- FiveM client).
--
-- `scriptgo pack --target fivem` copies this file into the resource as `scriptgo_shim.lua` and
-- lists it as the FIRST shared_script of the generated fxmanifest.lua. FXServer loads every
-- shared_script before the server_script (or client_script) entries, so `ScriptGo` exists before
-- any script of the resource runs, on both sides. One file serves both sides: server-only natives
-- are referenced only inside functions that run when IsDuplicityVersion() is true.
--
-- Everything else is native in FiveM and is not touched: CreateThread, Wait, SetTimeout,
-- AddEventHandler, RegisterNetEvent, TriggerEvent, TriggerServerEvent, TriggerClientEvent,
-- exports, RegisterCommand, GetCurrentResourceName, GetResourceState, GetConvar, promise.new and
-- Citizen.Await.
--
-- Natives and Lua helpers used here were checked on 2026-11-09 against the official sources:
-- citizenfx/fivem ext/native-decls (signatures and apisets) and
-- data/shared/citizen/scripting/lua/scheduler.lua (GetPlayers, PerformHttpRequest, exports).
--
-- Licensing is deliberately absent: FiveM is a free-only environment for SCRIPT//GO. The Rockstar
-- Games Creator Platform License Agreement (2026-09-10, §3.1(6)) forbids a third-party
-- marketplace that sells or licenses other creators' server content to server admins, so
-- ScriptGo.licensing raises capability_unavailable:licensing@fivem here.
--
-- Written for Lua 5.4 (FiveM's runtime) and kept loadable by Lua 5.1 and LuaJIT, so the unit
-- tests (sdk/lua/spec/fivem_shim_spec.lua) run on every interpreter the SDK is tested with.
if rawget(_G, "ScriptGo") ~= nil then return end

local ADAPTER_VERSION = "fivem-shim-0.1.0"
local ENVIRONMENT = "fivem"

local isServer = IsDuplicityVersion() == true
local side = isServer and "server" or "client"
local resourceName = GetCurrentResourceName()
-- FiveM's Lua runtime provides `json` (rapidjson) on both sides.
local J = rawget(_G, "json")
local unpackArgs = rawget(table, "unpack") or rawget(_G, "unpack")

local ALL = { "events", "logging", "storage", "players", "permissions", "commands", "config", "ui", "http", "licensing" }

-- What this side of a FiveM resource can call. players, permissions, config and http are server
-- side, as on every SCRIPT//GO host; ui is a chat message on both sides; licensing is never on.
local CAPS = {
    events = true, logging = true, storage = true, commands = true, ui = true,
    players = isServer, permissions = isServer, config = isServer, http = isServer,
    licensing = false,
}

local function unavailable(cap)
    return "capability_unavailable:" .. cap .. "@" .. ENVIRONMENT
end

local function refuse(cap)
    return function() error(unavailable(cap), 2) end
end

-- Player ids are integers >= 1 (0 is the console). Anything else answers nil/false before it
-- reaches a native.
local function validPlayer(id)
    return type(id) == "number" and id >= 1 and id == math.floor(id)
end

local function inThread(what)
    -- Lua 5.1 answers nil on the main thread; 5.2+ answers the main coroutine and true.
    local co, isMain = coroutine.running()
    if co == nil or isMain then
        error(what .. " must be called from a thread (CreateThread, an event handler, an export or a command)", 3)
    end
end

local SG = {}

-- print() goes to the server console (channel `script:<resource>`) or the client F8 console.
local function logger(level)
    return function(message) print(("[%s] %s"):format(level, tostring(message))) end
end
SG.log = { debug = logger("debug"), info = logger("info"), warn = logger("warn"), error = logger("error") }

SG.json = {
    encode = function(v) return J.encode(v) end,
    decode = function(s) return J.decode(s) end,
    null = rawget(J, "null"),
}

SG.time = {
    -- GetGameTimer: milliseconds since start; a CFX server native and a game native on the client.
    monotonic = function() return GetGameTimer() / 1000 end,
    -- FXServer's Lua has `os` (time, clock, date...); the FiveM client's has none, so the client
    -- answers nil, as an OPEN//77 client does.
    now = function()
        local os = rawget(_G, "os")
        if isServer and os and os.time then return os.time() end
        return nil
    end,
}

SG.runtime = {
    version = function() return "0.1.0" end,
    luaVersion = function() return _VERSION end,
    environment = function() return ENVIRONMENT end,
    side = function() return side end,
    adapterVersion = function() return ADAPTER_VERSION end,
}

-- `scriptgo pack` writes the manifest's permissions as `scriptgo_permission "<p>"` metadata
-- entries in fxmanifest.lua (FiveM keeps unknown manifest keys as metadata).
local function declaredPermissions()
    local out = {}
    local n = GetNumResourceMetadata(resourceName, "scriptgo_permission") or 0
    for i = 0, n - 1 do out[#out + 1] = GetResourceMetadata(resourceName, "scriptgo_permission", i) end
    return out
end

SG.resource = {
    name = function() return resourceName end,
    version = function() return GetResourceMetadata(resourceName, "version", 0) end,
    state = function(other) return GetResourceState(other or resourceName) end,
    hasPermission = function(p)
        for _, x in ipairs(declaredPermissions()) do if x == p then return true end end
        return false
    end,
    -- On the client, only files listed in `files` of the manifest can be read.
    readFile = function(path)
        if type(path) ~= "string" or path == "" or path:find("..", 1, true) or path:find("^[/\\]") or path:find("^%a:") then
            return nil, "invalid_path"
        end
        local text = LoadResourceFile(resourceName, path)
        if text == nil then return nil, "not_found" end
        return text
    end,
}

SG.events = { on = AddEventHandler, off = RemoveEventHandler, emit = TriggerEvent }
SG.net = {
    on = RegisterNetEvent, register = RegisterNetEvent,
    emitServer = function(...) return TriggerServerEvent(...) end,
    emitClient = function(...) return TriggerClientEvent(...) end,
}

-- ScriptGo.exports.call(resource, name, ...) -> promise, or nil, reason. FiveM's exports are
-- synchronous calls through a function reference, so the promise is settled when it is returned;
-- await() gives the values, or nil, reason, like on every SCRIPT//GO host.
local function settled(ok, values, reason)
    local p = { state = ok and "resolved" or "rejected", values = values, reason = reason }
    function p.await()
        if p.state == "resolved" then return unpackArgs(p.values, 1, p.values.n) end
        return nil, p.reason
    end
    function p.status() return p.state end
    function p.isSettled() return true end
    function p.next(_, onResolved, onRejected)
        if p.state == "resolved" then
            if onResolved then onResolved(unpackArgs(p.values, 1, p.values.n)) end
        elseif onRejected then
            onRejected(p.reason)
        end
    end
    return p
end

local function pack(...) return { n = select("#", ...), ... } end

SG.exports = {
    call = function(target, name, ...)
        if type(target) ~= "string" or type(name) ~= "string" then return nil, "invalid_export_name" end
        if GetResourceState(target) ~= "started" then return nil, "export_resource_unavailable" end
        local args = pack(...)
        local result = pack(pcall(function()
            local proxy = exports[target]
            local fn = proxy[name] -- FiveM raises "No such export <name> in resource <target>"
            return fn(proxy, unpackArgs(args, 1, args.n))
        end))
        if not result[1] then
            local message = tostring(result[2])
            if message:find("No such export", 1, true) then return nil, "export_not_found" end
            return settled(false, nil, "export_failed: " .. message)
        end
        local values = { n = result.n - 1 }
        for i = 2, result.n do values[i - 1] = result[i] end
        return settled(true, values, nil)
    end,
}

SG.capabilities = {
    has = function(c) return CAPS[c] == true end,
    list = function()
        local out = {}
        for _, c in ipairs(ALL) do if CAPS[c] then out[#out + 1] = c end end
        return out
    end,
    require = function(c) if not CAPS[c] then error(unavailable(c), 2) end end,
}

-- Storage: the resource KVP store (per resource; on the client, per server and resource). KVP
-- keeps strings, so each value is stored as its JSON text.
SG.storage = {
    get = function(key)
        local text = GetResourceKvpString(tostring(key))
        if type(text) ~= "string" then return nil end
        local ok, value = pcall(J.decode, text)
        if ok then return value end
        return nil
    end,
    set = function(key, value)
        if type(value) == "function" or type(value) == "thread" or type(value) == "userdata" then
            return false, "value_not_serializable"
        end
        local ok, text = pcall(J.encode, value)
        if not ok or type(text) ~= "string" then return false, "value_not_serializable" end
        SetResourceKvp(tostring(key), text)
        return true
    end,
    delete = function(key)
        DeleteResourceKvp(tostring(key))
        return true
    end,
    keys = function(prefix)
        local out = {}
        local handle = StartFindKvp(prefix ~= nil and tostring(prefix) or "")
        if handle == nil or handle == -1 then return out end
        while true do
            local key = FindKvp(handle)
            if key == nil then break end
            out[#out + 1] = key
        end
        EndFindKvp(handle)
        table.sort(out)
        return out
    end,
}

-- Chat: the `chat` resource (a system resource of FXServer) handles `chat:addMessage` on the
-- client, with `{ args = { author, text }, color = { r, g, b } }`.
local COLORS = {
    info = { 120, 180, 255 }, success = { 90, 200, 120 }, warning = { 255, 190, 60 }, error = { 230, 80, 80 },
}

local function chatMessage(payload)
    local kind = type(payload.type) == "string" and payload.type or "info"
    local title = payload.title ~= nil and tostring(payload.title) or kind
    return {
        color = COLORS[kind] or COLORS.info,
        multiline = true,
        args = { title, payload.message ~= nil and tostring(payload.message) or "" },
    }
end

if isServer then
    SG.players = {
        -- GetPlayers() answers the ids as strings (scheduler.lua); SCRIPT//GO uses integers.
        list = function()
            local out = {}
            for _, id in ipairs(GetPlayers()) do
                local n = tonumber(id)
                if n then out[#out + 1] = n end
            end
            table.sort(out)
            return out
        end,
        name = function(id)
            if not validPlayer(id) then return nil end
            return GetPlayerName(tostring(id))
        end,
        exists = function(id)
            if not validPlayer(id) then return false end
            for _, other in ipairs(GetPlayers()) do
                if tonumber(other) == id then return true end
            end
            return false
        end,
        -- The `license:` identifier (the player's Cfx.re account), else the first one FiveM has.
        identifier = function(id)
            if not validPlayer(id) then return nil end
            local src = tostring(id)
            local license = GetPlayerIdentifierByType(src, "license")
            if license ~= nil and license ~= "" then return license end
            local all = GetPlayerIdentifiers(src)
            return all and all[1] or nil
        end,
    }

    -- ACE permissions: `add_ace group.admin <privilege> allow` in server.cfg.
    SG.permissions = {
        has = function(playerId, privilege)
            if playerId == 0 then return true end
            if not validPlayer(playerId) or type(privilege) ~= "string" then return false end
            return IsPlayerAceAllowed(tostring(playerId), privilege) == true
        end,
    }

    -- Config: the convar "<resource>:<key>" (`set inventory_pro:max_weight 40` in server.cfg).
    -- JSON text is decoded, numbers and booleans are converted.
    SG.config = {
        get = function(key, default)
            local raw = GetConvar(resourceName .. ":" .. tostring(key), "")
            if raw == nil or raw == "" then return default end
            local first = raw:sub(1, 1)
            if first == "{" or first == "[" then
                local ok, v = pcall(J.decode, raw)
                if ok then return v end
                return default
            end
            if raw == "true" then return true end
            if raw == "false" then return false end
            return tonumber(raw) or raw
        end,
    }

    SG.ui = {
        notify = function(target, payload)
            if type(payload) ~= "table" then return false, "invalid_payload" end
            if target ~= -1 and not validPlayer(target) then return false, "invalid_target" end
            TriggerClientEvent("chat:addMessage", target, chatMessage(payload))
            return true
        end,
    }

    -- HTTP through PerformHttpRequest (server only). Inside a thread, request{ method, url,
    -- headers, body } waits and returns { status, body, headers, error }; status 0 when the
    -- exchange did not complete. FXServer reports a status >= 400 as a failure with the body in
    -- the error text ("HTTP 404: <body>"); it is turned back into an answer here. Redirects are
    -- not followed, as on OPEN//77.
    SG.http = {
        request = function(opts)
            inThread("ScriptGo.http.request")
            if type(opts) ~= "table" or type(opts.url) ~= "string" then return nil, "invalid_request" end
            local p = promise.new()
            PerformHttpRequest(opts.url, function(status, body, headers, errorData)
                status = tonumber(status) or 0
                local errorText = errorData
                if body == nil and status >= 400 and type(errorData) == "string" then
                    local prefix = "HTTP " .. status .. ": "
                    if errorData:sub(1, #prefix) == prefix then body = errorData:sub(#prefix + 1) end
                    errorText = nil
                end
                p:resolve({
                    status = status, body = body or "", headers = headers or {},
                    error = status == 0 and (errorText or "http_failed") or nil,
                })
            end, opts.method or "GET", opts.body or "", opts.headers or {}, { followLocation = false })
            return Citizen.Await(p)
        end,
    }
else
    SG.players = { list = refuse("players"), name = refuse("players"), exists = refuse("players"), identifier = refuse("players") }
    SG.permissions = { has = refuse("permissions") }
    SG.config = { get = refuse("config") }
    SG.http = { request = refuse("http") }
    -- notify(payload) or notify(nil, payload): the local player's chat.
    SG.ui = {
        notify = function(target, payload)
            if payload == nil then payload = target end
            if type(payload) ~= "table" then return false, "invalid_payload" end
            TriggerEvent("chat:addMessage", chatMessage(payload))
            return true
        end,
    }
end

-- Free-only environment: no licensing (see the header).
SG.licensing = { activate = refuse("licensing"), verify = refuse("licensing") }

-- OPEN//77-compatible names for the portable subset, as on every SCRIPT//GO host.
SG.notifications = {
    send = function(target, payload) return SG.ui.notify(target, payload) end,
    broadcast = function(payload) return SG.ui.notify(-1, payload) end,
}

ScriptGo = SG
if rawget(_G, "Open77") == nil then Open77 = SG end
