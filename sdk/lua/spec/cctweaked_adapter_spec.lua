-- The CC: Tweaked adapter (sdk/adapters/cctweaked/computer/scriptgo/adapter.lua) against stand-ins for
-- the CC: Tweaked APIs it uses (fs, os.epoch, os.clock, http, settings, colours), on every interpreter
-- of the spec run. Stand-ins only check the adapter's own logic; the real APIs are exercised by the
-- cc-core harness and, for verification, by `scriptgo verify --env cctweaked` in Minecraft.
local suite, scriptgo, ctx = ...
local test, expect, describe = suite.test, scriptgo.testing.expect, suite.describe

local ADAPTER = ctx.root .. "/sdk/adapters/cctweaked/computer/scriptgo/adapter.lua"

-- An in-memory disk with the parts of CC's fs API the adapter calls.
local function fakeFs()
    local files, dirs = {}, { [""] = true }
    local fs = {}
    local function norm(p) return (p:gsub("^/+", ""):gsub("/+$", "")) end
    function fs.combine(a, b) return norm(norm(a) .. "/" .. norm(b)) end
    function fs.getDir(p)
        p = norm(p)
        return p:match("^(.*)/[^/]*$") or ""
    end
    function fs.exists(p) p = norm(p) return files[p] ~= nil or dirs[p] == true end
    function fs.isDir(p) return dirs[norm(p)] == true end
    function fs.makeDir(p)
        p = norm(p)
        while p ~= "" do dirs[p] = true; p = fs.getDir(p) end
    end
    function fs.list(p)
        p = norm(p)
        local out, seen = {}, {}
        local prefix = p == "" and "" or (p .. "/")
        local function add(path)
            if path:sub(1, #prefix) == prefix then
                local name = path:sub(#prefix + 1):match("^[^/]+")
                if name and not seen[name] then seen[name] = true; out[#out + 1] = name end
            end
        end
        for f in pairs(files) do add(f) end
        for d in pairs(dirs) do if d ~= "" then add(d) end end
        table.sort(out)
        return out
    end
    function fs.open(p, mode)
        p = norm(p)
        if mode:sub(1, 1) == "r" then
            local text = files[p]
            if text == nil then return nil end
            return { readAll = function() return text end, close = function() end }
        end
        if not dirs[fs.getDir(p)] then return nil, "/" .. p .. ": No such file" end
        local parts = {}
        return {
            write = function(s) parts[#parts + 1] = s end,
            close = function() files[p] = table.concat(parts) end,
        }
    end
    fs.files = files
    function fs.put(p, text) fs.makeDir(fs.getDir(p)); files[norm(p)] = text end
    return fs
end

-- A CC-like global environment; http answers go to `requests` and come back as events.
local function cc(opts)
    opts = opts or {}
    local env = setmetatable({}, { __index = _G })
    env.fs = opts.fs or fakeFs()
    env.colours = { orange = 2, red = 16384, lime = 32, yellow = 16, white = 1 }
    env.settings = { get = function(k) return (opts.settings or {})[k] end }
    local clock = { now = 12.5, epoch = 1762700000123 }
    env.os = setmetatable({
        clock = function() return clock.now end,
        epoch = function(kind) assert(kind == "utc", "epoch kind") return clock.epoch end,
        time = function() return 7.25 end, -- the in-game hour on CC: Tweaked
    }, { __index = os })
    env.requests = {}
    if opts.http ~= false then
        env.http = {
            request = function(req)
                env.requests[#env.requests + 1] = req
                return true
            end,
        }
    end
    env.clock = clock
    return env
end

local function load(env, config, extra)
    local text = assert(ctx.readFile(ADAPTER), "adapter.lua not found")
    local chunk = assert(scriptgo.compat.loadWithEnv(text, "@adapter.lua", env))
    local o = { config = config or {}, out = function(line) env.printed = env.printed or {}; env.printed[#env.printed + 1] = line end }
    for k, v in pairs(extra or {}) do o[k] = v end
    return chunk()(scriptgo, o)
end

local function response(code, body)
    return {
        getResponseCode = function() return code end,
        readAll = function() return body end,
        getResponseHeaders = function() return { ["Content-Type"] = "text/plain" } end,
        close = function() end,
    }
end

describe("cctweaked adapter", function()
    test("names the environment, keeps licensing off and reads the clocks CC: Tweaked gives", function()
        local env = cc()
        local a = load(env)
        expect(a.environment).toBe("cctweaked")
        expect(a.adapterVersion).toBe("cctweaked-" .. scriptgo.VERSION)
        expect(a.capabilities.licensing).toBe(false)
        expect(a.capabilities.http).toBe(true)
        expect(a.now()).toBe(12.5)
        -- os.time() is an in-game hour there: the wall clock comes from os.epoch("utc").
        expect(a.wallTime()).toBe(1762700000)
    end)

    test("keeps licensing off even when the config tries to switch it on", function()
        local a = load(cc(), { licensing = true, convars = { scriptgo_api = "http://127.0.0.1:1" } })
        expect(a.capabilities.licensing).toBe(false)
    end)

    test("stores each key as a JSON file under /scriptgo/data", function()
        local env = cc()
        local a = load(env)
        a.storage.save("probe.server", '{"n":1}')
        expect(env.fs.files["scriptgo/data/probe.server.json"]).toBe('{"n":1}')
        expect(a.storage.load("probe.server")).toBe('{"n":1}')
        expect(a.storage.load("missing")).toBeNil()
    end)

    test("lists a resource's files recursively, skipping dot folders", function()
        local env = cc()
        env.fs.put("/scriptgo/resources/r/scriptgo.lua", "x")
        env.fs.put("/scriptgo/resources/r/server/main.lua", "x")
        env.fs.put("/scriptgo/resources/r/.git/HEAD", "x")
        local a = load(env)
        expect(a.listFiles("/scriptgo/resources/r")).toEqual({ "scriptgo.lua", "server/main.lua" })
    end)

    test("grants privileges from config.json, with * and prefix.* wildcards", function()
        local a = load(cc(), { permissions = { ["1"] = { "*" }, ["2"] = { "shop.*", "command.give" } } })
        expect(a.permissions.has(1, "anything")).toBe(true)
        expect(a.permissions.has(2, "shop.sell")).toBe(true)
        expect(a.permissions.has(2, "command.give")).toBe(true)
        expect(a.permissions.has(2, "command.kick")).toBe(false)
        expect(a.permissions.has(3, "shop.sell")).toBe(false)
    end)

    test("reads resource config, then convars, then the computer's settings", function()
        local a = load(cc({ settings = { motd = "from settings" } }), { resources = { shop = { tax = 5 } }, convars = { region = "eu" } })
        expect(a.config.get("shop", "tax")).toBe(5)
        expect(a.config.get(nil, "region")).toBe("eu")
        expect(a.config.get(nil, "motd")).toBe("from settings")
        expect(a.config.get("other", "tax")).toBeNil()
    end)

    test("prints notifications for the terminal player only", function()
        local env = cc()
        local a = load(env)
        a.ui.notify(2, { title = "Shop", message = "for someone else" })
        a.ui.notify(1, { title = "Shop", message = "bought", type = "success" })
        a.ui.notify(nil, { message = "local" })
        expect(env.printed).toEqual({ "* Shop: bought", "* local" })
        expect(#a.notifications).toBe(3)
    end)

    test("gives each HTTP request a unique fragment so answers to the same URL cannot be swapped", function()
        local env = cc()
        local a = load(env)
        local got = {}
        a.http.request({ url = "http://127.0.0.1:9/v1/x", method = "POST", body = "{}", headers = { n = 1 } }, function(r) got.first = r end)
        a.http.request({ url = "http://127.0.0.1:9/v1/x#old" }, function(r) got.second = r end)
        expect(env.requests[1].url).toBe("http://127.0.0.1:9/v1/x#sg-1")
        expect(env.requests[2].url).toBe("http://127.0.0.1:9/v1/x#sg-2")
        expect(env.requests[1].headers.n).toBe("1")
        expect(env.requests[1].redirect).toBe(false)
        expect(a.pendingRequests()).toBe(2)
        expect(a.onEvent("http_success", "http://127.0.0.1:9/v1/x#sg-2", response(200, "two"))).toBe(true)
        expect(got.second.body).toBe("two")
        expect(got.first).toBeNil()
        -- An HTTP error status still carries a response handle on http_failure.
        expect(a.onEvent("http_failure", "http://127.0.0.1:9/v1/x#sg-1", "Not Found", response(404, "nope"))).toBe(true)
        expect(got.first.status).toBe(404)
        expect(a.onEvent("http_success", "http://other/#sg-9", response(200, ""))).toBe(false)
        expect(a.onEvent("timer", 1)).toBe(false)
        expect(a.pendingRequests()).toBe(0)
    end)

    test("fails a request with no response, and every pending one when the host stops", function()
        local env = cc()
        local a = load(env)
        local got = {}
        a.http.request({ url = "http://a/" }, function(r) got.a = r end)
        a.http.request({ url = "http://b/" }, function(r) got.b = r end)
        a.onEvent("http_failure", "http://a/#sg-1", "Domain not permitted")
        expect(got.a.status).toBe(0)
        expect(got.a.error).toBe("http_failed: Domain not permitted")
        a.shutdown()
        expect(got.b.error).toBe("http_failed: the host stopped")
    end)

    test("reports HTTP unavailable when the server disables it or the config turns it off", function()
        local off = load(cc({ http = false }))
        expect(off.capabilities.http).toBe(false)
        expect(off.httpUnavailable:find("http.enabled", 1, true) ~= nil).toBe(true)
        local cfgOff = load(cc(), { http = false })
        expect(cfgOff.capabilities.http).toBe(false)
        expect(cfgOff.httpUnavailable).toBe("disabled by config")
    end)

    test("runs a resource through the core host: storage, wall clock and terminal notifications", function()
        local env = cc()
        env.fs.put("/scriptgo/resources/demo/scriptgo.lua", 'resource "demo"\nversion "1.0.0"\nscriptgo_version ">=0.1.0"\nenvironments { "cctweaked" }\ncapabilities { "storage", "ui" }\nserver_script "server/main.lua"\n')
        env.fs.put("/scriptgo/resources/demo/server/main.lua", table.concat({
            "local n = (ScriptGo.storage.get('runs') or 0) + 1",
            "ScriptGo.storage.set('runs', n)",
            "WALL = ScriptGo.time.now()",
            "exports('wall', function() return WALL end)",
            "exports('osTime', function() return os.time() end)",
            "ScriptGo.ui.notify(1, { title = 'demo', message = 'run ' .. n })",
        }, "\n"))
        local a = load(env)
        local host = scriptgo.newHost({ adapter = a, localPlayer = { id = 1, name = "Terminal" } })
        assert(host:addResource("/scriptgo/resources/demo"))
        local ok, why = host:start("demo")
        expect(ok).toBe(true, why)
        host:tick(a.now())
        expect(host:callExportSync("demo", "wall", "server")).toBe(1762700000)
        expect(host:callExportSync("demo", "osTime", "server")).toBe(1762700000)
        local shown = false
        for _, line in ipairs(env.printed) do if line == "* demo: run 1" then shown = true end end
        expect(shown).toBe(true)
        host:stopAll()
        local stored = false
        for path in pairs(env.fs.files) do if path:find("^scriptgo/data/") then stored = true end end
        expect(stored).toBe(true)
    end)
end)
