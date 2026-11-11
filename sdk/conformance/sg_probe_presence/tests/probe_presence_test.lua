-- The player match probe on the standalone host, against an in-memory API that answers like the
-- real one (docs/spec/player-match.md). `scriptgo verify --stub-api` runs the same probe against
-- the schema-checked stub over HTTP (packages/cli/src/lib/stub-presence.ts).
local API = "http://api.test"
local TOKEN = "sg_srv_test_token_0001"
local KEY = "pk_test_20261111"
-- HMAC-SHA256(KEY, "203.0.113.9"), from Node's crypto: the test stands in for the host's HMAC
-- with this one known answer, so a fingerprint that is not this one fails the report below.
local FP = "048bfae99c6a7a6e511353e1c419cb4f8d32f8ac0700067cf6b1b4170bcac946"

local function fakeApi(json, seen)
    local function err(status, code)
        return { status = status, body = json.encode({ error = { code = code, message = code } }) }
    end
    local function authorized(req) return req.headers and req.headers.authorization == "Bearer " .. TOKEN end
    return {
        ["POST " .. API .. "/v1/presence"] = function(req)
            if not authorized(req) then return err(401, "unknown_server_link") end
            local b = json.decode(req.body)
            for _, p in ipairs(b.players or {}) do
                if p.fp[1] ~= FP then return err(400, "validation_failed") end
                seen[#seen + 1] = p
            end
            return { status = 200, body = json.encode({ accepted = #(b.players or {}), presenceKey = KEY, rotatesAt = "2099-01-01T00:00:00.000Z" }) }
        end,
        ["POST " .. API .. "/v1/identity/codes/confirm"] = function(req)
            if not authorized(req) then return err(401, "unknown_server_link") end
            local code = json.decode(req.body).code:gsub("%-", "")
            if code == "K74QX" then return { status = 200, body = "{\"linked\":true}" } end
            if code == "USED00" then return err(410, "code_used") end
            if code == "EXP1RE" then return err(410, "code_expired") end
            return err(404, "unknown_code")
        end,
    }
end

describe("sg_probe_presence", function()
    test("every check passes against an API that follows the contract", function()
        local seen = {}
        local h = load({
            http = fakeApi(scriptgo.json, seen),
            config = { _global = { scriptgo_api = API, scriptgo_server_token = TOKEN, scriptgo_presence = "true" } },
            crypto = {
                hmacSha256 = function(key, message)
                    if key == KEY and message == "203.0.113.9" then return FP end
                    return ("0"):rep(64)
                end,
            },
        })
        h:join(1, "Ada", "203.0.113.9:30120")
        h:tick(3000)
        local r = h:call("sg_probe_presence", "results")
        expect(r.done).toBe(true)
        expect(r.fail).toBe(0)
        expect(#seen >= 1).toBe(true)
        expect(seen[1].name).toBe("Ada")
    end)

    test("without an HMAC, presence says why and the link command still works", function()
        local h = load({
            http = fakeApi(scriptgo.json, {}),
            config = { _global = { scriptgo_api = API, scriptgo_server_token = TOKEN, scriptgo_presence = "true" } },
        })
        h:join(1, "Ada", "203.0.113.9")
        h:tick(3000)
        local r = h:call("sg_probe_presence", "results")
        expect(r.done).toBe(true)
        -- presence.active and presence.reported fail; everything else passes.
        expect(r.fail).toBe(2)
    end)
end)
