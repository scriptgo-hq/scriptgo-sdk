-- Prints `SGCHECK PASS|FAIL <name>` lines like sg_probe; `SGCHECK DONE` once the bot has left.
local results = { pass = 0, fail = 0 }
local function record(name, ok, detail)
    if ok then
        results.pass = results.pass + 1
        print("SGCHECK PASS " .. name)
    else
        results.fail = results.fail + 1
        print("SGCHECK FAIL " .. name .. (detail ~= nil and (" " .. tostring(detail)) or ""))
    end
end

local joined, adminRan, pinged = nil, false, false

record("config.resource", ScriptGo.config.get("greeting") == "hello from config.json", ScriptGo.config.get("greeting"))
record("config.convar", GetConvar("sv_lan", "?") == "1", GetConvar("sv_lan", "?"))
record("config.missing", GetConvar("sg_gmod_paths_no_such_convar", "dflt") == "dflt")

AddEventHandler("playerJoining", function()
    joined = source
    record("players.joining", type(source) == "number" and source > 0, source)
    record("players.name", ScriptGo.players.name(source) == "sgverify", ScriptGo.players.name(source))
    record("players.identifier", ScriptGo.players.identifier(source) == "bot:" .. tostring(source), ScriptGo.players.identifier(source))
end)

RegisterCommand("sgadmin", function() adminRan = true end, true)

RegisterCommand("sgping", function(src, args, raw)
    pinged = true
    record("command.chat", src == joined and args.n == 2 and args[1] == "a" and args[2] == "b" and raw == "sgping a b", tostring(src) .. " " .. tostring(raw))
    record("command.restricted_refused", adminRan == false, "a non-admin ran /sgadmin")
    record("permissions.usergroup_grant", ScriptGo.permissions.has(src, "paths.granted") == true)
    record("permissions.wildcard_grant", ScriptGo.permissions.has(src, "shop.buy") == true)
    record("permissions.denied", ScriptGo.permissions.has(src, "paths.other") == false)
    record("ui.notify_player", ScriptGo.ui.notify(src, { title = "paths", message = "pong" }) == true)
    record("ui.notify_all", ScriptGo.ui.notify(-1, { title = "paths", message = "to everyone" }) == true)
end, false)

AddEventHandler("playerDropped", function(reason)
    record("players.dropped", source == joined and type(reason) == "string", tostring(source) .. " " .. tostring(reason))
    record("command.received", pinged, "the bot's /sgping never reached the resource")
    print(("SGCHECK DONE env=%s pass=%d fail=%d"):format(ScriptGo.runtime.environment(), results.pass, results.fail))
end)
