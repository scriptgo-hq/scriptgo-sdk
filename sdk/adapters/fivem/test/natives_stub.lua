-- A STUB of the FiveM natives the SCRIPT//GO shim calls, for unit tests only.
--
-- This is NOT FiveM and proves nothing about the real runtime: it records how the shim calls each
-- native and answers the way the official declarations say the native answers (citizenfx/fivem
-- ext/native-decls and data/shared/citizen/scripting/lua/scheduler.lua, read on 2026-11-09).
-- Only a run on a real FXServer (`scriptgo verify --env fivem`) counts as evidence.
--
--   local stub = dofile("sdk/adapters/fivem/test/natives_stub.lua")
--   local world = stub.new({ json = scriptgo.json, server = true, resource = "res_a", ... })
--   world.load(shimText)          -- runs the shim in the stub's global table
--   world.env.ScriptGo            -- the namespace the shim built
--   world.run(fn)                 -- runs fn in a coroutine, as CreateThread would
local M = {}

local unpackArgs = rawget(table, "unpack") or rawget(_G, "unpack")

local function loadIn(text, name, env)
    if rawget(_G, "setfenv") then
        local fn, err = loadstring(text, name)
        if not fn then error(err, 2) end
        setfenv(fn, env)
        return fn
    end
    local fn, err = load(text, name, "t", env)
    if not fn then error(err, 2) end
    return fn
end

