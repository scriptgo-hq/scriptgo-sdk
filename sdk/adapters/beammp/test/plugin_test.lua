-- Unit test of the BeamMP plugin (main.lua + lib/adapter.lua) on a MOCK of the BeamMP Lua API
-- (mock_beammp.lua). It checks the plugin's own logic: discovery, start, the verify report, the
-- tick, players (id shift), chat and console commands, permissions, notifications, storage,
-- reload and shutdown. It is not a BeamMP run and never produces a verification report.
--
--   lua53 plugin_test.lua <pluginDir> basic      plugin built with sg_probe and its dependencies
--   lua53 plugin_test.lua <pluginDir> realtime   scriptgo.json already holds a verify config; the
--                                                mock clock follows real time (curl runs for real)
--
-- Prints one `ok|FAIL <name>` line per check, then `<passed>/<total> checks passed`.
local pluginDir, mode = arg[1], arg[2] or "basic"
assert(pluginDir, "usage: plugin_test.lua <pluginDir> [basic|realtime]")
pluginDir = pluginDir:gsub("\\", "/")
local here = (debug.getinfo(1, "S").source:gsub("^@", ""):gsub("\\", "/"):match("^(.*)/")) or "."
local mock = dofile(here .. "/mock_beammp.lua")

local failures, total = 0, 0
local function check(name, ok, detail)
    total = total + 1
    if not ok then failures = failures + 1 end
    detail = detail ~= nil and tostring(detail):gsub("\r?\n", " | ") or ""
    io.stdout:write(("%s %s%s\n"):format(ok and "ok  " or "FAIL", name, detail ~= "" and ("  " .. detail) or ""))
end
local function finish()
    io.stdout:write(("%d/%d checks passed\n"):format(total - failures, total))
    os.exit(failures == 0 and 0 or 1)
end

local function read(path)
    local f = io.open(path, "rb")
    if not f then return nil end
    local t = f:read("*a")
    f:close()
    return t
end
local function write(path, text)
    local f = assert(io.open(path, "wb"))
    f:write(text)
    f:close()
end

-- BeamMP runs main.lua as a chunk named after the file, relative to the server folder.
local function loadPlugin()
    local text = assert(read(pluginDir .. "/main.lua"))
    assert((loadstring or load)(text, pluginDir .. "/main.lua"))()
    return ScriptGoBeamMP
end

local function logged(pattern)
    for _, e in ipairs(ScriptGoBeamMP.logs) do
        if tostring(e.message):find(pattern) then return tostring(e.message) end
    end
    return nil
end

local scriptgoJson = pluginDir .. "/scriptgo.json"

if mode == "realtime" then
    local cfgText = assert(read(scriptgoJson), "realtime mode needs scriptgo.json")
    local report = cfgText:match('"report"%s*:%s*"([^"]+)"') or "report.json"
    local reportPath = (report:match("^%a:[/\\]") or report:match("^/")) and report or (pluginDir .. "/" .. report)
    os.remove(reportPath)
    loadPlugin()
    local function sleep(ms)
        local untilT = os.clock() + ms / 1000
        while os.clock() < untilT do end
    end
    local waited = 0
    while waited < 60000 and not read(reportPath) do
        sleep(25)
        mock.advance(25)
        waited = waited + 25
    end
    local text = read(reportPath)
    check("report_written", text ~= nil, reportPath)
    if text then
        local rep = ScriptGoBeamMP.api.json.decode(text)
        check("report_verified", rep.status == "verified", rep.status)
        for _, c in ipairs(rep.checks or {}) do
            if c.status ~= "passed" then check("report:" .. c.name, false, c.message) end
        end
        check("http_requests_drained", ScriptGoBeamMP.api.pendingHttp() == 0, ScriptGoBeamMP.api.pendingHttp())
    end
    finish()
end

-- 1. Verify mode on sg_probe ------------------------------------------------------------------------
write(scriptgoJson, [[{ "verify": { "resource": "sg_probe", "seconds": 3, "report": "verify-report.json" } }]])
os.remove(pluginDir .. "/verify-report.json")
local sg = loadPlugin()
check("plugin_loaded", type(sg) == "table" and sg.host ~= nil)
check("tick_event_registered", mock.events.scriptgo_tick and mock.events.scriptgo_tick.ScriptGo_Tick == true)
check("tick_timer_25ms", mock.timers[1] ~= nil and mock.timers[1].ms == 25, mock.timers[1] and mock.timers[1].ms)
check("verify_starts_only_the_closure", sg.host:resourceState("sg_probe") == "started" and sg.host:resourceState("sg_eventbus") == "started",
    sg.host:resourceState("sg_probe"))
