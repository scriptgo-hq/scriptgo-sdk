-- Run with: scriptgo test sdk/packages/sg_inventory
local function setup(opts)
    local h = load(opts)
    h:join(1, "Ada")
    h:join(2, "Bo")
    h:tick(10)
    return h
end

local function inv(h, player) return h:call("sg_inventory", "getInventory", player or 1) end

describe("InventoryKit core", function()
    test("stacks fill existing stacks first, then free slots", function()
        local h = setup({ config = { sg_inventory = { slots = 3, maxWeight = 100 } } })
        expect(h:call("sg_inventory", "add", 1, "water", 7)).toBe(true)
        expect(h:call("sg_inventory", "add", 1, "water", 5)).toBe(true)
        local s = inv(h)
        expect(#s.items).toBe(2)
        expect(s.items[1].count).toBe(10)
        expect(s.items[2].count).toBe(2)
        expect(h:call("sg_inventory", "count", 1, "water")).toBe(12)
    end)

    test("adds are atomic: no space or too heavy leaves the inventory untouched", function()
        local h = setup({ config = { sg_inventory = { slots = 2, maxWeight = 5 } } })
        local ok, why = h:call("sg_inventory", "add", 1, "toolbox", 2)
        expect(ok).toBe(false)
        expect(why).toBe("too_heavy")
        h:call("sg_inventory", "add", 1, "rope", 2)
        local ok2, why2 = h:call("sg_inventory", "add", 1, "scrap", 2)
        expect(ok2).toBe(true)
        local ok3, why3 = h:call("sg_inventory", "add", 1, "coin", 1)
        expect(ok3).toBe(false)
        expect(why3).toBe("no_space")
        expect(#inv(h).items).toBe(2)
    end)

    test("items with meta are unique and never stack", function()
        local h = setup()
        h:call("sg_inventory", "add", 1, "toolbox", 1, { serial = "A1" })
        h:call("sg_inventory", "add", 1, "toolbox", 1, { serial = "B2" })
        local s = inv(h)
        expect(#s.items).toBe(2)
        expect(s.items[2].meta).toEqual({ serial = "B2" })
    end)

    test("move merges, splits and swaps", function()
        local h = setup()
        h:call("sg_inventory", "add", 1, "bread", 4)   -- slot 1
        h:call("sg_inventory", "add", 1, "rope", 1)    -- slot 2
        expect(h:call("sg_inventory", "move", 1, 1, 5, 2)).toBe(true) -- split 2 bread to slot 5
        expect(h:call("sg_inventory", "move", 1, 5, 1)).toBe(true)    -- merge back
        expect(h:call("sg_inventory", "move", 1, 1, 2)).toBe(true)    -- swap bread and rope
        local s = inv(h)
        expect(s.items[1].name).toBe("rope")
        expect(s.items[2].name).toBe("bread")
        expect(s.items[2].count).toBe(4)
        local ok, why = h:call("sg_inventory", "move", 1, 9, 1)
        expect(ok).toBe(false)
        expect(why).toBe("empty_slot")
    end)
end)

describe("sg_inventory server", function()
    test("inventories persist per player identifier across restarts", function()
        local h = setup()
        h:call("sg_inventory", "add", 1, "bandage", 3)
        h:stop("sg_inventory")
        h.host.storageCache = {}
        h:start("sg_inventory")
        expect(h:call("sg_inventory", "count", 1, "bandage")).toBe(3)
        expect(h:call("sg_inventory", "count", 2, "bandage")).toBe(0)
        expect(h:storage("sg_inventory")["inv:local:ada"].items[1].name).toBe("bandage")
    end)

    test("using a consumable removes one and announces it on the bus", function()
        local h = load({
            with = { "watcher" },
            files = {
                ["watcher/scriptgo.lua"] = 'resource "watcher"\nversion "1.0.0"\ndependency "sg_inventory"\nserver_script "s.lua"\n',
                ["watcher/s.lua"] = [[
                    used = {}
                    AddEventHandler("sg_inventory:used", function(player, item) used[#used + 1] = player .. ":" .. item end)
                    exports("used", function() return table.concat(used, ",") end)
                ]],
            },
        })
        h:join(1, "Ada")
        h:call("sg_inventory", "add", 1, "water", 2)
        expect(h:call("sg_inventory", "use", 1, 1)).toBe(true)
        h:tick(10)
        expect(h:call("sg_inventory", "count", 1, "water")).toBe(1)
        expect(h:call("watcher", "used")).toBe("1:water")
        local ok, why = h:call("sg_inventory", "use", 1, 7)
        expect(ok).toBe(false)
        expect(why).toBe("empty_slot")
    end)

    test("the client mirror follows the server and its requests are re-validated", function()
        local h = setup()
        h:call("sg_inventory", "add", 1, "scrap", 5)
        h:tick(10)
        expect(h:callClient("sg_inventory", "count", "scrap")).toBe(5)
        h:callClient("sg_inventory", "move", 1, 99)
        h:tick(30) -- client -> server -> client: two network hops
        expect(h:callClient("sg_inventory", "lastRefusal")).toEqual({ action = "move", reason = "invalid_slot" })
        h:callClient("sg_inventory", "move", 1, 4)
        h:tick(30)
        expect(h:callClient("sg_inventory", "getState").items[1].slot).toBe(4)
    end)

    test("client requests are rate limited", function()
        local h = setup()
        h:call("sg_inventory", "add", 1, "scrap", 1)
        for _ = 1, 15 do h:callClient("sg_inventory", "move", 1, 2) ; h:callClient("sg_inventory", "move", 2, 1) end
        h:tick(30)
        expect(h:callClient("sg_inventory", "lastRefusal").reason).toBe("rate_limited")
    end)

    test("giveitem uses PermissionsKit when it runs", function()
        local h = setup({ with = { "sg_permissions" } })
        h:command(1, "giveitem 1 coin 50")
        expect(h:call("sg_inventory", "count", 1, "coin")).toBe(0)
        h:call("sg_permissions", "grant", 1, "admin")
        h:command(1, "giveitem 2 coin 50")
        expect(h:call("sg_inventory", "count", 2, "coin")).toBe(50)
        h:command(0, "giveitem 1 coin 5")
        expect(h:call("sg_inventory", "count", 1, "coin")).toBe(5)
    end)

    test("unknown items and players are refused", function()
        local h = setup()
        local ok, why = h:call("sg_inventory", "add", 1, "plasma_rifle", 1)
        expect(ok).toBe(false)
        expect(why).toBe("unknown_item")
        local ok2, why2 = h:call("sg_inventory", "add", 42, "water", 1)
        expect(ok2).toBe(false)
        expect(why2).toBe("unknown_player")
        expect(h:call("sg_inventory", "defineItem", { name = "plasma_rifle", weight = 4, stack = 1 })).toBe(true)
        expect(h:call("sg_inventory", "add", 1, "plasma_rifle", 1)).toBe(true)
    end)
end)
