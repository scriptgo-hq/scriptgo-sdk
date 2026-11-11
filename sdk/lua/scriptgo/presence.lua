-- Player match (docs/spec/player-match.md): presence reporting and the `link` command, implemented
-- once for every host, like perks.lua.
--
-- 1. Presence (opt-in, `scriptgo_presence`, default off). While a player is connected, SCRIPT//GO is
--    told "this player is here, from this address", as HMAC-SHA256(presenceKey, normalised address):
--    a keyed fingerprint, never the address. The key comes from the API's answers and rotates. The
--    raw address never leaves the server and is never logged, nor are fingerprints.
-- 2. The code. A buyer whose browser could not be matched gets a short code on the page and types
--    `/link K7-4QX` in game; the server confirms it for the player who typed it.
--
--   local presence = M.new(services)
--   presence.joined(player)        a player joined: reported at once when presence is on
--   presence.left(player)          a player left: forgotten by SCRIPT//GO at once
--   presence.tick()                the host calls it about once a second; never blocks
--   presence.link(player, code)    -> true | false, reason      (waits for the API: call it from a thread)
--   presence.linkAsync(player, code, done)   the same, done(ok, reason) later; never blocks
--   presence.linkMessage(ok, reason, command) -> the plain sentence to show the player
--   presence.status()              -> { enabled, active, reason, reported, lastError, lastReportAt, rotatesAt }
--
-- Services (the host hands what it already has; no `os`, `io`, `debug`, `package`, `require` or
-- `setmetatable` here, so the file runs in the OPEN//77 sandbox and in the kits as well):
--   request(req, done)      asynchronous HTTP: req = { method, url, headers, body }; done({ status, body })
--   now()                   wall clock, Unix seconds
--   json                    { encode, decode }
--   config(key)             "scriptgo_api", "scriptgo_server_token", "scriptgo_presence",
--                           "scriptgo_perks_poll_seconds", "scriptgo_link_command"
--   identifier(player)      the platform's identifier of a connected player, or nil
--   name(player)            optional: the name the game shows for that player
--   address(player)         optional: the player's address ("203.0.113.9", "203.0.113.9:30120",
--                           "[2001:db8::1]:30120"...), or nil. Without it, only the code works.
--   players()               optional: the connected players (for the periodic refresh)
--   hmacSha256(key, msg)    optional: HMAC-SHA256 as lowercase hex, from a VETTED implementation the
--                           host already has (a platform crypto library). Never a Lua SHA-256: the
--                           project uses vetted cryptography only. Without it, presence is off and
--                           says why ("presence unavailable: no HMAC on this host"); the code works.
--   await(register)         optional: suspends the calling thread until register's callback runs (link only)
--   log(level, message)     optional
--   environment, adapterVersion   optional strings
local M = {}

M.PROTOCOL = 1
M.DEFAULT_COMMAND = "link"
M.NO_HMAC = "presence unavailable: no HMAC on this host"
M.NO_ADDRESS = "presence unavailable: this host cannot read a player's address"

local floor = math.floor

-- "2026-11-13T10:00:00.000Z" -> Unix seconds (UTC), by arithmetic (as in perks.lua).
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

local function validIdentifier(id)
    return type(id) == "string" and #id >= 1 and #id <= 128 and id:find("^[\33-\126]+$") ~= nil
end

-- An operator's yes: "1", "true", "on", "yes" (any case), or a boolean true.
local function truthy(v)
    if v == true then return true end
    if type(v) == "number" then return v ~= 0 end
    if type(v) ~= "string" then return false end
    v = v:lower()
    return v == "1" or v == "true" or v == "on" or v == "yes"
end
M.truthy = truthy

