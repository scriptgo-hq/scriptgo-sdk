-- SCRIPT//GO on OPEN//77, client part. Packed as `scriptgo_shim_client.lua`, the first client_script.
local SG = ScriptGo
local O = SG._open77

-- @capability ui
-- notify(payload) or notify(nil, payload): the local player's toast, shown by the bundled
-- open77_notifications package. The call is asynchronous; a missing package is logged, not raised.
O.caps.ui = true
SG.ui = {
    notify = function(target, payload)
        if payload == nil then payload = target end
        if type(payload) ~= "table" then return false, "invalid_payload" end
        local definition = O.toNotification(payload)
        CreateThread(function()
            local pending = Open77.exports.call("open77_notifications", "show", definition)
            if pending == nil then return end
            local ok, reason = pending:await()
            if ok == nil and reason ~= nil then
                Open77.log.warn("ScriptGo.ui.notify: " .. tostring(reason))
            end
        end)
        return true
    end,
}
-- @end
