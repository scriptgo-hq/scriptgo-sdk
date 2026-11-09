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
-- Talks to the SCRIPT//GO API at the `scriptgo_api` convar (default http://localhost:4100), with
-- the request and answer shapes of a SCRIPT//GO host: the decoded answer, or nil, reason[, body].
-- The operator allows the API host in server.jsonc `http.allowedHosts`.
do
    local function apiBase()
        local v = GetConvar("scriptgo_api", "")
        if v == nil or v == "" then return "http://localhost:4100" end
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
