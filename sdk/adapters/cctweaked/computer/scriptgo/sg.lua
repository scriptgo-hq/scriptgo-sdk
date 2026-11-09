-- SCRIPT//GO on a CC: Tweaked computer: runs SCRIPT//GO resources (and portable OPEN//77 ones).
--
--   scriptgo/sg            start the resources, then a console on the terminal
--   scriptgo/sg verify     verify mode for `scriptgo verify --env cctweaked` (reads /scriptgo/verify.json)
--
-- Layout on the computer's disk (`node sdk/adapters/cctweaked/build.mjs` builds it):
--   /scriptgo/core/          the SCRIPT//GO core
--   /scriptgo/adapter.lua    the cctweaked adapter
--   /scriptgo/resources/<name>/   resources (scriptgo.lua or open77.lua manifest)
--   /scriptgo/config.json    optional: { "resources": {...}, "convars": {...},
--                            "permissions": { "1": ["*"] }, "start": ["name"], "http": false }
--   /scriptgo/data/          storage, one JSON file per resource side
--
-- Console: a resource command runs as player 1 (whoever is at the terminal); `status`, `start`,
-- `stop`, `restart <name>`, `log`, `help` and `exit` drive the host. Ctrl+T also stops it.
local args = { ... }
local ROOT = "/scriptgo"
local TICK = 0.05 -- one server tick

local function readFile(path)
    local h = fs.open(path, "rb")
    if not h then return nil end
    local text = h.readAll() or ""
    h.close()
    return text
end

local coreDir = ROOT .. "/core/"
local coreText = readFile(coreDir .. "init.lua")
if not coreText then
    printError("SCRIPT//GO: the core is missing from " .. coreDir .. " (build the computer folder with sdk/adapters/cctweaked/build.mjs)")
    return
end
local scriptgo = assert(load(coreText, "@scriptgo/init.lua"))(coreDir, readFile)
local json = scriptgo.json
local makeAdapter = assert(load(assert(readFile(ROOT .. "/adapter.lua")), "@scriptgo/adapter.lua"))()

local verifyMode = args[1] == "verify"

local cfg = {}
do
    local text = readFile(ROOT .. "/config.json")
    if text then
        local ok, value = pcall(json.decode, text)
        if ok and type(value) == "table" then cfg = value else printError("SCRIPT//GO: config.json is not valid JSON; using defaults") end
    end
end

-- Terminal: the output scrolls above a one-line prompt (interactive mode only).
local parent = term.current()
local width, height = term.getSize()
local outWin, promptWin
if not verifyMode then
    term.clear()
    outWin = window.create(parent, 1, 1, width, height - 1)
    promptWin = window.create(parent, 1, height, width, 1)
end
local function out(line, colour)
    if not outWin then return end
    local previous = term.redirect(outWin)
    if colour and term.isColour() then term.setTextColour(colour) end
    print(line)
    term.setTextColour(colours.white)
    term.redirect(previous)
    if promptWin then promptWin.restoreCursor() end
end

