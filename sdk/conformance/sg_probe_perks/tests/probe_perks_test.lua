-- The perks probe on the standalone host, against an in-memory API that answers like the real one
-- (docs/spec/perks.md). `scriptgo verify --stub-api` runs the same probe against the
-- schema-checked stub over HTTP (packages/cli/src/lib/stub-perks.ts).
local API = "http://api.test"
local TOKEN = "sg_srv_test_token_0001"

local function fakeApi(json)
    local function err(status, code)
        return { status = status, body = json.encode({ error = { code = code, message = code } }) }
    end
    local function authorized(req) return req.headers and req.headers.authorization == "Bearer " .. TOKEN end
    local later = "2099-01-01T00:00:00.000Z"
    return {
        ["POST " .. API .. "/v1/perks/check"] = function(req)
            if not authorized(req) then return err(401, "unknown_server_link") end
            local b = json.decode(req.body)
            local perks = {}
            if b.player == "sgprobe:holder" then
                perks[1] = { key = "vip", status = "active", expiresAt = later, offlineGraceUntil = later }
            end
            return { status = 200, body = json.encode({ player = b.player, perks = perks, serverTime = "2026-11-11T00:00:00.000Z" }) }
        end,
        ["GET " .. API .. "/v1/perks/events?limit=100"] = {
            status = 200,
            body = json.encode({
                events = { { seq = 1, kind = "granted", perk = "vip", player = "sgprobe:buyer", reason = "purchase", status = "active",
                    expiresAt = later, offlineGraceUntil = later, at = "2026-11-11T00:00:00.000Z" } },
                cursor = 1, more = false, serverTime = "2026-11-11T00:00:00.000Z",
            }),
        },
        ["GET " .. API .. "/v1/perks/events?limit=100&after=1"] = {
            status = 200, body = "{\"events\":[],\"cursor\":1,\"more\":false,\"serverTime\":\"2026-11-11T00:00:00.000Z\"}",
        },
        ["POST " .. API .. "/v1/perks/events/ack"] = { status = 200, body = "{\"acked\":1}" },
        ["GET " .. API .. "/v1/perks/catalog"] = {
            status = 200,
            body = json.encode({
                { key = "vip", name = "VIP", description = "", interval = "month", price = { amount = 500, currency = "EUR" }, purchasable = true },
                { key = "gold", name = "Gold", description = "", interval = "perpetual", price = { amount = 1500, currency = "EUR" }, purchasable = false },
            }),
        },
        ["POST " .. API .. "/v1/perks/purchase-link"] = function(req)
            local b = json.decode(req.body)
            if b.perk == "gold" then return err(409, "not_purchasable") end
            if b.player == "sgprobe:holder" then return err(409, "already_held") end
            return { status = 201, body = "{\"url\":\"http://site.test/perk/x\",\"expiresAt\":\"2026-11-12T00:00:00.000Z\"}" }
        end,
    }
end

describe("sg_probe_perks", function()
    test("every check passes against an API that follows the contract", function()
        local h = load({
            http = fakeApi(scriptgo.json),
            config = { _global = { scriptgo_api = API, scriptgo_server_token = TOKEN } },
        })
        h:tick(2000)
        local r = h:call("sg_probe_perks", "results")
        expect(r.done).toBe(true)
        expect(r.fail).toBe(0)
        expect(r.pass).toBe(13)
    end)

    test("without a server link token, perks say not_linked instead of guessing", function()
        local h = load({ http = fakeApi(scriptgo.json), config = { _global = { scriptgo_api = API } } })
        h:tick(12000)
        local r = h:call("sg_probe_perks", "results")
        expect(r.done).toBe(true)
        expect(r.fail > 0).toBe(true)
    end)
end)
