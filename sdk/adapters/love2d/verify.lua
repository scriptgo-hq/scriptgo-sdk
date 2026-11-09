-- Headless verification inside a real LÖVE process (loaded by scriptgo_love.verify):
--
--   lovec <game> --scriptgo-verify <resourceDir> [--search <dir>]... [--report <out.json>]
--                [--settle <ms>] [--evidence <kind>=<value>]... [--with <exampleDir>]
--
-- Starts the resource and its dependencies through the love2d adapter, ticks them from real
-- love.update frames for --settle ms (default 2000), stops them, and writes a compatibility report
-- (CompatibilityRun: runId, ranAt, checks, evidence[{kind, path}]). Checks: manifest_valid,
-- environment_declared, dependencies_resolved, starts, export:<name>, no_runtime_errors, then one
-- self:<name> per `SGCHECK PASS|FAIL <name>` line (self:done fails when `SGCHECK DONE` never comes),
-- then `tests` (the resource's test_script files, run on LÖVE's LuaJIT). Exit code 0 when verified,
-- 1 when failing, 2 on a usage or internal error. Local paths are scrubbed from the report.
return function(sgl, argv)
    local lfs = love.filesystem
    local started = love.timer.getTime()
    local ranAt = os.date("!%Y-%m-%dT%H:%M:%SZ")

    local flags, search, extraEvidence = {}, {}, {}
    do
        local i = 1
        while i <= #argv do
            local a, v = argv[i], argv[i + 1]
            if a == "--scriptgo-verify" then flags.resource = v; i = i + 2
            elseif a == "--search" then search[#search + 1] = v; i = i + 2
            elseif a == "--evidence" then extraEvidence[#extraEvidence + 1] = v; i = i + 2
            elseif a == "--report" or a == "--settle" or a == "--with" then flags[a:sub(3)] = v; i = i + 2
            else i = i + 1 end
        end
    end

    local function say(s)
        io.write(s, "\n")
        io.flush()
    end

    local function fatal(msg)
        say("scriptgo verify: " .. tostring(msg))
        love.update = function() end
        love.event.quit(2)
    end

    if type(flags.resource) ~= "string" then return fatal("usage: --scriptgo-verify <resourceDir> [--search dir]... [--report out.json]") end

    -- Local paths never reach the report.
    local scrubs = {}
    local function addScrub(path, replacement)
        if type(path) ~= "string" or #path < 4 then return end
        path = path:gsub("\\", "/"):gsub("/+$", "")
        scrubs[#scrubs + 1] = { path, replacement }
        scrubs[#scrubs + 1] = { (path:gsub("/", "\\")), replacement }
    end
    addScrub(lfs.getSaveDirectory(), "<save>")
    addScrub(lfs.getWorkingDirectory(), ".")
    addScrub(os.getenv("USERPROFILE") or os.getenv("HOME"), "~")
    local function scrub(s)
        s = tostring(s)
        for _, r in ipairs(scrubs) do
            local from, to = r[1], r[2]
            local out, pos = {}, 1
            while true do
                local a, b = s:find(from, pos, true)
                if not a then break end
                out[#out + 1] = s:sub(pos, a - 1)
                out[#out + 1] = to
                pos = b + 1
            end
            out[#out + 1] = s:sub(pos)
            s = table.concat(out)
        end
        return s
    end

    -- Fresh storage for every run, in its own folder of the save directory.
    local STORAGE = "scriptgo-verify/storage"
    local function wipe(dir)
        if not lfs.getInfo(dir) then return end
        for _, name in ipairs(lfs.getDirectoryItems(dir)) do
            local p = dir .. "/" .. name
            if lfs.getInfo(p, "directory") then wipe(p) else lfs.remove(p) end
        end
        lfs.remove(dir)
    end
    wipe("scriptgo-verify")

    local root = sgl.absolute(flags.resource)
    for k, s in ipairs(search) do search[k] = sgl.absolute(s) end

    local logs, errorMessages = {}, {}
    local okNew, sg = pcall(sgl.new, {
        resources = {}, search = search, autoStart = false, storageDir = STORAGE, quiet = true,
        logSink = function(level, origin, msg)
            local line = ("[%s] %s %s"):format(level, origin, tostring(msg))
            logs[#logs + 1] = line
            if level == "error" then errorMessages[#errorMessages + 1] = tostring(msg) end
            if level == "error" or tostring(msg):find("SGCHECK", 1, true) then say(scrub(line)) end
        end,
    })
    if not okNew then return fatal(sg) end
    local scriptgo = sg.scriptgo

    local checks = {}
    local function check(name, ok, message)
        checks[#checks + 1] = { name = name, status = ok and "passed" or "failed", message = scrub(message or "") }
        return ok
    end

    local m, phase = nil, "done"
    do
        local fileName = "scriptgo.lua"
        local text = sgl.readFile(root .. "/scriptgo.lua")
        if not text then fileName, text = "open77.lua", sgl.readFile(root .. "/open77.lua") end
        local parsed = text and scriptgo.manifest.parse(text, fileName)
        m = parsed and parsed.ok and parsed.manifest or nil
        check("manifest_valid", m ~= nil, m and (m.name .. " " .. m.version) or "manifest missing or invalid")
    end
    if m then
        local declared = #m.environments == 0
        for _, e in ipairs(m.environments) do if e == "love2d" then declared = true end end
        check("environment_declared", declared, "love2d")
        local res, err = sg:add(root)
        check("dependencies_resolved", res ~= nil, err or "")
        if res then
            local ok, why = sg.host:start(m.name)
            check("starts", ok == true, why or "started")
            if ok then
                local side = sg.host:getResource(m.name).sides.server
                for _, e in ipairs(m.serverExports or {}) do
                    check("export:" .. e, side ~= nil and side.exports[e] ~= nil, "")
                end
                -- --with <dir>: one more resource started next to it (the README example).
                if flags.with then
                    local wres, werr = sg:add(sgl.absolute(flags.with))
                    local wname = type(wres) == "table" and wres.name or nil
                    local wok, wwhy = false, werr or "not loaded"
                    if wname then wok, wwhy = sg.host:start(wname) end
                    check("readme_example", wok == true, wok and (wname .. " started") or tostring(wwhy))
                end
                sg:join()
                phase = "running"
            end
        end
    end

    -- `SGCHECK PASS|FAIL <name> [detail]` lines, read exactly as the CLI's selfChecks does.
    local function selfChecks(text)
        local out, done = {}, false
        for line in (text .. "\n"):gmatch("([^\n]*)\n") do
            line = line:gsub("\r$", "")
            local verdict, rest = line:match("SGCHECK (%u+) (.*)$")
            if verdict == "PASS" or verdict == "FAIL" then
                local name = rest:match("^(%S+)")
                if name then
                    local after = rest:sub(#name + 1)
                    local message = after:sub(1, 1) == " " and after:sub(2) or ""
                    out[#out + 1] = { name = "self:" .. name, status = verdict == "PASS" and "passed" or "failed",
                        message = message:gsub("^%s+", ""):gsub("%s+$", "") }
                end
            end
            if line:find("SGCHECK DONE", 1, true) then done = true end
        end
        if #out > 0 and not done then
            out[#out + 1] = { name = "self:done", status = "failed", message = "SGCHECK DONE never printed: the self-checks did not finish" }
        end
        return out
    end

    -- The resource's test_script files, as `scriptgo test` runs them (in-memory harness).
    local function locate(name)
        for _, dir in ipairs(search) do
            local r = dir .. "/" .. name
            if sgl.readFile(r .. "/scriptgo.lua") or sgl.readFile(r .. "/open77.lua") then return r end
        end
        return nil
    end
    local function addWithDeps(host, dir)
        local res, err = host:addResource(dir)
        if not res then
            if err and err:find("already loaded") then return true end
            return nil, err
        end
        for _, dep in ipairs(res.manifest.dependencies) do
            if not host:getResource(dep.name) then
                local depRoot = locate(dep.name)
                if depRoot then
                    local ok, derr = addWithDeps(host, depRoot)
                    if not ok then return nil, derr end
                end
            end
        end
        return res
    end
    local function runTests()
        local testing = scriptgo.testing
        local suite = testing.suite()
        local function loadHarness(o)
            o = o or {}
            local h = testing.harness(o)
            local ok, err = addWithDeps(h.host, root)
            if not ok then error(err, 2) end
            for _, extra in ipairs(o.with or {}) do
                -- A name in the search paths, else the folder as given (tests use in-memory files).
                local eok, eerr = addWithDeps(h.host, locate(extra) or extra)
                if not eok then error(eerr, 2) end
            end
            if o.start ~= false then
                local sok, why = h:start(m.name)
                if not sok then error("start failed: " .. tostring(why), 2) end
                for _, extra in ipairs(o.with or {}) do h:start(extra:match("([^/\\]+)$")) end
            end
            return h
        end
        for _, rel in ipairs(m.testScripts) do
            local text = sgl.readFile(root .. "/" .. rel)
            if not text then return false, "cannot read " .. rel end
            local env = setmetatable({
                test = suite.test, it = suite.it, describe = suite.describe, expect = testing.expect,
                load = loadHarness, scriptgo = scriptgo, RESOURCE = m.name, ROOT = root,
            }, { __index = _G })
            local fn, err = scriptgo.compat.loadWithEnv(text, "@" .. m.name .. "/" .. rel, env)
            if not fn then return false, err end
            fn()
        end
        local lines = {}
        local result = suite.run(function(name, ok, err)
            lines[#lines + 1] = (ok and "  ok   " or "  FAIL ") .. name
            if not ok then lines[#lines + 1] = "       " .. tostring(err):gsub("\n", "\n       ") end
        end)
        local summary = ("%s: %d passed, %d failed (%s)"):format(m.name, result.passed, result.failed, scriptgo.compat.version)
        lines[#lines + 1] = summary
        return result.failed == 0, summary, table.concat(lines, "\n")
    end

    -- Pretty JSON with sorted keys, so reports diff well.
    local json = scriptgo.json
    local function pretty(v, indent)
        indent = indent or ""
        if type(v) ~= "table" then return json.encode(v) end
        local inner = indent .. "  "
        local parts = {}
        if #v > 0 or next(v) == nil then
            if next(v) == nil then return "[]" end
            for _, item in ipairs(v) do parts[#parts + 1] = inner .. pretty(item, inner) end
            return "[\n" .. table.concat(parts, ",\n") .. "\n" .. indent .. "]"
        end
        local keys = {}
        for k in pairs(v) do keys[#keys + 1] = k end
        table.sort(keys)
        for _, k in ipairs(keys) do parts[#parts + 1] = inner .. json.encode(k) .. ": " .. pretty(v[k], inner) end
        return "{\n" .. table.concat(parts, ",\n") .. "\n" .. indent .. "}"
    end

    local frames, runStart, finished = 0, nil, false
    local settle = (tonumber(flags.settle) or 2000) / 1000

    local function finish()
        finished = true
        local runMs = runStart and math.floor((love.timer.getTime() - runStart) * 1000) or 0
        if phase == "running" then
            sg:shutdown()
            check("no_runtime_errors", #errorMessages == 0, errorMessages[1] or "")
        end
        for _, c in ipairs(selfChecks(table.concat(logs, "\n"))) do checks[#checks + 1] = { name = c.name, status = c.status, message = scrub(c.message) } end
        local testsRan = false
        if m and phase == "running" then
            if #m.testScripts > 0 then
                local okRun, passed, summary, detail = pcall(runTests)
                if not okRun then passed, summary, detail = false, "tests raised: " .. tostring(passed), nil end
                testsRan = true
                check("tests", passed == true, summary)
                if detail then logs[#logs + 1] = detail end
            else
                checks[#checks + 1] = { name = "tests", status = "skipped", message = "no test_script" }
            end
        end

        local failed = 0
        for _, c in ipairs(checks) do if c.status == "failed" then failed = failed + 1 end end
        local major, minor, revision, codename = love.getVersion()
        local caps = {}
        for _, c in ipairs(scriptgo.capabilities.ALL) do if sg.host.capabilities[c] then caps[#caps + 1] = c end end
        local stored = {}
        for _, name in ipairs(lfs.getDirectoryItems(STORAGE)) do stored[#stored + 1] = name end
        table.sort(stored)
        local evidence = {
            { kind = "love-version", path = ("%d.%d.%d (%s)"):format(major, minor, revision, codename) },
            { kind = "interpreter", path = scriptgo.compat.version },
            { kind = "os", path = love.system and love.system.getOS() or "unknown" },
            { kind = "headless", path = love.graphics and "love.graphics loaded" or "no window, love.graphics disabled" },
            { kind = "frames", path = ("%d love.update frames over %d ms"):format(frames, runMs) },
            { kind = "resources", path = table.concat(sg.host.order, ", ") },
            { kind = "capabilities", path = table.concat(caps, ", ") },
            { kind = "http", path = sg.adapter.httpMode or ("unavailable: " .. tostring(sg.adapter.httpUnavailable)) },
            { kind = "storage", path = "<save>/" .. STORAGE .. ": " .. (#stored > 0 and table.concat(stored, ", ") or "nothing written") },
        }
        if testsRan then
            evidence[#evidence + 1] = { kind = "tests", path = "test_script files on the in-memory harness, inside LÖVE's LuaJIT" }
        end
        for _, e in ipairs(extraEvidence) do
            local kind, value = tostring(e):match("^([^=]+)=(.*)$")
            if kind then evidence[#evidence + 1] = { kind = kind, path = value } end
        end
        for _, e in ipairs(evidence) do e.path = scrub(e.path) end

        local name = m and m.name or scrub(root)
        local version = m and m.version or "unknown"
        local report = {
            runId = ("%s@%s:love2d:%s"):format(name, version, ranAt),
            package = name, version = version, environment = "love2d",
            status = failed == 0 and "verified" or "failing",
            runtimeVersion = ("LÖVE %d.%d"):format(major, minor),
            adapterVersion = sg.adapter.adapterVersion,
            luaVersion = scriptgo.compat.version,
            ranAt = ranAt,
            durationMs = math.floor((love.timer.getTime() - started) * 1000),
            log = scrub(table.concat(logs, "\n")),
            checks = checks,
            evidence = evidence,
        }
        if flags.report then
            local path = sgl.absolute(flags.report)
            local f, err = io.open(path, "wb")
            if not f then
                say("scriptgo verify: cannot write report: " .. scrub(err))
                failed = failed + 1
            else
                f:write(pretty(report), "\n")
                f:close()
            end
        end
        for _, c in ipairs(checks) do
            say(("  %-6s %s %s"):format(c.status == "passed" and "ok" or (c.status == "skipped" and "skip" or "FAIL"), c.name, c.message))
        end
        say(report.package .. ": " .. report.status .. " (love2d, " .. frames .. " frames)")
        love.event.quit(failed == 0 and 0 or 1)
    end

    love.update = function(dt)
        if finished then return end
        local ok, err = xpcall(function()
            if phase == "running" then
                runStart = runStart or love.timer.getTime()
                frames = frames + 1
                sg:update(dt)
                if love.timer.getTime() - runStart < settle then return end
            end
            finish()
        end, debug.traceback)
        if not ok then
            finished = true
            say("scriptgo verify: internal error: " .. scrub(err))
            love.event.quit(2)
        end
    end
    love.draw = nil
    love.quit = nil
end
