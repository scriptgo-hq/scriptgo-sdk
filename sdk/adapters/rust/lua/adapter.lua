-- Rust (Oxide/Carbon) adapter: maps the SCRIPT//GO host interface onto the functions the C# bridge
-- (sdk/adapters/rust/bridge) registers in the table `H`. The bridge implements them with the
-- plugin's services: Oxide/Carbon timers, data files, BasePlayer, permissions, plugin config, web
-- requests and chat. See sdk/adapters/rust/README.md.
--
--   local adapter = makeAdapter(scriptgo, H, opts)
--
-- opts: caps (which optional services the plugin provides), adapterVersion, budgetMs, logSink.
--
-- Every H function returns values and never raises: an error thrown across the C# boundary would
-- unwind native frames. Failures come back as nil/false plus a reason.
return function(scriptgo, H, opts)
    opts = opts or {}
    local json = scriptgo.json
    local caps = opts.caps or {}
    local unpack = scriptgo.compat.unpack

    local adapter = {
        environment = "rust",
        adapterVersion = opts.adapterVersion or "rust-0.1.0",
        -- Rust plugins run on the dedicated server only: there is no client-side plugin API.
        sides = { server = true },
        capabilities = {
            events = true, logging = true, commands = true,
            storage = caps.storage == true, players = caps.players == true,
            permissions = caps.permissions == true, config = caps.config == true,
            ui = caps.ui == true, http = caps.http == true, licensing = caps.http == true,
            -- Player perks: the core's module, over the plugin's web requests and the Steam identifier.
            perks = caps.http == true and caps.players == true,
            -- Player match: the core's presence module and the link command, over the same; the
            -- fingerprints use the bridge's HMACSHA256 and the player's connection address.
            presence = caps.http == true and caps.players == true,
        },
        budgetMs = opts.budgetMs,
    }

    -- Seconds, monotonic (a Stopwatch in the bridge).
    adapter.now = function() return H.now() end

    adapter.log = function(level, origin, msg)
        H.log(tostring(level), tostring(origin), tostring(msg))
        if opts.logSink then opts.logSink({ level = level, origin = origin, message = msg }) end
    end

    -- Reads are confined by the bridge to the configured resource folders.
    adapter.readFile = function(path) return H.readFile(path) end
    adapter.listFiles = function(root) return { H.listFiles(root) } end

    if caps.storage then
        adapter.storage = {
            load = function(key) return H.storageLoad(key) end,
            save = function(key, text) H.storageSave(key, text) end,
        }
    end

    local function validId(id) return type(id) == "number" and id >= 1 and id == math.floor(id) end

    if caps.players then
        adapter.players = {
            list = function()
                local ids = { H.players() }
                table.sort(ids)
                return ids
            end,
            name = function(id)
                if not validId(id) then return nil end
                return H.playerName(id)
            end,
            identifier = function(id)
                if not validId(id) then return nil end
                return H.playerIdentifier(id)
            end,
        }
        -- The address a player connects from, for player match only: the core hashes it and never
        -- sends or logs it, and scripts never see it. nil when the plugin cannot tell.
        if caps.playerAddress then
            adapter.players.address = function(id)
                if not validId(id) then return nil end
                return H.playerAddress(id)
            end
        end
    end

    -- HMAC-SHA256 from .NET (System.Security.Cryptography.HMACSHA256), for player match.
    adapter.crypto = {
        hmacSha256 = function(key, message)
            if type(key) ~= "string" or type(message) ~= "string" then return nil end
            return H.hmacSha256(key, message)
        end,
    }

    if caps.permissions then
        adapter.permissions = {
            has = function(id, privilege)
                if not validId(id) or type(privilege) ~= "string" then return false end
                return H.permission(id, privilege) == true
            end,
        }
    end

    -- Config values cross the boundary as JSON text (the plugin config is a JSON file).
    if caps.config then
        adapter.config = {
            get = function(resourceName, key)
                local text = H.config(resourceName, tostring(key))
                if type(text) ~= "string" then return nil end
                local ok, value = pcall(json.decode, text)
                if ok then return value end
                return nil
            end,
        }
    end

    if caps.ui then
        adapter.notifications = {}
        adapter.ui = {
            notify = function(target, n)
                adapter.notifications[#adapter.notifications + 1] = { target = target, payload = n }
                if #adapter.notifications > 200 then table.remove(adapter.notifications, 1) end
                H.notify(tonumber(target) or -1, tostring(n.type or "info"), tostring(n.title or n.resource or "notice"),
                    tostring(n.message or ""), tonumber(n.durationMs) or 0, tostring(n.resource or ""))
            end,
        }
    end

    -- HTTP: the bridge runs the request through the plugin's web requests and hands the answer back on
    -- a later tick (adapter.httpDone), always on the server's main thread.
    if caps.http then
        local pending, nextId = {}, 0
        adapter.http = {
            request = function(req, done)
                nextId = nextId + 1
                local id = nextId
                local flat = {}
                for k, v in pairs(req.headers or {}) do
                    flat[#flat + 1] = tostring(k)
                    flat[#flat + 1] = tostring(v)
                end
                pending[id] = done
                local ok, why = H.httpRequest(id, tostring(req.method or "GET"), tostring(req.url or ""), req.body, unpack(flat))
                if not ok then
                    pending[id] = nil
                    done({ status = 0, body = "", headers = {}, error = tostring(why or "request_failed") })
                end
            end,
        }
        adapter.httpDone = function(id, status, body, err, ...)
            local done = pending[id]
            pending[id] = nil
            if not done then return end
            local headers = {}
            local n = select("#", ...)
            for i = 1, n - 1, 2 do
                local k, v = select(i, ...)
                headers[tostring(k):lower()] = v
            end
            if err ~= nil or (tonumber(status) or 0) == 0 then
                done({ status = 0, body = "", headers = {}, error = tostring(err or "request_failed") })
            else
                done({ status = tonumber(status), body = body or "", headers = headers })
            end
        end
    end

    return adapter
end
