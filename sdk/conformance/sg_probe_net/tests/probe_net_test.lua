-- The network probe on the standalone host, against an in-memory API that answers like the real
-- one. `scriptgo verify --stub-api` runs the same probe against the schema-checked stub over HTTP.
local API = "http://api.test"
local KEY = "sg_live_test_key_0001"

local function fakeApi(json)
    local tokens = {}
    local function answer(valid, reason)
        return {
            status = 200,
            body = json.encode({
                valid = valid, reason = reason or json.null, status = valid and "active" or json.null,
                activationStatus = json.null, expiresAt = json.null,
                offlineGraceUntil = valid and "2030-01-01T00:00:00.000Z" or json.null,
                environments = valid and { "standalone" } or {}, token = "t",
            }),
        }
    end
    return {
        ["GET " .. API .. "/v1/health"] = { status = 200, body = "{\"ok\":true,\"version\":\"test\"}" },
        ["GET " .. API .. "/v1/sg-probe-missing"] = { status = 404, body = "{\"error\":{\"code\":\"not_found\"}}" },
        ["POST " .. API .. "/v1/licenses/verify"] = function(req)
            local b = json.decode(req.body)
            if b.deploymentToken then
                if not tokens[b.deploymentToken] then return answer(false, "unknown_key") end
                local r = answer(true)
                local decoded = json.decode(r.body)
                decoded.activationStatus = "active"
                r.body = json.encode(decoded)
                return r
            end
            if b.licenseKey == KEY and b.package == "sg_probe_net" then return answer(true) end
            return answer(false, "unknown_key")
        end,
        ["POST " .. API .. "/v1/licenses/activate"] = function(req)
            local b = json.decode(req.body)
            if b.licenseKey ~= KEY then
                return { status = 404, body = "{\"error\":{\"code\":\"unknown_key\",\"message\":\"Unknown license key.\"}}" }
            end
            tokens["sg_dep_1"] = true
            return { status = 201, body = "{\"activationId\":\"act_1\",\"deploymentToken\":\"sg_dep_1\"}" }
        end,
    }
end

describe("sg_probe_net", function()
    test("every check passes against an API that follows the contract", function()
        local h = load({
            http = fakeApi(scriptgo.json),
            config = { sg_probe_net = { api = API, license_key = KEY }, _global = { scriptgo_api = API } },
        })
        h:tick(1000)
        local r = h:call("sg_probe_net", "results")
        expect(r.done).toBe(true)
        if r.fail > 0 then
            for _, line in ipairs(r.lines) do print(line) end
        end
        expect(r.fail).toBe(0)
        expect(r.pass).toBe(9)
    end)

    test("without config it says so instead of guessing", function()
        local h = load({ http = fakeApi(scriptgo.json) })
        h:tick(1000)
        local r = h:call("sg_probe_net", "results")
        expect(r.done).toBe(true)
        expect(r.fail).toBe(1)
        expect(r.lines[2]:find("config.present", 1, true) ~= nil).toBe(true)
    end)
end)
