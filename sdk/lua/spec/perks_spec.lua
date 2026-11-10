-- Player perks (ADR-0038, docs/spec/perks.md): conformance of the one implementation every host
-- shares (scriptgo/perks.lua), first on its own with fake services, exactly as a third-party adapter
-- would drive it, then through a host and a resource. A fake wall clock and a fake API.
local suite, scriptgo = ...
local test, expect, describe = suite.test, scriptgo.testing.expect, suite.describe
local testing, json, perksLib = scriptgo.testing, scriptgo.json, scriptgo.perks
local unpack, pack = scriptgo.compat.unpack, scriptgo.compat.pack

local T0 = 1794268800 -- 2026-11-10T00:00:00Z
local HOUR, DAY = 3600, 86400
local API = "http://api.test"
local TOKEN = "sg_srv_test_token"
local ALICE, BOB = "steam:76561198000000001", "steam:76561198000000002"

local function iso(t)
    if t == nil then return nil end
    return os.date("!%Y-%m-%dT%H:%M:%S.000Z", t)
end

-- A fake SCRIPT//GO API for one operator. `api.held[player][key] = { expiresAt = <unix or nil> }` is
-- the truth; `api.queue` is the server's event queue; `api.mode` is "up", "down" or "unlinked".
local function fakeApi(wall)
    local api = { held = {}, queue = {}, acked = 0, seq = 0, mode = "up", calls = {}, graceHours = 72, links = {} }
    function api.grant(player, key, expiresAt)
        api.held[player] = api.held[player] or {}
        api.held[player][key] = { expiresAt = expiresAt }
    end
    function api.push(kind, player, key, expiresAt, reason)
        api.seq = api.seq + 1
        api.queue[#api.queue + 1] = { seq = api.seq, kind = kind, player = player, perk = key, expiresAt = expiresAt, reason = reason or "test", at = wall.now }
        return api.seq
    end
    local function graceOf(expiresAt)
        local g = wall.now + api.graceHours * HOUR
        if expiresAt and expiresAt < g then g = expiresAt end
        return g
    end
    function api.count(pattern)
        local n = 0
        for _, c in ipairs(api.calls) do if c.key:find(pattern, 1, true) then n = n + 1 end end
        return n
    end
    function api.request(req, done)
        local path = req.url:sub(#API + 1)
        local route = path:match("^[^?]*")
        api.calls[#api.calls + 1] = { key = (req.method or "GET") .. " " .. route, req = req, query = path:match("%?(.*)$") }
        if api.mode == "down" then return done({ status = 0, body = "", error = "http_failed" }) end
        if api.mode == "error" then return done({ status = 503, body = '{"error":{"code":"internal_error"}}' }) end
        if api.mode == "unlinked" or (req.headers or {}).authorization ~= "Bearer " .. TOKEN then
            return done({ status = 401, body = '{"error":{"code":"unknown_server_link","message":"Unknown or revoked server link token."}}' })
        end
        local body = req.body and json.decode(req.body) or {}
        if route == "/v1/perks/check" then
            local list = {}
            for key, p in pairs(api.held[body.player] or {}) do
                if not p.expiresAt or p.expiresAt > wall.now then
                    list[#list + 1] = { key = key, status = "active", expiresAt = iso(p.expiresAt), offlineGraceUntil = iso(p.graceUntil or graceOf(p.expiresAt)) }
                end
            end
            return done({ status = 200, body = json.encode({ player = body.player, perks = list, serverTime = iso(wall.now) }) })
        elseif route == "/v1/perks/events" then
            local after = tonumber((path:match("after=(%d+)"))) or api.acked
            local events, cursor = {}, after
            for _, e in ipairs(api.queue) do
                if e.seq > after then
                    events[#events + 1] = {
                        seq = e.seq, kind = e.kind, perk = e.perk, player = e.player, reason = e.reason, status = e.kind == "removed" and "refunded" or "active",
                        expiresAt = iso(e.expiresAt), offlineGraceUntil = e.kind ~= "removed" and iso(graceOf(e.expiresAt)) or nil, at = iso(e.at),
                    }
                    cursor = e.seq
                end
            end
            return done({ status = 200, body = json.encode({ events = events, cursor = cursor, more = false, serverTime = iso(wall.now) }) })
        elseif route == "/v1/perks/events/ack" then
            if body.upTo > api.acked then api.acked = body.upTo end
            return done({ status = 200, body = json.encode({ acked = api.acked }) })
        elseif route == "/v1/perks/purchase-link" then
            if (api.held[body.player] or {})[body.perk] then
                return done({ status = 409, body = '{"error":{"code":"already_held","message":"This player already has this perk."}}' })
            end
            api.links[#api.links + 1] = body
            return done({ status = 201, body = json.encode({ url = "https://web.test/perk/signed." .. body.perk, expiresAt = iso(wall.now + 900) }) })
        elseif route == "/v1/perks/catalog" then
            return done({ status = 200, body = '[{"key":"vip","name":"VIP","description":"","interval":"month","price":{"amount":500,"currency":"EUR"},"purchasable":true}]' })
        end
        return done({ status = 404, body = '{"error":{"code":"not_found"}}' })
    end
    return api
end

-- The services a host gives the module, with a manual clock. `opts.token = false` leaves it unlinked.
local function client(opts)
    opts = opts or {}
    local wall = opts.wall or { now = T0 }
    local api = opts.api or fakeApi(wall)
    local fired, logs = {}, {}
    local config = { scriptgo_api = API .. "/", scriptgo_server_token = opts.token == nil and TOKEN or opts.token or nil }
    local players = opts.players or { [1] = ALICE, [2] = BOB }
    local perks = perksLib.new({
        request = api.request,
        -- The fake API answers at once, so awaiting is taking what the callback was given.
        await = function(register)
            local out
            register(function(...) out = pack(...) end)
            if not out then error("the fake API did not answer") end
            return unpack(out, 1, out.n)
        end,
        identifier = function(player) return players[player] end,
        findPlayer = function(id)
            for n, v in pairs(players) do if v == id then return n end end
            return nil
        end,
        now = function() return wall.now end,
        json = json,
        config = function(key) return config[key] end,
        dispatch = function(fn, ...) fn(...) end,
        log = function(level, message) logs[#logs + 1] = level .. ": " .. message end,
        storage = opts.storage,
        environment = "standalone", adapterVersion = "spec",
        pollSeconds = 30, refreshSeconds = 600, retrySeconds = 30,
    })
    for _, kind in ipairs({ "granted", "removed" }) do
        perks.on(kind, function(player, key, info)
            fired[#fired + 1] = { kind = kind, player = player, key = key, identifier = info.identifier, reason = info.reason, expiresAt = info.expiresAt }
        end)
    end
    -- Moves the wall clock and ticks once a second, as a host does.
    local function pass(seconds)
        local left = seconds
        while left > 0 do
            local step = math.min(left, opts.step or 1)
            wall.now = wall.now + step
            perks.tick()
            left = left - step
        end
    end
    return perks, api, wall, fired, pass, config, logs
end

local function memoryStorage()
    local st = { data = nil, saves = 0 }
    function st.load() return st.data and json.decode(st.data) or nil end
    function st.save(t)
        st.data = json.encode(json.object(t))
        st.saves = st.saves + 1
    end
    return st
end

describe("perks: asking", function()
    test("asks the API with the server link token and the player's identifier", function()
        local perks, api = client()
        api.grant(ALICE, "vip", T0 + 30 * DAY)
        local has, info = perks.has(1, "vip")
        expect(has).toBe(true)
        expect(info.expiresAt).toBe(T0 + 30 * DAY)
        expect(info.source).toBe("api")
        local call = api.calls[1]
        expect(call.key).toBe("POST /v1/perks/check")
        expect(call.req.url).toBe(API .. "/v1/perks/check")
        expect(call.req.headers.authorization).toBe("Bearer " .. TOKEN)
        local body = json.decode(call.req.body)
        expect(body.player).toBe(ALICE)
        expect(body.environment).toBe("standalone")
    end)

    test("a perk that is not held, and a player given as an identifier", function()
        local perks, api = client()
        api.grant(BOB, "founder", nil)
        local has, why = perks.has(1, "vip")
        expect(has).toBe(false)
        expect(why).toBe("not_held")
        local ok, info = perks.has(BOB, "founder")
        expect(ok).toBe(true)
        expect(info.expiresAt).toBeNil()
    end)

    test("one answer covers every perk of the player, and is not asked for again at once", function()
        local perks, api = client()
        api.grant(ALICE, "vip", T0 + DAY)
        api.grant(ALICE, "founder", nil)
        expect(perks.has(1, "vip")).toBe(true)
        expect(perks.has(1, "founder")).toBe(true)
        expect(perks.has(1, "nothing")).toBe(false)
        expect(api.count("/v1/perks/check")).toBe(1)
        local list = perks.list(1)
        expect(#list).toBe(2)
        expect(list[1].key).toBe("founder")
        expect(list[2].key).toBe("vip")
        expect(list[2].expiresAt).toBe(T0 + DAY)
        expect(api.count("/v1/perks/check")).toBe(1)
    end)

    test("refuses a player it cannot identify and a malformed key, without a request", function()
        local perks, api = client()
        local a, why = perks.has(99, "vip")
        expect(a).toBe(false)
        expect(why).toBe("unknown_player")
        local b, why2 = perks.has("has spaces", "vip")
        expect(b).toBe(false)
        expect(why2).toBe("invalid_player")
        local c, why3 = perks.has(1, "Not A Key")
        expect(c).toBe(false)
        expect(why3).toBe("invalid_perk")
        expect(#api.calls).toBe(0)
    end)

    test("asks again after the refresh interval", function()
        local perks, api, wall = client()
        api.grant(ALICE, "vip", T0 + 30 * DAY)
        expect(perks.has(1, "vip")).toBe(true)
        wall.now = wall.now + 599
        expect(perks.has(1, "vip")).toBe(true)
        expect(api.count("/v1/perks/check")).toBe(1)
        wall.now = wall.now + 2
        api.held[ALICE] = nil
        expect(perks.has(1, "vip")).toBe(false)
        expect(api.count("/v1/perks/check")).toBe(2)
    end)
end)

describe("perks: a server that is not linked gets nothing", function()
    test("no token: nothing is asked and nothing is held", function()
        local perks, api, _, _, pass = client({ token = false })
        api.grant(ALICE, "vip", nil)
        local has, why = perks.has(1, "vip")
        expect(has).toBe(false)
        expect(why).toBe("not_linked")
        pass(120)
        expect(#api.calls).toBe(0)
        expect(perks.status().configured).toBe(false)
    end)

    test("a token the API does not know: refused, and nothing is held", function()
        local perks, api = client({ token = "sg_srv_another_operators_guess" })
        api.grant(ALICE, "vip", nil)
        local has, why = perks.has(1, "vip")
        expect(has).toBe(false)
        expect(why).toBe("not_linked")
        expect(perks.status().linked).toBe(false)
        local url, reason = perks.purchaseLink(1, "vip")
        expect(url).toBeNil()
        expect(reason).toBe("not_linked")
    end)

    test("a link revoked while the server runs: the cache is dropped and the script is told", function()
        local perks, api, _, fired, pass = client()
        api.grant(ALICE, "vip", nil)
        expect(perks.has(1, "vip")).toBe(true)
        api.mode = "unlinked"
        pass(31)
        expect(#fired).toBe(1)
        expect(fired[1].kind).toBe("removed")
        expect(fired[1].reason).toBe("not_linked")
        expect(fired[1].player).toBe(1)
        local has, why = perks.has(1, "vip")
        expect(has).toBe(false)
        expect(why).toBe("not_linked")
    end)
end)

describe("perks: the offline cache", function()
    test("keeps a player's perk while the API cannot be reached, for the offline grace and no longer", function()
        local perks, api, wall, fired, pass = client({ step = 60 })
        api.grant(ALICE, "founder", nil) -- no period end: only the offline grace bounds it
        expect(perks.has(1, "founder")).toBe(true)
        api.mode = "down"
        pass(71 * HOUR)
        local has, info = perks.has(1, "founder")
        expect(has).toBe(true)
        expect(info.source).toBe("cache")
        expect(#fired).toBe(0)
        pass(2 * HOUR)
        local late, why = perks.has(1, "founder")
        expect(late).toBe(false)
        expect(why).toBe("not_held")
        expect(#fired).toBe(1)
        expect(fired[1].kind).toBe("removed")
        expect(fired[1].reason).toBe("unverified")
        expect(fired[1].key).toBe("founder")
    end)

    test("never trusts a perk past its period end, even inside the offline grace", function()
        local perks, api, wall, fired, pass = client({ step = 30 })
        api.grant(ALICE, "vip", T0 + 2 * HOUR)
        expect(perks.has(1, "vip")).toBe(true)
        api.mode = "down"
        pass(2 * HOUR - 60)
        expect(perks.has(1, "vip")).toBe(true)
        pass(120)
        expect(perks.has(1, "vip")).toBe(false)
        expect(fired[#fired].kind).toBe("removed")
        expect(fired[#fired].reason).toBe("unverified")
    end)

    test("an offline grace later than the period end is cut back to it", function()
        local perks, api, wall = client()
        api.grant(ALICE, "vip", T0 + HOUR)
        api.held[ALICE].vip.graceUntil = T0 + 50 * HOUR -- a wrong answer: later than the period end
        expect(perks.has(1, "vip")).toBe(true)
        api.mode = "down"
        wall.now = T0 + HOUR + 1
        expect(perks.has(1, "vip")).toBe(false)
    end)

    test("a 5xx is an API that cannot answer, not a refusal", function()
        local perks, api, wall = client()
        api.grant(ALICE, "vip", T0 + 30 * DAY)
        expect(perks.has(1, "vip")).toBe(true)
        api.mode = "error"
        wall.now = wall.now + 700
        local has, info = perks.has(1, "vip")
        expect(has).toBe(true)
        expect(info.source).toBe("cache")
    end)

    test("with nothing cached and no API, the answer is no, and says why", function()
        local perks, api = client()
        api.mode = "down"
        local has, why = perks.has(1, "vip")
        expect(has).toBe(false)
        expect(why).toBe("unreachable")
    end)

    test("does not ask a dead API again for every question", function()
        local perks, api, wall = client()
        api.grant(ALICE, "vip", T0 + 30 * DAY)
        expect(perks.has(1, "vip")).toBe(true)
        api.mode = "down"
        wall.now = wall.now + 700
        for _ = 1, 5 do expect(perks.has(1, "vip")).toBe(true) end
        expect(api.count("/v1/perks/check")).toBe(2)
        wall.now = wall.now + 31
        expect(perks.has(1, "vip")).toBe(true)
        expect(api.count("/v1/perks/check")).toBe(3)
    end)

    test("at the period end the API is asked again: a renewed perk is kept without a handler", function()
        local perks, api, wall, fired, pass = client()
        api.grant(ALICE, "vip", T0 + HOUR)
        expect(perks.has(1, "vip")).toBe(true)
        api.grant(ALICE, "vip", T0 + 31 * DAY) -- renewed, and the event was missed
        pass(HOUR + 5)
        expect(#fired).toBe(0)
        local has, info = perks.has(1, "vip")
        expect(has).toBe(true)
        expect(info.expiresAt).toBe(T0 + 31 * DAY)
    end)

    test("at the period end, a perk that was not renewed is removed, once", function()
        local perks, api, wall, fired, pass = client()
        api.grant(ALICE, "vip", T0 + HOUR)
        expect(perks.has(1, "vip")).toBe(true)
        pass(HOUR + 120)
        expect(#fired).toBe(1)
        expect(fired[1].kind).toBe("removed")
        expect(fired[1].player).toBe(1)
        expect(fired[1].identifier).toBe(ALICE)
        expect(perks.has(1, "vip")).toBe(false)
    end)

    test("survives a restart through the host's storage, inside the same bounds", function()
        local storage = memoryStorage()
        local wall = { now = T0 }
        local api = fakeApi(wall)
        api.grant(ALICE, "founder", nil)
        api.grant(ALICE, "vip", T0 + HOUR)
        local first = client({ wall = wall, api = api, storage = storage })
        expect(first.has(1, "vip")).toBe(true)
        expect(storage.saves).toBe(1)
        expect(storage.data:find(TOKEN, 1, true)).toBeNil()

        -- The server restarts two hours later and the API is down.
        api.mode = "down"
        wall.now = T0 + 2 * HOUR
        local second = client({ wall = wall, api = api, storage = storage })
        local kept, info = second.has(1, "founder")
        expect(kept).toBe(true)
        expect(info.source).toBe("cache")
        -- The monthly perk ended while the server was down: it was not loaded at all.
        expect(second.has(1, "vip")).toBe(false)

        -- Three days later the stored answer is too old to trust.
        wall.now = T0 + 73 * HOUR
        local third = client({ wall = wall, api = api, storage = storage })
        expect(third.has(1, "founder")).toBe(false)
    end)

    test("does not rewrite storage for every question", function()
        local storage = memoryStorage()
        local perks, api, wall = client({ storage = storage })
        api.grant(ALICE, "vip", T0 + 30 * DAY)
        perks.has(1, "vip")
        for _ = 1, 3 do
            wall.now = wall.now + 601
            perks.has(1, "vip")
        end
        expect(api.count("/v1/perks/check")).toBe(4)
        expect(storage.saves).toBe(1)
        perks.has(2, "vip") -- a player with no perk is not stored
        expect(storage.saves).toBe(1)
    end)
end)

describe("perks: events", function()
    test("pulls the queue, applies each event and acknowledges it", function()
        local perks, api, wall, fired, pass = client()
        expect(perks.has(1, "vip")).toBe(false)
        api.grant(ALICE, "vip", T0 + 30 * DAY)
        local seq = api.push("granted", ALICE, "vip", T0 + 30 * DAY, "purchase")
        pass(31)
        expect(#fired).toBe(1)
        expect(fired[1].kind).toBe("granted")
        expect(fired[1].player).toBe(1)
        expect(fired[1].key).toBe("vip")
        expect(fired[1].reason).toBe("purchase")
        expect(fired[1].expiresAt).toBe(T0 + 30 * DAY)
        expect(api.acked).toBe(seq)
        expect(perks.status().cursor).toBe(seq)
        -- The cache was updated by the event: no new question to the API.
        local before = api.count("/v1/perks/check")
        expect(perks.has(1, "vip")).toBe(true)
        expect(api.count("/v1/perks/check")).toBe(before)
    end)

    test("a renewal moves the period end without calling a handler; a removal calls it", function()
        local perks, api, wall, fired, pass = client()
        api.grant(ALICE, "vip", T0 + DAY)
        expect(perks.has(1, "vip")).toBe(true)
        api.push("updated", ALICE, "vip", T0 + 31 * DAY, "renewed")
        pass(31)
        expect(#fired).toBe(0)
        local _, info = perks.has(1, "vip")
        expect(info.expiresAt).toBe(T0 + 31 * DAY)
        api.held[ALICE] = nil
        api.push("removed", ALICE, "vip", nil, "refunded")
        pass(31)
        expect(#fired).toBe(1)
        expect(fired[1].kind).toBe("removed")
        expect(fired[1].reason).toBe("refunded")
        local has = perks.has(1, "vip")
        expect(has).toBe(false)
    end)

    test("an event delivered twice is applied once", function()
        local perks, api, wall, fired, pass = client()
        expect(perks.has(1, "vip")).toBe(false)
        api.push("granted", ALICE, "vip", nil, "purchase")
        pass(31)
        expect(#fired).toBe(1)
        -- The acknowledgement was lost: the API still has the event in the queue.
        api.acked = 0
        local polls = api.count("/v1/perks/events")
        pass(31)
        expect(api.count("/v1/perks/events") > polls).toBe(true)
        expect(#fired).toBe(1)
        -- The client asks "since my cursor", whatever the API believes was acknowledged.
        expect(api.calls[#api.calls].query:find("after=1", 1, true)).toBeTruthy()
    end)

    test("tells the script about a player it never asked about, and caches nothing for them", function()
        local perks, api, wall, fired, pass = client()
        api.push("granted", BOB, "vip", T0 + DAY, "purchase")
        api.push("removed", "steam:offline", "vip", nil, "refunded")
        pass(31)
        expect(#fired).toBe(2)
        expect(fired[1].kind).toBe("granted")
        expect(fired[1].player).toBe(2)
        expect(fired[2].kind).toBe("removed")
        expect(fired[2].player).toBeNil()
        expect(fired[2].identifier).toBe("steam:offline")
        -- Nothing was cached for Bob: the next question goes to the API, the source of truth.
        api.grant(BOB, "vip", T0 + DAY)
        expect(perks.has(2, "vip")).toBe(true)
        expect(api.count("/v1/perks/check")).toBe(1)
    end)

    test("an event older than the last answer about the player is ignored", function()
        local perks, api, wall, fired, pass = client()
        api.push("granted", ALICE, "vip", T0 + DAY, "purchase") -- happened at T0
        wall.now = T0 + 10
        -- Refunded before the server asked: the answer already says "not held".
        expect(perks.has(1, "vip")).toBe(false)
        pass(31)
        expect(#fired).toBe(0)
        expect(perks.has(1, "vip")).toBe(false)
    end)

    test("backs off while the API cannot be reached, and calls no handler", function()
        local perks, api, wall, fired, pass = client()
        api.grant(ALICE, "vip", T0 + 30 * DAY)
        expect(perks.has(1, "vip")).toBe(true)
        api.mode = "down"
        pass(600)
        local polls = api.count("/v1/perks/events")
        expect(polls >= 3 and polls <= 6).toBe(true)
        expect(#fired).toBe(0)
        expect(perks.status().lastError).toBe("unreachable")
        api.mode = "up"
        pass(400)
        expect(perks.status().lastError).toBeNil()
    end)

    test("handlers can be removed", function()
        local perks, api, wall, fired, pass = client()
        local extra = 0
        local id = perks.on("granted", function() extra = extra + 1 end)
        api.push("granted", BOB, "vip", nil, "purchase")
        pass(31)
        expect(extra).toBe(1)
        expect(perks.off(id)).toBe(true)
        expect(perks.off(id)).toBe(false)
        api.push("granted", BOB, "founder", nil, "purchase")
        pass(31)
        expect(extra).toBe(1)
        expect(#fired).toBe(2)
        expect(function() perks.on("renamed", function() end) end).toThrow("granted")
    end)
end)

describe("perks: the purchase link and the catalog", function()
    test("asks for a link for one player and one perk", function()
        local perks, api = client()
        local url, expiresAt = perks.purchaseLink(1, "vip")
        expect(url).toBe("https://web.test/perk/signed.vip")
        expect(expiresAt).toBe(T0 + 900)
        expect(api.links[1].player).toBe(ALICE)
        expect(api.links[1].perk).toBe("vip")
        api.grant(ALICE, "vip", nil)
        local none, reason, message = perks.purchaseLink(1, "vip")
        expect(none).toBeNil()
        expect(reason).toBe("already_held")
        expect(message).toContain("already has")
        local catalog = perks.catalog()
        expect(catalog[1].key).toBe("vip")
    end)
end)

-- Through a host: ScriptGo.perks in a resource -----------------------------------------------------
local function hostWith(opts)
    opts = opts or {}
    local wall = { now = T0 }
    local api = fakeApi(wall)
    local files = {
        ["shop/scriptgo.lua"] = 'resource "shop"\nversion "1.0.0"\ncapabilities { "players", "perks" }\nserver_script "s.lua"\nclient_script "c.lua"\n',
        ["shop/s.lua"] = [[
            seen = {}
            exports("has", function(player, key)
                local has, info = ScriptGo.perks.has(player, key)
                return has, type(info) == "table" and info.source or info
            end)
            exports("link", function(player, key) return ScriptGo.perks.purchaseLink(player, key) end)
            exports("seen", function() return ScriptGo.json.encode(seen) end)
            ScriptGo.perks.on("granted", function(player, key, info) seen[#seen + 1] = "granted:" .. tostring(player) .. ":" .. key end)
            ScriptGo.perks.on("removed", function(player, key, info) seen[#seen + 1] = "removed:" .. tostring(player) .. ":" .. key .. ":" .. info.reason end)
            AddEventHandler("playerJoining", function()
                local player = source
                if ScriptGo.perks.has(player, "vip") then seen[#seen + 1] = "join-vip:" .. player end
            end)
        ]],
        ["shop/c.lua"] = 'exports("has", function() return ScriptGo.perks.has(1, "vip") end)',
        ["other/scriptgo.lua"] = 'resource "other"\nversion "1.0.0"\ncapabilities { "perks" }\nserver_script "s.lua"\n',
        ["other/s.lua"] = 'exports("has", function(player, key) return (ScriptGo.perks.has(player, key)) end)',
    }
    local adapter = testing.memoryAdapter({
        files = files, readFile = function() return nil end, capabilities = opts.capabilities,
        config = { _global = { scriptgo_api = API, scriptgo_server_token = opts.token == nil and TOKEN or opts.token or nil } },
        wallTime = function() return wall.now end,
    })
    adapter.http.request = api.request
    local h = testing.harness({ adapter = adapter })
    local function pass(seconds)
        for _ = 1, seconds do
            wall.now = wall.now + 1
            h.adapter.advance(1)
            h.host:tick(h.adapter.now())
        end
    end
    return h, api, wall, pass
end

describe("perks: through a host", function()
    test("a resource asks when a player joins, with the adapter's identifier", function()
        local h, api = hostWith()
        api.grant("local:ada", "vip", T0 + 30 * DAY)
        h:add("shop")
        expect(h:start("shop")).toBe(true)
        h:join(7, "Ada")
        expect(h:call("shop", "seen")).toBe('["join-vip:7"]')
        local asked
        for _, c in ipairs(api.calls) do
            if c.key == "POST /v1/perks/check" then asked = json.decode(c.req.body) end
        end
        expect(asked.player).toBe("local:ada")
        expect(asked.environment).toBe("standalone")
        local has, source = h:call("shop", "has", 7, "vip")
        expect(has).toBe(true)
        expect(source).toBe("cache")
        expect(h.host.capabilities.perks).toBe(true)
    end)

    test("the host pulls the queue from its tick and runs the handlers in the resource", function()
        local h, api, wall, pass = hostWith()
        h:add("shop")
        h:start("shop")
        h:join(7, "Ada")
        api.grant("local:ada", "vip", nil)
        api.push("granted", "local:ada", "vip", nil, "purchase")
        pass(31)
        expect(h:call("shop", "seen")).toBe('["granted:7:vip"]')
        api.held["local:ada"] = nil
        api.push("removed", "local:ada", "vip", nil, "refunded")
        pass(31)
        expect(h:call("shop", "seen")).toBe('["granted:7:vip","removed:7:vip:refunded"]')
        expect(api.acked).toBe(2)
    end)

    test("two resources share one client: one question, one queue", function()
        local h, api, wall, pass = hostWith()
        api.grant("local:ada", "vip", nil)
        h:add("shop")
        h:add("other")
        h:start("shop")
        h:start("other")
        h:join(7, "Ada")
        expect(h:call("other", "has", 7, "vip")).toBe(true)
        expect(h:call("shop", "has", 7, "vip")).toBe(true)
        expect(api.count("/v1/perks/check")).toBe(1)
        pass(61)
        expect(api.count("GET /v1/perks/events")).toBe(3)
    end)

    test("a stopped resource no longer gets events", function()
        local h, api, wall, pass = hostWith()
        h:add("shop")
        h:start("shop")
        h:join(7, "Ada")
        h:stop("shop")
        api.push("granted", "local:ada", "vip", nil, "purchase")
        pass(31)
        expect(h:findLog("perk handler failed")).toBeNil()
        expect(h:start("shop")).toBe(true)
        expect(h:call("shop", "seen")).toBe("[]")
    end)

    test("keeps the cache in the adapter's storage, without the token", function()
        local h, api = hostWith()
        api.grant("local:ada", "vip", nil)
        h:add("shop")
        h:start("shop")
        h:join(7, "Ada")
        local stored = h.adapter.storageData["scriptgo.perks"]
        expect(stored).toContain("local:ada")
        expect(stored:find(TOKEN, 1, true)).toBeNil()
    end)

    test("a host that is not linked: the script is told so, and nothing is asked", function()
        local h, api, wall, pass = hostWith({ token = false })
        h:add("shop")
        h:start("shop")
        h:join(7, "Ada")
        local has, why = h:call("shop", "has", 7, "vip")
        expect(has).toBe(false)
        expect(why).toBe("not_linked")
        pass(60)
        expect(#api.calls).toBe(0)
    end)

    test("is server side only, and needs the capability", function()
        local h = hostWith()
        h:add("shop")
        h:start("shop")
        local has, why = h:callClient("shop", "has")
        expect(has).toBe(false)
        expect(why).toBe("perks is server-side only")

        local off = hostWith({ capabilities = { events = true, logging = true, players = true, http = true } })
        off:add("shop")
        local ok, reason = off:start("shop")
        expect(ok).toBe(false)
        expect(reason).toBe("capability_unavailable:perks@standalone")
    end)

    test("without HTTP there are no perks, whatever the adapter says", function()
        local h = hostWith({ capabilities = { events = true, logging = true, players = true, perks = true } })
        expect(h.host.capabilities.perks).toBe(false)
        h:add("other")
        local ok, reason = h:start("other")
        expect(ok).toBe(false)
        expect(reason).toBe("capability_unavailable:perks@standalone")
    end)
end)

describe("perks: the registry declares it for every environment", function()
    test("supported, partial or unavailable, with the reason", function()
        local caps = scriptgo.capabilities
        local wired = { standalone = true, open77 = true, rust = true, dotnet = true }
        local n = 0
        for slug, e in pairs(caps.ENVIRONMENTS) do
            n = n + 1
            local support = (e.capabilities or {}).perks
            if support == nil then error(slug .. " does not declare perks") end
            if support ~= "supported" and support ~= "partial" and support ~= "unavailable" then error(slug .. ": perks = " .. tostring(support)) end
            local note = (e.notes or {}).perks
            if type(note) ~= "string" or #note < 10 then error(slug .. " gives no reason for perks = " .. support) end
            if (support ~= "unavailable") ~= (wired[slug] == true) then error(slug .. ": perks is " .. support .. " but the adapter is " .. (wired[slug] and "wired" or "not wired")) end
        end
        expect(n >= 20).toBe(true)
    end)
end)
