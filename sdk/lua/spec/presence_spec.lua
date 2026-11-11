-- Player match (docs/spec/player-match.md): conformance of the one implementation every host shares
-- (scriptgo/presence.lua), first on its own with fake services, then through a host. A fake wall
-- clock and a fake API. The HMAC is a table of vectors computed with Node's crypto
-- (createHmac("sha256", key).update(message).digest("hex")): the core never hashes by itself, it
-- only decides WHAT is hashed, and these vectors pin that text byte for byte.
local suite, scriptgo = ...
local test, expect, describe = suite.test, scriptgo.testing.expect, suite.describe
local testing, json, presenceLib = scriptgo.testing, scriptgo.json, scriptgo.presence

local T0 = 1794355200 -- 2026-11-11T00:00:00Z
local API = "http://api.test"
local TOKEN = "sg_srv_test_token"
local KEY1, KEY2 = "pk_test_20261111", "pk_test_20261112"

local VECTORS = {
    [KEY1 .. "|203.0.113.9"] = "048bfae99c6a7a6e511353e1c419cb4f8d32f8ac0700067cf6b1b4170bcac946",
    [KEY1 .. "|2001:db8:0:1::/64"] = "7e9541052658c68211018deadb2ad560ae255e0d30cb96d1dabda72bd4cc5939",
    [KEY1 .. "|198.51.100.23"] = "49276c5ac98e9d3c6d24825208d1e625cccec500a49d07156193e08555748a47",
    [KEY2 .. "|203.0.113.9"] = "c769002c8f338c151365ac2af8d8bac6956fffbe200f88a5f63ba8bf4eb7e2b3",
    [KEY2 .. "|2001:db8:0:1::/64"] = "d1cd53f20792217e410bfc9a546f5943e7f7cb1f99d5b1bb107c4df17af0833e",
    [KEY2 .. "|198.51.100.23"] = "35033d34da6921098e3f90143487d9814500cd94c9a64dc9380844ad496a220a",
}
local hashed = {}
local function hmac(key, message)
    hashed[#hashed + 1] = message
    return VECTORS[key .. "|" .. message] or error("no vector for " .. key .. " " .. message)
end

local function iso(t) return os.date("!%Y-%m-%dT%H:%M:%S.000Z", t) end

-- A fake API: answers /v1/presence with the current key, records what it was told, confirms codes.
local function fakeApi(wall)
    local api = { key = KEY1, rotatesAt = T0 + 86400, mode = "up", calls = {}, present = {}, codes = { ["MT4-2JF"] = "open" } }
    function api.count(pattern)
        local n = 0
        for _, c in ipairs(api.calls) do if c.key:find(pattern, 1, true) then n = n + 1 end end
        return n
    end
    function api.last(pattern)
        for i = #api.calls, 1, -1 do if api.calls[i].key:find(pattern, 1, true) then return api.calls[i] end end
    end
    function api.request(req, done)
        local path = req.url:sub(#API + 1)
        local call = { key = (req.method or "GET") .. " " .. path, req = req }
        api.calls[#api.calls + 1] = call
        if api.mode == "down" then return done({ status = 0, body = "" }) end
        if api.mode == "unlinked" or (req.headers or {}).authorization ~= "Bearer " .. TOKEN then
            return done({ status = 401, body = '{"error":{"code":"unknown_server_link","message":"x"}}' })
        end
        local body = req.body and json.decode(req.body) or {}
        call.body = body
        if path == "/v1/presence" and req.method == "POST" then
            for _, p in ipairs(body.players or {}) do api.present[p.player] = p end
            return done({ status = 200, body = json.encode({ accepted = #(body.players or {}), presenceKey = api.key, rotatesAt = iso(api.rotatesAt) }) })
        end
        local id = path:match("^/v1/presence/(.+)$")
        if id and req.method == "DELETE" then
            api.present[(id:gsub("%%(%x%x)", function(h) return string.char(tonumber(h, 16)) end))] = nil
            return done({ status = 204, body = "" })
        end
        if path == "/v1/identity/codes/confirm" then
            if api.mode == "busy" then return done({ status = 429, body = '{"error":{"code":"rate_limited","message":"x"}}' }) end
            local norm = tostring(body.code):upper():gsub("[%s%-]", "")
            for code, st in pairs(api.codes) do
                if code:gsub("%-", "") == norm then
                    if st ~= "open" then return done({ status = 410, body = '{"error":{"code":"code_used","message":"x"}}' }) end
                    api.codes[code] = body.player
                    return done({ status = 200, body = json.encode({ linked = true }) })
                end
            end
            return done({ status = 404, body = '{"error":{"code":"unknown_code","message":"x"}}' })
        end
        return done({ status = 404, body = '{"error":{"code":"not_found","message":"x"}}' })
    end
    return api
end

-- The module on its own, as an adapter author would wire it.
local function newClient(opts)
    opts = opts or {}
    local wall = { now = T0 }
    local api = fakeApi(wall)
    local cfg = { scriptgo_api = API, scriptgo_server_token = TOKEN, scriptgo_presence = "on" }
    for k, v in pairs(opts.config or {}) do cfg[k] = v end
    local players = opts.players or {
        [1] = { id = "steam:1", name = "Ada", address = "203.0.113.9:30120" },
        [2] = { id = "steam:2", name = "Bob", address = "[2001:db8:0:1:aaaa:bbbb:cccc:dddd]:30120" },
    }
    local logs = {}
    local services = {
        request = api.request,
        now = function() return wall.now end,
        json = json,
        config = function(k) local v = cfg[k]; if v == false then return nil end return v end,
        identifier = function(p) return players[p] and players[p].id end,
        name = function(p) return players[p] and players[p].name end,
        address = function(p) return players[p] and players[p].address end,
        players = function()
            local out = {}
            for id in pairs(players) do out[#out + 1] = id end
            table.sort(out)
            return out
        end,
        hmacSha256 = hmac,
        await = function(register)
            local r
            register(function(...) r = { ... } end)
            return r[1], r[2]
        end,
        log = function(level, message) logs[#logs + 1] = { level = level, message = message } end,
    }
    for k, v in pairs(opts.services or {}) do if v == false then services[k] = nil else services[k] = v end end
    return presenceLib.new(services), api, wall, cfg, players, logs
end

describe("address normalisation", function()
    local n = presenceLib.normalizeAddress
    test("IPv4, with or without a port", function()
        expect(n("203.0.113.9")).toBe("203.0.113.9")
        expect(n("203.0.113.9:30120")).toBe("203.0.113.9")
        expect(n(" 203.0.113.009 ")).toBe("203.0.113.9")
    end)
    test("IPv6 becomes its /64, written in full, lowercase, no leading zeros", function()
        expect(n("2001:0DB8:0000:0001:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:0:1::/64")
        expect(n("[2001:db8:0:1::5]:30120")).toBe("2001:db8:0:1::/64")
        expect(n("2001:db8::1")).toBe("2001:db8:0:0::/64")
        expect(n("fe80::1%eth0")).toBe("fe80:0:0:0::/64")
        expect(n("[::1]")).toBe("0:0:0:0::/64")
    end)
    test("IPv4-mapped IPv6 becomes the IPv4 address", function()
        expect(n("::ffff:203.0.113.9")).toBe("203.0.113.9")
        expect(n("[::ffff:203.0.113.9]:5000")).toBe("203.0.113.9")
        expect(n("::ffff:cb00:7109")).toBe("203.0.113.9")
    end)
    test("anything else is not an address", function()
        for _, bad in ipairs({ "", "loopback", "localhost:30120", "256.1.1.1", "1.2.3", "2001:db8::1::2", "1:2:3:4:5:6:7:8:9", "Error!", "12345::" }) do
            expect(n(bad)).toBe(nil)
        end
        expect(n(nil)).toBe(nil)
        expect(n(42)).toBe(nil)
    end)
end)

describe("presence reporting", function()
    test("off by default: nothing is sent, nothing is read", function()
        local reads = 0
        local p, api = newClient({ config = { scriptgo_presence = false }, services = { address = function() reads = reads + 1 end } })
        p.joined(1)
        for _ = 1, 5 do p.tick() end
        expect(#api.calls).toBe(0)
        expect(reads).toBe(0)
        expect(p.status().enabled).toBe(false)
        expect(p.status().reason).toBe("off")
    end)

    test("the first report fetches the key, then reports with it at once", function()
        hashed = {}
        local p, api = newClient()
        p.tick()
        expect(api.count("POST /v1/presence")).toBe(2)
        expect(#api.calls[1].body.players).toBe(0)
        local players = api.calls[2].body.players
        expect(#players).toBe(2)
        expect(players[1].player).toBe("steam:1")
        expect(players[1].name).toBe("Ada")
        expect(players[1].fp[1]).toBe(VECTORS[KEY1 .. "|203.0.113.9"])
        expect(players[2].fp[1]).toBe(VECTORS[KEY1 .. "|2001:db8:0:1::/64"])
        expect(p.status().active).toBe(true)
        expect(p.status().reported).toBe(2)
    end)

    test("the raw address never leaves the server", function()
        local p, api = newClient()
        p.tick()
        for _, c in ipairs(api.calls) do
            local text = (c.req.body or "") .. c.req.url
            expect(text:find("203.0.113.9", 1, true)).toBe(nil)
            expect(text:find("2001:db8", 1, true)).toBe(nil)
        end
    end)

    test("refreshed with the perks poll cadence, not every tick", function()
        local p, api, wall, cfg = newClient({ config = { scriptgo_perks_poll_seconds = "45" } })
        p.tick()
        local n = api.count("POST /v1/presence")
        wall.now = wall.now + 44
        p.tick()
        expect(api.count("POST /v1/presence")).toBe(n)
        wall.now = wall.now + 1
        p.tick()
        expect(api.count("POST /v1/presence")).toBe(n + 1)
    end)

    test("a join is reported at once; a leave is a DELETE with the identifier", function()
        local p, api, wall, cfg, players = newClient()
        p.tick()
        players[3] = { id = "steam:3", name = "Cyd", address = "198.51.100.23" }
        p.joined(3)
        local last = api.last("POST /v1/presence")
        expect(#last.body.players).toBe(1)
        expect(last.body.players[1].fp[1]).toBe(VECTORS[KEY1 .. "|198.51.100.23"])
        p.left(3)
        expect(api.last("DELETE").key).toBe("DELETE /v1/presence/steam%3A3")
        expect(api.present["steam:3"]).toBe(nil)
        -- A player the server never reported is not deleted.
        local before = #api.calls
        p.left(99)
        expect(#api.calls).toBe(before)
    end)

    test("a rotated key is used at once", function()
        local p, api, wall = newClient()
        p.tick()
        api.key = KEY2
        api.rotatesAt = T0 + 2 * 86400
        wall.now = T0 + 86400 -- rotatesAt of the first answer
        p.tick()
        local last = api.last("POST /v1/presence")
        expect(last.body.players[1].fp[1]).toBe(VECTORS[KEY2 .. "|203.0.113.9"])
    end)

    test("no HMAC on the host: presence says so once, the address is never read", function()
        local reads = 0
        local p, api, wall, cfg, players, logs = newClient({ services = { hmacSha256 = false, address = function() reads = reads + 1 end } })
        p.tick()
        p.tick()
        expect(p.status().reason).toBe("presence unavailable: no HMAC on this host")
        expect(api.count("POST /v1/presence")).toBe(0)
        expect(reads).toBe(0)
        local warned = 0
        for _, l in ipairs(logs) do if l.message:find("no HMAC", 1, true) then warned = warned + 1 end end
        expect(warned).toBe(1)
    end)

    test("no address function: presence says so", function()
        local p = newClient({ services = { address = false } })
        p.tick()
        expect(p.status().reason).toBe(presenceLib.NO_ADDRESS)
    end)

    test("a player without a readable address is left out, the others are reported", function()
        local p, api, wall, cfg, players = newClient()
        players[2].address = "loopback"
        p.tick()
        local last = api.last("POST /v1/presence")
        expect(#last.body.players).toBe(1)
        expect(last.body.players[1].player).toBe("steam:1")
    end)

    test("not linked: nothing is sent", function()
        local p, api = newClient({ config = { scriptgo_server_token = false } })
        p.tick()
        expect(#api.calls).toBe(0)
        expect(p.status().reason).toBe("not_linked")
    end)

    test("an API that cannot be reached is asked again later, with a back-off", function()
        local p, api, wall = newClient()
        api.mode = "down"
        p.tick()
        expect(api.count("POST /v1/presence")).toBe(1)
        wall.now = wall.now + 29
        p.tick()
        expect(api.count("POST /v1/presence")).toBe(1)
        wall.now = wall.now + 2
        p.tick()
        expect(api.count("POST /v1/presence")).toBe(2)
        expect(p.status().lastError).toBe("unreachable")
    end)

    test("nothing about an address or a fingerprint reaches the log", function()
        local p, api, wall, cfg, players, logs = newClient()
        p.tick()
        p.left(1)
        for _, l in ipairs(logs) do
            expect(l.message:find("203.0.113", 1, true)).toBe(nil)
            expect(l.message:find(VECTORS[KEY1 .. "|203.0.113.9"], 1, true)).toBe(nil)
        end
    end)

    test("every report names the environment and the adapter version, the empty one too", function()
        local p, api = newClient({ services = { environment = "rust", adapterVersion = "rust-bridge-1.2.3" } })
        p.tick()
        expect(api.calls[1].req.body:sub(1, 14)).toBe('{"players":[],')
        for _, c in ipairs(api.calls) do
            expect(c.body.environment).toBe("rust")
            expect(c.body.adapterVersion).toBe("rust-bridge-1.2.3")
        end
        expect(#api.calls[1].body.players).toBe(0)
        expect(#api.calls[2].body.players).toBe(2)
    end)

    test("an environment that is not an id is left out, not sent mangled", function()
        local p, api = newClient({ services = { environment = "Not An Id", adapterVersion = string.rep("v", 200) } })
        p.tick()
        expect(api.calls[1].body.environment).toBe(nil)
        expect(#api.calls[1].body.adapterVersion).toBe(128)
    end)
end)

describe("address mode", function()
    local addrCfg = { scriptgo_presence_addr = "on" }

    test("off by default: without an HMAC nothing is sent", function()
        local p, api = newClient({ services = { hmacSha256 = false } })
        p.tick()
        expect(api.count("POST /v1/presence")).toBe(0)
        expect(p.status().reason).toBe(presenceLib.NO_HMAC)
    end)

    test("on, with no HMAC: the normalised address is sent at once, without a key", function()
        local p, api = newClient({ config = addrCfg, services = { hmacSha256 = false, environment = "fivem", adapterVersion = "fivem-shim-0.1.0" } })
        p.tick()
        expect(api.count("POST /v1/presence")).toBe(1)
        local body = api.calls[1].body
        expect(body.environment).toBe("fivem")
        expect(body.adapterVersion).toBe("fivem-shim-0.1.0")
        expect(#body.players).toBe(2)
        expect(body.players[1].addr[1]).toBe("203.0.113.9")
        expect(body.players[1].fp).toBe(nil)
        expect(body.players[2].addr[1]).toBe("2001:db8:0:1::/64")
        expect(p.status().active).toBe(true)
        expect(p.status().mode).toBe("addr")
        expect(p.status().reported).toBe(2)
    end)

    test("on, with an HMAC: fingerprints are sent anyway", function()
        local p, api = newClient({ config = addrCfg })
        p.tick()
        local last = api.last("POST /v1/presence")
        expect(last.body.players[1].fp[1]).toBe(VECTORS[KEY1 .. "|203.0.113.9"])
        expect(last.body.players[1].addr).toBe(nil)
        expect(p.status().mode).toBe("fp")
    end)

    test("a join is reported at once, a rotated key changes nothing", function()
        local p, api, wall, cfg, players = newClient({ config = addrCfg, services = { hmacSha256 = false } })
        p.tick()
        local n = api.count("POST /v1/presence")
        api.key = KEY2
        players[3] = { id = "steam:3", name = "Cy", address = "198.51.100.23" }
        p.joined(3)
        expect(api.count("POST /v1/presence")).toBe(n + 1)
        local last = api.last("POST /v1/presence")
        expect(#last.body.players).toBe(1)
        expect(last.body.players[1].addr[1]).toBe("198.51.100.23")
        p.left(3)
        expect(api.count("DELETE /v1/presence/steam%3A3")).toBe(1)
    end)

    test("the address never reaches the log", function()
        local p, api, wall, cfg, players, logs = newClient({ config = addrCfg, services = { hmacSha256 = false } })
        api.mode = "down"
        p.tick()
        p.left(1)
        local told = 0
        for _, l in ipairs(logs) do
            expect(l.message:find("203.0.113", 1, true)).toBe(nil)
            expect(l.message:find("2001:db8", 1, true)).toBe(nil)
            if l.message:find("address mode", 1, true) then told = told + 1 end
        end
        -- The operator is told once that addresses leave the server.
        expect(told).toBe(1)
    end)
end)

describe("the link command", function()
    test("a typed code is confirmed for the player who typed it", function()
        local p, api = newClient({ config = { scriptgo_presence = false } })
        local ok, reason = p.link(1, "mt4-2jf")
        expect(ok).toBe(true)
        expect(reason).toBe(nil)
        expect(api.codes["MT4-2JF"]).toBe("steam:1")
        local body = api.last("/v1/identity/codes/confirm").body
        expect(body.code).toBe("MT4-2JF")
        expect(body.player).toBe("steam:1")
        expect(body.name).toBe("Ada")
        expect(p.linkMessage(ok, reason)).toBe("Linked: you can go back to your browser.")
    end)

    test("a confirm names the environment and the adapter version", function()
        local p, api = newClient({ services = { environment = "standalone", adapterVersion = "standalone-0.1.0" } })
        expect(p.link(1, "MT4-2JF")).toBe(true)
        local body = api.last("/v1/identity/codes/confirm").body
        expect(body.environment).toBe("standalone")
        expect(body.adapterVersion).toBe("standalone-0.1.0")
    end)

    test("the code is every word of the command, joined", function()
        local from = presenceLib.codeFromArgs
        expect(from({ "mt4", "2jf" })).toBe("mt4 2jf")
        expect(from({ "MT4-2JF" })).toBe("MT4-2JF")
        expect(from("mt4 2jf")).toBe("mt4 2jf")
        expect(from({})).toBe(nil)
        expect(from(nil)).toBe(nil)
        expect(presenceLib.normalizeCode(from({ "mt4", "2jf" }))).toBe("MT42JF")
        local p, api = newClient()
        expect(p.link(1, from({ "mt4", "2jf" }))).toBe(true)
        expect(api.codes["MT4-2JF"]).toBe("steam:1")
    end)

    test("refusals become plain sentences", function()
        local p, api = newClient()
        local ok, reason = p.link(1, "ZZ-ZZZZ")
        expect(ok).toBe(false)
        expect(reason).toBe("unknown_code")
        expect(p.linkMessage(ok, reason)).toContain("not valid")
        p.link(1, "MT4-2JF")
        ok, reason = p.link(2, "MT4-2JF")
        expect(reason).toBe("code_used")
        expect(p.linkMessage(ok, reason)).toContain("Ask the page for a new one")
        ok, reason = p.link(1, nil)
        expect(reason).toBe("usage")
        expect(p.linkMessage(ok, reason)).toBe("Type the code your browser shows, for example: /link MT4-2JF")
        ok, reason = p.link(1, "<script>")
        expect(reason).toBe("invalid_code")
        ok, reason = p.link(42, "MT4-2JF")
        expect(reason).toBe("unknown_player")
        api.mode = "busy"
        ok, reason = p.link(1, "AB-CDE")
        expect(reason).toBe("rate_limited")
        expect(p.linkMessage(ok, reason)).toContain("Wait a minute")
        api.mode = "down"
        ok, reason = p.link(1, "AB-CDE")
        expect(reason).toBe("unreachable")
        api.mode = "unlinked"
        ok, reason = p.link(1, "AB-CDE")
        expect(reason).toBe("not_linked")
    end)

    test("the command name comes from scriptgo_link_command; off removes it", function()
        expect(newClient().command()).toBe("link")
        expect(newClient({ config = { scriptgo_link_command = "/Verify" } }).command()).toBe("verify")
        expect(newClient({ config = { scriptgo_link_command = "off" } }).command()).toBe(nil)
        expect(newClient({ config = { scriptgo_link_command = "" } }).command()).toBe(nil)
        local p = newClient({ config = { scriptgo_link_command = "verify" } })
        expect(p.linkMessage(false, "usage")).toBe("Type the code your browser shows, for example: /verify MT4-2JF")
    end)
end)

-- Through a host: the adapter hands addresses and an HMAC; the host reports joins and drops and
-- serves /link as a host command, answering the player with a notification.
local function hostWith(config, crypto)
    local wall = { now = T0 }
    local api = fakeApi(wall)
    local h = testing.harness({
        config = { _global = config },
        crypto = crypto,
        wallTime = function() return wall.now end,
    })
    h.adapter.http.request = api.request
    return h, api, wall
end

describe("through a host", function()
    local cfg = { scriptgo_api = API, scriptgo_server_token = TOKEN, scriptgo_presence = "true" }

    test("joins and drops are reported, the address stays in the host", function()
        local h, api = hostWith(cfg, { hmacSha256 = hmac })
        h:join(5, "Ada", "203.0.113.9:1234")
        h:tick(10)
        local last = api.last("POST /v1/presence")
        expect(last ~= nil).toBe(true)
        local found = false
        for _, p in ipairs(last.body.players) do
            if p.fp[1] == VECTORS[KEY1 .. "|203.0.113.9"] then found = true end
        end
        expect(found).toBe(true)
        h:drop(5, "quit")
        expect(api.count("DELETE /v1/presence/local%3Aada")).toBe(1)
    end)

    test("/link is a host command and answers the player", function()
        local h, api = hostWith(cfg, { hmacSha256 = hmac })
        h:join(5, "Ada", "203.0.113.9")
        local ok = h:command(5, "/link MT4-2JF")
        expect(ok).toBe(true)
        expect(api.codes["MT4-2JF"]).toBe("local:ada")
        local n = h.adapter.notifications[#h.adapter.notifications]
        expect(n.target).toBe(5)
        expect(n.payload.message).toBe("Linked: you can go back to your browser.")
        expect(h.host:hasCommand("link")).toBe(true)
        local body = api.last("/v1/identity/codes/confirm").body
        expect(body.environment).toBe("standalone")
        expect(body.adapterVersion).toBe("testing")
    end)

    test("/link with a space in the code", function()
        local h, api = hostWith(cfg, { hmacSha256 = hmac })
        h:join(5, "Ada", "203.0.113.9")
        expect(h:command(5, "/link mt4 2jf")).toBe(true)
        expect(api.codes["MT4-2JF"]).toBe("local:ada")
    end)

    test("a resource's own command of that name wins", function()
        local h, api = hostWith(cfg, { hmacSha256 = hmac })
        h.adapter.readFile = (function(files) return function(p) return files[p] end end)({
            ["own/scriptgo.lua"] = 'resource "own"\nversion "0.1.0"\ncapabilities { "commands" }\nserver_script "s.lua"\n',
            ["own/s.lua"] = 'RegisterCommand("link", function(src) ScriptGo.log.info("own link " .. src) end)\n',
        })
        h:add("own")
        h:start("own")
        h:join(5, "Ada", "203.0.113.9")
        h:command(5, "/link MT4-2JF")
        expect(api.count("/v1/identity/codes/confirm")).toBe(0)
    end)

    test("without a server token there is no /link", function()
        local h = hostWith({ scriptgo_api = API }, { hmacSha256 = hmac })
        h:join(5, "Ada", "203.0.113.9")
        expect(h.host:hasCommand("link")).toBe(false)
    end)

    test("presence without http is off", function()
        local h = testing.harness({ capabilities = { events = true, players = true, commands = true } })
        expect(h.host:hasCapability("presence")).toBe(false)
    end)

    test("ScriptGo.presence.status from a resource", function()
        local h = hostWith(cfg, nil)
        h.adapter.readFile = (function(files) return function(p) return files[p] end end)({
            ["sttest/scriptgo.lua"] = 'resource "sttest"\nversion "0.1.0"\ncapabilities { "presence" }\nserver_script "s.lua"\n',
            ["sttest/s.lua"] = 'local s = ScriptGo.presence.status()\nScriptGo.log.info("presence " .. tostring(s.enabled) .. " " .. tostring(s.reason))\n',
        })
        h:add("sttest")
        local ok, why = h:start("sttest")
        expect(ok).toBe(true)
        local seen = false
        for _, l in ipairs(h.adapter.logs) do
            if tostring(l.message):find("presence true presence unavailable: no HMAC on this host", 1, true) then seen = true end
        end
        expect(seen).toBe(true)
    end)
end)
