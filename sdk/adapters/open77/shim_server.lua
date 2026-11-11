-- SCRIPT//GO on OPEN//77, server part. Packed as `scriptgo_shim_server.lua`, the first server_script.
-- Fills the server-only members of the namespace scriptgo_shim.lua created.
--
-- `scriptgo pack` keeps a `@capability <name>` ... `@end` section only when the manifest asks for
-- that capability, so the packed resource references (and declares permissions for) no native it
-- does not use.
local SG = ScriptGo
local O = SG._open77
local J, validPlayer = O.json, O.validPlayer
local resourceName = GetCurrentResourceName()

SG.time.now = function() return Open77.time.unix() end

-- @capability players
-- Player ids are integers >= 1; OPEN//77 stops a resource that passes 0 to a player lookup, so
-- every lookup is guarded here.
O.caps.players = true
SG.players = {
    list = function() return GetPlayers() end,
    name = function(id) if validPlayer(id) then return GetPlayerName(id) end return nil end,
    exists = function(id) return validPlayer(id) and GetPlayerName(id) ~= nil end,
    identifier = function(id) if validPlayer(id) then return Open77.players.identifier(id) end return nil end,
}
-- @end

-- @capability permissions
-- Needs `acl.read`, which `scriptgo pack` adds when the manifest asks for the permissions capability.
O.caps.permissions = true
SG.permissions = {
    has = function(playerId, privilege)
        if playerId == 0 then return true end
        if not validPlayer(playerId) then return false end
        return Open77.acl.isAllowed(playerId, privilege) == true
    end,
}
-- @end

-- @capability config
-- Config: "<resource>:<key>" from the server's convars, then the resource's tunables (GetConvar's
-- own fall-through). JSON text is decoded, numbers and booleans are converted.
O.caps.config = true
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
-- @end

-- @capability ui
-- Needs `network.events`, which `scriptgo pack` adds when the manifest asks for the ui capability.
O.caps.ui = true
SG.ui = {
    notify = function(target, payload)
        if type(payload) ~= "table" then return false, "invalid_payload" end
        if target == -1 then return Open77.notifications.broadcast(O.toNotification(payload)) end
        if not validPlayer(target) then return false, "invalid_target" end
        return Open77.notifications.send(target, O.toNotification(payload))
    end,
}
-- @end

-- @capability http
-- Needs `http.request`, which `scriptgo pack` adds, and an operator who enabled outbound HTTP in
-- server.jsonc (`http.enabled` and `http.allowedHosts`). Same contract as a SCRIPT//GO host:
-- inside a thread, `request{ method, url, headers, body }` waits and returns
-- `{ status, body, headers, error }`, status 0 when the exchange did not complete; a request the
-- host refuses at once returns nil, reason (host_not_allowed, http_unavailable, ...).
local function httpRequest(opts)
    if type(opts) ~= "table" or type(opts.url) ~= "string" then return nil, "invalid_request" end
    local p = promise.new()
    local ok, reason = Open77.http.request(opts.url, function(status, body, headers, err)
        p:resolve({ status = status or 0, body = body or "", headers = headers or {}, error = err })
    end, opts.method or "GET", opts.body, opts.headers)
    if ok == false then return nil, reason end
    return Citizen.Await(p)
end
O.caps.http = true
SG.http = { request = httpRequest }
-- @end

-- @capability licensing
-- Talks to the SCRIPT//GO API at the `scriptgo_api` convar (default https://api.scriptgo.dev), with
-- the request and answer shapes of a SCRIPT//GO host: the decoded answer, or nil, reason[, body].
-- The operator allows the API host in server.jsonc `http.allowedHosts`.
do
    local function apiBase()
        local v = GetConvar("scriptgo_api", "")
        if v == nil or v == "" then return "https://api.scriptgo.dev" end
        return (v:gsub("/+$", ""))
    end
    local function call(path, body)
        local p = promise.new()
        local ok, reason = Open77.http.request(apiBase() .. path, function(status, text, headers, err)
            p:resolve({ status = status or 0, body = text or "", error = err })
        end, "POST", J.encode(body), { ["content-type"] = "application/json" })
        if ok == false then return nil, reason end
        local response = Citizen.Await(p)
        if response.status == 0 then return nil, response.error or "http_failed" end
        local dok, decoded = pcall(J.decode, response.body)
        if not dok then return nil, "invalid_response (" .. tostring(response.status) .. ")" end
        if response.status >= 400 then
            local e = type(decoded) == "table" and decoded.error
            return nil, (type(e) == "table" and e.code) or ("http_" .. tostring(response.status)), decoded
        end
        return decoded
    end
    O.caps.licensing = true
    SG.licensing = {
        activate = function(opts)
            return call("/v1/licenses/activate", {
                licenseKey = opts.licenseKey, package = opts.package, environment = "open77",
                deploymentName = opts.deploymentName, adapterVersion = SG.runtime.adapterVersion(),
            })
        end,
        verify = function(opts)
            return call("/v1/licenses/verify", {
                licenseKey = opts.licenseKey, deploymentToken = opts.deploymentToken,
                package = opts.package, environment = "open77", adapterVersion = SG.runtime.adapterVersion(),
            })
        end,
    }
