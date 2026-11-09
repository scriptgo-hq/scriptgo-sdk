-- Pure inventory logic, shared by server and client. Defines the global `SgInventory`.
--
-- An item definition: { name, label, weight = 0.5, stack = 10, usable = false, consume = false,
-- category = "misc" }. An inventory: { slots = 24, maxWeight = 30, items = { [slot] = { name,
-- count, meta? } } }. Items that carry `meta` are unique: they never stack.
-- Every mutation is atomic: it either applies completely or leaves the inventory untouched.
SgInventory = {}

SgInventory.NAME_PATTERN = "^[a-z0-9_]+$"

function SgInventory.validateItem(def)
    if type(def) ~= "table" then return false, "invalid_item" end
    if type(def.name) ~= "string" or #def.name > 48 or not def.name:find(SgInventory.NAME_PATTERN) then
        return false, "invalid_item_name"
    end
    if def.label ~= nil and (type(def.label) ~= "string" or #def.label > 64) then return false, "invalid_label" end
    local w = def.weight or 0
    if type(w) ~= "number" or w < 0 or w ~= w or w > 1000 then return false, "invalid_weight" end
    local s = def.stack or 1
    if type(s) ~= "number" or s < 1 or s ~= math.floor(s) or s > 10000 then return false, "invalid_stack" end
    return true
end

function SgInventory.normalizeItem(def)
    return {
        name = def.name, label = def.label or def.name, weight = def.weight or 0, stack = def.stack or 1,
        usable = def.usable == true, consume = def.consume == true, category = def.category or "misc",
        description = def.description,
    }
end

function SgInventory.new(slots, maxWeight)
    return { slots = slots or 24, maxWeight = maxWeight or 30, items = {} }
end

local function isCount(n) return type(n) == "number" and n >= 1 and n == math.floor(n) and n <= 1000000 end

local function clone(inv)
    local items = {}
    for slot, it in pairs(inv.items) do items[slot] = { name = it.name, count = it.count, meta = it.meta } end
    return { slots = inv.slots, maxWeight = inv.maxWeight, items = items }
end

function SgInventory.weight(inv, defs)
    local total = 0
    for _, it in pairs(inv.items) do
        local d = defs[it.name]
        total = total + (d and d.weight or 0) * it.count
    end
    return total
end

function SgInventory.count(inv, name)
    local n = 0
    for _, it in pairs(inv.items) do if it.name == name then n = n + it.count end end
    return n
end

function SgInventory.freeSlots(inv)
    local n = 0
    for slot = 1, inv.slots do if not inv.items[slot] then n = n + 1 end end
    return n
end

-- add(inv, defs, name, count, meta) -> true | false, reason
function SgInventory.add(inv, defs, name, count, meta)
    local d = defs[name]
    if not d then return false, "unknown_item" end
    if not isCount(count) then return false, "invalid_count" end
    if SgInventory.weight(inv, defs) + d.weight * count > inv.maxWeight + 1e-9 then return false, "too_heavy" end
    local work = clone(inv)
    local left = count
    if meta == nil then
        for slot = 1, work.slots do
            local it = work.items[slot]
            if left > 0 and it and it.name == name and it.meta == nil and it.count < d.stack then
                local take = math.min(d.stack - it.count, left)
                it.count = it.count + take
                left = left - take
            end
        end
    end
    local perSlot = meta == nil and d.stack or 1
    for slot = 1, work.slots do
        if left <= 0 then break end
        if not work.items[slot] then
            local take = math.min(perSlot, left)
            work.items[slot] = { name = name, count = take, meta = meta }
            left = left - take
        end
    end
    if left > 0 then return false, "no_space" end
    inv.items = work.items
    return true
end

-- remove(inv, name, count) -> true | false, reason  (takes from the last slots first)
function SgInventory.remove(inv, name, count)
    if not isCount(count) then return false, "invalid_count" end
    if SgInventory.count(inv, name) < count then return false, "not_enough" end
    local left = count
    for slot = inv.slots, 1, -1 do
        local it = inv.items[slot]
        if left > 0 and it and it.name == name then
            local take = math.min(it.count, left)
            it.count = it.count - take
            left = left - take
            if it.count == 0 then inv.items[slot] = nil end
        end
    end
    return true
end

function SgInventory.removeFromSlot(inv, slot, count)
    local it = inv.items[slot]
    if not it then return false, "empty_slot" end
    if not isCount(count) or count > it.count then return false, "invalid_count" end
    it.count = it.count - count
    if it.count == 0 then inv.items[slot] = nil end
    return true
end

-- move(inv, defs, from, to, count?) : move, merge into a matching stack, split, or swap.
function SgInventory.move(inv, defs, from, to, count)
    if type(from) ~= "number" or type(to) ~= "number" or from < 1 or to < 1 or from > inv.slots or to > inv.slots
        or from ~= math.floor(from) or to ~= math.floor(to) then
        return false, "invalid_slot"
    end
    if from == to then return true end
    local src = inv.items[from]
    if not src then return false, "empty_slot" end
    count = count or src.count
    if not isCount(count) or count > src.count then return false, "invalid_count" end
    local dst = inv.items[to]
    local d = defs[src.name]
    if not dst then
        inv.items[to] = { name = src.name, count = count, meta = src.meta }
        src.count = src.count - count
        if src.count == 0 then inv.items[from] = nil end
        return true
    end
    if dst.name == src.name and dst.meta == nil and src.meta == nil and d then
        local room = d.stack - dst.count
        if room <= 0 then return false, "stack_full" end
        local take = math.min(room, count)
        dst.count = dst.count + take
        src.count = src.count - take
        if src.count == 0 then inv.items[from] = nil end
        return true
    end
    if count ~= src.count then return false, "slot_occupied" end
    inv.items[from], inv.items[to] = dst, src
    return true
end

-- A plain, JSON-friendly view for clients and exports.
function SgInventory.snapshot(inv, defs)
    local list = {}
    for slot = 1, inv.slots do
        local it = inv.items[slot]
        if it then
            local d = defs[it.name] or {}
            list[#list + 1] = {
                slot = slot, name = it.name, label = d.label or it.name, count = it.count, meta = it.meta,
                weight = (d.weight or 0) * it.count, usable = d.usable == true,
            }
        end
    end
    return { slots = inv.slots, maxWeight = inv.maxWeight, weight = SgInventory.weight(inv, defs), items = list }
end

-- Storage form (a list, since sparse integer keys do not survive JSON) and back.
function SgInventory.serialize(inv)
    local list = {}
    for slot = 1, inv.slots do
        local it = inv.items[slot]
        if it then list[#list + 1] = { slot = slot, name = it.name, count = it.count, meta = it.meta } end
    end
    return { v = 1, items = list }
end

function SgInventory.deserialize(data, slots, maxWeight, defs)
    local inv = SgInventory.new(slots, maxWeight)
    local dropped = 0
    for _, it in ipairs(type(data) == "table" and data.items or {}) do
        if defs[it.name] and type(it.slot) == "number" and it.slot >= 1 and it.slot <= inv.slots and isCount(it.count) then
            inv.items[it.slot] = { name = it.name, count = it.count, meta = it.meta }
        else
            dropped = dropped + 1
        end
    end
    return inv, dropped
end