mock.advance(3500)
local reportText = read(pluginDir .. "/verify-report.json")
check("verify_report_written", reportText ~= nil)
if reportText then
    local report = sg.api.json.decode(reportText)
    check("verify_report_status", report.status == "verified", report.status)
    check("verify_report_environment", report.environment == "beammp" and report.runtimeVersion == "BeamMP-Server 3.9.3", report.runtimeVersion)
    local selfPass, selfFail = 0, 0
    for _, c in ipairs(report.checks) do
        if c.name:sub(1, 5) == "self:" then
            if c.status == "passed" then selfPass = selfPass + 1 else selfFail = selfFail + 1 end
        elseif c.status ~= "passed" then
            check("verify_check:" .. c.name, false, c.message)
        end
    end
    check("verify_probe_self_checks", selfPass >= 20 and selfFail == 0, selfPass .. " passed, " .. selfFail .. " failed")
end
check("verify_calls_exit", mock.exited == true)

-- 2. Normal mode, through the hot-reload path -------------------------------------------------------
mock.exited = false
write(pluginDir .. "/scriptgo.json", [[{
  "start": ["bmp_test"],
  "dataDir": "]] .. pluginDir .. [[/data-test",
  "resources": { "bmp_test": { "greeting": "hi" } },
  "convars": { "sv_test": "on" },
  "permissions": { "Ada": ["command.sgadmin"], "beammp:777": ["shop.*"] }
}]])
local test = pluginDir .. "/resources/bmp_test"
FS.CreateDirectory(test .. "/server")
write(test .. "/scriptgo.lua", [[
resource "bmp_test"
version "0.1.0"
environments { "beammp" }
capabilities { "events", "logging", "storage", "players", "permissions", "commands", "config", "ui" }
server_script "server/main.lua"
]])
write(test .. "/server/main.lua", [[
RegisterCommand("sgtest", function(src, args)
    local what = args[1]
    if what == "notify" then
        ScriptGo.ui.notify(src, { title = "T", message = "to you" })
        ScriptGo.ui.notify(-1, { title = "All", message = "to all" })
    elseif what == "store" then
        ScriptGo.storage.set("k", { v = 7 })
    elseif what == "who" then
        print("SGTEST who " .. tostring(ScriptGo.players.name(src)) .. " " .. tostring(ScriptGo.players.identifier(src)))
        print("SGTEST list " .. table.concat(ScriptGo.players.list(), ","))
        print("SGTEST shop " .. tostring(ScriptGo.permissions.has(src, "shop.buy")))
    elseif what == "client" then
        local ok, why = TriggerClientEvent("bmp:x", src, 1)
        print("SGTEST client " .. tostring(ok) .. " " .. tostring(why))
    elseif what == "config" then
        print("SGTEST config " .. tostring(ScriptGo.config.get("greeting")) .. " " .. tostring(GetConvar("sv_test", "off")))
    end
    print("SGTEST cmd source=" .. tostring(src) .. " arg=" .. tostring(what))
end, false)
RegisterCommand("sgadmin", function(src) print("SGTEST admin source=" .. tostring(src)) end, true)
AddEventHandler("playerJoining", function() print("SGTEST joining source=" .. tostring(source)) end)
AddEventHandler("playerDropped", function(reason) print("SGTEST dropped source=" .. tostring(source) .. " " .. tostring(reason)) end)
local ticks = 0
CreateThread(function() while true do ticks = ticks + 1; Wait(0) end end)
exports("ticks", function() return ticks end)
]])

