-- InventoryKit, server side (authoritative).
--
-- Item definitions come from the resource config ("items") or the small generic set below, and can
-- be extended at runtime with defineItem. Inventories are keyed by player identifier and saved
-- after every change. Changes are pushed to the owning client ("sg_inventory:state") and announced
-- on the server bus ("sg_inventory:changed", "sg_inventory:used") for other resources.
local DEFAULT_ITEMS = {
    { name = "water", label = "Water bottle", weight = 0.5, stack = 10, usable = true, consume = true, category = "food" },
    { name = "bread", label = "Bread", weight = 0.3, stack = 10, usable = true, consume = true, category = "food" },
    { name = "bandage", label = "Bandage", weight = 0.1, stack = 20, usable = true, consume = true, category = "medical" },
    { name = "rope", label = "Rope", weight = 1.0, stack = 5, category = "tools" },
    { name = "scrap", label = "Scrap", weight = 0.2, stack = 50, category = "materials" },
    { name = "coin", label = "Coin", weight = 0.0, stack = 1000, category = "currency" },
    { name = "toolbox", label = "Toolbox", weight = 3.0, stack = 1, usable = true, category = "tools" },
}

local cfg = function(key, default)
    if ScriptGo.capabilities.has("config") then return ScriptGo.config.get(key, default) end
    return default
end

local SLOTS = tonumber(cfg("slots", 24)) or 24
local MAX_WEIGHT = tonumber(cfg("maxWeight", 30)) or 30
local RATE = 10 -- client requests per second per player

local defs = {}
local inventories = {} -- identifier -> inventory
local buckets = {}

local function define(def)
    local ok, why = SgInventory.validateItem(def)
    if not ok then return false, why end
    defs[def.name] = SgInventory.normalizeItem(def)
    return true
end

for _, def in ipairs(cfg("items", DEFAULT_ITEMS)) do
    local ok, why = define(def)
    if not ok then ScriptGo.log.warn(("item %s ignored: %s"):format(tostring(def and def.name), why)) end
end

local function identifier(playerId)
    if type(playerId) ~= "number" or not ScriptGo.players.exists(playerId) then return nil end
    return ScriptGo.players.identifier(playerId)
end

local function inventoryOf(playerId)
    local id = identifier(playerId)
    if not id then return nil, "unknown_player" end
    local inv = inventories[id]
    if not inv then
        local dropped
        inv, dropped = SgInventory.deserialize(ScriptGo.storage.get("inv:" .. id), SLOTS, MAX_WEIGHT, defs)
        if dropped > 0 then ScriptGo.log.warn(("%d unknown or invalid stacks dropped from %s"):format(dropped, id)) end
        inventories[id] = inv
    end
    return inv, id
end

local function commit(playerId, id, inv, change)
    ScriptGo.storage.set("inv:" .. id, SgInventory.serialize(inv))
    TriggerClientEvent("sg_inventory:state", playerId, SgInventory.snapshot(inv, defs))
    if change then TriggerEvent("sg_inventory:changed", playerId, change) end
end

local function add(playerId, name, count, meta)
    local inv, id = inventoryOf(playerId)
    if not inv then return false, id end
    count = count or 1
    local ok, why = SgInventory.add(inv, defs, name, count, meta)
    if not ok then return false, why end
    commit(playerId, id, inv, { item = name, delta = count })
    return true
end

local function remove(playerId, name, count)
    local inv, id = inventoryOf(playerId)
    if not inv then return false, id end
    count = count or 1
    local ok, why = SgInventory.remove(inv, name, count)
    if not ok then return false, why end
    commit(playerId, id, inv, { item = name, delta = -count })
    return true
end

local function move(playerId, from, to, count)
    local inv, id = inventoryOf(playerId)
    if not inv then return false, id end
    local ok, why = SgInventory.move(inv, defs, from, to, count)
    if not ok then return false, why end
    commit(playerId, id, inv, nil)
    return true
end

