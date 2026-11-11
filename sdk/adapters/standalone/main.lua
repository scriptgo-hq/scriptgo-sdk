-- SCRIPT//GO standalone host (CLI). Usually started by `scriptgo run|test|verify`; usable directly:
--
--   lua main.lua run    <resourceDir>... [--search dir]... [--config file.json] [--data dir]
--                       [--script file] [--for ms] [--realtime] [--log debug|info|warn|error]
--   lua main.lua test   <resourceDir> [--search dir]...
--   lua main.lua verify <resourceDir> [--search dir]... [--report out.json] [--environment id]
--                       [--with exampleDir]
--
-- A run script is a text file of steps, one per line ('#' comments):
--   wait 250                     advance time (simulated unless --realtime)
--   join 2 Bob | drop 2 quit     players; `join 2 Bob @203.0.113.7` gives a simulated address
--                                (player match tests: use documentation addresses only)
--   cmd 2 /give medkit 1         a player's chat command;  console stop_server  a console command
--   call res export [json args]  call a server export, print the result
--   expect-log <lua pattern>     fail unless a log line matches;  expect-notify <pattern> likewise
--   start res | stop res
local here = (debug.getinfo(1, "S").source:sub(2):gsub("\\", "/"):match("^(.*/)") or "./")
local sdkRoot = here .. "../../"
local scriptgo = assert(loadfile(sdkRoot .. "lua/scriptgo/init.lua"))(sdkRoot .. "lua/scriptgo/")
local json = scriptgo.json
local makeAdapter = assert(loadfile(here .. "adapter.lua"))()

