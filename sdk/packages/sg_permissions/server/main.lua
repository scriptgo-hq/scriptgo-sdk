-- PermissionsKit, server side.
--
-- Roles come from the resource config ("roles") or the defaults below; grants are stored per player
-- identifier, so they survive reconnects and restarts. Host operators (the host's own privilege
-- system: Luanti privs, OPEN//77 ACL, standalone config) hold "*" through the `scriptgo.admin`
-- privilege when the host offers the `permissions` capability.
local DEFAULT_ROLES = {
    user = { privileges = {} },
    moderator = { inherits = { "user" }, privileges = { "chat.mute", "players.kick", "inventory.inspect" } },
    admin = { inherits = { "moderator" }, privileges = { "*" } },
}

local defs = {}
local grants = {}   -- identifier -> { roles = {...}, direct = {...} }
local cache = {}    -- playerId -> { patterns, roles }

local function copyList(t)
    local out = {}
    for i, v in ipairs(t or {}) do out[i] = v end
    return out
end

local function validateRole(name, def)
    if not SgPerms.isRole(name) then return false, "invalid_role_name" end
    if type(def) ~= "table" then return false, "invalid_role" end
    for _, p in ipairs(def.privileges or {}) do
        if not SgPerms.isPrivilege(p) then return false, "invalid_privilege:" .. tostring(p) end
    end
    for _, parent in ipairs(def.inherits or {}) do
        if not SgPerms.isRole(parent) then return false, "invalid_role_name:" .. tostring(parent) end
    end
    return true
end

local function loadRoles()
    local configured = ScriptGo.capabilities.has("config") and ScriptGo.config.get("roles") or nil
    local source = type(configured) == "table" and configured or DEFAULT_ROLES
    for name, def in pairs(source) do
        local ok, why = validateRole(name, def)
        if ok then
            defs[name] = { inherits = copyList(def.inherits), privileges = copyList(def.privileges) }
        else
            ScriptGo.log.warn(("role %s ignored: %s"):format(tostring(name), why))
        end
    end
    local _, cycle = SgPerms.expand((function() local n = {} for k in pairs(defs) do n[#n + 1] = k end return n end)(), defs)
    if cycle then ScriptGo.log.error("role configuration has a cycle: " .. cycle) end
end

local function identifier(playerId)
    return ScriptGo.players.identifier(playerId)
end

local function storageKey(id) return "grants:" .. id end

local function grantsOf(playerId)
    local id = identifier(playerId)
    if not id then return nil end
    local g = grants[id]
    if not g then
        g = ScriptGo.storage.get(storageKey(id)) or { roles = {}, direct = {} }
        g.roles, g.direct = g.roles or {}, g.direct or {}
        grants[id] = g
    end
    return g, id
end

local function save(id)
    local g = grants[id]
    if not g then return end
    if #g.roles == 0 and #g.direct == 0 then ScriptGo.storage.delete(storageKey(id))
    else ScriptGo.storage.set(storageKey(id), g) end
end

local function effective(playerId)
    local c = cache[playerId]
    if c then return c end
    local g = grantsOf(playerId)
    local roles = g and copyList(g.roles) or {}
    if defs.user then table.insert(roles, 1, "user") end
    local patterns, expanded = SgPerms.patterns(roles, defs, g and g.direct)
    c = { patterns = patterns, roles = expanded }
    cache[playerId] = c
    return c
end

local function isOperator(playerId)
    if playerId == 0 then return true end
    if not ScriptGo.capabilities.has("permissions") then return false end
    return ScriptGo.permissions.has(playerId, "scriptgo.admin")
end

local function has(playerId, privilege)
    if type(privilege) ~= "string" or privilege == "" then return false end
    if isOperator(playerId) then return true end
    if type(playerId) ~= "number" or not ScriptGo.players.exists(playerId) then return false end
    return SgPerms.decide(effective(playerId).patterns, privilege)
end

local function changed(playerId)
    cache[playerId] = nil
    local e = effective(playerId)
    TriggerEvent("sg_permissions:changed", playerId, e.roles)
    TriggerClientEvent("sg_permissions:state", playerId, e.roles, e.patterns)
end

local function grant(playerId, role)
    if not defs[role] then return false, "unknown_role" end
    local g, id = grantsOf(playerId)
    if not g then return false, "unknown_player" end
    for _, r in ipairs(g.roles) do if r == role then return true end end
    g.roles[#g.roles + 1] = role
    save(id)
    changed(playerId)
    return true
end

local function revoke(playerId, role)
    local g, id = grantsOf(playerId)
    if not g then return false, "unknown_player" end
    for i, r in ipairs(g.roles) do
        if r == role then
            table.remove(g.roles, i)
            save(id)
            changed(playerId)
            return true
        end
    end
    return false, "not_granted"
end

exports("has", function(playerId, privilege) return has(playerId, privilege) end)
exports("grant", grant)
exports("revoke", revoke)
exports("roles", function(playerId) return effective(playerId).roles end)
exports("privileges", function(playerId) return effective(playerId).patterns end)
exports("listRoles", function()
    local out = {}
    for name, d in pairs(defs) do out[#out + 1] = { name = name, inherits = d.inherits, privileges = d.privileges } end
    table.sort(out, function(a, b) return a.name < b.name end)
    return out
end)

-- defineRole(name, { inherits, privileges }) adds or replaces a role at runtime (not persisted).
exports("defineRole", function(name, def)
    local ok, why = validateRole(name, def)
    if not ok then return false, why end
    local previous = defs[name]
    defs[name] = { inherits = copyList(def.inherits), privileges = copyList(def.privileges) }
    local _, cycle = SgPerms.expand({ name }, defs)
    if cycle then defs[name] = previous; return false, cycle end
    cache = {}
    return true
end)

-- /perm grant <id> <role> | revoke <id> <role> | check <id> <privilege> | roles <id>
local function reply(target, message, kind)
    if target == 0 or not ScriptGo.capabilities.has("ui") then
        print(message)
    else
        ScriptGo.ui.notify(target, { type = kind or "info", title = "Permissions", message = message })
    end
end

RegisterCommand("perm", function(src, args)
    if src ~= 0 and not has(src, "permissions.manage") then
        return reply(src, "You may not manage permissions.", "error")
    end
    local action, target, value = args[1], tonumber(args[2]), args[3]
    if not action or not target then
        return reply(src, "Usage: perm grant|revoke|check|roles <playerId> [role|privilege]")
    end
    if action == "grant" or action == "revoke" then
        local ok, why = (action == "grant" and grant or revoke)(target, value)
        reply(src, ok and (action .. " " .. tostring(value) .. " -> " .. target) or (action .. " failed: " .. tostring(why)), ok and "success" or "error")
    elseif action == "check" then
        reply(src, ("%d %s %s"):format(target, has(target, value) and "has" or "lacks", tostring(value)))
    elseif action == "roles" then
        reply(src, ("%d: %s"):format(target, table.concat(effective(target).roles, ", ")))
    else
        reply(src, "Unknown action " .. tostring(action), "error")
    end
end, false)

AddEventHandler("playerDropped", function()
    local playerId = source
    cache[playerId] = nil
    local id = identifier(playerId)
    if id then grants[id] = nil end
end)

RegisterNetEvent("sg_permissions:request", function()
    local playerId = source
    local e = effective(playerId)
    TriggerClientEvent("sg_permissions:state", playerId, e.roles, e.patterns)
end)

loadRoles()
