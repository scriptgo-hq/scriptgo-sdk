-- PermissionsKit, client side: a read-only mirror for UI decisions (show or hide an admin button).
-- The server stays authoritative; never trust this mirror for anything that matters.
local roles, patterns = {}, {}

RegisterNetEvent("sg_permissions:state", function(r, p)
    roles, patterns = r or {}, p or {}
    TriggerEvent("sg_permissions:updated", roles)
end)

exports("roles", function() return roles end)
exports("can", function(privilege) return SgPerms.decide(patterns, privilege) end)

TriggerServerEvent("sg_permissions:request")