local logs = {}
local adapter = makeAdapter(scriptgo, {
    config = cfg, out = out, quiet = verifyMode,
    logSink = function(level, origin, msg)
        logs[#logs + 1] = { level = level, origin = origin, message = tostring(msg) }
        if #logs > 3000 then table.remove(logs, 1) end
    end,
})
local player = { id = 1, name = "Terminal" }
local host = scriptgo.newHost({ adapter = adapter, localPlayer = player })

-- Discovery ------------------------------------------------------------------------------------------
local resourceDir = ROOT .. "/resources"

local function locate(name)
    local root = resourceDir .. "/" .. name
    if fs.exists(root .. "/scriptgo.lua") or fs.exists(root .. "/open77.lua") then return root end
    return nil
end

local function addWithDeps(root)
    local res, err = host:addResource(root)
    if not res then
        if err and err:find("already loaded") then return true end
        return nil, err
    end
    for _, dep in ipairs(res.manifest.dependencies) do
        if not host:getResource(dep.name) then
            local depRoot = locate(dep.name)
            if depRoot then
                local ok, derr = addWithDeps(depRoot)
                if not ok then return nil, derr end
            end
        end
    end
    return res
end

local names = {}
if fs.isDir(resourceDir) then
    for _, name in ipairs(fs.list(resourceDir)) do
        if locate(name) then names[#names + 1] = name end
    end
end
table.sort(names)
for _, name in ipairs(names) do
    local ok, err = addWithDeps(locate(name))
    if not ok then host:log("error", name .. ": " .. tostring(err)) end
end

-- The loop: ticks the host every server tick and hands CC events (HTTP answers) to the adapter.
local ticks = 0
local running = true
local function hostLoop(untilClock)
    local timer = os.startTimer(TICK)
    while running do
        local ev = table.pack(os.pullEventRaw())
        if ev[1] == "timer" and ev[2] == timer then
            ticks = ticks + 1
            host:tick(adapter.now())
            if untilClock and adapter.now() >= untilClock then return end
            timer = os.startTimer(TICK)
        elseif ev[1] == "terminate" then
            running = false
        else
            adapter.onEvent(ev[1], ev[2], ev[3], ev[4])
        end
    end
end

local function shutdownHost()
    host:playerDrop(player.id, "quit")
    host:stopAll()
    host:tick(adapter.now())
    adapter.shutdown()
end

-- Verify mode ----------------------------------------------------------------------------------------
-- /scriptgo/verify.json: { "resource": name, "seconds": 3, "report": "/scriptgo-report.json",
-- "with": exampleName, "shutdown": true }. Writes a CompatibilityRun (the same shape as every other
-- host) and turns the computer off. Checks: manifest_valid, environment_declared,
-- dependencies_resolved, starts, export:<name>, readme_example (with "with"), no_runtime_errors,
-- self:<name> for each `SGCHECK PASS|FAIL <name>` line (self:done when SGCHECK DONE never came),
-- then tests (the resource's test_script files on the in-memory harness, on this computer's Lua).
local function verify()
    local startedEpoch = os.epoch("utc")
    local v = json.decode(assert(readFile(ROOT .. "/verify.json"), "verify.json is missing"))
    local checks = {}
    local function check(name, ok, message)
        checks[#checks + 1] = { name = name, status = ok and "passed" or "failed", message = tostring(message or "") }
        return ok
    end

    local res = host:getResource(v.resource)
    local m = res and res.manifest
    check("manifest_valid", m ~= nil, m and (m.name .. " " .. m.version) or "resource not found or manifest invalid")
    local started = false
    if m then
        local declared = #m.environments == 0
        for _, e in ipairs(m.environments) do if e == "cctweaked" then declared = true end end
        check("environment_declared", declared, table.concat(m.environments, ", "))
        local missing = {}
        for _, dep in ipairs(m.dependencies) do
            if not host:getResource(dep.name) then missing[#missing + 1] = dep.name end
        end
        check("dependencies_resolved", #missing == 0, table.concat(missing, ", "))
        local ok, why = host:start(v.resource)
        check("starts", ok == true, ok and "started" or why)
        if ok then
            local side = host:getResource(v.resource).sides.server
            for _, e in ipairs(m.serverExports or {}) do
                check("export:" .. e, side ~= nil and side.exports[e] ~= nil, "")
            end
            if v.with then
                local wok, wwhy = false, "not found"
                if host:getResource(v.with) then wok, wwhy = host:start(v.with) end
                check("readme_example", wok == true, wok and (v.with .. " started") or wwhy)
            end
            host:playerJoin(player.id, player.name)
            started = true
        end
    end

    local seconds = tonumber(v.seconds) or 3
    local runClock = os.clock()
    if started then hostLoop(os.clock() + seconds) end
    local runSeconds = os.clock() - runClock
    if started then shutdownHost() end

    local errors = {}
    for _, e in ipairs(logs) do if e.level == "error" then errors[#errors + 1] = e end end
    if started then
        check("no_runtime_errors", #errors == 0, errors[1] and (errors[1].origin .. " " .. errors[1].message) or "")
    end
    local lines, selfCount, done = {}, 0, false
    for _, e in ipairs(logs) do
        lines[#lines + 1] = ("[%s] %s %s"):format(e.level, e.origin, e.message)
        local verdict, cname, detail = e.message:match("SGCHECK (%u+) (%S+)%s*(.*)$")
        if verdict == "PASS" or verdict == "FAIL" then
            selfCount = selfCount + 1
            checks[#checks + 1] = { name = "self:" .. cname, status = verdict == "PASS" and "passed" or "failed", message = detail or "" }
        end
        if e.message:find("SGCHECK DONE", 1, true) then done = true end
    end
    if selfCount > 0 and not done then check("self:done", false, "SGCHECK DONE never printed: the self-checks did not finish") end

    -- The resource's test_script files, as `scriptgo test` runs them (in-memory harness).
    local testsRan = false
    if m and started then
        if #m.testScripts > 0 then
            local testing = scriptgo.testing
            local suite = testing.suite()
            local function addAll(h, dir)
                local r, err = h.host:addResource(dir)
                if not r then
                    if err and err:find("already loaded") then return true end
                    return nil, err
                end
                for _, dep in ipairs(r.manifest.dependencies) do
                    if not h.host:getResource(dep.name) and locate(dep.name) then
                        local ok, derr = addAll(h, locate(dep.name))
                        if not ok then return nil, derr end
                    end
                end
                return r
            end
            local function loadHarness(o)
                o = o or {}
                -- os.time() is the in-game hour here: the harness gets the adapter's wall clock.
                if o.wallTime == nil and not o.adapter then o.wallTime = adapter.wallTime end
                local h = testing.harness(o)
                local ok, err = addAll(h, res.root)
                if not ok then error(err, 2) end
                for _, extra in ipairs(o.with or {}) do
                    local eok, eerr = addAll(h, locate(extra) or extra)
                    if not eok then error(eerr, 2) end
                end
                if o.start ~= false then
                    local sok, why = h:start(m.name)
                    if not sok then error("start failed: " .. tostring(why), 2) end
                    for _, extra in ipairs(o.with or {}) do h:start(extra:match("([^/\\]+)$")) end
                end
                return h
            end
            local loaded, loadErr = true, nil
            for _, rel in ipairs(m.testScripts) do
                local text = readFile(res.root .. "/" .. rel)
                if not text then loaded, loadErr = false, "cannot read " .. rel break end
                local env = setmetatable({
                    test = suite.test, it = suite.it, describe = suite.describe, expect = testing.expect,
                    load = loadHarness, scriptgo = scriptgo, RESOURCE = m.name, ROOT = res.root,
                }, { __index = _G })
                local fn, err = scriptgo.compat.loadWithEnv(text, "@" .. m.name .. "/" .. rel, env)
                if not fn then loaded, loadErr = false, err break end
                local ok, rerr = pcall(fn)
                if not ok then loaded, loadErr = false, rerr break end
            end
            testsRan = true
            if not loaded then
                check("tests", false, loadErr)
            else
                local result = suite.run(function(name, ok, err)
                    lines[#lines + 1] = (ok and "  ok   " or "  FAIL ") .. name
                    if not ok then lines[#lines + 1] = "       " .. tostring(err) end
                end)
                check("tests", result.failed == 0, ("%s: %d passed, %d failed (%s)"):format(m.name, result.passed, result.failed, scriptgo.compat.version))
            end
        else
            checks[#checks + 1] = { name = "tests", status = "skipped", message = "no test_script" }
        end
    end

    local failed = 0
    for _, c in ipairs(checks) do if c.status == "failed" then failed = failed + 1 end end
    local caps = {}
    for _, c in ipairs(scriptgo.capabilities.ALL) do if host.capabilities[c] then caps[#caps + 1] = c end end
    local stored = fs.isDir(adapter.dataDir) and fs.list(adapter.dataDir) or {}
    table.sort(stored)
    -- _HOST is "ComputerCraft <version> (Minecraft <version>)" inside Minecraft.
    local hostString = tostring(_HOST)
    local ccVersion = hostString:match("^ComputerCraft (%S+)") or "?"
    local mcVersion = hostString:match("%(Minecraft ([^)]+)%)")
    local evidence = {
        { kind = "host", path = hostString },
        { kind = "interpreter", path = scriptgo.compat.version },
        { kind = "computer", path = ("#%d, %s terminal %dx%d"):format(os.getComputerID(), term.isColour() and "colour" or "monochrome", width, height) },
        { kind = "ticks", path = ("%d host ticks from os.startTimer over %.2f s of computer time"):format(ticks, runSeconds) },
        { kind = "resources", path = table.concat(host.order, ", ") },
        { kind = "capabilities", path = table.concat(caps, ", ") },
        { kind = "http", path = adapter.httpMode or ("unavailable: " .. tostring(adapter.httpUnavailable)) },
        { kind = "storage", path = adapter.dataDir .. ": " .. (#stored > 0 and table.concat(stored, ", ") or "nothing written") },
        { kind = "disk_free", path = tostring(fs.getFreeSpace("/")) .. " bytes" },
    }
    if testsRan then evidence[#evidence + 1] = { kind = "tests", path = "test_script files on the in-memory harness, on this computer's Lua" } end

    local ranAt = os.date("!%Y-%m-%dT%H:%M:%SZ")
    local report = {
        runId = ("%s@%s:cctweaked:%s"):format(m and m.name or tostring(v.resource), m and m.version or "unknown", ranAt),
        package = m and m.name or tostring(v.resource), version = m and m.version or "unknown", environment = "cctweaked",
        status = failed == 0 and "verified" or "failing",
        runtimeVersion = "CC: Tweaked " .. ccVersion .. (mcVersion and (", Minecraft " .. mcVersion) or ", no Minecraft"),
        adapterVersion = adapter.adapterVersion, luaVersion = scriptgo.compat.version,
        ranAt = ranAt, durationMs = math.floor(os.epoch("utc") - startedEpoch),
        log = table.concat(lines, "\n"), checks = checks, evidence = evidence,
    }
    local target = v.report or "/scriptgo-report.json"
    local tmp = target .. ".tmp"
    local h = assert(fs.open(tmp, "wb"))
    h.write(json.encode(report))
    h.close()
    if fs.exists(target) then fs.delete(target) end
    fs.move(tmp, target)
    print(("SCRIPT//GO verify %s: %s (%d checks, %d failed)"):format(report.package, report.status, #checks, failed))
    if v.shutdown ~= false then os.shutdown() end
end

if verifyMode then
    verify()
    return
end

-- Interactive mode -----------------------------------------------------------------------------------
if type(cfg.start) == "table" then
    for _, name in ipairs(cfg.start) do
        local ok, why = host:start(name)
        if not ok then host:log("error", name .. " did not start: " .. tostring(why)) end
    end
else
    for name, result in pairs(host:startAll()) do
        if result ~= "started" then host:log("error", name .. " did not start: " .. tostring(result)) end
    end
end
host:playerJoin(player.id, player.name)
out(("SCRIPT//GO %s on %s: %d resource(s). Type help."):format(scriptgo.VERSION, tostring(_HOST), #host.order), colours.lightBlue)

local HELP = "status | start <name> | stop <name> | restart <name> | log | exit | <resource command>"
local history = {}
local function console()
    while running do
        term.redirect(promptWin)
        promptWin.clear()
        promptWin.setCursorPos(1, 1)
        write("sg> ")
        local ok, line = pcall(read, nil, history)
        term.redirect(parent)
        if not ok then
            running = false
            return
        end
        line = (line or ""):gsub("^%s+", ""):gsub("%s+$", ""):gsub("^/", "")
        if line ~= "" then
            history[#history + 1] = line
            local verb, rest = line:match("^(%S+)%s*(.-)$")
            if verb == "exit" or verb == "quit" then
                running = false
                return
            elseif verb == "help" then
                out(HELP)
            elseif verb == "status" then
                for _, name in ipairs(host.order) do
                    out(("%-20s %-8s %s"):format(name, host:getResource(name).manifest.version, tostring(host:resourceState(name))))
                end
            elseif verb == "log" then
                for i = math.max(1, #adapter.lines - (height - 3)), #adapter.lines do out(adapter.lines[i]) end
            elseif (verb == "start" or verb == "stop" or verb == "restart") and rest ~= "" and host:getResource(rest) then
                if verb ~= "start" then host:stop(rest, "console") end
                if verb ~= "stop" then
                    local sok, why = host:start(rest)
                    if not sok then out(rest .. " did not start: " .. tostring(why), colours.red) end
                end
                out(rest .. ": " .. tostring(host:resourceState(rest)))
            else
                local cok, why = host:executeCommand(player.id, line)
                if not cok then
                    out(why == "not_allowed" and ("You are not allowed to use " .. verb .. ".") or (verb .. ": " .. tostring(why)), colours.red)
                end
            end
        end
    end
end

parallel.waitForAny(function() hostLoop(nil) end, console)
shutdownHost()
term.redirect(parent)
term.clear()
term.setCursorPos(1, 1)
print("SCRIPT//GO stopped.")