local timersBefore = #mock.timers
sg = loadPlugin()
check("reload_replaces_timer", #mock.timers == timersBefore, #mock.timers .. " timers")
check("reload_started_listed_resource", sg.host:resourceState("bmp_test") == "started", sg.host:resourceState("bmp_test"))
check("reload_did_not_start_others", sg.host:resourceState("sg_probe") ~= "started", sg.host:resourceState("sg_probe"))

mock.advance(200)
local function ticks() return sg.host:getResource("bmp_test").sides.server.exports.ticks() end
local t0 = ticks()
check("wait0_resumes_each_tick", t0 >= 6 and t0 <= 10, t0 .. " ticks in 200 ms")
mock.trigger("scriptgo_tick", 0, "from a client")
check("client_triggered_tick_ignored", ticks() == t0, ticks() .. " vs " .. t0)

-- Players: BeamMP id 0 is SCRIPT//GO player 1.
mock.join(0, "Ada", { identifiers = { beammp = "4242", ip = "127.0.0.1" } })
mock.join(1, "guest123", { guest = true, identifiers = { ip = "127.0.0.2" } })
mock.join(2, "Bob", { identifiers = { beammp = "777" } })
mock.advance(50)
check("join_shifts_ids", logged("SGTEST joining source=1") ~= nil and logged("SGTEST joining source=2") ~= nil)

local r = mock.trigger("onChatMessage", 0, "Ada", "/sgtest who")
check("chat_command_consumed", r[1] == 1, tostring(r[1]))
mock.advance(50)
check("player_name_and_identifier", logged("SGTEST who Ada beammp:4242") ~= nil, logged("SGTEST who"))
check("player_list", logged("SGTEST list 1,2,3") ~= nil, logged("SGTEST list"))
check("command_source_is_shifted", logged("SGTEST cmd source=1 arg=who") ~= nil)

mock.trigger("onChatMessage", 1, "guest123", "/sgtest who")
mock.advance(50)
check("guest_identifier", logged("SGTEST who guest123 beammp%-guest:guest123") ~= nil, logged("SGTEST who guest"))

mock.trigger("onChatMessage", 2, "Bob", "/sgtest who")
mock.advance(50)
check("permission_by_identifier_wildcard", logged("SGTEST shop true") ~= nil)

r = mock.trigger("onChatMessage", 0, "Ada", "hello everyone")
check("plain_chat_untouched", r[1] == nil)

local chatBefore = #mock.chat
r = mock.trigger("onChatMessage", 1, "guest123", "/sgadmin")
mock.advance(50)
check("restricted_command_refused", r[1] == 1 and #mock.chat == chatBefore + 1 and mock.chat[#mock.chat].id == 1
    and mock.chat[#mock.chat].message:find("not allowed") ~= nil, mock.chat[#mock.chat] and mock.chat[#mock.chat].message)
check("refused_command_did_not_run", logged("SGTEST admin source=2") == nil)
mock.trigger("onChatMessage", 0, "Ada", "/SGADMIN")
mock.advance(50)
check("restricted_command_granted_by_name", logged("SGTEST admin source=1") ~= nil)

mock.trigger("onChatMessage", 0, "Ada", "/sgtest notify")
mock.advance(50)
local n1, n2 = mock.notifications[#mock.notifications - 1], mock.notifications[#mock.notifications]
check("notify_player", n1 ~= nil and n1.id == 0 and n1.message == "[T] to you", n1 and (n1.id .. " " .. n1.message))
check("notify_all", n2 ~= nil and n2.id == -1 and n2.message == "[All] to all", n2 and (n2.id .. " " .. n2.message))

mock.trigger("onChatMessage", 0, "Ada", "/sgtest store")
mock.advance(50)
local stored = read(pluginDir .. "/data-test/storage/bmp_test.json")
check("storage_file_written", stored ~= nil and stored:find('"v":7') ~= nil, stored)
check("storage_tmp_renamed", read(pluginDir .. "/data-test/storage/bmp_test.json.tmp") == nil)

mock.trigger("onChatMessage", 0, "Ada", "/sgtest client")
mock.advance(50)
check("client_events_unavailable", logged("SGTEST client false network_unavailable") ~= nil, logged("SGTEST client"))
check("no_client_packet_sent", #mock.clientEvents == 0)

mock.trigger("onChatMessage", 0, "Ada", "/sgtest config")
mock.advance(50)
check("config_and_convar", logged("SGTEST config hi on") ~= nil, logged("SGTEST config"))

-- Console.
r = mock.trigger("onConsoleInput", "scriptgo")
check("console_lists_resources", type(r[1]) == "string" and r[1]:find("bmp_test 0.1.0%s+started") ~= nil, r[1])
r = mock.trigger("onConsoleInput", "sgtest console")
mock.advance(50)
check("console_runs_resource_command_as_source_0", r[1] == "ran sgtest" and logged("SGTEST cmd source=0 arg=console") ~= nil, r[1])
r = mock.trigger("onConsoleInput", "status")
check("console_ignores_other_input", r[1] == nil)
r = mock.trigger("onConsoleInput", "scriptgo restart bmp_test")
check("console_restart", r[1] == "bmp_test: started", r[1])

mock.leave(2)
mock.advance(50)
check("disconnect_drops_player", logged("SGTEST dropped source=3 left") ~= nil)

-- Clock: monotonic and rebased past 1000 s without a jump.
local before = sg.adapter.now()
mock.advance(1001000)
local after = sg.adapter.now()
check("clock_rebases_without_jump", math.abs((after - before) - 1001) < 0.01, ("%.3f"):format(after - before))

mock.trigger("onShutdown")
check("shutdown_stops_resources", sg.host:resourceState("bmp_test") ~= "started", sg.host:resourceState("bmp_test"))

local errors = {}
for _, e in ipairs(sg.logs) do if e.level == "error" then errors[#errors + 1] = tostring(e.message) end end
check("no_errors_logged", #errors == 0, errors[1])
finish()