-- opts: json (encode/decode/null), server (default true), resource, convars, players
-- ({ ["1"] = { name, identifiers = { "license:..." } } }), aces ({ ["1|perm"] = true }),
-- metadata ({ version = { "1.0.0" }, scriptgo_permission = { ... } }), files, resources
-- ({ other = { state = "started", exports = { name = fn } } }), http (fn(url, method, data, headers,
-- options) -> status, body, headers, errorData), clock (GetGameTimer value), osTime.
function M.new(opts)
    opts = opts or {}
    local server = opts.server ~= false
    local own = opts.resource or "stub_res"
    local w = {
        calls = {}, kvp = {}, printed = {}, finds = {}, openFinds = 0,
        clock = opts.clock or 4200,
    }

    local function record(name, ...)
        w.calls[#w.calls + 1] = { name = name, args = { n = select("#", ...), ... } }
    end

    -- Every call of a native, in order; `w.called(name)` answers the list for one native.
    function w.called(name)
        local out = {}
        for _, c in ipairs(w.calls) do if c.name == name then out[#out + 1] = c.args end end
        return out
    end

    local env = {
        assert = assert, error = error, ipairs = ipairs, next = next, pairs = pairs, pcall = pcall,
        rawequal = rawequal, rawget = rawget, rawset = rawset, select = select, setmetatable = setmetatable,
        getmetatable = getmetatable, tonumber = tonumber, tostring = tostring, type = type, unpack = rawget(_G, "unpack"),
        _VERSION = "Lua 5.4", string = string, table = table, math = math, coroutine = coroutine,
    }
    env._G = env
    env.json = { encode = opts.json.encode, decode = opts.json.decode, null = opts.json.null }
    if server then env.os = { time = function() return opts.osTime or 1800000000 end } end

    env.print = function(...)
        local parts = {}
        for i = 1, select("#", ...) do parts[i] = tostring((select(i, ...))) end
        w.printed[#w.printed + 1] = table.concat(parts, "\t")
    end

    -- shared: IS_DUPLICITY_VERSION, GET_CURRENT_RESOURCE_NAME, GET_RESOURCE_STATE
    env.IsDuplicityVersion = function() return server end
    env.GetCurrentResourceName = function() return own end
    env.GetResourceState = function(name)
        record("GetResourceState", name)
        if name == own then return "started" end
        local r = opts.resources and opts.resources[name]
        return r and (r.state or "started") or "missing"
    end

    -- shared: GET_NUM_RESOURCE_METADATA, GET_RESOURCE_METADATA, LOAD_RESOURCE_FILE
    local metadata = opts.metadata or {}
    env.GetNumResourceMetadata = function(res, key)
        record("GetNumResourceMetadata", res, key)
        return res == own and metadata[key] and #metadata[key] or 0
    end
    env.GetResourceMetadata = function(res, key, index)
        record("GetResourceMetadata", res, key, index)
        local list = res == own and metadata[key]
        return list and list[index + 1] or nil
    end
    env.LoadResourceFile = function(res, path)
        record("LoadResourceFile", res, path)
        return res == own and opts.files and opts.files[path] or nil
    end

    -- shared: GET_CONVAR(varName, default_)
    env.GetConvar = function(name, default)
        record("GetConvar", name, default)
        local v = opts.convars and opts.convars[name]
        if v == nil then return default end
        return v
    end

    -- shared: GET_RESOURCE_KVP_STRING, SET_RESOURCE_KVP, DELETE_RESOURCE_KVP, START_FIND_KVP,
    -- FIND_KVP, END_FIND_KVP. Values are strings; a missing key answers nil.
    env.GetResourceKvpString = function(key)
        record("GetResourceKvpString", key)
        return w.kvp[key]
    end
    env.SetResourceKvp = function(key, value)
        record("SetResourceKvp", key, value)
        assert(type(key) == "string" and type(value) == "string", "stub: SET_RESOURCE_KVP takes (char*, char*)")
        w.kvp[key] = value
    end
    env.DeleteResourceKvp = function(key)
        record("DeleteResourceKvp", key)
        w.kvp[key] = nil
    end
    env.StartFindKvp = function(prefix)
        record("StartFindKvp", prefix)
        local keys = {}
        for k in pairs(w.kvp) do if k:sub(1, #prefix) == prefix then keys[#keys + 1] = k end end
        if #keys == 0 then return -1 end
        -- Unsorted on purpose: the shim sorts.
        table.sort(keys, function(a, b) return a > b end)
        w.finds[#w.finds + 1] = { keys = keys, i = 0 }
        w.openFinds = w.openFinds + 1
        return #w.finds
    end
    env.FindKvp = function(handle)
        local f = w.finds[handle]
        f.i = f.i + 1
        return f.keys[f.i]
    end
    env.EndFindKvp = function(handle)
        record("EndFindKvp", handle)
        w.openFinds = w.openFinds - 1
    end

    -- server: GET_GAME_TIMER (a game native of the same name on the client)
    env.GetGameTimer = function() return w.clock end

    -- server: GetPlayers() (scheduler.lua: ids as strings), GET_PLAYER_NAME(char* playerSrc),
    -- GET_PLAYER_IDENTIFIER_BY_TYPE(char*, char*), GetPlayerIdentifiers (scheduler.lua),
    -- IS_PLAYER_ACE_ALLOWED(char* playerSrc, char* object)
    local players = opts.players or {}
    local function src(name, value)
        assert(type(value) == "string", "stub: " .. name .. " takes a char* playerSrc, got " .. type(value))
        return value
    end
    if server then
        env.GetPlayers = function()
            record("GetPlayers")
            local out = {}
            for id in pairs(players) do out[#out + 1] = id end
            table.sort(out, function(a, b) return a > b end)
            return out
        end
        env.GetPlayerName = function(s)
            record("GetPlayerName", s)
            local p = players[src("GetPlayerName", s)]
            return p and p.name or nil
        end
        env.GetPlayerIdentifierByType = function(s, kind)
            record("GetPlayerIdentifierByType", s, kind)
            local p = players[src("GetPlayerIdentifierByType", s)]
            for _, ident in ipairs(p and p.identifiers or {}) do
                if ident:sub(1, #kind + 1) == kind .. ":" then return ident end
            end
            return nil
        end
        env.GetPlayerIdentifiers = function(s)
            record("GetPlayerIdentifiers", s)
            local p = players[src("GetPlayerIdentifiers", s)]
            return p and p.identifiers or {}
        end
        env.IsPlayerAceAllowed = function(s, object)
            record("IsPlayerAceAllowed", s, object)
            return (opts.aces or {})[src("IsPlayerAceAllowed", s) .. "|" .. object] == true
        end
        env.TriggerClientEvent = function(name, target, ...) record("TriggerClientEvent", name, target, ...) end
        -- scheduler.lua: PerformHttpRequest(url, cb, method, data, headers, options), then
        -- cb(status, body, headers, errorData). The stub answers synchronously.
        env.PerformHttpRequest = function(url, cb, method, data, headers, options)
            record("PerformHttpRequest", url, method, data, headers, options)
            cb((opts.http or function() return 0, nil, {}, "stub: no http answer" end)(url, method, data, headers, options))
        end
    else
        env.TriggerServerEvent = function(name, ...) record("TriggerServerEvent", name, ...) end
    end

    env.AddEventHandler = function(name, fn) record("AddEventHandler", name, fn) return { name = name } end
    env.RemoveEventHandler = function(h) record("RemoveEventHandler", h) end
    env.RegisterNetEvent = function(name, fn) record("RegisterNetEvent", name, fn) end
    env.TriggerEvent = function(name, ...) record("TriggerEvent", name, ...) end

    -- deferred.lua: promise.new(), p:resolve(v), states 0 pending, 3 resolved, 4 rejected.
    env.promise = {
        new = function()
            local p = { state = 0 }
            function p.resolve(_, v) if p.state == 0 then p.state, p.value = 3, v end end
            function p.reject(_, v) if p.state == 0 then p.state, p.value = 4, v end end
            return p
        end,
    }
    env.Citizen = {
        Await = function(p)
            if p.state == 0 then error("stub: Citizen.Await on a pending promise", 2) end
            if p.state == 4 then error(p.value, 2) end
            return p.value
        end,
    }

    -- scheduler.lua: exports[resource][name] raises "No such export <name> in resource <resource>"
    -- and answers function(self, ...).
    env.exports = setmetatable({}, {
        __index = function(_, res)
            return setmetatable({}, {
                __index = function(_, name)
                    local r = opts.resources and opts.resources[res]
                    local fn = r and r.exports and r.exports[name]
                    if not fn then error("No such export " .. name .. " in resource " .. res, 2) end
                    return function(_, ...) return fn(...) end
                end,
            })
        end,
    })

    w.env = env

    function w.load(text, name)
        return loadIn(text, name or "=scriptgo_shim.lua", env)()
    end

    -- Runs fn as a scheduler thread (the stub has no scheduler: Wait is not provided).
    function w.run(fn, ...)
        local co = coroutine.create(fn)
        local function finish(ok, ...)
            if not ok then error((...), 3) end
            return ...
        end
        return finish(coroutine.resume(co, ...))
    end

    return w
end

return M
