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
SG.players = {
    list = function() return GetPlayers() end,
    name = function(id) if validPlayer(id) then return GetPlayerName(id) end return nil end,
    exists = function(id) return validPlayer(id) and GetPlayerName(id) ~= nil end,
    identifier = function(id) if validPlayer(id) then return Open77.players.identifier(id) end return nil end,
}
-- @end

-- @capability permissions
-- Needs `acl.read`, which `scriptgo pack` adds when the manifest asks for the permissions capability.
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
SG.ui = {
    notify = function(target, payload)
        if type(payload) ~= "table" then return false, "invalid_payload" end
        if target == -1 then return Open77.notifications.broadcast(O.toNotification(payload)) end
        if not validPlayer(target) then return false, "invalid_target" end
        return Open77.notifications.send(target, O.toNotification(payload))
    end,
}
-- @end
