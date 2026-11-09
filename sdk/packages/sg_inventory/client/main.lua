-- InventoryKit, client side: the mirror a UI draws from, and the requests a player can make.
-- The server decides; a refused request comes back as "sg_inventory:refused".
local state = { slots = 0, maxWeight = 0, weight = 0, items = {} }
local lastRefusal

RegisterNetEvent("sg_inventory:state", function(snapshot)
    state = snapshot
    TriggerEvent("sg_inventory:updated", state)
end)

RegisterNetEvent("sg_inventory:refused", function(action, reason)
    lastRefusal = { action = action, reason = reason }
    if ScriptGo.capabilities.has("ui") then
        ScriptGo.ui.notify(nil, { type = "error", title = "Inventory", message = ("%s refused: %s"):format(action, reason) })
    end
end)

RegisterNetEvent("sg_inventory:used", function(name)
    TriggerEvent("sg_inventory:itemUsed", name)
end)

exports("getState", function() return state end)
exports("count", function(name)
    local n = 0
    for _, it in ipairs(state.items) do if it.name == name then n = n + it.count end end
    return n
end)
exports("lastRefusal", function() return lastRefusal end)
exports("move", function(from, to, count) return TriggerServerEvent("sg_inventory:move", from, to, count) end)
exports("use", function(slot) return TriggerServerEvent("sg_inventory:use", slot) end)
exports("refresh", function() return TriggerServerEvent("sg_inventory:request") end)

if ScriptGo.capabilities.has("commands") then
    RegisterCommand("inventory", function()
        local parts = {}
        for _, it in ipairs(state.items) do parts[#parts + 1] = ("%d:%s x%d"):format(it.slot, it.label, it.count) end
        local text = ("%.1f/%.1f kg — %s"):format(state.weight, state.maxWeight, #parts > 0 and table.concat(parts, ", ") or "empty")
        if ScriptGo.capabilities.has("ui") then
            ScriptGo.ui.notify(nil, { type = "info", title = "Inventory", message = text })
        else
            print(text)
        end
    end, false)
end

TriggerServerEvent("sg_inventory:request")
