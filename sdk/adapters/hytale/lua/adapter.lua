-- Hytale adapter: SCRIPT//GO resources inside one Java server plugin (sdk/adapters/hytale).
--
--   local adapter, api = adapterFactory(scriptgo, native, opts)
--
-- `native` is the table the Java side (scriptgo.jvm.ScriptGoHost) builds; it is never visible to
-- resources, whose sandbox the core builds from scratch. opts: config (the decoded scriptgo.json),
-- logSink (function(entry), verify runs).
--
-- Hytale specifics: plugins run on the server only, so only the server side of a resource runs.
-- Players are UUIDs; the Java side gives each one a session-stable integer id (1, 2, ...).
-- Notifications are chat messages. HTTP exists only for the hosts the operator lists in
-- scriptgo.json `http.allowedHosts`; without any, http and licensing are unavailable and say so.
return function(scriptgo, native, opts)
    opts = opts or {}
    local cfg = opts.config or {}

    local httpCfg = type(cfg.http) == "table" and cfg.http or {}
    local allowedHosts = {}
    for _, h in ipairs(type(httpCfg.allowedHosts) == "table" and httpCfg.allowedHosts or {}) do
        allowedHosts[tostring(h):lower()] = true
    end
    local httpOn = next(allowedHosts) ~= nil

    local adapter = {
        environment = "hytale",
        adapterVersion = native.adapterVersion(),
        sides = { server = true },
        capabilities = {
            events = true, logging = true, storage = true, players = true, permissions = true,
            commands = true, config = true, ui = true,
            http = httpOn, licensing = httpOn,
        },
        -- A resume that runs longer than this raises instead of stalling the plugin's host thread.
        budgetMs = tonumber(cfg.budgetMs) or 1000,
        notifications = {},
    }

    adapter.now = native.now

    adapter.log = function(level, origin, msg)
        native.log(level, tostring(origin), tostring(msg))
        if opts.logSink then opts.logSink({ level = level, origin = origin, message = msg }) end
    end

    -- Reads are limited by the Java side to the resource folders and the plugin's data folder.
    adapter.readFile = native.readFile
    adapter.listFiles = native.listFiles

    -- One JSON file per resource under <data>/storage/.
    adapter.storage = { load = native.storageLoad, save = native.storageSave }

    adapter.players = {
        list = native.playerList,
        name = native.playerName,
        identifier = function(id)
            local uuid = native.playerUuid(id)
            if not uuid then return nil end
            return "hytale:" .. uuid
        end,
    }

    -- Permissions: the Hytale permission nodes `scriptgo.admin` (everything) and
    -- `scriptgo.<privilege>` first (operators hold every node), then the grants in scriptgo.json,
    -- by player name or UUID: { "permissions": { "alice": ["command.give", "shop.*"] } }.
    local grants = type(cfg.permissions) == "table" and cfg.permissions or {}
    local function granted(list, privilege)
        if type(list) ~= "table" then return false end
        for _, p in ipairs(list) do
            p = tostring(p)
            if p == "*" or p == privilege then return true end
            if p:sub(-2) == ".*" and privilege:sub(1, #p - 1) == p:sub(1, -2) then return true end
        end
        return false
    end
    adapter.permissions = {
        has = function(id, privilege)
            if native.hasPermission(id, privilege) then return true end
            local name, uuid = native.playerName(id), native.playerUuid(id)
            return granted(name and grants[name], privilege) or granted(uuid and grants[uuid], privilege)
        end,
    }

    -- Config: scriptgo.json { "resources": { "<name>": { key: value } }, "convars": { key: value } }.
    adapter.config = {
        get = function(resourceName, key)
            if resourceName == nil then return (type(cfg.convars) == "table" and cfg.convars or {})[key] end
            local r = (type(cfg.resources) == "table" and cfg.resources or {})[resourceName]
            return type(r) == "table" and r[key] or nil
        end,
    }

    -- Notifications as chat lines, to one player or to everyone (-1).
    adapter.ui = {
        notify = function(target, payload)
            adapter.notifications[#adapter.notifications + 1] = { target = target, payload = payload }
            local title = payload.title or payload.resource or "notice"
            native.notify(target, tostring(title), tostring(payload.message or ""), tostring(payload.type or "info"))
        end,
    }

    -- HTTP through java.net.http, asynchronous: the answer is handed back on the host thread at the
    -- next tick. Only the operator's hosts; redirects are never followed.
    if httpOn then
        adapter.http = {
            request = function(req, done)
                local url = tostring(req.url or "")
                local host = url:match("^[hH][tT][tT][pP][sS]?://([^/:%?#@]+)")
                if not host or not allowedHosts[host:lower()] then
                    done({ status = 0, body = "", error = "host_not_allowed" })
                    return
                end
                local headers = {}
                for k, v in pairs(req.headers or {}) do headers[tostring(k)] = tostring(v) end
                native.httpRequest(req.method or "GET", url, headers, req.body,
                    tonumber(req.timeout) or tonumber(httpCfg.timeoutSeconds) or 10, done)
            end,
        }
    end

    return adapter
end
