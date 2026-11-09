-- Inventory Pro, client side: hotbar mirror and the request to use a hotbar entry.
local hotbar = {}
local lastRefusal

RegisterNetEvent("inventory_pro:hotbar", function(bar) hotbar = bar or {} end)
RegisterNetEvent("inventory_pro:refused", function(action, reason)
    lastRefusal = { action = action, reason = reason }
    if ScriptGo.capabilities.has("ui") then
        ScriptGo.ui.notify({ type = "error", title = "Inventory Pro", message = action .. ": " .. tostring(reason) })
    end
end)

exports("hotbar", function() return hotbar end)
exports("lastRefusal", function() return lastRefusal end)
exports("useHotbar", function(index) return TriggerServerEvent("inventory_pro:useHotbar", index) end)
