-- Items and recipes added by Inventory Pro. Defines the global `InvProCatalog`.
InvProCatalog = {}

InvProCatalog.RARITIES = { "common", "uncommon", "rare", "epic" }

InvProCatalog.ITEMS = {
    { name = "repair_kit", label = "Repair kit", weight = 1.2, stack = 5, usable = true, consume = true, category = "tools", rarity = "uncommon" },
    { name = "lantern", label = "Lantern", weight = 0.8, stack = 1, usable = true, category = "tools", rarity = "common" },
    { name = "lockpick", label = "Lockpick", weight = 0.05, stack = 10, usable = true, consume = true, category = "tools", rarity = "rare" },
    { name = "cloth", label = "Cloth", weight = 0.1, stack = 50, category = "materials", rarity = "common" },
    { name = "medkit", label = "Medkit", weight = 0.6, stack = 5, usable = true, consume = true, category = "medical", rarity = "uncommon" },
}

InvProCatalog.RECIPES = {
    repair_kit = { output = { item = "repair_kit", count = 1 }, inputs = { { item = "scrap", count = 4 }, { item = "rope", count = 1 } } },
    lockpick = { output = { item = "lockpick", count = 2 }, inputs = { { item = "scrap", count = 2 } } },
    medkit = { output = { item = "medkit", count = 1 }, inputs = { { item = "bandage", count = 3 }, { item = "cloth", count = 2 } } },
    lantern = { output = { item = "lantern", count = 1 }, inputs = { { item = "scrap", count = 6 }, { item = "cloth", count = 1 } } },
}

InvProCatalog.HOTBAR_SIZE = 5

function InvProCatalog.rarityOf(name)
    for _, it in ipairs(InvProCatalog.ITEMS) do
        if it.name == name then return it.rarity end
    end
    return "common"
end
