-- Luanti adapter: SCRIPT//GO resources inside one regular (non-trusted) Luanti mod.
--
--   local adapter, api = dofile(modpath .. "/adapter.lua")(scriptgo, opts)
--
-- opts: config (table from <world>/scriptgo.json), http (the table core.request_http_api() returned
-- at load time, or nil), logSink (function(entry) for verify runs).
--
-- Luanti specifics: mods are server-side, so only the server side of a resource runs. Players have
-- names, not numbers: the adapter gives each name a session-stable integer id (1, 2, ...).
-- Notifications go to chat. HTTP exists only when the server owner lists the mod in
-- secure.http_mods; without it, http and licensing are unavailable and say so.
return function(scriptgo, opts)
    opts = opts or {}
    local json = scriptgo.json
    local cfg = opts.config or {}
    local http = opts.http
    local modStorage = core.get_mod_storage()

    local adapter = {
        environment = "luanti",
        adapterVersion = "luanti-0.1.0",
        sides = { server = true },
        capabilities = {
            events = true, logging = true, storage = true, players = true, permissions = true,
            commands = true, config = true, ui = true,
            http = http ~= nil, licensing = http ~= nil,
        },
        notifications = {},
    }

    adapter.now = function() return core.get_us_time() / 1000000 end

    local LEVELS = { debug = "verbose", info = "action", warn = "warning", error = "error" }
    adapter.log = function(level, origin, msg)
        core.log(LEVELS[level] or "action", "[scriptgo] " .. tostring(origin) .. " " .. tostring(msg))
        if opts.logSink then opts.logSink({ level = level, origin = origin, message = msg }) end
    end

    -- Mod security lets a mod read its own folder and read/write the world folder.
    adapter.readFile = function(path)
        local f = io.open(path, "rb")
        if not f then return nil end
        local text = f:read("*a")
        f:close()
        return text
    end

    adapter.listFiles = function(root)
        local out = {}
        local function walk(dir, prefix)
            for _, name in ipairs(core.get_dir_list(dir, false) or {}) do
                out[#out + 1] = prefix .. name
            end
            for _, name in ipairs(core.get_dir_list(dir, true) or {}) do
                if name:sub(1, 1) ~= "." then walk(dir .. "/" .. name, prefix .. name .. "/") end
            end
        end
        walk(root, "")
        table.sort(out)
        return out
    end

    -- Storage: one mod-storage entry per resource side, holding its JSON document.
    adapter.storage = {
        load = function(key)
            local text = modStorage:get_string("res:" .. key)
            if text == "" then return nil end
            return text
        end,
        save = function(key, text) modStorage:set_string("res:" .. key, text) end,
    }

    -- Players: names <-> session-stable integer ids.
    local idByName, nameById, nextId = {}, {}, 1
    local api = {}
    function api.idFor(name)
        local id = idByName[name]
        if not id then
            id = nextId
            nextId = nextId + 1
            idByName[name], nameById[id] = id, name
        end
        return id
    end
    function api.nameOf(id) return nameById[id] end

    local function online(name) return name ~= nil and core.get_player_by_name(name) ~= nil end
    adapter.players = {
        list = function()
            local ids = {}
            for _, player in ipairs(core.get_connected_players()) do
                ids[#ids + 1] = api.idFor(player:get_player_name())
            end
            table.sort(ids)
            return ids
        end,
        name = function(id)
            local name = nameById[id]
            if online(name) then return name end
            return nil
        end,
        identifier = function(id)
            local name = nameById[id]
            if not name then return nil end
            return "luanti:" .. name
        end,
    }

    -- Permissions: the `server` and `scriptgo_admin` privileges grant everything; otherwise the
    -- grants in scriptgo.json, by player name: { "permissions": { "alice": ["command.give", "shop.*"] } }.
    local grants = cfg.permissions or {}
    adapter.permissions = {
        has = function(id, privilege)
            local name = nameById[id]
            if not name then return false end
            local privs = core.get_player_privs(name) or {}
            if privs.server or privs.scriptgo_admin then return true end
            local list = grants[name]
            if type(list) ~= "table" then return false end
            for _, p in ipairs(list) do
                if p == "*" or p == privilege then return true end
                if p:sub(-2) == ".*" and privilege:sub(1, #p - 1) == p:sub(1, -2) then return true end
            end
            return false
        end,
    }

    -- Config: scriptgo.json { "resources": { "<name>": { key: value } }, "convars": { key: value } },
    -- convars falling back to the server's minetest.conf / luanti.conf settings.
    adapter.config = {
        get = function(resourceName, key)
            if resourceName == nil then
                local v = (cfg.convars or {})[key]
                if v ~= nil then return v end
                return core.settings:get(key)
            end
            local r = (cfg.resources or {})[resourceName]
            return r and r[key]
        end,
    }

    -- Notifications as chat lines.
    adapter.ui = {
        notify = function(target, payload)
            adapter.notifications[#adapter.notifications + 1] = { target = target, payload = payload }
            local title = payload.title or payload.resource or "notice"
            local line = core.colorize(payload.type == "error" and "#ff6b6b" or "#ffd23f", "[" .. title .. "] ")
                .. tostring(payload.message or "")
            if target == -1 then
                core.chat_send_all(line)
            else
                local name = nameById[target]
                if online(name) then core.chat_send_player(name, line) end
            end
        end,
    }

    -- HTTP through the engine's asynchronous fetch.
    if http then
        adapter.http = {
            request = function(req, done)
                local headers = {}
                for k, v in pairs(req.headers or {}) do headers[#headers + 1] = k .. ": " .. tostring(v) end
                http.fetch({
                    url = req.url, method = req.method or "GET", data = req.body,
                    extra_headers = headers, timeout = req.timeout or 10,
                }, function(res)
                    if not res.succeeded and (res.code or 0) == 0 then
                        done({ status = 0, body = "", error = res.timeout and "timeout" or "request_failed" })
                    else
                        done({ status = res.code, body = res.data or "", headers = {} })
                    end
                end)
            end,
        }
    end

    api.json = json
    return adapter, api
end
