-- Player perks (ADR-0038, docs/spec/perks.md): the one implementation every host shares.
--
-- An operator sells a perk (a monthly VIP, a one-time rank) to the players of their own servers, from
-- their own store. The payment provider tells SCRIPT//GO; this module asks SCRIPT//GO; the operator's
-- own script applies the perk. The game server never talks to the payment provider.
--
--   local perks = M.new(services)
--   perks.has(player, "vip")            -> true, info | false, reason      (waits for the API)
--   perks.list(player)                  -> { { key = "vip", expiresAt = <unix or nil> }, ... } | nil, reason
--   perks.on("granted" | "removed", fn) -> handler id; fn(player, key, info)
--   perks.purchaseLink(player, "vip")   -> url, expiresAt | nil, reason
--   perks.tick()                        the host calls it; it pulls the event queue and never blocks
--
-- It depends on the host for exactly this (the `services` table), and on nothing else: no `os`, `io`,
-- `debug`, `package`, `require` or `setmetatable`, so the same file runs in the portable host, in the
-- OPEN//77 sandbox and in a host kit.
--
--   request(req, done)   asynchronous HTTP: req = { method, url, headers, body }; done({ status, body })
--   await(register)      suspends the calling thread: `register(resume)` starts the work, and the
--                        values given to `resume` are returned. Only has/list/purchaseLink/catalog use it.
--   identifier(player)   the platform's identifier string of a connected player, or nil
--   findPlayer(id)       optional: the connected player with that identifier, or nil
--   now()                wall clock, Unix seconds
--   json                 { encode, decode }
--   config(key)          a host setting: "scriptgo_api", "scriptgo_server_token" and, optionally,
--                        "scriptgo_perks_poll_seconds" (how often the event queue is pulled; 30)
--   dispatch(fn, ...)    runs a handler (in its own thread where the host has threads)
--   log(level, message)  optional
--   storage              optional: { load() -> table or nil, save(table) }; the cache survives a restart
--   environment, adapterVersion   optional strings, sent to the API for the operator's dashboard
--   pollSeconds (30), refreshSeconds (600), retrySeconds (30)   optional
--
-- The cache. What the API said about a player is kept in memory (and in `storage` when the host has
-- one), so a server that loses the API does not strip its players at once. It is bounded twice, and
-- neither bound is ever passed: a perk is not trusted after its period end (`expiresAt`), nor after
-- the offline grace the API gave with its answer (`offlineGraceUntil`, never later than the period
-- end). At a bound the API is asked again; when it cannot be reached the perk is removed, with the
-- handler called. A server whose link token is unknown or revoked gets nothing and keeps nothing.
local M = {}

M.PROTOCOL = 1
-- Used when an answer carries no offline grace (it always does): the API's documented default.
M.DEFAULT_OFFLINE_GRACE = 72 * 3600

local floor = math.floor
local HUGE = math.huge

-- "2026-11-13T10:00:00.000Z" -> Unix seconds (UTC), by arithmetic: hosts differ on date formatting,
-- and some have no date library at all.
local function parseIsoTime(text)
    if type(text) ~= "string" then return nil end
    local y, mo, d, h, mi, s = text:match("^(%d+)-(%d+)-(%d+)T(%d+):(%d+):(%d+)")
    if not y then return nil end
    y, mo, d = tonumber(y), tonumber(mo), tonumber(d)
    if mo <= 2 then y = y - 1 end
    local era = floor(y / 400)
    local yoe = y - era * 400
    local doy = floor((153 * (mo + (mo > 2 and -3 or 9)) + 2) / 5) + d - 1
    local doe = yoe * 365 + floor(yoe / 4) - floor(yoe / 100) + doy
    return (era * 146097 + doe - 719468) * 86400 + tonumber(h) * 3600 + tonumber(mi) * 60 + tonumber(s)
end
M.parseIsoTime = parseIsoTime

-- A player identifier as the API accepts it: 1 to 128 printable ASCII characters, no spaces.
local function validIdentifier(id)
    return type(id) == "string" and #id >= 1 and #id <= 128 and id:find("^[\33-\126]+$") ~= nil
end
M.validIdentifier = validIdentifier

local function validKey(key)
    return type(key) == "string" and #key >= 1 and #key <= 64 and key:find("^[a-z0-9][a-z0-9_%.%-]*$") ~= nil
end

