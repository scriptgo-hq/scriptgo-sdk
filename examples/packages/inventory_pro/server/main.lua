-- Inventory Pro, server side. Every premium entry point goes through `requireLicense`.
local hotbars = {} -- playerId -> { [1..5] = slot }

local function inv(name, ...)
    local pending, reason = Open77.exports.call("sg_inventory", name, ...)
    if not pending then return nil, reason end
    return pending:await()
end

local function requireLicense()
    if InvProLicense.active() then return true end
    return false, "not_licensed:" .. tostring(InvProLicense.reason or InvProLicense.state)
end

local function say(playerId, message, kind)
    if playerId == 0 or not ScriptGo.capabilities.has("ui") then return print(message) end
    ScriptGo.ui.notify(playerId, { type = kind or "info", title = "Inventory Pro", message = message })
end

-- Items are registered with InventoryKit once it is up (it is a declared dependency).
CreateThread(function()
    for _, def in ipairs(InvProCatalog.ITEMS) do
        local ok, why = inv("defineItem", def)
        if not ok then ScriptGo.log.warn("defineItem " .. def.name .. ": " .. tostring(why)) end
    end
end)

local function craft(playerId, recipeName)
    local licensed, why = requireLicense()
    if not licensed then return false, why end
    local recipe = InvProCatalog.RECIPES[recipeName]
    if not recipe then return false, "unknown_recipe" end
    for _, input in ipairs(recipe.inputs) do
        local have = inv("count", playerId, input.item) or 0
        if have < input.count then return false, "missing:" .. input.item end
    end
    -- Take the inputs, then give the output; give the inputs back if the output does not fit.
    local taken = {}
    for _, input in ipairs(recipe.inputs) do
        local ok, err = inv("remove", playerId, input.item, input.count)
        if not ok then
            for _, t in ipairs(taken) do inv("add", playerId, t.item, t.count) end
            return false, err
        end
        taken[#taken + 1] = input
    end
    local ok, err = inv("add", playerId, recipe.output.item, recipe.output.count)
    if not ok then
        for _, t in ipairs(taken) do inv("add", playerId, t.item, t.count) end
        return false, err
    end
    TriggerEvent("inventory_pro:crafted", playerId, recipeName)
    return true, recipe.output
end

local function bindHotbar(playerId, index, slot)
    local licensed, why = requireLicense()
    if not licensed then return false, why end
    index, slot = tonumber(index), tonumber(slot)
    if not index or index < 1 or index > InvProCatalog.HOTBAR_SIZE or index ~= math.floor(index) then return false, "invalid_hotbar_index" end
    if not slot or slot < 1 or slot ~= math.floor(slot) then return false, "invalid_slot" end
    hotbars[playerId] = hotbars[playerId] or {}
    hotbars[playerId][index] = slot
    ScriptGo.storage.set("hotbar:" .. tostring(ScriptGo.players.identifier(playerId)), hotbars[playerId])
    TriggerClientEvent("inventory_pro:hotbar", playerId, hotbars[playerId])
    return true
end

local function useHotbar(playerId, index)
    local licensed, why = requireLicense()
    if not licensed then return false, why end
    local bar = hotbars[playerId]
    if not bar then
        bar = ScriptGo.storage.get("hotbar:" .. tostring(ScriptGo.players.identifier(playerId))) or {}
        hotbars[playerId] = bar
    end
    local slot = bar[tonumber(index)]
    if not slot then return false, "hotbar_empty" end
    return inv("use", playerId, slot)
end

exports("status", function()
    return { state = InvProLicense.state, reason = InvProLicense.reason, graceUntil = InvProLicense.graceUntil, checkedAt = InvProLicense.checkedAt }
end)
exports("craft", craft)
exports("bindHotbar", bindHotbar)
exports("useHotbar", useHotbar)
exports("recipes", function()
    local out = {}
    for name, r in pairs(InvProCatalog.RECIPES) do out[#out + 1] = { name = name, output = r.output, inputs = r.inputs, rarity = InvProCatalog.rarityOf(r.output.item) } end
    table.sort(out, function(a, b) return a.name < b.name end)
    return out
end)

if ScriptGo.capabilities.has("commands") then
    RegisterCommand("craft", function(src, args)
        if src == 0 then return print("craft: run it in game") end
        local ok, result = craft(src, args[1])
        if ok then say(src, ("Crafted %d x %s"):format(result.count, result.item), "success")
        else say(src, "Crafting failed: " .. tostring(result), "error") end
    end, false)

    RegisterCommand("hotbar", function(src, args)
        if src == 0 then return print("hotbar: run it in game") end
        local ok, why = bindHotbar(src, args[1], args[2])
        say(src, ok and ("Hotbar %s -> slot %s"):format(args[1], args[2]) or ("Hotbar failed: " .. tostring(why)), ok and "success" or "error")
    end, false)

    RegisterCommand("invpro", function(src)
        local s = InvProLicense
        say(src, ("Inventory Pro: license %s%s"):format(s.state, s.reason and (" (" .. s.reason .. ")") or ""))
    end, false)
end

RegisterNetEvent("inventory_pro:useHotbar", function(index)
    local playerId = source
    local ok, why = useHotbar(playerId, index)
    if not ok then TriggerClientEvent("inventory_pro:refused", playerId, "hotbar", why) end
end)

AddEventHandler("playerDropped", function() hotbars[source] = nil end)
