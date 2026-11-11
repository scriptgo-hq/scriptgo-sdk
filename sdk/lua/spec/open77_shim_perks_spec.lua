-- ScriptGo.perks in the OPEN//77 shim (sdk/adapters/open77/shim.lua + shim_server.lua), against a
-- STUB of the OPEN//77 natives the section calls. It checks that the shim hands the portable core's
-- perks module the right things (HTTP, the player identifier, the clock, kvp); it is not OPEN//77.
-- The run on a real OPEN//77 server is `node tools/perks-e2e.mjs --host open77`.
local suite, scriptgo, ctx = ...
local test, expect, describe = suite.test, scriptgo.testing.expect, suite.describe
local json, compat = scriptgo.json, scriptgo.compat
local unpack, pack = compat.unpack, compat.pack

local T0 = 1794268800
local API, TOKEN = "http://api.test", "sg_srv_open77"
local ADA = "op77:ada-5e1c"

local shimDir = ctx.root .. "/sdk/adapters/open77/"
local shared = assert(ctx.readFile(shimDir .. "shim.lua"))
-- What `scriptgo pack` does with an include line (packages/manifest/src/open77.ts, expandIncludes).
local server = assert(ctx.readFile(shimDir .. "shim_server.lua")):gsub("[^\n]*%-%-%s*@include%s+(%S+)[^\n]*", function(rel)
    return (assert(ctx.readFile(shimDir .. rel), "cannot include " .. rel))
end)

local function iso(t) return t and os.date("!%Y-%m-%dT%H:%M:%S.000Z", t) or nil end

