-- SCRIPT//GO on OPEN//77, shared part: maps the portable `ScriptGo` namespace onto OPEN//77.
--
-- `scriptgo pack --target open77` copies three files into the resource and lists them before the
-- resource's own scripts:
--   shared_script "scriptgo_shim.lua"         this file: everything both sides have
--   server_script "scriptgo_shim_server.lua"  players, permissions, config, server notifications
--   client_script "scriptgo_shim_client.lua"  client notifications
-- Everything else (CreateThread, Wait, events, exports, RegisterCommand, Open77.exports.call,
-- promises) is native in OPEN//77 and is not touched.
--
-- The OPEN//77 sandbox has no `os`, `io`, `debug` or `package`, and the client sandbox has no
-- `setmetatable`: this file uses none of them, and calls no server-only native (the devkit validator
-- checks both). Natives were checked against the devkit catalogue, build 2.50.0+op77.156.
if rawget(_G, "ScriptGo") ~= nil then return end

local isServer = IsDuplicityVersion() == true
local side = isServer and "server" or "client"
local resourceName = GetCurrentResourceName()
local J = rawget(_G, "json") or Open77.json

-- Always present on both sides. Each `@capability` section of the side files switches its own
-- capability on, so `capabilities.has` answers for what this packed resource can really call.
local CAPS = {
    events = true, logging = true, storage = true, commands = true, ui = false,
    players = false, permissions = false, config = false, http = false, licensing = false, perks = false,
}
local ALL = { "events", "logging", "storage", "players", "permissions", "commands", "config", "ui", "http", "licensing", "perks" }

local function unavailable(cap)
    return "capability_unavailable:" .. cap .. "@open77"
end

local function refuse(cap)
    return function() error(unavailable(cap), 2) end
end

local SG = {}

SG.log = {
    debug = function(m) Open77.log.debug(tostring(m)) end,
    info = function(m) Open77.log.info(tostring(m)) end,
    warn = function(m) Open77.log.warn(tostring(m)) end,
    error = function(m) Open77.log.error(tostring(m)) end,
}

SG.json = {
    encode = function(v) return J.encode(v) end,
    decode = function(s) return J.decode(s) end,
}

SG.time = {
    monotonic = function() return Open77.time.monotonic() end,
    -- Wall-clock seconds. The server reads Open77.time.unix (set by scriptgo_shim_server.lua); an
    -- OPEN//77 client has no wall clock, so this stays nil there.
    now = function() return nil end,
}

SG.runtime = {
    version = function() return "0.1.0" end,
    luaVersion = function() return _VERSION end,
    environment = function() return "open77" end,
    side = function() return side end,
    adapterVersion = function() return "open77-shim-0.4.0" end,
}

SG.resource = {
    name = function() return resourceName end,
    state = function(other) return GetResourceState(other or resourceName) end,
}

SG.events = { on = AddEventHandler, off = RemoveEventHandler, emit = TriggerEvent }
SG.net = { on = RegisterNetEvent, register = RegisterNetEvent, emitServer = TriggerServerEvent, emitClient = TriggerClientEvent }
SG.exports = { call = function(...) return Open77.exports.call(...) end }

SG.capabilities = {
    has = function(c) return CAPS[c] == true end,
    list = function()
        local out = {}
        for _, c in ipairs(ALL) do if CAPS[c] then out[#out + 1] = c end end
        return out
    end,
    require = function(c) if not CAPS[c] then error(unavailable(c), 2) end end,
}

-- Storage: OPEN//77 kvp keeps scalars only, so every value is stored as its JSON text. The server
-- kvp is per resource; the client kvp is per server address, resource and key.
SG.storage = {
    get = function(key)
        local text = Open77.kvp.get(tostring(key))
        if type(text) ~= "string" then return nil end
        local ok, value = pcall(J.decode, text)
        if ok then return value end
        return nil
    end,
    set = function(key, value)
        local ok, text = pcall(J.encode, value)
        if not ok then return false, "value_not_serializable" end
        return Open77.kvp.set(tostring(key), text)
    end,
    delete = function(key) return Open77.kvp.delete(tostring(key)) end,
    keys = function(prefix) return Open77.kvp.keys(prefix) or {} end,
}

-- Filled by the side files. Until then (and on the side that lacks them) each call raises
-- capability_unavailable, the same refusal a SCRIPT//GO host gives.
SG.players = { list = refuse("players"), name = refuse("players"), exists = refuse("players"), identifier = refuse("players") }
SG.permissions = { has = refuse("permissions") }
SG.config = { get = refuse("config") }
SG.ui = { notify = refuse("ui") }
SG.http = { request = refuse("http") }
SG.licensing = { activate = refuse("licensing"), verify = refuse("licensing") }
SG.perks = {
    has = refuse("perks"), list = refuse("perks"), refresh = refuse("perks"), purchaseLink = refuse("perks"),
    catalog = refuse("perks"), on = refuse("perks"), off = refuse("perks"), status = refuse("perks"),
}

-- For the side files only.
SG._open77 = {
    caps = CAPS,
    unavailable = unavailable,
    json = J,
    validPlayer = function(id) return type(id) == "number" and id >= 1 and id == math.floor(id) end,
    toNotification = function(payload)
        return {
            type = payload.type or "info", title = payload.title, message = payload.message,
            durationMs = payload.durationMs, icon = payload.icon,
        }
    end,
}

ScriptGo = SG