-- Address normalisation ----------------------------------------------------------------------------
-- The one canonical text both sides hash (the API computes the browser's the same way):
--   IPv4                      dotted quad, decimal, no leading zeros:   203.0.113.9
--   IPv4-mapped IPv6          the IPv4 address:                         ::ffff:203.0.113.9 -> 203.0.113.9
--   any other IPv6            its /64: the first four groups in lowercase hex without leading zeros,
--                             never compressed, then "::/64":           2001:db8:0:1::/64
-- A port, brackets and an IPv6 zone (%eth0) are dropped. Anything else (a host name) is nil.
local function ipv4(text)
    local a, b, c, d = text:match("^(%d+)%.(%d+)%.(%d+)%.(%d+)$")
    if not a then return nil end
    local parts = { tonumber(a), tonumber(b), tonumber(c), tonumber(d) }
    for i = 1, 4 do
        if not parts[i] or parts[i] > 255 or #({ a, b, c, d })[i] > 3 then return nil end
    end
    return parts
end

-- IPv6 text -> eight 16-bit numbers, or nil.
local function ipv6(text)
    if text:find("[^%x:%.]") then return nil end
    local tail4
    local dotted = text:match(":(%d+%.%d+%.%d+%.%d+)$")
    if dotted then
        tail4 = ipv4(dotted)
        if not tail4 then return nil end
        text = text:sub(1, #text - #dotted) .. "0:0"
    end
    local function groups(part)
        local out = {}
        if part == "" then return out end
        for g in (part .. ":"):gmatch("([^:]*):") do
            if g == "" or #g > 4 then return nil end
            out[#out + 1] = tonumber(g, 16)
        end
        return out
    end
    local head, rest = text:match("^(.-)::(.*)$")
    local list
    if head then
        if rest:find("::", 1, true) then return nil end
        local h, r = groups(head), groups(rest)
        if not h or not r or #h + #r > 7 then return nil end
        list = {}
        for _, g in ipairs(h) do list[#list + 1] = g end
        for _ = 1, 8 - #h - #r do list[#list + 1] = 0 end
        for _, g in ipairs(r) do list[#list + 1] = g end
    else
        list = groups(text)
        if not list or #list ~= 8 then return nil end
    end
    if tail4 then
        list[7] = tail4[1] * 256 + tail4[2]
        list[8] = tail4[3] * 256 + tail4[4]
    end
    return list
end

function M.normalizeAddress(text)
    if type(text) ~= "string" then return nil end
    text = text:match("^%s*(.-)%s*$")
    if text == "" or #text > 128 then return nil end
    local bracketed = text:match("^%[([^%]]+)%]") -- [v6]:port or [v6]
    if bracketed then text = bracketed end
    -- IPv4 with a port: one colon.
    local host4 = text:match("^(%d+%.%d+%.%d+%.%d+):%d+$")
    if host4 then text = host4 end
    local v4 = ipv4(text)
    if v4 then return table.concat(v4, ".") end
    text = text:gsub("%%.*$", "") -- zone
    local g = ipv6(text:lower())
    if not g then return nil end
    if g[1] == 0 and g[2] == 0 and g[3] == 0 and g[4] == 0 and g[5] == 0 and g[6] == 0xffff then
        return ("%d.%d.%d.%d"):format(floor(g[7] / 256), g[7] % 256, floor(g[8] / 256), g[8] % 256)
    end
    return ("%x:%x:%x:%x::/64"):format(g[1], g[2], g[3], g[4])
end

-- A name of at most 64 bytes, never cut inside a UTF-8 character.
local function shortName(name)
    if #name <= 64 then return name end
    return (name:sub(1, 64):gsub("[\192-\255][\128-\191]*$", ""))
end

-- Percent-encoding for a path segment (identifiers are printable ASCII, so this is enough).
local function encodeSegment(s)
    return (s:gsub("[^%w%-%._~]", function(c) return ("%%%02X"):format(c:byte()) end))
end

-- What the player reads after /link. Plain words; `command` is the command's name.
local MESSAGES = {
    ok = "Linked: you can go back to your browser.",
    usage = "Type the code your browser shows, for example: /%s K7-4QX",
    invalid_code = "That code is not valid: it may be mistyped, already used, or older than 10 minutes. Ask the page for a new one.",
    not_linked = "This server is not linked to SCRIPT//GO, so it cannot link you. Tell the server's operator.",
    unknown_player = "This server cannot tell who you are, so it cannot link you.",
    rate_limited = "Too many tries. Wait a minute, then try again.",
    unreachable = "SCRIPT//GO could not be reached. Try again in a minute.",
}
-- API refusal codes that all mean "this code will not work".
local CODE_REFUSALS = { unknown_code = true, code_expired = true, code_used = true, invalid_code = true, validation_failed = true }

function M.linkMessage(ok, reason, command)
    if ok then return MESSAGES.ok end
    command = command or M.DEFAULT_COMMAND
    if reason == "usage" then return MESSAGES.usage:format(command) end
    if CODE_REFUSALS[reason] then return MESSAGES.invalid_code end
    if MESSAGES[reason] then return MESSAGES[reason] end
    return "The code could not be confirmed (" .. tostring(reason) .. ")."
end

-- A typed code: letters and digits, any case, with or without the dash. Sent upper case, as typed
-- otherwise; the API compares codes ignoring case, spaces and dashes.
function M.normalizeCode(code)
    if type(code) ~= "string" then return nil end
    code = code:gsub("%s+", ""):upper()
    if code == "" or #code > 16 or code:find("[^A-Z0-9%-]") then return nil end
    local bare = code:gsub("%-", "")
    if #bare < 4 or #bare > 12 then return nil end
    return code
end

function M.new(s)
    if not (type(s) == "table" and type(s.request) == "function" and type(s.now) == "function"
        and type(s.identifier) == "function" and type(s.json) == "table" and type(s.config) == "function") then
        error("scriptgo.presence.new: request, now, identifier, json and config are required", 2)
    end
    local json = s.json
    local pollSeconds = tonumber(s.pollSeconds) or 30

    local state = {
        key = nil, rotatesAt = nil, nextRefresh = 0, sending = false, failures = 0,
        lastError = nil, lastReportAt = nil, reported = 0, said = nil,
    }
    local known = {}     -- player handle -> identifier, for those SCRIPT//GO was told about

    local function log(level, message)
        if s.log then pcall(s.log, level, message) end
    end

    local function setting(key)
        local v = s.config(key)
        if type(v) == "string" and v ~= "" then return v end
        return nil
    end

    local function pollEvery()
        local v = tonumber(s.config("scriptgo_perks_poll_seconds"))
        if v and v >= 1 then return v end
        return pollSeconds
    end

    local function apiBase()
        return ((setting("scriptgo_api") or "https://api.scriptgo.dev"):gsub("/+$", ""))
    end

    -- done(decoded) on 2xx; done(nil, reason[, error]). "not_linked": no token or 401/403.
    -- "rate_limited": 429. "unreachable": network, 5xx, 408. Anything else: the API's refusal code.
    local function call(method, path, body, done)
        local token = setting("scriptgo_server_token")
        if not token then return done(nil, "not_linked") end
        local req = { method = method, url = apiBase() .. path, headers = { authorization = "Bearer " .. token, accept = "application/json" } }
        if body ~= nil then
            req.headers["content-type"] = "application/json"
            -- A string is sent as is (an empty report: every JSON encoder agrees on '[]' then).
            req.body = type(body) == "string" and body or json.encode(body)
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
            if status == 401 or status == 403 then return finish(nil, "not_linked") end
            if status == 429 then return finish(nil, "rate_limited") end
            local decoded
            local okd, d = pcall(json.decode, response.body or "")
            if okd and type(d) == "table" then decoded = d end
            if status >= 200 and status < 300 then return finish(decoded or {}) end
            if status >= 400 and status < 500 and status ~= 408 then
                local e = decoded and type(decoded.error) == "table" and decoded.error or nil
                return finish(nil, tostring(e and e.code or ("http_" .. status)), e)
            end
            return finish(nil, "unreachable")
        end)
        if not ok then
            log("warn", "presence: the HTTP request could not be made: " .. tostring(err))
            finish(nil, "unreachable")
        end
    end

    -- Why presence is not running, or nil when it is.
    local function blocked()
        if not truthy(s.config("scriptgo_presence")) then return "off" end
        if not setting("scriptgo_server_token") then return "not_linked" end
        if type(s.address) ~= "function" then return M.NO_ADDRESS end
        if type(s.hmacSha256) ~= "function" then return M.NO_HMAC end
        return nil
    end

    -- Says a reason once (and again when it changes), never per tick.
    local function say(reason)
        if reason == state.said then return end
        state.said = reason
        if reason and reason ~= "off" then log("warn", reason) end
    end

    -- One player's presence entry, or nil (no identifier, no readable address, or no fingerprint).
    -- The address is used here and dropped; it is never stored, sent or logged.
    local function entryFor(player, key)
        local okId, id = pcall(s.identifier, player)
        if not okId or not validIdentifier(id) then return nil end
        local okAddr, raw = pcall(s.address, player)
        local normalised = okAddr and M.normalizeAddress(raw) or nil
        if not normalised then return nil end
        local okFp, fp = pcall(s.hmacSha256, key, normalised)
        if not okFp or type(fp) ~= "string" or not fp:find("^%x+$") or #fp ~= 64 then
            say("presence unavailable: the host's HMAC failed")
            return nil
        end
        local name = id
        if s.name then
            local okName, n = pcall(s.name, player)
            if okName and type(n) == "string" and n ~= "" then name = n end
        end
        return { player = id, name = shortName(name), fp = { fp:lower() } }, id
    end

    local function connected()
        if not s.players then
            local out = {}
            for handle in pairs(known) do out[#out + 1] = handle end
            return out
        end
        local ok, list = pcall(s.players)
        return ok and type(list) == "table" and list or {}
    end

    -- Sends the presence of `handles` (nil: every connected player). Without a key, an empty report
    -- fetches it first; an answer whose key differs from the one used sends again at once.
    local function report(handles, retried)
        if state.sending then
            state.nextRefresh = 0
            return
        end
        local key = state.key
        local entries, ids = {}, {}
        if key then
            for _, h in ipairs(handles or connected()) do
                local e, id = entryFor(h, key)
                if e then
                    entries[#entries + 1] = e
                    ids[#ids + 1] = { h, id }
                end
            end
            if #entries == 0 and handles then return end
        end
        state.sending = true
        local body = #entries > 0 and { players = entries } or '{"players":[]}'
        call("POST", "/v1/presence", body, function(answer, reason)
            state.sending = false
            local now = s.now()
            if not answer then
                state.lastError = reason
                state.failures = state.failures + 1
                local wait = pollEvery() * (2 ^ math.min(state.failures - 1, 4))
                state.nextRefresh = now + math.min(wait, 300)
                if reason == "not_linked" then
                    known = {}
                    state.reported = 0
                end
                return
            end
            state.lastError, state.failures = nil, 0
            -- The key is a plain token (16 to 128 of A-Z a-z 0-9 _ -): anything else is ignored.
            local k = answer.presenceKey
            local newKey = type(k) == "string" and #k >= 16 and #k <= 128 and k:find("^[%w_%-]+$") and k or nil
            state.rotatesAt = parseIsoTime(answer.rotatesAt)
            for _, pair in ipairs(ids) do known[pair[1]] = pair[2] end
            if #entries > 0 then
                state.lastReportAt = now
                state.reported = #entries
            end
            if not handles then state.nextRefresh = now + pollEvery() end
            if newKey and newKey ~= key then
                state.key = newKey
                -- Report again with the new key at once; once only, whatever the API answers then.
                if not retried then report(handles, true) end
            end
        end)
    end

    local api = {}

    function api.joined(player)
        local why = blocked()
        if why then return end
        if state.key then report({ player }) else state.nextRefresh = 0 end
    end

    function api.left(player)
        local id = known[player]
        if id == nil then return end
        known[player] = nil
        if blocked() == "off" then return end
        call("DELETE", "/v1/presence/" .. encodeSegment(id), nil, function() end)
    end

    function api.tick()
        local why = blocked()
        say(why)
        if why then return end
        local now = s.now()
        if state.sending then return end
        local due = now >= state.nextRefresh or (state.rotatesAt ~= nil and now >= state.rotatesAt)
        if not due then return end
        if state.rotatesAt and now >= state.rotatesAt then state.rotatesAt = nil end
        if #connected() == 0 then
            state.nextRefresh = now + pollEvery()
            return
        end
        report(nil)
    end

    -- Confirms a code the player typed; done(true) or done(false, reason). Never blocks.
    function api.linkAsync(player, code, done)
        local typed = M.normalizeCode(code)
        if not typed then return done(false, (code == nil or code == "") and "usage" or "invalid_code") end
        local okId, id = pcall(s.identifier, player)
        if not okId or not validIdentifier(id) then return done(false, "unknown_player") end
        local body = { code = typed, player = id }
        if s.name then
            local okName, n = pcall(s.name, player)
            if okName and type(n) == "string" and n ~= "" then body.name = shortName(n) end
        end
        call("POST", "/v1/identity/codes/confirm", body, function(answer, reason)
            if answer then
                log("info", "presence: a link code was confirmed for a player")
                return done(true)
            end
            return done(false, reason)
        end)
    end

    -- The same, waiting for the API: call it from a thread.
    function api.link(player, code)
        if not s.await then return false, "await_unavailable" end
        return s.await(function(resume) api.linkAsync(player, code, resume) end)
    end

    function api.linkMessage(ok, reason) return M.linkMessage(ok, reason, api.command()) end

    -- The name of the link command, or nil when the operator switched it off ("" or "off").
    function api.command()
        local v = s.config("scriptgo_link_command")
        if v == nil then return M.DEFAULT_COMMAND end
        if type(v) ~= "string" then return nil end
        v = v:gsub("^%s*/?", ""):gsub("%s+$", ""):lower()
        if v == "" or v == "off" or v == "false" or v == "0" or not v:find("^[%w_%-%.]+$") then return nil end
        return v
    end

    function api.status()
        local why = blocked()
        return {
            enabled = why ~= "off", active = why == nil, reason = why,
            reported = state.reported, lastError = state.lastError,
            lastReportAt = state.lastReportAt, rotatesAt = state.rotatesAt,
        }
    end

    return api
end

return M