-- A small world: a clock, a thread scheduler with Wait and promises, kvp, convars, players and an
-- HTTP bridge whose callback runs on a later tick, as OPEN//77's does.
local function world(opts)
    opts = opts or {}
    local w = { now = T0, kvp = opts.kvp or {}, convars = opts.convars or { scriptgo_api = API, scriptgo_server_token = TOKEN }, requests = {}, held = {}, queue = {}, acked = 0, down = false, logs = {} }
    local threads, http = {}, {}
    local env = {}
    for _, name in ipairs({ "assert", "error", "ipairs", "next", "pairs", "pcall", "rawget", "select", "tonumber", "tostring", "type" }) do env[name] = _G[name] end
    env.string, env.table, env.math = string, table, math
    env._G = env
    env._VERSION = _VERSION

    local function resume(thread, ...)
        local res = pack(coroutine.resume(thread.co, ...))
        if not res[1] then error(tostring(res[2]) .. "\n" .. debug.traceback(thread.co), 0) end
        if coroutine.status(thread.co) == "dead" then
            threads[thread] = nil
            return
        end
        local req = res[2]
        if req.await then thread.await, thread.wake = req.await, nil else thread.wake = w.now + req.wait / 1000 end
    end
    env.CreateThread = function(fn)
        local thread = { co = coroutine.create(fn) }
        threads[thread] = true
        resume(thread)
    end
    env.Wait = function(ms) coroutine.yield({ wait = ms }) end
    local Promise = {}
    Promise.__index = Promise
    function Promise:resolve(...) self.values = pack(...) end
    env.promise = { new = function() return setmetatable({}, Promise) end }
    env.Citizen = {
        Await = function(p)
            if not p.values then coroutine.yield({ await = p }) end
            return unpack(p.values, 1, p.values.n)
        end,
    }

    env.IsDuplicityVersion = function() return true end
    env.GetCurrentResourceName = function() return "shop" end
    env.GetResourceState = function() return "started" end
    w.handlers, w.commands, w.chat, w.endpointReads = {}, {}, {}, 0
    env.AddEventHandler = function(name, fn)
        w.handlers[name] = w.handlers[name] or {}
        table.insert(w.handlers[name], fn)
    end
    env.RemoveEventHandler, env.TriggerEvent = function() end, function() end
    env.RegisterCommand = function(name, fn)
        if w.commands[name] then error("duplicate command '" .. name .. "'") end
        w.commands[name] = fn
        return true
    end
    -- Fires a host event as OPEN//77 does: `source` is a global of the handler's call.
    function w.fire(name, src, ...)
        for _, fn in ipairs(w.handlers[name] or {}) do
            env.source = src
            fn(...)
            env.source = nil
        end
    end
    env.RegisterNetEvent, env.TriggerServerEvent, env.TriggerClientEvent = function() end, function() end, function() end
    env.GetConvar = function(name, default)
        local v = w.convars[name]
        if v == nil then return default end
        return v
    end
    local players = opts.players or { [3] = ADA }
    env.GetPlayers = function()
        local ids = {}
        for id in pairs(players) do ids[#ids + 1] = id end
        table.sort(ids)
        return ids
    end
    env.GetPlayerName = function(id) return players[id] and ("Player " .. id) or nil end
    local function logger(level) return function(m) w.logs[#w.logs + 1] = level .. ": " .. m end end
    env.Open77 = {
        json = { encode = json.encode, decode = json.decode },
        log = { debug = logger("debug"), info = logger("info"), warn = logger("warn"), error = logger("error") },
        time = { monotonic = function() return w.now - T0 end, unix = function() return w.now end },
        kvp = {
            get = function(key) return w.kvp[key] end,
            set = function(key, value) w.kvp[key] = value return true end,
            delete = function(key) w.kvp[key] = nil return true end,
            keys = function() return {} end,
        },
        players = {
            identifier = function(id)
                if type(id) ~= "number" or id < 1 then error("id must be positive") end
                return players[id]
            end,
            endpoint = function(id)
                w.endpointReads = w.endpointReads + 1
                return players[id] and "203.0.113.9:31337" or nil, "player_not_found"
            end,
        },
        chat = { send = function(id, msg) w.chat[#w.chat + 1] = { id = id, msg = msg } return true end },
        acl = { isAllowed = function() return false end },
        notifications = { send = function() return true end, broadcast = function() return true end },
        exports = { call = function() end },
        http = {
            request = function(url, callback, method, body, headers)
                w.requests[#w.requests + 1] = { url = url, method = method, body = body, headers = headers }
                http[#http + 1] = { url = url, callback = callback, method = method, body = body, headers = headers }
                return true
            end,
        },
    }

    -- The fake SCRIPT//GO API, answering on the tick after the request.
    local function answer(r)
        if w.down then return r.callback(0, "", {}, "http_failed") end
        if (r.headers or {}).authorization ~= "Bearer " .. TOKEN then return r.callback(401, '{"error":{"code":"unknown_server_link"}}', {}) end
        local path = r.url:sub(#API + 1):match("^[^?]*")
        local body = r.body and json.decode(r.body) or {}
        if path == "/v1/perks/check" then
            local list = {}
            for key, p in pairs(w.held[body.player] or {}) do
                list[#list + 1] = { key = key, status = "active", expiresAt = iso(p.expiresAt), offlineGraceUntil = iso(math.min(w.now + 72 * 3600, p.expiresAt or math.huge)) }
            end
            return r.callback(200, json.encode({ player = body.player, perks = list, serverTime = iso(w.now) }), {})
        elseif path == "/v1/perks/events" then
            local after = tonumber((r.url:match("after=(%d+)"))) or w.acked
            local events, cursor = {}, after
            for _, e in ipairs(w.queue) do
                if e.seq > after then
                    events[#events + 1] = e
                    cursor = e.seq
                end
            end
            return r.callback(200, json.encode({ events = events, cursor = cursor, more = false, serverTime = iso(w.now) }), {})
        elseif path == "/v1/perks/events/ack" then
            w.acked = math.max(w.acked, body.upTo)
            return r.callback(200, json.encode({ acked = w.acked }), {})
        end
        if path == "/v1/identity/codes/confirm" then
            w.confirmed = body
            if (body.code:gsub("%-", "")) == "MT42JF" then return r.callback(200, json.encode({ linked = true }), {}) end
            return r.callback(404, '{"error":{"code":"unknown_code"}}', {})
        end
        if path == "/v1/presence" then
            w.presence = body
            return r.callback(200, json.encode({ presenceKey = "pk_test", rotatesAt = iso(w.now + 86400) }), {})
        end
        return r.callback(404, '{"error":{"code":"not_found"}}', {})
    end

    function w.pump()
        local pending = http
        http = {}
        for _, r in ipairs(pending) do answer(r) end
        local ready = {}
        for thread in pairs(threads) do
            if thread.await and thread.await.values then ready[#ready + 1] = thread
            elseif thread.wake and thread.wake <= w.now then ready[#ready + 1] = thread end
        end
        for _, thread in ipairs(ready) do
            thread.await, thread.wake = nil, nil
            resume(thread)
        end
    end
    function w.pass(seconds)
        for _ = 1, seconds do
            w.now = w.now + 1
            w.pump()
            w.pump()
        end
    end
    -- Runs fn in a thread and pumps until it returns.
    function w.run(fn)
        local out
        env.CreateThread(function() out = pack(fn()) end)
        for _ = 1, 20 do
            if out then break end
            w.pump()
        end
        if not out then error("the thread did not finish") end
        return unpack(out, 1, out.n)
    end
    function w.load(text, name)
        local fn = assert(compat.loadWithEnv(text, "@" .. name, env))
        fn()
    end
    w.env = env
    return w
end

local function shop(opts)
    local w = world(opts)
    w.load(shared, "scriptgo_shim.lua")
    w.load(server, "scriptgo_shim_server.lua")
    return w, w.env.ScriptGo
end

describe("open77 shim: perks (stub natives)", function()
    test("the shared shim alone refuses, as a host without the capability does", function()
        local w = world()
        w.load(shared, "scriptgo_shim.lua")
        local SG = w.env.ScriptGo
        expect(SG.capabilities.has("perks")).toBe(false)
        expect(function() SG.perks.has(3, "vip") end).toThrow("capability_unavailable:perks@open77")
    end)

    test("asks the API through Open77.http.request with the convar token and the durable identifier", function()
        local w, SG = shop()
        expect(SG.capabilities.has("perks")).toBe(true)
        w.held[ADA] = { vip = { expiresAt = T0 + 86400 } }
        local has, info = w.run(function() return SG.perks.has(3, "vip") end)
        expect(has).toBe(true)
        expect(info.expiresAt).toBe(T0 + 86400)
        local check
        for _, r in ipairs(w.requests) do if r.url == API .. "/v1/perks/check" then check = r end end
        expect(check.method).toBe("POST")
        expect(check.headers.authorization).toBe("Bearer " .. TOKEN)
        local body = json.decode(check.body)
        expect(body.player).toBe(ADA)
        expect(body.environment).toBe("open77")
        expect(body.adapterVersion).toBe("open77-shim-0.5.0")
        -- A player id below 1 never reaches the native (it would stop the resource).
        local none, why = w.run(function() return SG.perks.has(0, "vip") end)
        expect(none).toBe(false)
        expect(why).toBe("unknown_player")
    end)

    test("pulls the event queue from a thread and runs handlers with the connected player", function()
        local w, SG = shop()
        local seen = {}
        SG.perks.on("granted", function(player, key, info) seen[#seen + 1] = "granted:" .. tostring(player) .. ":" .. key .. ":" .. info.identifier end)
        SG.perks.on("removed", function(player, key, info) seen[#seen + 1] = "removed:" .. tostring(player) .. ":" .. key .. ":" .. info.reason end)
        expect(w.run(function() return SG.perks.has(3, "vip") end)).toBe(false)
        w.queue[1] = { seq = 1, kind = "granted", perk = "vip", player = ADA, reason = "purchase", status = "active", expiresAt = iso(T0 + 86400), offlineGraceUntil = iso(T0 + 86400), at = iso(w.now) }
        w.pass(32)
        expect(seen[1]).toBe("granted:3:vip:" .. ADA)
        expect(w.acked).toBe(1)
        w.queue[2] = { seq = 2, kind = "removed", perk = "vip", player = ADA, reason = "refunded", status = "refunded", at = iso(w.now) }
        w.pass(32)
        expect(seen[2]).toBe("removed:3:vip:refunded")
        expect(w.acked).toBe(2)
    end)

    test("keeps the cache in the resource's kvp and trusts it only inside its bounds", function()
        local kvp = {}
        local w, SG = shop({ kvp = kvp })
        w.held[ADA] = { founder = {} }
        expect(w.run(function() return SG.perks.has(3, "founder") end)).toBe(true)
        expect(type(kvp["scriptgo.perks"])).toBe("string")
        expect(kvp["scriptgo.perks"]:find(TOKEN, 1, true)).toBeNil()

        -- The server restarts while the API is down: the stored answer still holds...
        local again, SG2 = shop({ kvp = kvp })
        again.down = true
        again.now = T0 + 3600
        local has, info = again.run(function() return SG2.perks.has(3, "founder") end)
        expect(has).toBe(true)
        expect(info.source).toBe("cache")
        -- ...but not past the offline grace of that answer.
        local late, SG3 = shop({ kvp = kvp })
        late.down = true
        late.now = T0 + 73 * 3600
        expect(late.run(function() return SG3.perks.has(3, "founder") end)).toBe(false)
    end)

    test("a server that is not linked gets nothing", function()
        local w, SG = shop({ convars = { scriptgo_api = API } })
        w.held[ADA] = { vip = {} }
        local has, why = w.run(function() return SG.perks.has(3, "vip") end)
        expect(has).toBe(false)
        expect(why).toBe("not_linked")
        w.pass(60)
        expect(#w.requests).toBe(0)

        local wrong, SG2 = shop({ convars = { scriptgo_api = API, scriptgo_server_token = "sg_srv_someone_elses" } })
        wrong.held[ADA] = { vip = {} }
        local has2, why2 = wrong.run(function() return SG2.perks.has(3, "vip") end)
        expect(has2).toBe(false)
        expect(why2).toBe("not_linked")
    end)
end)

describe("open77 shim: presence (stub natives)", function()
    test("off unless declared: the shared shim alone refuses", function()
        local w = world()
        w.load(shared, "scriptgo_shim.lua")
        expect(w.env.ScriptGo.capabilities.has("presence")).toBe(false)
        expect(function() w.env.ScriptGo.presence.status() end).toThrow("capability_unavailable:presence@open77")
    end)

    test("/link is registered at resource start and confirms the durable identifier", function()
        local w, SG = shop()
        expect(SG.capabilities.has("presence")).toBe(true)
        w.fire("onResourceStart", nil, "shop")
        expect(type(w.commands.link)).toBe("function")
        w.env.CreateThread(function() w.commands.link(3, { "mt4-2jf", n = 1 }, "link mt4-2jf") end)
        w.pass(1)
        expect(w.confirmed.player).toBe(ADA)
        expect(w.confirmed.code).toBe("MT4-2JF")
        expect(w.chat[1].id).toBe(3)
        expect(w.chat[1].msg.text).toBe("Linked: you can go back to your browser.")
        w.env.CreateThread(function() w.commands.link(3, { "ZZ-ZZZZ", n = 1 }, "link ZZ-ZZZZ") end)
        w.pass(1)
        expect(w.chat[2].msg.text).toContain("not valid")
    end)

    test("/link joins every argument and names the environment and the adapter version", function()
        local w = shop()
        w.fire("onResourceStart", nil, "shop")
        w.env.CreateThread(function() w.commands.link(3, { "mt4", "2jf", n = 2 }, "link mt4 2jf") end)
        w.pass(1)
        expect(w.confirmed.code).toBe("MT42JF")
        expect(w.confirmed.environment).toBe("open77")
        expect(w.confirmed.adapterVersion).toBe("open77-shim-0.5.0")
        expect(w.chat[1].msg.text).toBe("Linked: you can go back to your browser.")
    end)

    test("address mode: the normalised address is sent, never logged, with the environment", function()
        local w, SG = shop({ convars = { scriptgo_api = API, scriptgo_server_token = TOKEN, scriptgo_presence = "on", scriptgo_presence_addr = "on" } })
        w.fire("onResourceStart", nil, "shop")
        w.pass(5)
        local st = SG.presence.status()
        expect(st.active).toBe(true)
        expect(st.mode).toBe("addr")
        expect(w.presence.environment).toBe("open77")
        expect(w.presence.adapterVersion).toBe("open77-shim-0.5.0")
        expect(w.presence.players[1].player).toBe(ADA)
        expect(w.presence.players[1].addr[1]).toBe("203.0.113.9")
        expect(w.presence.players[1].fp).toBeNil()
        for _, l in ipairs(w.logs) do expect(l:find("203.0.113", 1, true)).toBeNil() end
    end)

    test("presence on, but no HMAC native: it says so and never reads an endpoint", function()
        local w, SG = shop({ convars = { scriptgo_api = API, scriptgo_server_token = TOKEN, scriptgo_presence = "on" } })
        w.fire("onResourceStart", nil, "shop")
        w.fire("playerJoining", 3)
        w.pass(5)
        local st = SG.presence.status()
        expect(st.enabled).toBe(true)
        expect(st.active).toBe(false)
        expect(st.reason).toBe("presence unavailable: no HMAC on this host")
        expect(w.endpointReads).toBe(0)
        expect(w.presence).toBeNil()
        local warned = 0
        for _, l in ipairs(w.logs) do if l:find("no HMAC on this host", 1, true) then warned = warned + 1 end end
        expect(warned).toBe(1)
    end)

    test("scriptgo_link_command off: no command", function()
        local w = shop({ convars = { scriptgo_api = API, scriptgo_server_token = TOKEN, scriptgo_link_command = "off" } })
        w.fire("onResourceStart", nil, "shop")
        expect(w.commands.link).toBeNil()
    end)
end)
