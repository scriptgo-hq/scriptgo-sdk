-- Prints `SGCHECK PASS|FAIL <name>` per check and `SGCHECK DONE ...` at the end, like sg_probe.
-- The checks follow the licensing API contract (packages/shared VerifyResult / ActivateResult): a
-- refused key is an answer (valid = false), not an error; activate refuses an unknown key with
-- the error code `unknown_key`.
local results = { pass = 0, fail = 0, lines = {}, done = false }
local PACKAGE = "sg_probe_net"
local UNKNOWN_KEY = "sg_live_not_a_real_key_0000"

local function record(name, ok, detail)
    local line
    if ok then
        results.pass = results.pass + 1
        line = "SGCHECK PASS " .. name
    else
        results.fail = results.fail + 1
        line = "SGCHECK FAIL " .. name .. (detail ~= nil and (" " .. tostring(detail)) or "")
    end
    results.lines[#results.lines + 1] = line
    print(line)
end

local function check(name, fn)
    local ok, verdict, detail = pcall(fn)
    if not ok then return record(name, false, "raised: " .. tostring(verdict)) end
    record(name, verdict == true, detail)
end

local function run()
    local env = ScriptGo.runtime.environment()
    local api = ScriptGo.config.get("api")
    local key = ScriptGo.config.get("license_key")

    check("capabilities.declared", function()
        for _, c in ipairs({ "http", "licensing", "config" }) do
            if not ScriptGo.capabilities.has(c) then return false, c end
        end
        return true
    end)
    local configured = type(api) == "string" and api ~= "" and type(key) == "string" and key ~= ""
    record("config.present", configured, "set the `api` and `license_key` config of sg_probe_net")
    if configured then
        api = api:gsub("/+$", "")

        check("http.get", function()
            local r, why = ScriptGo.http.request({ method = "GET", url = api .. "/v1/health" })
            if not r then return false, why end
            local ok, body = pcall(ScriptGo.json.decode, r.body or "")
            return r.status == 200 and ok and type(body) == "table" and body.ok == true, tostring(r.status) .. " " .. tostring(r.body)
        end)
        -- A 4xx is an answer with a status, not a transport failure.
        check("http.status_404", function()
            local r, why = ScriptGo.http.request({ method = "GET", url = api .. "/v1/sg-probe-missing" })
            return r ~= nil and r.status == 404, r and r.status or why
        end)

        check("licensing.verify_valid", function()
            local r, why = ScriptGo.licensing.verify({ licenseKey = key, package = PACKAGE })
            if type(r) ~= "table" then return false, why end
            return r.valid == true and r.reason == nil and r.status == "active" and type(r.offlineGraceUntil) == "string"
                and type(r.token) == "string", tostring(r.reason)
        end)
        check("licensing.verify_unknown", function()
            local r, why = ScriptGo.licensing.verify({ licenseKey = UNKNOWN_KEY, package = PACKAGE })
            if type(r) ~= "table" then return false, why end
            return r.valid == false and r.reason == "unknown_key", tostring(r.reason)
        end)
        local token
        check("licensing.activate", function()
            local r, why = ScriptGo.licensing.activate({ licenseKey = key, package = PACKAGE, deploymentName = "sg-probe-" .. env })
            if type(r) ~= "table" then return false, why end
            token = r.deploymentToken
            return type(r.activationId) == "string" and type(token) == "string", "no deployment token"
        end)
        check("licensing.verify_deployment", function()
            if not token then return false, "no token from activate" end
            local r, why = ScriptGo.licensing.verify({ deploymentToken = token, package = PACKAGE })
            if type(r) ~= "table" then return false, why end
            return r.valid == true and r.activationStatus == "active", tostring(r.reason)
        end)
        check("licensing.activate_unknown", function()
            local r, why = ScriptGo.licensing.activate({ licenseKey = UNKNOWN_KEY, package = PACKAGE, deploymentName = "sg-probe" })
            return r == nil and why == "unknown_key", why
        end)
    end

    -- On OPEN//77 the operator's allow-list is the whole reachable surface: anything else is refused
    -- before a byte leaves the server.
    if env == "open77" then
        check("http.allow_list", function()
            local r, why = ScriptGo.http.request({ method = "GET", url = "http://not-allowed.invalid/" })
            return r == nil and why == "host_not_allowed", tostring(why or (r and r.status))
        end)
    end

    results.done = true
    print(("SGCHECK DONE env=%s lua=%s pass=%d fail=%d"):format(env, _VERSION, results.pass, results.fail))
end

exports("results", function() return results end)

CreateThread(function()
    Wait(100)
    run()
end)
