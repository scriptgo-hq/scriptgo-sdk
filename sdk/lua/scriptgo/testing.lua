-- Test support: an in-memory adapter with a manual clock, and a harness that drives a host the way
-- a player and an operator would (join, run commands, call exports, advance time) while recording
-- everything the resource did (logs, notifications, storage writes, network events).
--
-- Used by the SDK's own specs, by `scriptgo test` for resource `test_script` files, and by the
-- adapter verification runs.
local R = ...
local hostLib = R("host")
local json = R("json")
local caps = R("capabilities")
local compat = R("compat")

local M = {}

local function readDisk(path)
    local f = io and io.open(path, "rb")
    if not f then return nil end
    local text = f:read("*a")
    f:close()
    return text
end

-- opts.files      = { ["res/scriptgo.lua"] = "...", ... } in-memory files (checked first)
-- opts.readFile   = fallback reader (defaults to the disk when io exists)
-- opts.capabilities = set of capability names (defaults to every capability)
-- opts.environment  = environment id reported to resources (default "standalone")
-- opts.permissions  = { [playerId] = { ["privilege"] = true } }
-- opts.config       = { [resourceName] = { key = value }, _global = { convar = value } }
-- opts.wallTime     = function returning Unix seconds, for hosts whose os.time is not (CC: Tweaked)
function M.memoryAdapter(opts)
    opts = opts or {}
    local files = opts.files or {}
    local read = opts.readFile or readDisk
    local clock = 0
    local adapter = {
        environment = opts.environment or "standalone",
        adapterVersion = "testing",
        capabilities = {},
        storageData = {},
        notifications = {},
        logs = {},
        httpLog = {},
        wallTime = opts.wallTime,
        -- Simulated players carry the address given to Harness:join (player match tests), and
        -- opts.crypto = { hmacSha256 = fn } stands in for the host's vetted HMAC.
        playerAddresses = true,
        crypto = opts.crypto,
    }
    local set = opts.capabilities
    for _, c in ipairs(caps.ALL) do
        adapter.capabilities[c] = (set == nil) or (set[c] == true)
    end
    function adapter.now() return clock end
    function adapter.advance(seconds) clock = clock + seconds end
    function adapter.readFile(path)
        path = path:gsub("\\", "/")
        local text = files[path]
        if text ~= nil then return text end
        return read(path)
    end
    -- Lists in-memory files under a root (disk listing is the real adapters' job).
    function adapter.listFiles(root)
        root = root:gsub("\\", "/"):gsub("/$", "") .. "/"
        local out = {}
        for path in pairs(files) do
            if path:sub(1, #root) == root then out[#out + 1] = path:sub(#root + 1) end
        end
        table.sort(out)
        return out
    end
    function adapter.log(level, origin, msg)
        adapter.logs[#adapter.logs + 1] = { level = level, origin = origin, message = msg }
        if opts.echo then print(("[%s] %s: %s"):format(level, origin, msg)) end
    end
    adapter.storage = {
        load = function(key) return adapter.storageData[key] end,
        save = function(key, text) adapter.storageData[key] = text end,
    }
    adapter.ui = {
        notify = function(target, payload)
            adapter.notifications[#adapter.notifications + 1] = { target = target, payload = payload }
        end,
    }
    local perms = opts.permissions or {}
    adapter.permissions = {
        has = function(playerId, privilege)
            local p = perms[playerId]
            return p ~= nil and (p[privilege] == true or p["*"] == true)
        end,
        grant = function(playerId, privilege)
            perms[playerId] = perms[playerId] or {}
            perms[playerId][privilege] = true
        end,
    }
    local config = opts.config or {}
    adapter.config = {
        get = function(resourceName, key)
            local scope = resourceName and config[resourceName] or config._global
            if scope == nil then return nil end
            return scope[key]
        end,
    }
    -- HTTP: tests register handlers by "METHOD url"; unmatched requests answer 599.
    local routes = opts.http or {}
    adapter.http = {
        request = function(req, done)
            adapter.httpLog[#adapter.httpLog + 1] = req
            local handler = routes[(req.method or "GET") .. " " .. req.url] or routes[req.url]
            local response
            if type(handler) == "function" then response = handler(req)
            elseif type(handler) == "table" then response = handler
            else response = { status = 599, body = "{\"error\":{\"code\":\"no_route\"}}" } end
            done(response)
        end,
        route = function(key, handler) routes[key] = handler end,
    }
    return adapter
end

local Harness = {}
Harness.__index = Harness

-- Creates a host over a memory adapter. Accepts the memoryAdapter options plus `localPlayer`.
function M.harness(opts)
    opts = opts or {}
    local adapter = opts.adapter or M.memoryAdapter(opts)
    local host = hostLib.new({
        adapter = adapter,
        environment = opts.environment or adapter.environment,
        sides = opts.sides,
        localPlayer = opts.localPlayer or { id = 1, name = "Tester" },
        budgetMs = opts.budgetMs,
    })
    return setmetatable({ host = host, adapter = adapter }, Harness)
end

function Harness:add(root, opts)
    local res, err = self.host:addResource(root, opts)
    if not res then error(err, 2) end
    return res
end

function Harness:start(name)
    local ok, why = self.host:start(name)
    self:tick(0)
    return ok, why
end

function Harness:stop(name) return self.host:stop(name) end

-- Advances the manual clock by `ms` in 10 ms ticks (one tick at least).
function Harness:tick(ms)
    ms = ms or 0
    local steps = math.max(1, math.ceil(ms / 10))
    local per = ms / steps / 1000
    for _ = 1, steps do
        self.adapter.advance(per)
        self.host:tick(self.adapter.now())
    end
end

function Harness:join(id, name, address)
    self.host:playerJoin(id, name, address)
    self:tick(0)
end

function Harness:drop(id, reason)
    self.host:playerDrop(id, reason)
    self:tick(0)
end

function Harness:command(source, line)
    local ok, why = self.host:executeCommand(source, line)
    self:tick(0)
    return ok, why
end

-- Calls an export synchronously (ticks the host until it settles).
function Harness:call(resource, export, ...)
    return self.host:callExportSync(resource, export, "server", 5000, ...)
end

function Harness:callClient(resource, export, ...)
    return self.host:callExportSync(resource, export, "client", 5000, ...)
end

-- Sends a network event from the local client to the server (as player `source`).
function Harness:clientEmit(name, ...)
    local args = R("codec").copyArgs(...)
    self.host:_queue("net", "server", name, args, { source = self.host.localPlayer.id })
    self:tick(0)
end

function Harness:notifications() return self.adapter.notifications end

function Harness:lastNotification()
    local n = self.adapter.notifications
    return n[#n]
end

function Harness:logs(level)
    local out = {}
    for _, e in ipairs(self.adapter.logs) do
        if not level or e.level == level then out[#out + 1] = e end
    end
    return out
end

-- Returns the first log line matching a Lua pattern, or nil.
function Harness:findLog(pattern, level)
    for _, e in ipairs(self.adapter.logs) do
        if (not level or e.level == level) and tostring(e.message):find(pattern) then return e end
    end
    return nil
end

function Harness:storage(resourceName)
    local text = self.adapter.storageData[resourceName]
    if not text then return {} end
    return json.decode(text)
end

-- A tiny test runner for resource `test_script` files and SDK specs ---------------------------------
-- test(name, fn), expect(value).toBe(x) / toEqual(x) / toBeTruthy() / toBeNil() / toContain(s) /
-- toThrow(pattern?), plus harness access through `scriptgo.testing`.
local function deepEqual(a, b, seen)
    if a == b then return true end
    if type(a) ~= "table" or type(b) ~= "table" then return false end
    seen = seen or {}
    if seen[a] == b then return true end
    seen[a] = b
    for k, v in pairs(a) do
        if not deepEqual(v, b[k], seen) then return false end
    end
    for k in pairs(b) do
        if a[k] == nil then return false end
    end
    return true
end
M.deepEqual = deepEqual

local function show(v)
    if type(v) == "table" then
        local ok, text = pcall(json.encode, v)
        if ok then return text end
    end
    if type(v) == "string" then return string.format("%q", v) end
    return tostring(v)
end
M.show = show

function M.expect(actual)
    local e = {}
    local function fail(msg) error(msg, 3) end
    function e.toBe(expected)
        if actual ~= expected then fail("expected " .. show(expected) .. ", got " .. show(actual)) end
    end
    function e.toEqual(expected)
        if not deepEqual(actual, expected) then fail("expected " .. show(expected) .. ", got " .. show(actual)) end
    end
    function e.toBeTruthy()
        if not actual then fail("expected a truthy value, got " .. show(actual)) end
    end
    function e.toBeFalsy()
        if actual then fail("expected a falsy value, got " .. show(actual)) end
    end
    function e.toBeNil()
        if actual ~= nil then fail("expected nil, got " .. show(actual)) end
    end
    function e.toContain(fragment)
        if type(actual) ~= "string" or not actual:find(fragment, 1, true) then
            fail("expected " .. show(actual) .. " to contain " .. show(fragment))
        end
    end
    function e.toThrow(pattern)
        if type(actual) ~= "function" then fail("toThrow needs a function") end
        local ok, err = pcall(actual)
        if ok then fail("expected an error") end
        if pattern and not tostring(err):find(pattern, 1, true) then
            fail("expected error containing " .. show(pattern) .. ", got " .. show(tostring(err)))
        end
    end
    return e
end

-- Collects tests, runs them, returns { passed, failed, results = { {name, ok, err} } }.
function M.suite()
    local s = { tests = {}, prefix = {} }
    function s.describe(name, fn)
        s.prefix[#s.prefix + 1] = name
        fn()
        s.prefix[#s.prefix] = nil
    end
    function s.test(name, fn)
        local full = #s.prefix > 0 and (table.concat(s.prefix, " > ") .. " > " .. name) or name
        s.tests[#s.tests + 1] = { name = full, fn = fn }
    end
    s.it = s.test
    function s.run(report)
        local passed, failed, results = 0, 0, {}
        for _, t in ipairs(s.tests) do
            local ok, err = compat.xpcall(t.fn, function(e)
                if type(debug) == "table" and debug.traceback then return debug.traceback(tostring(e), 2) end
                return tostring(e)
            end)
            if ok then passed = passed + 1 else failed = failed + 1 end
            results[#results + 1] = { name = t.name, ok = ok, err = (not ok) and tostring(err) or nil }
            if report then report(t.name, ok, err) end
        end
        return { passed = passed, failed = failed, results = results }
    end
    return s
end

return M
