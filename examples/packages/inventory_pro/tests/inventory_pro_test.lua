-- Run with: scriptgo test examples/packages/inventory_pro --search sdk/packages
local VERIFY = "POST https://api.scriptgo.dev/v1/licenses/verify"

local function iso(offsetSeconds)
    return os.date("!%Y-%m-%dT%H:%M:%SZ", os.time() + offsetSeconds)
end

local function validResponse(req)
    local body = scriptgo.json.decode(req.body)
    if body.licenseKey ~= "SG-KESTREL-OK" then
        return { status = 200, body = '{"valid":false,"status":"revoked","reason":"unknown_key"}' }
    end
    return { status = 200, body = scriptgo.json.encode({
        valid = true, status = "active", activationStatus = "active", expiresAt = scriptgo.json.null,
        offlineGraceUntil = iso(72 * 3600), environments = { "standalone" }, token = "signed",
        package = body.package,
    }) }
end

local function setup(key, route)
    local h = load({
        config = { inventory_pro = { license_key = key } },
        http = { [VERIFY] = route or validResponse },
    })
    h:join(1, "Ada")
    h:tick(20)
    return h
end

local function give(h, item, n) return h:call("sg_inventory", "add", 1, item, n) end

describe("inventory_pro licensing", function()
    test("a valid license enables crafting", function()
        local h = setup("SG-KESTREL-OK")
        expect(h:call("inventory_pro", "status").state).toBe("active")
        give(h, "scrap", 4); give(h, "rope", 1)
        local ok, out = h:call("inventory_pro", "craft", 1, "repair_kit")
        expect(ok).toBe(true)
        expect(out).toEqual({ item = "repair_kit", count = 1 })
        expect(h:call("sg_inventory", "count", 1, "repair_kit")).toBe(1)
        expect(h:call("sg_inventory", "count", 1, "scrap")).toBe(0)
        -- The verify call carried the package and the environment.
        local sent = scriptgo.json.decode(h.adapter.httpLog[1].body)
        expect(sent.package).toBe("kestrel//inventory-pro")
        expect(sent.environment).toBe("standalone")
    end)

    test("without a key every premium feature is refused, with the reason", function()
        local h = setup(nil)
        expect(h:call("inventory_pro", "status").reason).toBe("no_license_key")
        local ok, why = h:call("inventory_pro", "craft", 1, "lockpick")
        expect(ok).toBe(false)
        expect(why).toBe("not_licensed:no_license_key")
        expect(h:findLog("license invalid %(no_license_key%)", "error")).toBeTruthy()
    end)

    test("a definitive refusal from the API switches the features off", function()
        local h = setup("SG-SOMEONE-ELSE")
        local s = h:call("inventory_pro", "status")
        expect(s.state).toBe("invalid")
        expect(s.reason).toBe("unknown_key")
    end)

    test("an unreachable API keeps a licensed server running inside its grace window", function()
        local h = setup("SG-KESTREL-OK")
        expect(h:call("inventory_pro", "status").state).toBe("active")
        h.adapter.http.route(VERIFY, { status = 503, body = '{"error":{"code":"unavailable"}}' })
        h:stop("inventory_pro")
        h:start("inventory_pro")
        h:tick(20)
        local s = h:call("inventory_pro", "status")
        expect(s.state).toBe("grace")
        expect(s.reason).toBe("api_unreachable:unavailable")
        give(h, "scrap", 2)
        expect(h:call("inventory_pro", "craft", 1, "lockpick")).toBe(true)
    end)

    test("outside the grace window an unreachable API means not licensed", function()
        local h = setup("SG-KESTREL-OK", function()
            return { status = 200, body = scriptgo.json.encode({ valid = true, status = "active", offlineGraceUntil = iso(-60) }) }
        end)
        h.adapter.http.route(VERIFY, { status = 503, body = "{}" })
        h:stop("inventory_pro")
        h:start("inventory_pro")
        h:tick(20)
        expect(h:call("inventory_pro", "status").state).toBe("invalid")
    end)
end)

describe("inventory_pro features", function()
    test("crafting checks inputs and leaves the inventory intact on failure", function()
        local h = setup("SG-KESTREL-OK")
        give(h, "bandage", 3)
        local ok, why = h:call("inventory_pro", "craft", 1, "medkit")
        expect(ok).toBe(false)
        expect(why).toBe("missing:cloth")
        expect(h:call("sg_inventory", "count", 1, "bandage")).toBe(3)
        expect(select(2, h:call("inventory_pro", "craft", 1, "nope"))).toBe("unknown_recipe")
    end)

    test("hotbar entries use the bound slot and persist", function()
        local h = setup("SG-KESTREL-OK")
        give(h, "water", 2)
        expect(h:call("inventory_pro", "bindHotbar", 1, 1, 1)).toBe(true)
        h:tick(20)
        expect(h:callClient("inventory_pro", "hotbar")).toEqual({ 1 })
        expect(h:call("inventory_pro", "useHotbar", 1, 1)).toBe(true)
        expect(h:call("sg_inventory", "count", 1, "water")).toBe(1)
        expect(select(2, h:call("inventory_pro", "useHotbar", 1, 3))).toBe("hotbar_empty")
        expect(h:storage("inventory_pro")["hotbar:local:ada"]).toEqual({ 1 })
    end)

    test("its items are registered with InventoryKit", function()
        local h = setup("SG-KESTREL-OK")
        local names = {}
        for _, it in ipairs(h:call("sg_inventory", "items")) do names[it.name] = true end
        expect(names.medkit and names.lockpick and names.repair_kit and true).toBe(true)
    end)

    test("the date helper reads ISO-8601 UTC exactly", function()
        local h = setup("SG-KESTREL-OK")
        local env = h.host:getResource("inventory_pro").sides.server.env
        expect(env.InvProLicense.isoToEpoch("1970-01-01T00:00:00Z")).toBe(0)
        expect(env.InvProLicense.isoToEpoch("2026-11-09T12:30:15.123Z")).toBe(1794227415)
        expect(env.InvProLicense.isoToEpoch("2000-02-29T00:00:00Z")).toBe(951782400)
    end)
end)
