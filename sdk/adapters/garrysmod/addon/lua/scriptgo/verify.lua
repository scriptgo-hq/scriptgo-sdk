-- Verify mode, driven by data/scriptgo/verify.json (written by `scriptgo verify --env garrysmod`):
--   { "resource": "<name>", "with": "<name>"|null, "seconds": 4, "report": "scriptgo/verify-report.json",
--     "bot": true, "botChat": ["/command args"], "config": { ... }, "storageDir": "scriptgo/verify/storage" }
-- Starts only that resource (dependencies first) and then `with` (the README example), lets them
-- run on real server frames, has a bot join and leave (the engine's own PlayerInitialSpawn and
-- player_disconnect), and writes a report with the same schema as the other hosts into data/.
-- GMod blocks `quit` from Lua, so the runner stops the server once the report exists.
return function(ctx)
    local host, scriptgo, adapter, logs, req = ctx.host, ctx.scriptgo, ctx.adapter, ctx.logs, ctx.request
    local json = scriptgo.json
    local name, with = req.resource, req.with
    if with == json.null then with = nil end
    local seconds = tonumber(req.seconds) or 4
    local reportPath = req.report or "scriptgo/verify-report.json"
    local M = {}

    local ticks, startedAt = 0, nil
    hook.Add("Think", "scriptgo_verify", function() ticks = ticks + 1 end)

    local withStarted, withWhy = false, nil
    local bot = { requested = req.bot ~= false }

    local function writeReport()
        hook.Remove("Think", "scriptgo_verify")
        local checks = {}
        local function check(cname, ok, message)
            checks[#checks + 1] = { name = cname, status = ok and "passed" or "failed", message = message or "" }
        end
        local res = host:getResource(name)
        local m = res and res.manifest
        check("manifest_valid", m ~= nil, m and (m.name .. " " .. m.version) or "resource not found or manifest invalid")
        if m then
            local declared = #m.environments == 0
            for _, e in ipairs(m.environments) do if e == "garrysmod" then declared = true end end
            check("environment_declared", declared, table.concat(m.environments, ", "))
            local missing = {}
            for _, dep in ipairs(m.dependencies) do
                if not host:getResource(dep.name) then missing[#missing + 1] = dep.name end
            end
            check("dependencies_resolved", #missing == 0, table.concat(missing, ", "))
            local state = host:resourceState(name)
            check("starts", state == "started", state == "started" and state or (state .. " " .. tostring(res.failure or "")))
            local side = res.sides and res.sides.server
            for _, e in ipairs(m.serverExports or {}) do
                check("export:" .. e, side ~= nil and side.exports[e] ~= nil, "")
            end
            if with then
                check("readme_example", withStarted == true, withStarted == true and (with .. " started") or tostring(withWhy))
            end
        end
        -- The engine's side: the scheduler ticked on Think, and a real player entity joined and left.
        check("host:ticks", ticks > 0, ticks .. " Think frames in " .. seconds .. " s")
        if bot.requested then
            check("host:player_join", bot.joined == true,
                bot.id and ("bot userid " .. bot.id .. " joined; ScriptGo.players.list had it: " .. tostring(bot.listed)) or tostring(bot.why or "no bot"))
            check("host:player_drop", bot.dropped == true, bot.dropped and "dropped on kick" or "still listed after kick")
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
            package = m and m.name or name, version = m and m.version or "", environment = "garrysmod",
            status = failed == 0 and "verified" or "failing",
            -- BRANCH is "unknown" on the default (public) branch.
            runtimeVersion = ("Garry's Mod %s (%s%s)"):format(tostring(VERSIONSTR), tostring(jit and jit.arch or "?"),
                (BRANCH and BRANCH ~= "unknown") and (", branch " .. tostring(BRANCH)) or ""),
            adapterVersion = adapter.adapterVersion, luaVersion = scriptgo.compat.version,
            durationMs = math.floor((SysTime() - (startedAt or SysTime())) * 1000),
            checks = checks, log = table.concat(lines, "\n"),
            evidence = { seconds = seconds, map = game.GetMap(), ticks = ticks, gmodVersion = VERSION },
        }
        file.CreateDir(reportPath:match("^(.*)/[^/]*$") or "scriptgo")
        file.Write(reportPath, json.encode(report))
        MsgC(Color(120, 220, 120), ("[scriptgo] verify %s: %s (%d checks, %d failed) -> data/%s\n"):format(report.package, report.status, #checks, failed, reportPath))
    end

    function M.start()
        startedAt = SysTime()
        local ok, why = false, "not found"
        if host:getResource(name) then ok, why = host:start(name) end
        if not ok then adapter.log("error", "verify", name .. " did not start: " .. tostring(why)) end
        if ok and with then
            if host:getResource(with) then
                withStarted, withWhy = host:start(with)
            else
                withWhy = "not found"
            end
        end
        if bot.requested then
            -- A bot is a real player entity: PlayerInitialSpawn and player_disconnect fire for it.
            timer.Simple(math.min(1, seconds / 4), function()
                local ply = player.CreateNextBot("sgverify")
                if not IsValid(ply) then bot.why = "player.CreateNextBot failed (maxplayers too low?)" return end
                bot.id = ply:UserID()
                bot.joined = host.players[bot.id] ~= nil
                for _, id in ipairs(host:playerList()) do if id == bot.id then bot.listed = true end end
                -- botChat: lines the bot says, through the engine's own say path (PlayerSay hooks).
                for i, line in ipairs(type(req.botChat) == "table" and req.botChat or {}) do
                    timer.Simple(0.1 * i, function() if IsValid(ply) then ply:Say(tostring(line)) end end)
                end
                timer.Simple(math.max(0.5, seconds / 4), function()
                    if IsValid(ply) then ply:Kick("SCRIPT//GO verify finished") end
                    timer.Simple(0.5, function() bot.dropped = host.players[bot.id] == nil end)
                end)
            end)
        end
        timer.Simple(seconds, writeReport)
    end

    return M
end