end
-- @end

-- @capability perks
-- Player perks (ADR-0038): what the operator sold to a player from their own store, asked from the
-- SCRIPT//GO API. Nothing here talks to a payment provider, and nothing of this is in OPEN//77
-- itself: it is this Lua file calling SCRIPT//GO over the server's allowed HTTP.
--
-- The logic is the portable core's module (sdk/lua/scriptgo/perks.lua), included below by
-- `scriptgo pack` word for word: one implementation for every host. This section only hands it what
-- OPEN//77 has: Open77.http.request (permission `http.request`, which `scriptgo pack` adds, and an
-- operator who allows the API host in server.jsonc), Open77.players.identifier (the player's durable
-- authenticated identifier), the wall clock and the resource's kvp for the cache.
--
-- Convars: `scriptgo_api` (default https://api.scriptgo.dev) and `scriptgo_server_token` (the sg_srv_
-- token of the server link made in the SCRIPT//GO dashboard). The shim is packed per resource, so each
-- resource that uses perks pulls the event queue on its own.
do
    local Core = (function(...)
-- @include ../../lua/scriptgo/perks.lua
    end)()
    local CACHE_KEY = "scriptgo.perks"
    local client

    local function perks()
        if client then return client end
        client = Core.new({
            request = function(req, done)
                local ok, reason = Open77.http.request(req.url, function(status, body, headers, err)
                    done({ status = status or 0, body = body or "", error = err })
                end, req.method or "GET", req.body, req.headers)
                if ok == false then done({ status = 0, body = "", error = reason }) end
            end,
            -- The module resumes with up to three values; they cross the promise as one table.
            await = function(register)
                local p = promise.new()
                register(function(a, b, c) p:resolve({ a, b, c }) end)
                local r = Citizen.Await(p)
                if type(r) ~= "table" then return nil, "await_failed" end
                return r[1], r[2], r[3]
            end,
            identifier = function(id)
                if validPlayer(id) then return Open77.players.identifier(id) end
                return nil
            end,
            findPlayer = function(identifier)
                for _, id in ipairs(GetPlayers()) do
                    if validPlayer(id) and Open77.players.identifier(id) == identifier then return id end
                end
                return nil
            end,
            now = function() return Open77.time.unix() end,
            json = { encode = J.encode, decode = J.decode },
            config = function(key)
                local v = GetConvar(key, "")
                if v == nil or v == "" then return nil end
                return v
            end,
            -- A handler runs in its own thread of this resource, so it may Wait and call natives.
            dispatch = function(fn, player, key, info)
                CreateThread(function() fn(player, key, info) end)
            end,
            log = function(level, message)
                local write = Open77.log[level] or Open77.log.info
                write("ScriptGo.perks: " .. tostring(message))
            end,
            storage = {
                load = function()
                    local text = Open77.kvp.get(CACHE_KEY)
                    if type(text) ~= "string" then return nil end
                    local ok, data = pcall(J.decode, text)
                    if ok then return data end
                    return nil
                end,
                -- A kvp value holds 64 KiB: a cache larger than that stays in memory only.
                save = function(data)
                    local ok, text = pcall(J.encode, data)
                    if ok and type(text) == "string" and #text < 60000 then Open77.kvp.set(CACHE_KEY, text) end
                end,
            },
            environment = "open77",
            adapterVersion = SG.runtime.adapterVersion(),
        })
        -- The event queue is pulled from a thread of this resource; the first use starts it.
        CreateThread(function()
            while true do
                client.tick()
                Wait(1000)
            end
        end)
        return client
    end

    O.caps.perks = true
    SG.perks = {
        has = function(player, key) return perks().has(player, key) end,
        list = function(player) return perks().list(player) end,
        refresh = function(player) return perks().refresh(player) end,
        purchaseLink = function(player, key) return perks().purchaseLink(player, key) end,
        catalog = function() return perks().catalog() end,
        on = function(kind, fn) return perks().on(kind, fn) end,
        off = function(id) return perks().off(id) end,
        status = function() return perks().status() end,
    }
end
-- @end

-- @capability presence
-- Player match (docs/spec/player-match.md): ties a buyer on a shop to a player of this server.
--
-- The logic is the portable core's module (sdk/lua/scriptgo/presence.lua), included below by
-- `scriptgo pack` word for word. This section hands it what OPEN//77 has:
--   - the /link command (convar `scriptgo_link_command`, default "link"; "off" removes it). The
--     player types the code their browser shows; the server confirms it to SCRIPT//GO for the player
--     OPEN//77 authenticated (Open77.players.identifier). Needs `scriptgo_server_token`.
--   - presence reporting, opt-in (convar `scriptgo_presence`, default off): connected players'
--     keyed address fingerprints. It reads Open77.players.endpoint (permission
--     `players.identity.sensitive`, which `scriptgo pack` adds for this capability), and needs an
--     HMAC-SHA256 from the host. OPEN//77 build 2.50.0+op77.208 has no HMAC native, so presence
--     says "presence unavailable: no HMAC on this host" and never reads an address; /link works.
-- Declare this capability in ONE resource per server: each packed resource registers its own /link.
do
    local Core = (function(...)
-- @include ../../lua/scriptgo/presence.lua
    end)()
    local client

    local function presence()
        if client then return client end
        client = Core.new({
            request = function(req, done)
                local ok, reason = Open77.http.request(req.url, function(status, body, headers, err)
                    done({ status = status or 0, body = body or "", error = err })
                end, req.method or "GET", req.body, req.headers)
                if ok == false then done({ status = 0, body = "", error = reason }) end
            end,
            await = function(register)
                local p = promise.new()
                register(function(a, b) p:resolve({ a, b }) end)
                local r = Citizen.Await(p)
                if type(r) ~= "table" then return false, "await_failed" end
                return r[1], r[2]
            end,
            identifier = function(id)
                if validPlayer(id) then return Open77.players.identifier(id) end
                return nil
            end,
            name = function(id)
                if validPlayer(id) then return GetPlayerName(id) end
                return nil
            end,
            -- "ip:port" or "[v6]:port"; the core drops the port and hashes the rest. Read only when
            -- presence is on and an HMAC exists (never on a build without one).
            address = function(id)
                if not validPlayer(id) then return nil end
                local endpoint = Open77.players.endpoint(id)
                if type(endpoint) ~= "string" then return nil end
                return endpoint
            end,
            players = function() return GetPlayers() end,
            -- No HMAC native in OPEN//77 build 2.50.0+op77.208: presence reporting stays off. When
            -- OPEN//77 gains a vetted HMAC-SHA256, it is wired here.
            hmacSha256 = nil,
            now = function() return Open77.time.unix() end,
            json = { encode = J.encode, decode = J.decode },
            config = function(key)
                local v = GetConvar(key, "")
                if v == nil or v == "" then return nil end
                return v
            end,
            log = function(level, message)
                local write = Open77.log[level] or Open77.log.info
                write("ScriptGo.presence: " .. tostring(message))
            end,
            environment = "open77",
            adapterVersion = SG.runtime.adapterVersion(),
        })
        CreateThread(function()
            while true do
                client.tick()
                Wait(1000)
            end
        end)
        return client
    end

    -- The server learns about joins and leaves from the host's own events.
    AddEventHandler("playerJoining", function()
        local id = tonumber(source)
        if id then presence().joined(id) end
    end)
    AddEventHandler("playerDropped", function()
        local id = tonumber(source)
        if id then presence().left(id) end
    end)
    AddEventHandler("onResourceStart", function(name)
        if name ~= resourceName then return end
        local p = presence()
        local command = p.command()
        if not command then return end
        local ok, err = pcall(RegisterCommand, command, function(src, args)
            if src == 0 then
                Open77.log.info("ScriptGo.presence: /" .. command .. " is typed by a player in game, with the code their browser shows")
                return
            end
            p.linkAsync(src, args and args[1], function(linked, reason)
                Open77.chat.send(src, { author = "SCRIPT//GO", text = p.linkMessage(linked, reason) })
            end)
        end, false)
        if not ok then Open77.log.warn("ScriptGo.presence: /" .. command .. " is not registered here (" .. tostring(err) .. "): another resource has it") end
    end)

    O.caps.presence = true
    SG.presence = {
        status = function() return presence().status() end,
        link = function(player, code) return presence().link(player, code) end,
        linkMessage = function(ok, reason) return presence().linkMessage(ok, reason) end,
    }
end
-- @end
