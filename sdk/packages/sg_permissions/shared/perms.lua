-- Pure permission logic, shared by server and client. Defines the global `SgPerms`.
--
-- A privilege is a dotted name: "inventory.give", "chat.mute". A pattern matches it exactly, or with
-- a trailing wildcard ("inventory.*" matches "inventory.give" and "inventory.admin.reset"), or "*".
-- A pattern starting with "-" denies: deny wins over allow at the same or lower specificity.
SgPerms = {}

SgPerms.PRIVILEGE_PATTERN = "^[a-z0-9_]+[a-z0-9_%.%-]*%*?$"
SgPerms.ROLE_PATTERN = "^[a-z0-9_%-]+$"

function SgPerms.isPrivilege(p)
    if type(p) ~= "string" or #p > 96 then return false end
    if p == "*" then return true end
    local body = p:sub(1, 1) == "-" and p:sub(2) or p
    return body == "*" or body:find(SgPerms.PRIVILEGE_PATTERN) ~= nil
end

function SgPerms.isRole(name)
    return type(name) == "string" and #name <= 48 and name:find(SgPerms.ROLE_PATTERN) ~= nil
end

-- Specificity of a pattern that matches `privilege`, or nil when it does not match.
local function specificity(pattern, privilege)
    if pattern == "*" then return 0 end
    if pattern == privilege then return 1000 end
    if pattern:sub(-2) == ".*" then
        local prefix = pattern:sub(1, -2) -- keeps the dot
        if privilege:sub(1, #prefix) == prefix then return #prefix end
    end
    return nil
end

-- Decides `privilege` against a list of patterns (allow and "-deny").
function SgPerms.decide(patterns, privilege)
    local bestAllow, bestDeny
    for _, p in ipairs(patterns) do
        local deny = p:sub(1, 1) == "-"
        local s = specificity(deny and p:sub(2) or p, privilege)
        if s then
            if deny then bestDeny = math.max(bestDeny or -1, s)
            else bestAllow = math.max(bestAllow or -1, s) end
        end
    end
    if bestDeny and (not bestAllow or bestDeny >= bestAllow) then return false end
    return bestAllow ~= nil
end

-- Expands roles through inheritance; returns the ordered role list or nil, "role_cycle:<name>".
function SgPerms.expand(roles, defs)
    local out, state = {}, {}
    local function visit(name)
        if state[name] == "done" then return true end
        if state[name] == "visiting" then return false, "role_cycle:" .. name end
        local def = defs[name]
        if not def then return true end
        state[name] = "visiting"
        for _, parent in ipairs(def.inherits or {}) do
            local ok, err = visit(parent)
            if not ok then return false, err end
        end
        state[name] = "done"
        out[#out + 1] = name
        return true
    end
    for _, r in ipairs(roles) do
        local ok, err = visit(r)
        if not ok then return nil, err end
    end
    return out
end

-- Effective patterns of a set of roles, plus direct per-player patterns.
function SgPerms.patterns(roles, defs, direct)
    local expanded = SgPerms.expand(roles, defs) or {}
    local out = {}
    for _, r in ipairs(expanded) do
        for _, p in ipairs(defs[r].privileges or {}) do out[#out + 1] = p end
    end
    for _, p in ipairs(direct or {}) do out[#out + 1] = p end
    return out, expanded
end
