-- VIP perks, server side.
--
-- The operator created a perk with the key "vip" in the SCRIPT//GO dashboard, linked this server to
-- their account and gave it the link token (the host setting scriptgo_server_token). From there:
--
--   * when a player joins, the script asks whether they have the perk (ScriptGo.perks.has: the
--     answer comes from SCRIPT//GO, the source of truth, and is cached by the host);
--   * while the server runs, it is told when a perk is granted or removed (a purchase, a refund,
--     the end of a period) and applies that at once;
--   * a player without the perk can be given a purchase link tied to their identifier.
--
-- What "having VIP" does is this script's business: here it is a table and a log line. Nothing in
-- this file talks to a payment provider.
local PERK = "vip"

local vip = {} -- player id -> true while that player is connected and has the perk

local function setting(key)
    if not ScriptGo.capabilities.has("config") then return nil end
    return ScriptGo.config.get(key)
end

local function apply(player, on, why)
    if player == nil then return end
    if (vip[player] == true) == on then return end
    vip[player] = on or nil
    ScriptGo.log.info(("SGPERK %s player=%s perk=%s (%s)"):format(on and "applied" or "withdrawn", tostring(player), PERK, tostring(why)))
    if ScriptGo.capabilities.has("ui") then
        ScriptGo.ui.notify(player, {
            type = on and "success" or "info", title = "VIP",
            message = on and "Your VIP perk is active." or "Your VIP perk has ended.",
        })
    end
end

AddEventHandler("onPlayerConnected", function(player)
    local has, info = ScriptGo.perks.has(player, PERK)
    ScriptGo.log.info(("SGPERK join player=%s identifier=%s %s=%s"):format(tostring(player), tostring(ScriptGo.players.identifier(player)), PERK, tostring(has)))
    apply(player, has, has and "held at join" or tostring(info))
end)

AddEventHandler("onPlayerDisconnected", function(player)
    vip[player] = nil
end)

-- `player` is the connected player with that identifier, or nil when they are not on this server.
ScriptGo.perks.on("granted", function(player, key, info)
    ScriptGo.log.info(("SGPERK granted identifier=%s perk=%s reason=%s"):format(info.identifier, key, tostring(info.reason)))
    if key == PERK then apply(player, true, info.reason) end
end)

ScriptGo.perks.on("removed", function(player, key, info)
    ScriptGo.log.info(("SGPERK removed identifier=%s perk=%s reason=%s"):format(info.identifier, key, tostring(info.reason)))
    if key == PERK then apply(player, false, info.reason) end
end)

exports("has", function(player, key)
    local has, info = ScriptGo.perks.has(player, key or PERK)
    if has then return true, info.expiresAt, info.source end
    return false, info
end)

exports("isVip", function(player) return vip[player] == true end)

-- A purchase link for one player: the page it opens names the perk, the seller and the player, and
-- sends them to the operator's own store.
exports("link", function(player, key)
    return ScriptGo.perks.purchaseLink(player, key or PERK)
end)

-- Demonstration and end-to-end runs: the setting "watch" (a list of player identifiers) makes the
-- script report, twice a second, what it would answer for each of them, and "print_links" makes it
-- ask for a purchase link whenever one of them does not have the perk.
CreateThread(function()
    local watch = setting("watch")
    if type(watch) ~= "table" or #watch == 0 then return end
    local last = {}
    while true do
        for _, identifier in ipairs(watch) do
            local has, info = ScriptGo.perks.has(identifier, PERK)
            local line
            if has then
                line = "held expires=" .. tostring(info.expiresAt or "never")
            else
                line = "not_held (" .. tostring(info) .. ")"
            end
            if last[identifier] ~= line then
                last[identifier] = line
                ScriptGo.log.info(("SGPERK state identifier=%s perk=%s %s"):format(identifier, PERK, line))
                if not has and info == "not_held" and setting("print_links") == true then
                    local url, why = ScriptGo.perks.purchaseLink(identifier, PERK)
                    ScriptGo.log.info(("SGPERK link identifier=%s perk=%s %s"):format(identifier, PERK, url or ("refused (" .. tostring(why) .. ")")))
                end
            end
        end
        Wait(500)
    end
end)