local argv = { ... }
local command = argv[1]
local positional, flags, multi = {}, {}, { search = {} }
do
    local i = 2
    while i <= #argv do
        local a = argv[i]
        local name = a:match("^%-%-(.+)$")
        if name then
            local value = argv[i + 1]
            if name == "realtime" or name == "quiet" then
                flags[name] = true
                i = i + 1
            else
                if multi[name] then table.insert(multi[name], value) else flags[name] = value end
                i = i + 2
            end
        else
            positional[#positional + 1] = a
            i = i + 1
        end
    end
end

local function readFile(path)
    local f = io.open(path, "rb")
    if not f then return nil end
    local t = f:read("*a")
    f:close()
    return t
end

local function die(msg)
    io.stderr:write("scriptgo: " .. msg .. "\n")
    os.exit(2)
end

local function normalize(p) return (p:gsub("\\", "/"):gsub("/+$", "")) end

-- The manifest of a resource folder: scriptgo.lua, then scriptgo.json, then open77.lua.
local function readManifest(root)
    for _, name in ipairs(scriptgo.manifest.MANIFEST_FILES) do
        local text = readFile(root .. "/" .. name)
        if text then return text, name end
    end
    return nil
end

-- Finds a resource folder by name in the search paths.
local function locate(name)
    for _, dir in ipairs(multi.search) do
        local root = normalize(dir) .. "/" .. name
        if readManifest(root) then return root end
    end
    return nil
end

-- Adds a resource and, recursively, its dependencies found in the search paths.
local function addWithDeps(host, root, seen)
    seen = seen or {}
    local res, err = host:addResource(root)
    if not res then
        if err and err:find("already loaded") then return true end
        return nil, err
    end
    seen[res.name] = true
    for _, dep in ipairs(res.manifest.dependencies) do
        if not host:getResource(dep.name) then
            local depRoot = locate(dep.name)
            if depRoot then
                local ok, derr = addWithDeps(host, depRoot, seen)
                if not ok then return nil, derr end
            end
        end
    end
    return res
end

local function loadConfig()
    if not flags.config then return {} end
    local text = readFile(flags.config)
    if not text then die("cannot read config " .. flags.config) end
    local ok, cfg = pcall(json.decode, text)
    if not ok then die("invalid config: " .. tostring(cfg)) end
    return cfg
end

-- run ------------------------------------------------------------------------------------------------
local function run()
    if #positional == 0 then die("run: give at least one resource folder") end
    local cfg = loadConfig()
    local logs = {}
    local adapter = makeAdapter(scriptgo, {
        config = cfg, dataDir = flags.data, logLevel = flags.log, quiet = flags.quiet,
        logSink = function(level, origin, msg) logs[#logs + 1] = { level = level, origin = origin, message = msg } end,
    })
    local clock = 0
    if not flags.realtime then
        adapter.now = function() return clock end
    end
    local host = scriptgo.newHost({ adapter = adapter, localPlayer = { id = 1, name = (cfg.player or "Player") } })
    for _, root in ipairs(positional) do
        local ok, err = addWithDeps(host, normalize(root))
        if not ok then die(err) end
    end
    -- Host-enforced licenses: config "licenses": { "<resource>": { "deploymentToken": "sg_dep_...",
    -- "package": "creator//name" } }. A guarded resource starts on a valid answer of the licensing
    -- API only, is checked again every `interval` seconds (default 600) and is stopped when the
    -- offline grace of its last valid answer runs out. A license check, not code secrecy.
    if type(cfg.licenses) == "table" then
        for name, lic in pairs(cfg.licenses) do
            if host.resources[name] and type(lic) == "table" then
                host:guardLicense(name, {
                    deploymentToken = lic.deploymentToken, licenseKey = lic.licenseKey,
                    package = lic.package, interval = tonumber(lic.interval),
                })
            end
        end
        host:tick(adapter.now and adapter.now() or nil) -- the first check, before anything starts
    end
    local results = host:startAll()
    local failed = 0
    for name, state in pairs(results) do
        if state ~= "started" then failed = failed + 1; adapter.log("error", "host", name .. ": " .. tostring(state)) end
    end
    host:playerJoin(1, cfg.player or "Player", cfg.playerAddress)

    local function advance(ms)
        if flags.realtime then
            local target = adapter.now() + ms / 1000
            repeat
                host:tick(adapter.now())
                adapter.sleep(5)
            until adapter.now() >= target
        else
            local steps = math.max(1, math.ceil(ms / 10))
            for _ = 1, steps do
                clock = clock + (ms / steps) / 1000
                host:tick(clock)
            end
        end
    end
    advance(0)

    local stepFailures = 0
    local function step(line)
        line = line:gsub("^%s+", ""):gsub("%s+$", "")
        if line == "" or line:sub(1, 1) == "#" then return end
        local verb, rest = line:match("^(%S+)%s*(.*)$")
        if verb == "wait" then
            advance(tonumber(rest) or 0)
        elseif verb == "join" then
            local id, name = rest:match("^(%d+)%s*(.*)$")
            local address
            name, address = name:match("^(.-)%s*@(%S+)$") or name, name:match("@(%S+)$")
            host:playerJoin(tonumber(id), name ~= "" and name or nil, address); advance(0)
        elseif verb == "drop" then
            local id, reason = rest:match("^(%d+)%s*(.*)$")
            host:playerDrop(tonumber(id), reason ~= "" and reason or nil); advance(0)
        elseif verb == "cmd" then
            local id, cmdline = rest:match("^(%d+)%s+(.*)$")
            local ok, why = host:executeCommand(tonumber(id), cmdline)
            if not ok then adapter.log("warn", "host", "command refused: " .. tostring(why)) end
            advance(0)
        elseif verb == "console" then
            local ok, why = host:executeCommand(0, rest)
            if not ok then adapter.log("warn", "host", "command refused: " .. tostring(why)) end
            advance(0)
        elseif verb == "call" then
            local res, export, argText = rest:match("^(%S+)%s+(%S+)%s*(.*)$")
            local args = argText ~= "" and json.decode(argText) or {}
            local out = { host:callExportSync(res, export, "server", 5000, scriptgo.compat.unpack(args)) }
            adapter.log("info", "call", res .. "." .. export .. " -> " .. json.encode(out))
        elseif verb == "start" then
            local ok, why = host:start(rest); if not ok then adapter.log("error", "host", why) end
            advance(0)
        elseif verb == "stop" then
            host:stop(rest); advance(0)
        elseif verb == "expect-log" or verb == "expect-notify" then
            local found = false
            if verb == "expect-log" then
                for _, e in ipairs(logs) do if tostring(e.message):find(rest) then found = true break end end
            else
                for _, n in ipairs(adapter.notifications) do
                    if tostring(n.payload.message):find(rest) or tostring(n.payload.title):find(rest) then found = true break end
                end
            end
            if found then
                adapter.log("info", "check", "ok   " .. verb .. " " .. rest)
            else
                stepFailures = stepFailures + 1
                adapter.log("error", "check", "FAIL " .. verb .. " " .. rest)
            end
        else
            adapter.log("warn", "host", "unknown step: " .. line)
        end
    end

    if flags.script then
        local text = readFile(flags.script) or die("cannot read script " .. flags.script)
        for line in (text .. "\n"):gmatch("([^\n]*)\n") do step(line) end
    elseif flags["for"] then
        advance(tonumber(flags["for"]) or 0)
    else
        io.write("scriptgo standalone: type steps (cmd 1 /help, console <cmd>, wait <ms>, quit)\n")
        for line in io.lines() do
            if line == "quit" or line == "exit" then break end
            step(line)
        end
    end
    host:stopAll()
    advance(0)
    os.exit((failed == 0 and stepFailures == 0) and 0 or 1)
end

-- test -----------------------------------------------------------------------------------------------
-- Runs the resource's test_script files. Each file gets `test/it/describe/expect` and
-- `load(opts?)`, which returns a started harness with the resource and its dependencies.
local function test()
    local root = positional[1] or die("test: give a resource folder")
    root = normalize(root)
    local manifestText, manifestName = readManifest(root)
    if not manifestText then die("no manifest in " .. root) end
    local parsed = scriptgo.manifest.parse(manifestText, manifestName)
    if not parsed.ok then die("invalid manifest: " .. parsed.errors[1].code) end
    local m = parsed.manifest
    local testing = scriptgo.testing
    if #m.testScripts == 0 then
        io.write(m.name .. ": no test_script declared\n")
        os.exit(0)
    end
    local suite = testing.suite()
    local function loadHarness(opts)
        opts = opts or {}
        local h = testing.harness(opts)
        local ok, err = addWithDeps(h.host, root)
        if not ok then error(err, 2) end
        for _, extra in ipairs(opts.with or {}) do
            local r = locate(extra) or extra
            local eok, eerr = addWithDeps(h.host, normalize(r))
            if not eok then error(eerr, 2) end
        end
        if opts.start ~= false then
            local sok, why = h:start(m.name)
            if not sok then error("start failed: " .. tostring(why), 2) end
            for _, extra in ipairs(opts.with or {}) do
                local name = extra:match("([^/\\]+)$")
                h:start(name)
            end
        end
        return h
    end
    for _, rel in ipairs(m.testScripts) do
        local text = readFile(root .. "/" .. rel) or die("cannot read " .. rel)
        local env = setmetatable({
            test = suite.test, it = suite.it, describe = suite.describe, expect = testing.expect,
            load = loadHarness, scriptgo = scriptgo, RESOURCE = m.name, ROOT = root,
        }, { __index = _G })
        local fn, err = scriptgo.compat.loadWithEnv(text, "@" .. m.name .. "/" .. rel, env)
        if not fn then die(err) end
        fn()
    end
    local result = suite.run(function(name, ok, err)
        io.write((ok and "  ok   " or "  FAIL ") .. name .. "\n")
        if not ok then io.write("       " .. tostring(err):gsub("\n", "\n       ") .. "\n") end
    end)
    io.write(("%s: %d passed, %d failed (%s)\n"):format(m.name, result.passed, result.failed, scriptgo.compat.version))
    os.exit(result.failed == 0 and 0 or 1)
end

-- verify ---------------------------------------------------------------------------------------------
-- Machine-checkable compatibility evidence for the standalone environment: manifest, start,
-- declared exports, capability matrix, and the resource's own tests.
local cfgPlayerAddress
local function verify()
    local root = normalize(positional[1] or die("verify: give a resource folder"))
    local started = os.clock()
    local checks = {}
    local function check(name, ok, message)
        checks[#checks + 1] = { name = name, status = ok and "passed" or "failed", message = message or "" }
        return ok
    end
    local text, manifestName = readManifest(root)
    local parsed = text and scriptgo.manifest.parse(text, manifestName)
    local m = parsed and parsed.ok and parsed.manifest
    check("manifest_valid", m ~= nil and m ~= false, m and (m.name .. " " .. m.version) or "manifest missing or invalid")
    local logs = {}
    if m then
        local env = flags.environment or "standalone"
        local declared = #m.environments == 0
        for _, e in ipairs(m.environments) do if e == env then declared = true end end
        check("environment_declared", declared, env)
        -- Simulated players and clock, but with --config the real config and HTTP (curl) of the
        -- standalone adapter, so a resource can be verified against a live (or stub) API.
        local adapter = scriptgo.testing.memoryAdapter({ environment = env })
        -- The verifier's simulated address (config "verifierAddress"), for a player-match probe.
        cfgPlayerAddress = nil
        adapter.adapterVersion = scriptgo.VERSION
        if flags.config then
            local cfgTable = loadConfig()
            cfgPlayerAddress = cfgTable.verifierAddress
            local real = makeAdapter(scriptgo, { config = cfgTable, quiet = true })
            adapter.config, adapter.http = real.config, real.http
            adapter.capabilities.http = real.capabilities.http ~= false
            adapter.capabilities.licensing = real.capabilities.licensing ~= false
            adapter.capabilities.perks = real.capabilities.perks ~= false
            adapter.capabilities.presence = real.capabilities.presence ~= false
            adapter.crypto = real.crypto
        end
        local h = scriptgo.testing.harness({ adapter = adapter, environment = env })
        local ok, err = addWithDeps(h.host, root)
        check("dependencies_resolved", ok ~= nil, err or "")
        if ok then
            local sok, why = h:start(m.name)
            check("starts", sok == true, why or "started")
            if sok then
                local side = h.host:getResource(m.name).sides.server
                for _, e in ipairs(m.serverExports or {}) do
                    check("export:" .. e, side and side.exports[e] ~= nil, "")
                end
                -- --with <dir>: one more resource started next to it (the README example).
                if flags.with then
                    local wroot = normalize(flags.with)
                    local wres, werr = addWithDeps(h.host, wroot)
                    local wname = type(wres) == "table" and wres.name or nil
                    local wok, wwhy = false, werr or "not loaded"
                    if wname then wok, wwhy = h:start(wname) end
                    check("readme_example", wok == true, wok and (wname .. " started") or tostring(wwhy))
                end
                h:join(2, "Verifier", cfgPlayerAddress)
                -- Simulated time: long enough for start-up threads and self-checks (SGCHECK lines).
                h:tick(tonumber(flags.settle) or 2000)
                h:drop(2, "verify_done")
                h.host:stopAll()
                h:tick(0)
                local errors = h:logs("error")
                check("no_runtime_errors", #errors == 0, #errors > 0 and errors[1].message or "")
            end
        end
        for _, e in ipairs(h.adapter.logs) do logs[#logs + 1] = ("[%s] %s %s"):format(e.level, e.origin, e.message) end
    end
    local failedChecks = 0
    for _, c in ipairs(checks) do if c.status ~= "passed" then failedChecks = failedChecks + 1 end end
    local report = {
        package = m and m.name or root, version = m and m.version or "", environment = flags.environment or "standalone",
        status = failedChecks == 0 and "verified" or "failing",
        runtimeVersion = scriptgo.compat.version, adapterVersion = scriptgo.VERSION,
        luaVersion = scriptgo.compat.version, durationMs = math.floor((os.clock() - started) * 1000),
        log = table.concat(logs, "\n"), checks = checks, evidence = {},
    }
    local out = json.encode(report)
    if flags.report then
        local f = assert(io.open(flags.report, "wb"))
        f:write(out)
        f:close()
    end
    for _, c in ipairs(checks) do io.write(("  %-6s %s %s\n"):format(c.status == "passed" and "ok" or "FAIL", c.name, c.message)) end
    io.write(report.package .. ": " .. report.status .. "\n")
    os.exit(failedChecks == 0 and 0 or 1)
end

if command == "run" then run()
elseif command == "test" then test()
elseif command == "verify" then verify()
else
    io.write("usage: lua main.lua run|test|verify <resourceDir> [...]\n")
    os.exit(command and 2 or 0)
end
