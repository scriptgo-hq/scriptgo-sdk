-- SCRIPT//GO for Hytale: runs SCRIPT//GO (and portable OPEN//77) resources inside the plugin.
--
--   local api = main(scriptgo, native, adapterFactory, opts)
--
-- Called once by the Java side (scriptgo.jvm.ScriptGoHost) on its host thread; every function of
-- the returned table is also only ever called on that thread.
--
-- opts.resourceDirs  folders holding <name>/scriptgo.lua (or open77.lua) resources, searched in order
-- opts.configText    the text of scriptgo.json, or nil
-- opts.verify        { name, with, seconds } in verify mode, else nil
--
-- scriptgo.json (all optional):
--   { "resources": { "<name>": { "key": "value" } }, "convars": { "key": "value" },
--     "permissions": { "<player name or uuid>": ["command.give", "shop.*"] },
--     "start": ["<name>", ...], "http": { "allowedHosts": ["api.example.com"], "timeoutSeconds": 10 },
--     "budgetMs": 1000 }
-- "start", when present, replaces auto-start with an explicit list.
return function(scriptgo, native, adapterFactory, opts)
    local json = scriptgo.json

    local cfg = {}
    if opts.configText then
        local ok, value = pcall(json.decode, opts.configText)
        if ok and type(value) == "table" then
            cfg = value
        else
            native.log("error", "scriptgo", "scriptgo.json is not valid JSON; using defaults")
        end
    end

    local logs = {}
    local adapter = adapterFactory(scriptgo, native, {
        config = cfg,
        logSink = function(entry)
            logs[#logs + 1] = entry
            if #logs > 5000 then table.remove(logs, 1) end
        end,
    })
    local host = scriptgo.newHost({ adapter = adapter })

    -- Discovery --------------------------------------------------------------------------------------
    local searchDirs = opts.resourceDirs or {}

    local function isResource(root)
        return native.isFile(root .. "/scriptgo.lua") or native.isFile(root .. "/open77.lua")
    end

    local function locate(name)
        for _, dir in ipairs(searchDirs) do
            local root = dir .. "/" .. name
            if isResource(root) then return root end
        end
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

    local discovered, names = {}, {}
    for _, dir in ipairs(searchDirs) do
        for _, name in ipairs(native.listDirs(dir)) do
            local root = dir .. "/" .. name
            if not discovered[name] and isResource(root) then
                discovered[name] = root
                names[#names + 1] = name
            end
        end
    end
    table.sort(names)
    for _, name in ipairs(names) do
        local ok, err = addWithDeps(discovered[name])
        if not ok then native.log("error", "scriptgo", name .. ": " .. tostring(err)) end
    end

    -- Start ------------------------------------------------------------------------------------------
    local verify = opts.verify
    local withStarted, withWhy = false, nil
    if verify then
        -- Verify runs start the resource under test (and its dependencies) only, then the README
        -- example resource named by `with`, if any.
        local ok, why
        if host:getResource(verify.name) then ok, why = host:start(verify.name) else why = "not found" end
        if not ok then native.log("error", "scriptgo", "verify: " .. verify.name .. " did not start: " .. tostring(why)) end
        if ok and verify.with then
            if host:getResource(verify.with) then
                withStarted, withWhy = host:start(verify.with)
            else
                withWhy = "not found"
            end
        end
    elseif type(cfg.start) == "table" then
        for _, name in ipairs(cfg.start) do
            local ok, why = host:start(name)
            if not ok then native.log("error", "scriptgo", name .. " did not start: " .. tostring(why)) end
        end
    else
        for name, result in pairs(host:startAll()) do
            if result ~= "started" then native.log("error", "scriptgo", name .. " did not start: " .. tostring(result)) end
        end
    end

    -- Verify report ----------------------------------------------------------------------------------
    -- Same schema as `scriptgo verify` on the other hosts (see the Luanti mod); written by the Java
    -- side to the report path it was given, after which the server is asked to shut down.
    local started = native.now()
    local reported = false
    local function writeReport()
        reported = true
        local checks = {}
        local function check(name, ok, message)
            checks[#checks + 1] = { name = name, status = ok and "passed" or "failed", message = message or "" }
        end
        local res = host:getResource(verify.name)
        local m = res and res.manifest
        check("manifest_valid", m ~= nil, m and (m.name .. " " .. m.version) or "resource not found or manifest invalid")
        if m then
            local declared = #m.environments == 0
            for _, e in ipairs(m.environments) do if e == "hytale" then declared = true end end
            check("environment_declared", declared, table.concat(m.environments, ", "))
            local missing = {}
            for _, dep in ipairs(m.dependencies) do
                if not host:getResource(dep.name) then missing[#missing + 1] = dep.name end
            end
            check("dependencies_resolved", #missing == 0, table.concat(missing, ", "))
            local state = host:resourceState(verify.name)
            check("starts", state == "started", state)
            local side = res.sides and res.sides.server
            for _, e in ipairs(m.serverExports or {}) do
                check("export:" .. e, side ~= nil and side.exports[e] ~= nil, "")
            end
            if verify.with then
                check("readme_example", withStarted == true, withStarted == true and (verify.with .. " started") or tostring(withWhy))
            end
        end
        local errors = {}
        for _, e in ipairs(logs) do if e.level == "error" then errors[#errors + 1] = e end end
        check("no_runtime_errors", #errors == 0, errors[1] and (tostring(errors[1].origin) .. " " .. tostring(errors[1].message)) or "")
        -- SGCHECK lines a resource printed become checks, as in `scriptgo verify`.
        local selfCount, done = 0, false
        local lines = {}
        for _, e in ipairs(logs) do
            local msg = tostring(e.message)
            lines[#lines + 1] = ("[%s] %s %s"):format(e.level, tostring(e.origin), msg)
            local verdict, cname, detail = msg:match("SGCHECK (%u+) (%S+)%s*(.*)$")
            if verdict == "PASS" or verdict == "FAIL" then
                selfCount = selfCount + 1
                checks[#checks + 1] = { name = "self:" .. cname, status = verdict == "PASS" and "passed" or "failed", message = detail or "" }
            end
            if msg:find("SGCHECK DONE", 1, true) then done = true end
        end
        if selfCount > 0 and not done then check("self:done", false, "SGCHECK DONE never printed: the self-checks did not finish") end

        local failed = 0
        for _, c in ipairs(checks) do if c.status == "failed" then failed = failed + 1 end end
        local report = {
            package = m and m.name or verify.name, version = m and m.version or "", environment = "hytale",
            status = failed == 0 and "verified" or "failing",
            runtimeVersion = native.runtimeVersion(), adapterVersion = adapter.adapterVersion,
            luaVersion = native.luaVersion(),
            durationMs = math.floor((native.now() - started) * 1000),
            checks = checks, log = table.concat(lines, "\n"), evidence = { seconds = verify.seconds },
        }
        native.writeReport(json.encode(report))
        native.log("info", "scriptgo", ("verify %s: %s (%d checks, %d failed)"):format(report.package, report.status, #checks, failed))
        native.shutdown("SCRIPT//GO verify finished")
    end

    -- Entry points (Java side) -----------------------------------------------------------------------
    local api = {}

    function api.tick()
        host:tick()
        if verify and not reported and native.now() - started >= (tonumber(verify.seconds) or 3) then writeReport() end
    end

    function api.playerJoin(id, name) host:playerJoin(id, name) end
    function api.playerDrop(id, reason) host:playerDrop(id, reason) end

    -- A resource command line from a player (id) or the console (0). Returns ok, why.
    function api.command(source, line) return host:executeCommand(source, line) end
    function api.hasCommand(name) return host.commands[tostring(name):lower()] ~= nil end
    function api.commandList() return host:commandList() end

    -- `/scriptgo [start|stop|restart <resource>]`; the Java side checks the caller's privilege for
    -- the three actions. Returns ok, text.
    function api.admin(param)
        local action, target = tostring(param or ""):match("^%s*(%S+)%s+(%S+)%s*$")
        if not action then
            local lines = {}
            for _, rname in ipairs(host.order) do
                local r = host:getResource(rname)
                lines[#lines + 1] = ("%s %s  %s"):format(rname, r.manifest.version, host:resourceState(rname))
            end
            return true, #lines > 0 and table.concat(lines, "\n") or "No resources."
        end
        if action ~= "start" and action ~= "stop" and action ~= "restart" then
            return false, "Usage: /scriptgo [start|stop|restart <resource>]"
        end
        if not host:getResource(target) then return false, "Unknown resource " .. target .. "." end
        if action == "stop" or action == "restart" then host:stop(target, "command") end
        if action == "start" or action == "restart" then
            local ok, why = host:start(target)
            if not ok then return false, target .. " did not start: " .. tostring(why) end
        end
        return true, target .. ": " .. host:resourceState(target)
    end

    function api.shutdown() host:stopAll() end

    -- For tests and diagnostics.
    function api.resourceState(name) return host:resourceState(name) end
    api.host = host
    return api
end
