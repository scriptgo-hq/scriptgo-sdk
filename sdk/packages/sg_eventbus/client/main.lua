-- EventBus Kit, client side: retained values of public topics, and publishing through the server.
local retained = {}
local rejections = {}

RegisterNetEvent("sg_eventbus:retained", function(values)
    for name, entry in pairs(values or {}) do retained[name] = entry end
    TriggerEvent("sg_eventbus:synced")
end)

RegisterNetEvent("sg_eventbus:rejected", function(name, reason)
    rejections[#rejections + 1] = { topic = name, reason = reason }
    if #rejections > 50 then table.remove(rejections, 1) end
    ScriptGo.log.warn(("publication to %s refused: %s"):format(tostring(name), tostring(reason)))
end)

-- publish(topic, payload): sent to the server, which validates it (topic must allow clientPublish).
exports("publish", function(name, payload)
    if not SgSchema.isTopic(name) then return false, "invalid_topic_name" end
    return TriggerServerEvent("sg_eventbus:publish", name, payload)
end)

-- last(topic) -> payload, meta for a public retained topic (after sync).
exports("last", function(name)
    local entry = retained[name]
    if not entry then return nil, "not_synced" end
    return entry.payload, entry.meta
end)

-- Keeps the retained cache current for public retained topics a client resource listens to.
exports("track", function(name)
    if not SgSchema.isTopic(name) then return false, "invalid_topic_name" end
    RegisterNetEvent("sgbus:" .. name, function(payload, meta)
        retained[name] = { payload = payload, meta = meta }
    end)
    return true
end)

exports("rejections", function() return rejections end)

TriggerServerEvent("sg_eventbus:sync")
