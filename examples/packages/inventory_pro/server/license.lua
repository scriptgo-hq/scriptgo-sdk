-- License gate for Inventory Pro. Defines the global `InvProLicense`.
--
-- On start, and every six hours, the server verifies its license key with the SCRIPT//GO API
-- (ScriptGo.licensing.verify). A valid answer is cached with its offline grace deadline, so a
-- network outage does not switch a paying server off until that deadline passes.
--
-- Honest limits: the server owner controls this machine, so a determined owner can patch any
-- client-side check. The gate exists to make the paid path the easy one and to give creators an
-- activation record, not to be unbreakable DRM.
InvProLicense = { state = "checking", reason = nil, checkedAt = nil, graceUntil = nil }

local PACKAGE = "kestrel//inventory-pro"
local RECHECK_MS = 6 * 60 * 60 * 1000

-- "2026-12-01T10:00:00Z" (or with milliseconds) -> Unix seconds, UTC, without os.time's local-time trap.
local function isoToEpoch(s)
    if type(s) ~= "string" then return nil end
    local y, mo, d, h, mi, se = s:match("^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)")
    if not y then return nil end
    y, mo, d = tonumber(y), tonumber(mo), tonumber(d)
    -- Days from civil (Howard Hinnant).
    if mo <= 2 then y = y - 1 end
    local era = math.floor(y / 400)
    local yoe = y - era * 400
    local mp = (mo + 9) % 12
    local doy = math.floor((153 * mp + 2) / 5) + d - 1
    local doe = yoe * 365 + math.floor(yoe / 4) - math.floor(yoe / 100) + doy
    local days = era * 146097 + doe - 719468
    return days * 86400 + tonumber(h) * 3600 + tonumber(mi) * 60 + tonumber(se)
end
InvProLicense.isoToEpoch = isoToEpoch

local function setState(state, reason)
    local changed = InvProLicense.state ~= state
    InvProLicense.state, InvProLicense.reason = state, reason
    if changed then
        local msg = ("license %s%s"):format(state, reason and (" (" .. reason .. ")") or "")
        if state == "active" or state == "grace" then ScriptGo.log.info(msg) else ScriptGo.log.error(msg) end
        TriggerEvent("inventory_pro:license", state, reason)
    end
end

function InvProLicense.active()
    return InvProLicense.state == "active" or InvProLicense.state == "grace"
end

local function licenseKey()
    if not ScriptGo.capabilities.has("config") then return nil end
    local key = ScriptGo.config.get("license_key")
    if type(key) ~= "string" or key == "" then return nil end
    return key
end

-- Runs from a thread: performs one verification and updates the state.
function InvProLicense.check()
    local key = licenseKey()
    if not key then
        setState("invalid", "no_license_key")
        return
    end
    if not ScriptGo.capabilities.has("licensing") then
        setState("invalid", "licensing_unavailable_here")
        return
    end
    local result, code = ScriptGo.licensing.verify({ licenseKey = key, package = PACKAGE })
    InvProLicense.checkedAt = ScriptGo.time.now()
    if result and result.valid then
        InvProLicense.graceUntil = isoToEpoch(result.offlineGraceUntil)
        ScriptGo.storage.set("license:last_valid", {
            status = result.status, offlineGraceUntil = result.offlineGraceUntil, checkedAt = InvProLicense.checkedAt,
        })
        setState("active", nil)
        return
    end
    if result and result.valid == false then
        -- A definitive answer from the API: no grace for a revoked or expired license.
        ScriptGo.storage.delete("license:last_valid")
        setState("invalid", result.reason or result.status or "invalid")
        return
    end
    -- Transport failure or API error: fall back on the cached grace window.
    local cached = ScriptGo.storage.get("license:last_valid")
    local graceUntil = cached and isoToEpoch(cached.offlineGraceUntil)
    if graceUntil and ScriptGo.time.now() < graceUntil then
        InvProLicense.graceUntil = graceUntil
        setState("grace", "api_unreachable:" .. tostring(code))
    else
        setState("invalid", "api_unreachable:" .. tostring(code))
    end
end

CreateThread(function()
    while true do
        InvProLicense.check()
        Wait(RECHECK_MS)
    end
end)
