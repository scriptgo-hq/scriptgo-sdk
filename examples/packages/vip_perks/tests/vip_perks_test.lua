-- Run with: scriptgo test examples/packages/vip_perks
-- A fake SCRIPT//GO API on the harness's HTTP: one player has the perk, the other does not.
local API = "http://api.test"

local function iso(offsetSeconds)
    return os.date("!%Y-%m-%dT%H:%M:%S.000Z", os.time() + offsetSeconds)
end

local function setup(opts)
    opts = opts or {}
    local asked = {}
    local h = load({
        config = { _global = { scriptgo_api = API, scriptgo_server_token = opts.token or "sg_srv_example" } },
        http = {
            ["POST " .. API .. "/v1/perks/check"] = function(req)
                if (req.headers or {}).authorization ~= "Bearer sg_srv_example" then
                    return { status = 401, body = '{"error":{"code":"unknown_server_link"}}' }
                end
                local body = scriptgo.json.decode(req.body)
                asked[#asked + 1] = body.player
                local perks = {}
                if body.player == "local:ada" then
                    perks[1] = { key = "vip", status = "active", expiresAt = iso(30 * 86400), offlineGraceUntil = iso(72 * 3600) }
                end
                return { status = 200, body = scriptgo.json.encode({ player = body.player, perks = perks, serverTime = iso(0) }) }
            end,
            ["POST " .. API .. "/v1/perks/purchase-link"] = function(req)
                local body = scriptgo.json.decode(req.body)
                return { status = 201, body = scriptgo.json.encode({ url = "https://web.test/perk/" .. body.player, expiresAt = iso(900) }) }
            end,
        },
    })
    return h, asked
end

describe("vip_perks", function()
    test("asks when a player joins and applies the perk", function()
        local h, asked = setup()
        h:join(2, "Ada")
        h:join(3, "Bob")
        expect(asked).toEqual({ "local:ada", "local:bob" })
        expect(h:call("vip_perks", "isVip", 2)).toBe(true)
        expect(h:call("vip_perks", "isVip", 3)).toBe(false)
        expect(h:findLog("SGPERK join player=2 identifier=local:ada vip=true")).toBeTruthy()
        expect(h:findLog("SGPERK applied player=2")).toBeTruthy()
        expect(h:lastNotification().payload.message).toBe("Your VIP perk is active.")
    end)

    test("offers a purchase link to a player who does not have it", function()
        local h = setup()
        h:join(3, "Bob")
        local has, why = h:call("vip_perks", "has", 3)
        expect(has).toBe(false)
        expect(why).toBe("not_held")
        expect(h:call("vip_perks", "link", 3)).toBe("https://web.test/perk/local:bob")
    end)

    test("on a server that is not linked, nobody has the perk", function()
        local h = setup({ token = "sg_srv_not_this_one" })
        h:join(2, "Ada")
        local has, why = h:call("vip_perks", "has", 2)
        expect(has).toBe(false)
        expect(why).toBe("not_linked")
        expect(h:call("vip_perks", "isVip", 2)).toBe(false)
    end)
end)
