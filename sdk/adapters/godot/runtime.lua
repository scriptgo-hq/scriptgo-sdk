-- SCRIPT//GO runtime glue for Godot 4. scriptgo_host.gd runs this chunk in a lua-gdextension
-- LuaState (libraries: base, coroutine, string, os, math, table, debug, utf8, GODOT_VARIANT,
-- GODOT_CLASSES; no io, no package) and calls the function it returns:
--
--   local ctl = boot(sdkRoot, optionsJson, clockUsec, logSink)
--
--   sdkRoot      folder holding lua/scriptgo/ and adapters/godot/ (res://, user:// or absolute)
--   optionsJson  { config, storageDir, budgetMs, localPlayer = { id, name } } as JSON text
--   clockUsec    Callable -> Time.get_ticks_usec() (Lua must not touch the Time singleton)
--   logSink      Callable(level, origin, message)
--
-- The controller's functions take plain values and return ONE value; structures travel as JSON
-- text so GDScript never has to walk nested LuaTables.
return function(sdkRoot, optionsJson, clockUsec, logSink)
    sdkRoot = tostring(sdkRoot):gsub("\\", "/")
    if not sdkRoot:match("/$") then sdkRoot = sdkRoot .. "/" end

    local function read(path)
        if not FileAccess:file_exists(path) then return nil end
        return FileAccess:get_file_as_string(path)
    end
    local function loadChunk(path, chunkname)
        local text = read(path)
        if not text then error("scriptgo: cannot read " .. chunkname, 0) end
        return assert(load(text, "@" .. chunkname, "t"))
    end

    local scriptgo = loadChunk(sdkRoot .. "lua/scriptgo/init.lua", "scriptgo/init.lua")(sdkRoot .. "lua/scriptgo/", read)
    local json = scriptgo.json
    local options = {}
    if type(optionsJson) == "string" and optionsJson ~= "" then options = json.decode(optionsJson) end

    local logs = {}
    local function sink(level, origin, msg)
        logs[#logs + 1] = { level = level, origin = origin, message = msg }
        if #logs > 20000 then table.remove(logs, 1) end
        if logSink then logSink(level, origin, msg) end
    end

    local makeAdapter = loadChunk(sdkRoot .. "adapters/godot/adapter.lua", "scriptgo/adapters/godot/adapter.lua")()
    local adapter = makeAdapter(scriptgo, {
        clock = clockUsec and function() return clockUsec() / 1e6 end or nil,
        config = options.config,
        storageDir = options.storageDir,
        budgetMs = options.budgetMs,
        logSink = sink,
    })
    local localPlayer = options.localPlayer or { id = 1, name = "Player" }
    local host = scriptgo.newHost({ adapter = adapter, localPlayer = localPlayer })

    local search = {}
    local function normalize(p) return (tostring(p):gsub("\\", "/"):gsub("/+$", "")) end
    local function hasManifest(root) return read(root .. "/scriptgo.lua") ~= nil or read(root .. "/open77.lua") ~= nil end
    local function locate(name)
        for _, dir in ipairs(search) do
            local root = dir .. "/" .. name
            if hasManifest(root) then return root end
        end
        return nil
    end

    -- Adds a resource and, recursively, its dependencies found in the search paths. Names of
    -- dependencies that could not be located go to `missing`.
    local function addWithDeps(h, root, missing)
        local res, err = h:addResource(root)
        if not res then
            if err and err:find("already loaded", 1, true) then return true end
            return nil, err
        end
        for _, dep in ipairs(res.manifest.dependencies) do
            if not h:getResource(dep.name) then
                local depRoot = locate(dep.name)
                if depRoot then
                    local ok, derr = addWithDeps(h, depRoot, missing)
                    if not ok then return nil, derr end
                elseif missing then
                    missing[#missing + 1] = dep.name
                end
            end
        end
        return res
    end

    local function encode(v) return json.encode(v) end
    local function decodeArgs(text)
        if type(text) ~= "string" or text == "" then return {} end
        local ok, v = pcall(json.decode, text)
        return (ok and type(v) == "table") and v or {}
    end

    local ctl = {}

    function ctl.info()
        local caps = {}
        for _, c in ipairs(scriptgo.capabilities.ALL) do if host.capabilities[c] then caps[#caps + 1] = c end end
        return encode({
            version = scriptgo.VERSION, luaVersion = scriptgo.compat.version, environment = host.environment,
            adapterVersion = adapter.adapterVersion, capabilities = caps, storageDir = adapter.storageDir,
        })
    end

    function ctl.addSearchPath(dir)
        search[#search + 1] = normalize(dir)
        return true
    end

    -- Returns "" on success, else the reason.
    function ctl.add(root)
        local missing = {}
        local ok, err = addWithDeps(host, normalize(root), missing)
        if not ok then return tostring(err) end
        if #missing > 0 then return "missing dependencies: " .. table.concat(missing, ", ") end
        return ""
    end

    function ctl.startAll() return encode(host:startAll()) end
    function ctl.start(name)
        local ok, why = host:start(name)
        return ok and "" or tostring(why)
    end
    function ctl.stop(name) return host:stop(name) and true or false end
    function ctl.stopAll() host:stopAll(); host:tick(adapter.now()); return true end

    function ctl.join(id, name) host:playerJoin(math.floor(id), name); return true end
    function ctl.drop(id, reason) host:playerDrop(math.floor(id), reason); return true end

    -- One frame: advance the scheduler to the adapter clock. Returns pending notifications.
    function ctl.tick()
        host:tick(adapter.now())
        return #adapter.pending
    end

    -- A console (source 0) or player command line. Returns "" or the refusal reason.
    function ctl.command(source, line)
        local ok, why = host:executeCommand(math.floor(source), tostring(line))
        return ok and "" or tostring(why)
    end

    -- Calls an export and returns {"ok":true,"values":[...]} if it settled within this call
    -- (exports that do not Wait settle at once), {"ok":false,"pending":true} or {"ok":false,"reason":...}.
    function ctl.callExport(resource, exportName, side, argsJson)
        local args = decodeArgs(argsJson)
        local promise, err = host:callExport(resource, exportName, side or "server", scriptgo.compat.unpack(args))
        if not promise then return encode({ ok = false, reason = err }) end
        if not promise:isSettled() then return encode({ ok = false, pending = true }) end
        if promise.state ~= "resolved" then return encode({ ok = false, reason = promise.reason }) end
        local values = {}
        for i = 1, promise.values.n do values[i] = promise.values[i] == nil and json.null or promise.values[i] end
        return encode({ ok = true, values = values })
    end

    function ctl.drainNotifications()
        local out = {}
        for _, n in ipairs(adapter.drainNotifications()) do
            local p = n.payload or {}
            out[#out + 1] = {
                target = n.target, type = tostring(p.type or "info"), title = p.title and tostring(p.title) or "",
                message = tostring(p.message or ""), resource = tostring(p.resource or ""),
                durationMs = tonumber(p.durationMs) or 3500,
            }
        end
        return encode(out)
    end

    function ctl.states()
        local out = {}
        for _, name in ipairs(host.order) do out[name] = host:resourceState(name) end
        return encode(json.object(out))
    end

    function ctl.commands() return encode(host:commandList()) end

    -- Verification ---------------------------------------------------------------------------------
    -- Same checks as `main.lua verify` (manifest_valid, environment_declared,
    -- dependencies_resolved, starts, export:*, no_runtime_errors), but the resource runs in real
    -- Godot frames between verifyBegin and verifyFinish; then SGCHECK lines become self:* checks
    -- and the resource's test_script files run on this LuaState.
    local verify = { checks = {} }
    local function check(name, ok, message)
        verify.checks[#verify.checks + 1] = { name = name, status = ok and "passed" or "failed", message = message or "" }
        return ok
    end

    function ctl.verifyBegin(resourceDir, searchJson)
        for _, dir in ipairs(decodeArgs(searchJson)) do search[#search + 1] = normalize(dir) end
        local root = normalize(resourceDir)
        verify.root = root
        local text = read(root .. "/scriptgo.lua") or read(root .. "/open77.lua")
        local parsed = text and scriptgo.manifest.parse(text, "scriptgo.lua")
        local m = parsed and parsed.ok and parsed.manifest or nil
        verify.manifest = m
        check("manifest_valid", m ~= nil, m and (m.name .. " " .. m.version) or "manifest missing or invalid")
        if not m then return encode({ ok = false }) end
        local declared = #m.environments == 0
        for _, e in ipairs(m.environments) do if e == "godot" then declared = true end end
        check("environment_declared", declared, table.concat(m.environments, ", "))
        local missing = {}
        local ok, err = addWithDeps(host, root, missing)
        if ok and #missing > 0 then ok, err = nil, "missing: " .. table.concat(missing, ", ") end
        check("dependencies_resolved", ok ~= nil, err or "")
        if not ok then return encode({ ok = false, name = m.name }) end
        local sok, why = host:start(m.name)
        check("starts", sok == true, why or "started")
        if not sok then return encode({ ok = false, name = m.name }) end
        local side = host:getResource(m.name).sides.server
        for _, e in ipairs(m.serverExports or {}) do
            check("export:" .. e, side ~= nil and side.exports[e] ~= nil, "")
        end
        host:tick(adapter.now())
        host:playerJoin(localPlayer.id, localPlayer.name)
        verify.started = true
        local names = {}
        for _, n in ipairs(host.order) do names[#names + 1] = n end
        return encode({ ok = true, name = m.name, resources = names })
    end

    -- Lines `SGCHECK PASS|FAIL <name> [detail]` -> self:<name> checks, as selfChecks in verify.ts.
    local function selfChecks(logText)
        local out, done = {}, false
        for line in (logText .. "\n"):gmatch("([^\n]*)\n") do
            line = line:gsub("\r$", "")
            local verdict, name, rest = line:match("SGCHECK (%u+) (%S+)(.*)$")
            if (verdict == "PASS" or verdict == "FAIL") and name then
                local message = rest:match("^ (.*)$") or ""
                out[#out + 1] = { name = "self:" .. name, status = verdict == "PASS" and "passed" or "failed",
                    message = (message:gsub("^%s+", ""):gsub("%s+$", "")) }
            end
            if line:find("SGCHECK DONE", 1, true) then done = true end
        end
        if #out > 0 and not done then
            out[#out + 1] = { name = "self:done", status = "failed", message = "SGCHECK DONE never printed: the self-checks did not finish" }
        end
        return out
    end

    -- The resource's test_script files on this LuaState (memory harness, simulated time), like
    -- `main.lua test`. Returns ok, summary line.
    local function runTests(m, root)
        local testing = scriptgo.testing
        local suite = testing.suite()
        local function loadHarness(opts)
            opts = opts or {}
            opts.readFile = opts.readFile or read
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
                for _, extra in ipairs(opts.with or {}) do h:start((extra:match("([^/\\]+)$"))) end
            end
            return h
        end
        for _, rel in ipairs(m.testScripts) do
            local text = read(root .. "/" .. rel)
            if not text then return false, "cannot read " .. rel end
            local env = setmetatable({
                test = suite.test, it = suite.it, describe = suite.describe, expect = testing.expect,
                load = loadHarness, scriptgo = scriptgo, RESOURCE = m.name, ROOT = root,
            }, { __index = _G })
            local fn, err = scriptgo.compat.loadWithEnv(text, "@" .. m.name .. "/" .. rel, env)
            if not fn then return false, tostring(err) end
            local ok, rerr = pcall(fn)
            if not ok then return false, tostring(rerr) end
        end
        local failures = {}
        local result = suite.run(function(name, ok, err)
            if not ok then failures[#failures + 1] = name .. ": " .. tostring(err):match("^[^\n]*") end
        end)
        local line = ("%s: %d passed, %d failed (%s)"):format(m.name, result.passed, result.failed, scriptgo.compat.version)
        if #failures > 0 then line = line .. " — " .. table.concat(failures, "; ") end
        return result.failed == 0, line
    end

    local function replacePlain(s, from, to)
        if from == "" then return s end
        local out, i = {}, 1
        while true do
            local a, b = s:find(from, i, true)
            if not a then break end
            out[#out + 1] = s:sub(i, a - 1)
            out[#out + 1] = to
            i = b + 1
        end
        out[#out + 1] = s:sub(i)
        return table.concat(out)
    end

    -- ctx: { runtimeVersion, ranAt, durationMs, frames, elapsedMs, settleMs, evidence = [{kind, path}],
    --        redact = [[absolutePrefix, label], ...] }. Returns the report as JSON text.
    function ctl.verifyFinish(ctxJson)
        local ctx = decodeArgs(ctxJson)
        local m = verify.manifest
        if verify.started then
            local frames, elapsed, settle = tonumber(ctx.frames) or 0, tonumber(ctx.elapsedMs) or 0, tonumber(ctx.settleMs) or 2000
            check("real_frames", frames >= 30 and elapsed >= settle * 0.9,
                ("%d frames in %d ms"):format(frames, math.floor(elapsed)))
            host:playerDrop(localPlayer.id, "verify_done")
            host:tick(adapter.now())
            host:stopAll()
            host:tick(adapter.now())
            local firstError
            for _, e in ipairs(logs) do
                if e.level == "error" then firstError = firstError or e.message end
            end
            check("no_runtime_errors", firstError == nil, firstError and tostring(firstError):match("^[^\n]*") or "")
        end
        local lines = {}
        for _, e in ipairs(logs) do lines[#lines + 1] = ("[%s] %s %s"):format(e.level, e.origin, tostring(e.message)) end
        local logText = table.concat(lines, "\n")
        for _, c in ipairs(selfChecks(logText)) do verify.checks[#verify.checks + 1] = c end
        if m and verify.started then
            if #m.testScripts > 0 then
                local ok, summary = runTests(m, verify.root)
                check("tests", ok, summary)
            else
                verify.checks[#verify.checks + 1] = { name = "tests", status = "skipped", message = "no test_script" }
            end
        end

        -- Keep local paths (they carry the user name) out of the report.
        local redactions = ctx.redact or {}
        table.sort(redactions, function(a, b) return #tostring(a[1]) > #tostring(b[1]) end)
        local function clean(s)
            s = tostring(s or "")
            for _, r in ipairs(redactions) do s = replacePlain(s, tostring(r[1]), tostring(r[2])) end
            s = s:gsub("[A-Za-z]:[/\\][Uu]sers[/\\][^/\\%s\"']+", "<home>")
            return s
        end
        local failed = 0
        for _, c in ipairs(verify.checks) do
            c.message = clean(c.message)
            if c.status == "failed" then failed = failed + 1 end
        end
        local name = m and m.name or clean(verify.root or "")
        local version = m and m.version or ""
        local report = {
            runId = ("%s@%s:godot:%s"):format(name, version, tostring(ctx.ranAt or "")),
            package = name, version = version, environment = "godot",
            status = failed == 0 and "verified" or "failing",
            runtimeVersion = ctx.runtimeVersion or "", adapterVersion = adapter.adapterVersion,
            luaVersion = scriptgo.compat.version, ranAt = ctx.ranAt or "",
            durationMs = math.floor(tonumber(ctx.durationMs) or 0),
            checks = verify.checks, log = clean(logText), evidence = ctx.evidence or {},
        }
        return encode(report)
    end

    ctl.host = host
    ctl.adapter = adapter
    ctl.scriptgo = scriptgo
    return ctl
end
