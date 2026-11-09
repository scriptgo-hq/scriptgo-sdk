-- Headless verification inside a real Neovim process:
--
--   nvim --headless --clean -l sdk/adapters/neovim/verify.lua --scriptgo-verify <resourceDir>
--        [--search <dir>]... [--report <out.json>] [--settle <ms>] [--evidence <kind>=<value>]...
--        [--with <exampleDir>] [--config <config.json>]   (same shape as the standalone config)
--
-- Starts the resource and its dependencies through the neovim adapter, lets the plugin's libuv
-- timer tick them on Neovim's main loop for --settle ms (default 2000, inside vim.wait), stops
-- them, and writes a compatibility report (CompatibilityRun). Checks: manifest_valid,
-- environment_declared, dependencies_resolved, starts, export:<name>, readme_example (with --with),
-- no_runtime_errors, one self:<name> per `SGCHECK PASS|FAIL <name>` line (self:done fails when
-- `SGCHECK DONE` never comes), then `tests` (the test_script files, on Neovim's LuaJIT).
-- Returns the exit code: 0 verified, 1 failing, 2 usage or internal error. Local paths are scrubbed.
return function(argv)
    local uv = vim.uv or vim.loop
    local started = uv.hrtime()
    local ranAt = os.date("!%Y-%m-%dT%H:%M:%SZ")
    local sgn = require("scriptgo_nvim")

    local flags, search, extraEvidence = {}, {}, {}
    do
        local i = 1
        while i <= #argv do
            local a, v = argv[i], argv[i + 1]
            if a == "--scriptgo-verify" then flags.resource = v; i = i + 2
            elseif a == "--search" then search[#search + 1] = v; i = i + 2
            elseif a == "--evidence" then extraEvidence[#extraEvidence + 1] = v; i = i + 2
            elseif a == "--report" or a == "--settle" or a == "--with" or a == "--config" then flags[a:sub(3)] = v; i = i + 2
            else i = i + 1 end
        end
    end

    local function say(s)
        io.stdout:write(s, "\n")
        io.stdout:flush()
    end
    if type(flags.resource) ~= "string" then
        say("scriptgo verify: usage: --scriptgo-verify <resourceDir> [--search dir]... [--report out.json]")
        return 2
    end
    local function absolute(p) return vim.fs.normalize(vim.fn.fnamemodify(p, ":p")):gsub("/+$", "") end

    -- Local paths never reach the report.
    local scrubs = {}
    local function addScrub(path, replacement)
        if type(path) ~= "string" or #path < 4 then return end
        path = path:gsub("\\", "/"):gsub("/+$", "")
        scrubs[#scrubs + 1] = { path, replacement }
        scrubs[#scrubs + 1] = { (path:gsub("/", "\\")), replacement }
    end
    local storageDir = vim.fs.normalize(vim.fn.tempname()) .. "-scriptgo-storage"
    addScrub(storageDir, "<storage>")
    addScrub(vim.fs.normalize(vim.fn.stdpath("data")), "<data>")
    addScrub(vim.fs.normalize(vim.fn.getcwd()), ".")
    addScrub(os.getenv("TEMP"), "<tmp>")
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

    local root = absolute(flags.resource)
    for k, s in ipairs(search) do search[k] = absolute(s) end

    local config
    if flags.config then
        local f = io.open(absolute(flags.config), "rb")
        if not f then
            say("scriptgo verify: cannot read config " .. flags.config)
            return 2
        end
        config = f:read("*a")
        f:close()
    end

    local logs, errorMessages = {}, {}
    local okNew, sg = pcall(sgn.new, {
        search = search, autoStart = false, storageDir = storageDir, quiet = true, config = config,
        player = { id = 1, name = "Verifier" },
        logSink = function(level, origin, msg)
            local line = ("[%s] %s %s"):format(level, origin, tostring(msg))
            logs[#logs + 1] = line
            if level == "error" then errorMessages[#errorMessages + 1] = tostring(msg) end
            if level == "error" or tostring(msg):find("SGCHECK", 1, true) then say(scrub(line)) end
        end,
    })
    if not okNew then
        say("scriptgo verify: " .. scrub(sg))
        return 2
    end
    local scriptgo = sg.scriptgo

    local checks = {}
    local function check(name, ok, message)
        checks[#checks + 1] = { name = name, status = ok and "passed" or "failed", message = scrub(message or "") }
        return ok
    end
    local function readFile(p)
        local f = io.open(p, "rb")
        if not f then return nil end
        local t = f:read("*a")
        f:close()
        return t
    end

    local m, running = nil, false
    do
        local fileName = "scriptgo.lua"
        local text = readFile(root .. "/scriptgo.lua")
        if not text then fileName, text = "open77.lua", readFile(root .. "/open77.lua") end
        local parsed = text and scriptgo.manifest.parse(text, fileName)
        m = parsed and parsed.ok and parsed.manifest or nil
        check("manifest_valid", m ~= nil, m and (m.name .. " " .. m.version) or "manifest missing or invalid")
    end
    if m then
        local declared = #m.environments == 0
        for _, e in ipairs(m.environments) do if e == "neovim" then declared = true end end
        check("environment_declared", declared, "neovim")
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
                if flags.with then
                    local wres, werr = sg:add(absolute(flags.with))
                    local wname = type(wres) == "table" and wres.name or nil
                    local wok, wwhy = false, werr or "not loaded"
                    if wname then wok, wwhy = sg.host:start(wname) end
                    check("readme_example", wok == true, wok and (wname .. " started") or tostring(wwhy))
                end
                sg:join()
                running = true
            end
        end
    end

    -- Real ticking: the plugin's own timer, on Neovim's main loop, while vim.wait runs the loop.
    local settleMs = tonumber(flags.settle) or 2000
    local runStart = uv.hrtime()
    if running then
        sg:run(10)
        vim.wait(settleMs, function() return false end, 10)
    end
    local runMs = math.floor((uv.hrtime() - runStart) / 1e6)
    local ticks = sg.ticks

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
    local function addWithDeps(host, dir)
        local res, err = host:addResource(dir)
        if not res then
            if err and err:find("already loaded") then return true end
            return nil, err
        end
        for _, dep in ipairs(res.manifest.dependencies) do
            if not host:getResource(dep.name) then
                local depRoot = sg:locate(dep.name)
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
                local eok, eerr = addWithDeps(h.host, sg:locate(extra) or extra)
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
            local text = readFile(root .. "/" .. rel)
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

    if running then
        sg:shutdown()
        check("no_runtime_errors", #errorMessages == 0, errorMessages[1] or "")
    end
    for _, c in ipairs(selfChecks(table.concat(logs, "\n"))) do checks[#checks + 1] = { name = c.name, status = c.status, message = scrub(c.message) } end
    local testsRan = false
    if m and running then
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
    local v = vim.version()
    local caps = {}
    for _, c in ipairs(scriptgo.capabilities.ALL) do if sg.host.capabilities[c] then caps[#caps + 1] = c end end
    local stored = {}
    for name, kind in vim.fs.dir(storageDir) do if kind == "file" then stored[#stored + 1] = name end end
    table.sort(stored)
    local evidence = {
        { kind = "neovim-version", path = ("%d.%d.%d%s"):format(v.major, v.minor, v.patch, v.prerelease and "-dev" or "") },
        { kind = "interpreter", path = scriptgo.compat.version },
        { kind = "os", path = uv.os_uname().sysname },
        { kind = "headless", path = #vim.api.nvim_list_uis() == 0 and "nvim --headless --clean -l" or "with a UI" },
        { kind = "ticks", path = ("%d host ticks from a libuv timer over %d ms"):format(ticks, runMs) },
        { kind = "resources", path = table.concat(sg.host.order, ", ") },
        { kind = "capabilities", path = table.concat(caps, ", ") },
        { kind = "http", path = sg.adapter.httpMode or ("unavailable: " .. tostring(sg.adapter.httpUnavailable)) },
        { kind = "storage", path = "<storage>: " .. (#stored > 0 and table.concat(stored, ", ") or "nothing written") },
    }
    if testsRan then
        evidence[#evidence + 1] = { kind = "tests", path = "test_script files on the in-memory harness, inside Neovim's LuaJIT" }
    end
    for _, e in ipairs(extraEvidence) do
        local kind, value = tostring(e):match("^([^=]+)=(.*)$")
        if kind then evidence[#evidence + 1] = { kind = kind, path = value } end
    end
    for _, e in ipairs(evidence) do e.path = scrub(e.path) end
    vim.fn.delete(storageDir, "rf")

    local name = m and m.name or scrub(root)
    local version = m and m.version or "unknown"
    local report = {
        runId = ("%s@%s:neovim:%s"):format(name, version, ranAt),
        package = name, version = version, environment = "neovim",
        status = failed == 0 and "verified" or "failing",
        runtimeVersion = ("Neovim %d.%d"):format(v.major, v.minor),
        adapterVersion = sg.adapter.adapterVersion,
        luaVersion = scriptgo.compat.version,
        ranAt = ranAt,
        durationMs = math.floor((uv.hrtime() - started) / 1e6),
        log = scrub(table.concat(logs, "\n")),
        checks = checks,
        evidence = evidence,
    }
    if flags.report then
        local f, err = io.open(absolute(flags.report), "wb")
        if not f then
            say("scriptgo verify: cannot write report: " .. scrub(err))
            failed = failed + 1
        else
            -- vim.json.encode does not sort keys; the CLI reads the report back and rewrites it.
            f:write(vim.json.encode(report), "\n")
            f:close()
        end
    end
    for _, c in ipairs(checks) do
        say(("  %-6s %s %s"):format(c.status == "passed" and "ok" or (c.status == "skipped" and "skip" or "FAIL"), c.name, c.message))
    end
    say(("%s: %s (neovim, %d ticks)"):format(report.package, report.status, ticks))
    return failed == 0 and 0 or 1
end