-- The instant after which a cached perk is no longer trusted without asking again.
local function trustUntil(p)
    local t = p.graceUntil or HUGE
    if p.expiresAt and p.expiresAt < t then t = p.expiresAt end
    return t
end

function M.new(s)
    if not (type(s) == "table" and type(s.request) == "function" and type(s.now) == "function"
        and type(s.identifier) == "function" and type(s.json) == "table" and type(s.config) == "function") then
        error("scriptgo.perks.new: request, now, identifier, json and config are required", 2)
    end
    local json = s.json
    local pollSeconds = tonumber(s.pollSeconds) or 30
    local refreshSeconds = tonumber(s.refreshSeconds) or 600
    local retrySeconds = tonumber(s.retrySeconds) or 30

    local cache = {}       -- identifier -> { perks = { [key] = { expiresAt, graceUntil, status } }, checkedAt, asOf, retryAt }
    local inflight = {}    -- identifier -> list of callbacks waiting for one request
    local handlers = { granted = {}, removed = {} }
    local nextHandler = 0
    local state = { linked = nil, cursor = nil, nextPoll = 0, polling = false, failures = 0, lastPollAt = nil, lastError = nil, nextSweep = 0 }

    local function log(level, message)
        if s.log then s.log(level, message) end
    end

    local function setting(key)
        local v = s.config(key)
        if type(v) == "string" and v ~= "" then return v end
        return nil
    end

    -- Seconds between two pulls of the event queue: the operator's setting, else the host's default.
    local function pollEvery()
        local v = tonumber(s.config("scriptgo_perks_poll_seconds"))
        if v and v >= 1 then return v end
        return pollSeconds
    end

    local function apiBase()
        return ((setting("scriptgo_api") or "http://localhost:4100"):gsub("/+$", ""))
    end

    -- Persistence ---------------------------------------------------------------------------------
    local function save()
        if not (s.storage and s.storage.save) then return end
        local players, any = {}, false
        for id, entry in pairs(cache) do
            local kept, has = {}, false
            for key, p in pairs(entry.perks) do
                kept[key] = { expiresAt = p.expiresAt, graceUntil = p.graceUntil, status = p.status }
                has = true
            end
            if has then
                players[id] = { perks = kept, asOf = entry.asOf }
                any = true
            end
        end
        local ok, err = pcall(s.storage.save, { v = 1, players = any and players or nil })
        if not ok then log("warn", "the perk cache could not be saved: " .. tostring(err)) end
    end

    local function load()
        if not (s.storage and s.storage.load) then return end
        local ok, data = pcall(s.storage.load)
        if not ok or type(data) ~= "table" or data.v ~= 1 or type(data.players) ~= "table" then return end
        local now = s.now()
        for id, saved in pairs(data.players) do
            if validIdentifier(id) and type(saved) == "table" and type(saved.perks) == "table" then
                -- checkedAt 0: the first question about this player asks the API again.
                local entry = { perks = {}, checkedAt = 0, asOf = tonumber(saved.asOf) or 0 }
                local has = false
                for key, p in pairs(saved.perks) do
                    if validKey(key) and type(p) == "table" and tonumber(p.graceUntil) then
                        local perk = { expiresAt = tonumber(p.expiresAt), graceUntil = tonumber(p.graceUntil), status = p.status }
                        -- A perk whose bound passed while the server was down is not loaded at all.
                        if now < trustUntil(perk) then
                            entry.perks[key] = perk
                            has = true
                        end
                    end
                end
                if has then cache[id] = entry end
            end
        end
    end

    -- Handlers ------------------------------------------------------------------------------------
    local function fire(kind, id, key, p, reason)
        local list = handlers[kind]
        if #list == 0 then return end
        local player = nil
        if s.findPlayer then
            local ok, found = pcall(s.findPlayer, id)
            if ok then player = found end
        end
        local snapshot = {}
        for i, h in ipairs(list) do snapshot[i] = h end
        for _, h in ipairs(snapshot) do
            local info = { identifier = id, perk = key, reason = reason, expiresAt = p and p.expiresAt or nil }
            local ok, err
            if s.dispatch then ok, err = pcall(s.dispatch, h.fn, player, key, info)
            else ok, err = pcall(h.fn, player, key, info) end
            if not ok then log("error", "perk handler failed: " .. tostring(err)) end
        end
    end

    -- A server that is not linked keeps nothing: every perk it believed in is removed.
    local function unlink()
        state.linked = false
        local had = false
        for id, entry in pairs(cache) do
            for key, p in pairs(entry.perks) do
                had = true
                fire("removed", id, key, p, "not_linked")
            end
        end
        cache = {}
        state.cursor = nil
        if had then save() end
    end

    -- HTTP ----------------------------------------------------------------------------------------
    -- done(decoded) on a 2xx JSON answer; done(nil, reason[, error]) otherwise. "not_linked": no
    -- token, or the API does not know it. "unreachable": the API could not answer (network, 5xx,
    -- 408, 429): nothing is decided by that. Anything else is the API's own refusal code.
    local function call(method, path, body, done)
        local token = setting("scriptgo_server_token")
        if not token then return done(nil, "not_linked") end
        local req = { method = method, url = apiBase() .. path, headers = { authorization = "Bearer " .. token, accept = "application/json" } }
        if body ~= nil then
            req.headers["content-type"] = "application/json"
            req.body = json.encode(body)
        end
        local settled = false
        local function finish(...)
            if settled then return end
            settled = true
            return done(...)
        end
        local ok, err = pcall(s.request, req, function(response)
            if type(response) ~= "table" then return finish(nil, "unreachable") end
            local status = tonumber(response.status) or 0
            if status == 401 or status == 403 then
                unlink()
                return finish(nil, "not_linked")
            end
            local decoded
            local okd, d = pcall(json.decode, response.body or "")
            if okd and type(d) == "table" then decoded = d end
            if status >= 200 and status < 300 and decoded then
                state.linked = true
                return finish(decoded)
            end
            if status >= 400 and status < 500 and status ~= 408 and status ~= 429 and decoded and type(decoded.error) == "table" then
                return finish(nil, tostring(decoded.error.code or ("http_" .. status)), decoded.error)
            end
            return finish(nil, "unreachable")
        end)
        if not ok then
            log("warn", "perks: the HTTP request could not be made: " .. tostring(err))
            finish(nil, "unreachable")
        end
    end

    -- The cache -----------------------------------------------------------------------------------
    local function holds(entry, key, now)
        local p = entry and entry.perks[key]
        return p ~= nil and now < trustUntil(p)
    end

    -- Replaces what is known about a player with the API's answer. The first answer about a player
    -- calls no handler (the caller is being told); a later one calls them for what changed.
    local function apply(id, answer)
        local now = s.now()
        local old = cache[id]
        local entry = { perks = {}, checkedAt = now, asOf = parseIsoTime(answer.serverTime) or now }
        if type(answer.perks) == "table" then
            for _, h in ipairs(answer.perks) do
                if type(h) == "table" and validKey(h.key) then
                    local expiresAt = parseIsoTime(h.expiresAt)
                    local graceUntil = parseIsoTime(h.offlineGraceUntil) or (now + M.DEFAULT_OFFLINE_GRACE)
                    if expiresAt and graceUntil > expiresAt then graceUntil = expiresAt end
                    entry.perks[h.key] = { expiresAt = expiresAt, graceUntil = graceUntil, status = h.status }
                end
            end
        end
        cache[id] = entry
        local changed = old == nil
        if old then
            for key, p in pairs(entry.perks) do
                local was = old.perks[key]
                if not was or was.expiresAt ~= p.expiresAt or math.abs((was.graceUntil or 0) - p.graceUntil) >= 3600 then changed = true end
            end
            for key in pairs(old.perks) do
                if not entry.perks[key] then changed = true end
            end
        end
        if old then
            for key, p in pairs(entry.perks) do
                if not old.perks[key] then fire("granted", id, key, p, "refreshed") end
            end
            for key, p in pairs(old.perks) do
                if not entry.perks[key] then fire("removed", id, key, p, "refreshed") end
            end
        end
        -- Not for every join: only when what is kept across a restart really changed.
        if changed and (next(entry.perks) ~= nil or (old and next(old.perks) ~= nil)) then save() end
    end

    -- The API could not be reached: what is past its bound is no longer trusted.
    local function dropUnverified(id)
        local entry = cache[id]
        if not entry then return end
        local now = s.now()
        local changed = false
        for key, p in pairs(entry.perks) do
            if now >= trustUntil(p) then
                entry.perks[key] = nil
                changed = true
                fire("removed", id, key, p, "unverified")
            end
        end
        if changed then save() end
    end

    -- Asks the API about one player. Concurrent questions about the same player share one request.
    local function fetchAsync(id, done)
        local waiting = inflight[id]
        if waiting then
            waiting[#waiting + 1] = done
            return
        end
        waiting = { done }
        inflight[id] = waiting
        call("POST", "/v1/perks/check", { player = id, environment = s.environment, adapterVersion = s.adapterVersion }, function(answer, reason)
            inflight[id] = nil
            if answer then
                apply(id, answer)
            elseif reason == "unreachable" then
                local entry = cache[id]
                if entry then entry.retryAt = s.now() + retrySeconds end
                dropUnverified(id)
            end
            for _, cb in ipairs(waiting) do
                if cb then cb(answer ~= nil, reason) end
            end
        end)
    end

    local function fetch(id)
        if not s.await then return false, "await_unavailable" end
        return s.await(function(resume) fetchAsync(id, resume) end)
    end

    local function identifierOf(player)
        if type(player) == "string" then
            if validIdentifier(player) then return player end
            return nil, "invalid_player"
        end
        local ok, id = pcall(s.identifier, player)
        if ok and validIdentifier(id) then return id end
        return nil, "unknown_player"
    end

    -- Brings the entry of a player up to date when it is missing, old, or at a bound. Returns the
    -- entry and whether the API answered now; or nil, reason.
    local function current(id, key)
        if not setting("scriptgo_server_token") then return nil, "not_linked" end
        local now = s.now()
        local entry = cache[id]
        local atBound = false
        if entry then
            for k, p in pairs(entry.perks) do
                if (key == nil or k == key) and now >= trustUntil(p) then atBound = true end
            end
        end
        local due = entry == nil or atBound or (now - entry.checkedAt) >= refreshSeconds
        if due and entry and entry.retryAt and now < entry.retryAt and not atBound then due = false end
        if not due then return entry, false end
        local ok, reason = fetch(id)
        entry = cache[id]
        if ok then return entry, true end
        if reason ~= "unreachable" then return nil, reason end
        if not entry then return nil, "unreachable" end
        return entry, false
    end

    -- Events --------------------------------------------------------------------------------------
    local function applyEvent(ev)
        local id, key = ev.player, ev.perk
        if not validIdentifier(id) or not validKey(key) then return false end
        local entry = cache[id]
        local at = parseIsoTime(ev.at)
        -- What the API said about this player after the event happened already includes it.
        if entry and at and at < entry.asOf then return false end
        if ev.kind == "removed" then
            if not entry then
                fire("removed", id, key, nil, tostring(ev.reason))
                return false
            end
            local p = entry.perks[key]
            if not p then return false end
            entry.perks[key] = nil
            fire("removed", id, key, p, tostring(ev.reason))
            return true
        end
        if ev.kind ~= "granted" and ev.kind ~= "updated" then return false end
        local now = s.now()
        local expiresAt = parseIsoTime(ev.expiresAt)
        local graceUntil = parseIsoTime(ev.offlineGraceUntil) or (now + M.DEFAULT_OFFLINE_GRACE)
        if expiresAt and graceUntil > expiresAt then graceUntil = expiresAt end
        local p = { expiresAt = expiresAt, graceUntil = graceUntil, status = ev.status }
        if not entry then
            -- A player nobody asked about yet: the script is told, nothing is cached (the whole
            -- truth about a player comes from a check, and the next question asks for it).
            if ev.kind == "granted" then fire("granted", id, key, p, tostring(ev.reason)) end
            return false
        end
        local had = entry.perks[key] ~= nil
        entry.perks[key] = p
        if not had then fire("granted", id, key, p, tostring(ev.reason)) end
        return true
    end

    local function poll(now)
        state.polling = true
        local path = "/v1/perks/events?limit=100"
        if state.cursor then path = path .. "&after=" .. tostring(state.cursor) end
        call("GET", path, nil, function(answer, reason)
            state.polling = false
            state.lastPollAt = s.now()
            if not answer then
                state.lastError = reason
                state.failures = state.failures + 1
                local wait = pollEvery() * (2 ^ math.min(state.failures - 1, 4))
                state.nextPoll = s.now() + math.min(wait, 300)
                return
            end
            state.lastError, state.failures = nil, 0
            local changed, top = false, state.cursor or 0
            if type(answer.events) == "table" then
                for _, ev in ipairs(answer.events) do
                    local seq = type(ev) == "table" and tonumber(ev.seq) or nil
                    -- Each event once: a sequence number at or below the cursor was already applied.
                    if seq and seq > top then
                        if applyEvent(ev) then changed = true end
                        top = seq
                    end
                end
            end
            local cursor = tonumber(answer.cursor)
            if cursor and cursor > top then top = cursor end
            local advanced = state.cursor == nil or top > state.cursor
            state.cursor = top
            if changed then save() end
            if advanced and top > 0 then
                call("POST", "/v1/perks/events/ack", { upTo = top }, function() end)
            end
            state.nextPoll = answer.more == true and s.now() or (s.now() + pollEvery())
        end)
    end

    -- Perks that reached a bound without anybody asking: the API is asked again.
    local function sweep(now)
        for id, entry in pairs(cache) do
            if not inflight[id] and now >= (entry.retryAt or 0) then
                for _, p in pairs(entry.perks) do
                    if now >= trustUntil(p) then
                        fetchAsync(id, false)
                        break
                    end
                end
            end
        end
    end

    -- Public --------------------------------------------------------------------------------------
    local api = {}

    function api.has(player, key)
        if not validKey(key) then return false, "invalid_perk" end
        local id, why = identifierOf(player)
        if not id then return false, why end
        local entry, fresh = current(id, key)
        if not entry then return false, fresh end
        if holds(entry, key, s.now()) then
            local p = entry.perks[key]
            return true, { expiresAt = p.expiresAt, status = p.status, source = fresh and "api" or "cache" }
        end
        return false, "not_held"
    end

    function api.list(player)
        local id, why = identifierOf(player)
        if not id then return nil, why end
        local entry, fresh = current(id, nil)
        if not entry then return nil, fresh end
        local now, out = s.now(), {}
        for key, p in pairs(entry.perks) do
            if now < trustUntil(p) then out[#out + 1] = { key = key, expiresAt = p.expiresAt, status = p.status } end
        end
        table.sort(out, function(a, b) return a.key < b.key end)
        return out
    end

    -- Forgets what is cached about a player and asks the API again.
    function api.refresh(player)
        local id, why = identifierOf(player)
        if not id then return false, why end
        local entry = cache[id]
        if entry then entry.checkedAt, entry.retryAt = 0, nil end
        local got, reason = current(id, nil)
        if not got then return false, reason end
        return true
    end

    function api.purchaseLink(player, key)
        if not validKey(key) then return nil, "invalid_perk" end
        local id, why = identifierOf(player)
        if not id then return nil, why end
        if not s.await then return nil, "await_unavailable" end
        local answer, reason, err = s.await(function(resume)
            call("POST", "/v1/perks/purchase-link", { player = id, perk = key }, resume)
        end)
        if not answer then return nil, reason, type(err) == "table" and err.message or nil end
        return answer.url, parseIsoTime(answer.expiresAt)
    end

    function api.catalog()
        if not s.await then return nil, "await_unavailable" end
        local answer, reason = s.await(function(resume) call("GET", "/v1/perks/catalog", nil, resume) end)
        if not answer then return nil, reason end
        return answer
    end

    function api.on(kind, fn)
        if (kind ~= "granted" and kind ~= "removed") or type(fn) ~= "function" then
            error('ScriptGo.perks.on(kind, fn): kind is "granted" or "removed", fn a function', 2)
        end
        nextHandler = nextHandler + 1
        local list = handlers[kind]
        list[#list + 1] = { id = nextHandler, fn = fn }
        return nextHandler
    end

    function api.off(id)
        for _, list in pairs(handlers) do
            for i, h in ipairs(list) do
                if h.id == id then
                    table.remove(list, i)
                    return true
                end
            end
        end
        return false
    end

    -- Called by the host on its own clock (every tick, or about once a second). Never blocks.
    function api.tick()
        if not setting("scriptgo_server_token") then return end
        local now = s.now()
        if not state.polling and now >= state.nextPoll then poll(now) end
        if now >= state.nextSweep then
            state.nextSweep = now + 1
            sweep(now)
        end
    end

    function api.status()
        return {
            linked = state.linked, configured = setting("scriptgo_server_token") ~= nil,
            cursor = state.cursor, lastPollAt = state.lastPollAt, lastError = state.lastError,
        }
    end

    load()
    return api
end

return M