local function use(playerId, slot)
    local inv, id = inventoryOf(playerId)
    if not inv then return false, id end
    local it = inv.items[slot]
    if not it then return false, "empty_slot" end
    local d = defs[it.name]
    if not d or not d.usable then return false, "not_usable" end
    local name, meta = it.name, it.meta
    if d.consume then
        SgInventory.removeFromSlot(inv, slot, 1)
        commit(playerId, id, inv, { item = name, delta = -1, reason = "used" })
    end
    TriggerEvent("sg_inventory:used", playerId, name, slot, meta)
    TriggerClientEvent("sg_inventory:used", playerId, name, meta)
    return true
end

exports("defineItem", define)
exports("items", function()
    local out = {}
    for _, d in pairs(defs) do out[#out + 1] = d end
    table.sort(out, function(a, b) return a.name < b.name end)
    return out
end)
exports("getInventory", function(playerId)
    local inv, why = inventoryOf(playerId)
    if not inv then return nil, why end
    return SgInventory.snapshot(inv, defs)
end)
exports("count", function(playerId, name)
    local inv = inventoryOf(playerId)
    return inv and SgInventory.count(inv, name) or 0
end)
exports("add", add)
exports("remove", remove)
exports("move", move)
exports("use", use)
exports("clear", function(playerId)
    local inv, id = inventoryOf(playerId)
    if not inv then return false, id end
    inv.items = {}
    commit(playerId, id, inv, { cleared = true })
    return true
end)

-- Client requests: rate limited per player; the server re-validates everything.
local function allow(playerId)
    local t = ScriptGo.time.monotonic()
    local b = buckets[playerId]
    if not b then b = { tokens = RATE, at = t }; buckets[playerId] = b end
    b.tokens = math.min(RATE, b.tokens + (t - b.at) * RATE)
    b.at = t
    if b.tokens < 1 then return false end
    b.tokens = b.tokens - 1
    return true
end

local function refuse(playerId, action, why)
    TriggerClientEvent("sg_inventory:refused", playerId, action, why)
end

RegisterNetEvent("sg_inventory:request", function()
    local playerId = source
    if not allow(playerId) then return end
    local inv = inventoryOf(playerId)
    if inv then TriggerClientEvent("sg_inventory:state", playerId, SgInventory.snapshot(inv, defs)) end
end)

RegisterNetEvent("sg_inventory:move", function(from, to, count)
    local playerId = source
    if not allow(playerId) then return refuse(playerId, "move", "rate_limited") end
    local ok, why = move(playerId, tonumber(from), tonumber(to), count and tonumber(count) or nil)
    if not ok then refuse(playerId, "move", why) end
end)

RegisterNetEvent("sg_inventory:use", function(slot)
    local playerId = source
    if not allow(playerId) then return refuse(playerId, "use", "rate_limited") end
    local ok, why = use(playerId, tonumber(slot))
    if not ok then refuse(playerId, "use", why) end
end)

-- giveitem <playerId> <item> [count]: privilege inventory.give (PermissionsKit when running,
-- otherwise the host's own privileges); the console always may.
local function mayGive(src)
    if src == 0 then return true end
    if GetResourceState("sg_permissions") == "started" then
        local ok, allowed = pcall(function() return exports.sg_permissions:has(src, "inventory.give") end)
        return ok and allowed == true
    end
    return ScriptGo.capabilities.has("permissions") and ScriptGo.permissions.has(src, "inventory.give")
end

if ScriptGo.capabilities.has("commands") then
    RegisterCommand("giveitem", function(src, args)
        local function say(msg, kind)
            if src == 0 or not ScriptGo.capabilities.has("ui") then return print(msg) end
            ScriptGo.ui.notify(src, { type = kind or "info", title = "Inventory", message = msg })
        end
        if not mayGive(src) then return say("You may not give items.", "error") end
        local target, item, count = tonumber(args[1]), args[2], tonumber(args[3] or "1")
        if not target or not item then return say("Usage: giveitem <playerId> <item> [count]") end
        local ok, why = add(target, item, count)
        say(ok and ("Gave %d x %s to %d"):format(count, item, target) or ("giveitem failed: " .. tostring(why)), ok and "success" or "error")
    end, false)
end

AddEventHandler("playerDropped", function()
    local playerId = source
    buckets[playerId] = nil
    local id = ScriptGo.players.identifier(playerId)
    if id then inventories[id] = nil end
end)
