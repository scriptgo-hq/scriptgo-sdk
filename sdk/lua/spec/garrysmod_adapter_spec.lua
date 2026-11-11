-- The Garry's Mod adapter (sdk/adapters/garrysmod/addon/lua/scriptgo/adapter.lua) against a MOCK of
-- the GLua API: an in-memory file system, fake players, a recording HTTP(). This is a unit test of
-- the mapping only; it proves nothing about Garry's Mod itself. The real runs are
-- `scriptgo verify --env garrysmod` on a dedicated server (TEST_RESULTS.md).
local suite, scriptgo, ctx = ...
local test, expect, describe = suite.test, scriptgo.testing.expect, suite.describe
local compat = scriptgo.compat

local adapterSource = assert(ctx.readFile(ctx.root .. "/sdk/adapters/garrysmod/addon/lua/scriptgo/adapter.lua"))

local function fakePlayer(t)
    local p = { userid = t.userid, nick = t.nick, bot = t.bot or false, group = t.group or "user",
        sid64 = t.sid64 or ("7656119800000000" .. t.userid), sid = t.sid or ("STEAM_0:0:" .. t.userid),
        super = t.super or false, chat = {}, valid = true }
    function p:UserID() return self.userid end
    function p:Nick() return self.nick end
    function p:IsBot() return self.bot end
    function p:SteamID64() return self.bot and "90071996842377216" or self.sid64 end
    function p:SteamID() return self.bot and "BOT" or self.sid end
    function p:IsSuperAdmin() return self.super end
    function p:GetUserGroup() return self.group end
    function p:ChatPrint(s) self.chat[#self.chat + 1] = s end
    return p
end

-- A fresh mock world: files["LUA:path"] / files["DATA:path"], players by UserID.
local function world(opts)
    opts = opts or {}
    local w = { files = {}, players = {}, http = {}, printed = {}, broadcast = {}, convars = opts.convars or {}, clock = 100 }
    local env = setmetatable({}, { __index = _G })
    env._G = env
    env.SysTime = function() return w.clock end
    env.print = function(...) w.printed[#w.printed + 1] = table.concat({ ... }, "\t") end
    env.file = {
        Read = function(path, id) return w.files[id .. ":" .. path] end,
        Write = function(path, text) w.files["DATA:" .. path] = text end,
        CreateDir = function() end,
        Find = function(pattern, id)
            local dir = pattern:gsub("/%*$", "")
            local files, dirs, seenDir = {}, {}, {}
            local prefix = id .. ":" .. dir .. "/"
            for key in pairs(w.files) do
                if key:sub(1, #prefix) == prefix then
                    local rest = key:sub(#prefix + 1)
                    local first, more = rest:match("^([^/]+)(/?)")
                    if more == "/" then
                        if not seenDir[first] then seenDir[first] = true; dirs[#dirs + 1] = first end
                    else
                        files[#files + 1] = first
                    end
                end
            end
            table.sort(files); table.sort(dirs)
            return files, dirs
        end,
    }
    env.Player = function(id)
        local p = w.players[id]
        return p or { valid = false }
    end
    env.IsValid = function(p) return type(p) == "table" and p.valid == true end
    env.player = { GetAll = function()
        local list = {}
        for _, p in pairs(w.players) do list[#list + 1] = p end
        return list
    end }
    env.HUD_PRINTTALK = 3
    env.PrintMessage = function(kind, text) w.broadcast[#w.broadcast + 1] = { kind = kind, text = text } end
    env.GetConVar = function(name)
        local v = w.convars[name]
        if v == nil then return nil end
        return { GetString = function() return v end }
    end
    if opts.http ~= false then
        env.HTTP = function(req)
            w.http[#w.http + 1] = req
            return opts.httpStarts ~= false
        end
    end
    if opts.cami then env.CAMI = opts.cami end
    w.env = env
    w.load = function(adapterOpts)
        local fn = assert(compat.loadWithEnv(adapterSource, "@garrysmod/adapter.lua", env))
        return fn()(scriptgo, adapterOpts)
    end
    return w
end

describe("garrysmod adapter (mock GLua)", function()
    test("declares a server-only host; http and licensing follow HTTP()", function()
        local a = world().load()
        expect(a.environment).toBe("garrysmod")
        expect(a.sides.server).toBe(true)
        expect(a.sides.client).toBeNil()
        expect(a.capabilities.http).toBe(true)
        expect(a.capabilities.licensing).toBe(true)
        local b = world({ http = false }).load()
        expect(b.capabilities.http).toBe(false)
        expect(b.http).toBeNil()
    end)

    test("reads LUA: and DATA: roots and lists files recursively", function()
        local w = world()
        w.files["LUA:scriptgo/resources/res_a/scriptgo.lua"] = "m"
        w.files["LUA:scriptgo/resources/res_a/server/main.lua"] = "s"
        w.files["DATA:scriptgo/resources/res_b/scriptgo.lua"] = "d"
        local a = w.load()
        expect(a.readFile("LUA:scriptgo/resources/res_a/scriptgo.lua")).toBe("m")
        expect(a.readFile("DATA:scriptgo/resources/res_b/scriptgo.lua")).toBe("d")
        expect(a.readFile("LUA:scriptgo/resources/res_a/missing.lua")).toBeNil()
        local list = a.listFiles("LUA:scriptgo/resources/res_a")
        expect(table.concat(list, ",")).toBe("scriptgo.lua,server/main.lua")
    end)

    test("stores one JSON file per resource side under the storage folder", function()
        local w = world()
        local a = w.load({ storageDir = "scriptgo/verify/storage" })
        a.storage.save("sg_probe.client", '{"a":1}')
        expect(w.files["DATA:scriptgo/verify/storage/sg_probe.client.json"]).toBe('{"a":1}')
        expect(a.storage.load("sg_probe.client")).toBe('{"a":1}')
        expect(a.storage.load("never_saved")).toBeNil()
        w.files["DATA:scriptgo/verify/storage/empty.json"] = ""
        expect(a.storage.load("empty")).toBeNil()
    end)

    test("players: UserID ids, steam and bot identifiers kept after they leave", function()
        local w = world()
        w.players[7] = fakePlayer({ userid = 7, nick = "Ada" })
        w.players[3] = fakePlayer({ userid = 3, nick = "sgbot", bot = true })
        local a = w.load()
        expect(table.concat(a.players.list(), ",")).toBe("3,7")
        expect(a.players.name(7)).toBe("Ada")
        expect(a.players.identifier(7)).toBe("steam:76561198000000007")
        expect(a.players.identifier(3)).toBe("bot:3")
        w.players[7] = nil
        expect(a.players.name(7)).toBeNil()
        expect(a.players.identifier(7)).toBe("steam:76561198000000007")
        expect(a.players.name(0)).toBeNil()
        expect(a.players.identifier(-3)).toBeNil()
        expect(a.players.name("7")).toBeNil()
    end)

    test("permissions: superadmin, usergroup, SteamID64 and wildcard grants", function()
        local w = world()
        w.players[1] = fakePlayer({ userid = 1, nick = "root", super = true })
        w.players[2] = fakePlayer({ userid = 2, nick = "mod", group = "moderator" })
        w.players[3] = fakePlayer({ userid = 3, nick = "vip", sid64 = "76561198000000099" })
        local a = w.load({ config = { permissions = {
            moderator = { "command.kick", "shop.*" },
            ["76561198000000099"] = { "vip.lounge" },
        } } })
        expect(a.permissions.has(1, "anything")).toBe(true)
        expect(a.permissions.has(2, "command.kick")).toBe(true)
        expect(a.permissions.has(2, "shop.buy")).toBe(true)
        expect(a.permissions.has(2, "shopping")).toBe(false)
        expect(a.permissions.has(3, "vip.lounge")).toBe(true)
        expect(a.permissions.has(3, "command.kick")).toBe(false)
        expect(a.permissions.has(99, "command.kick")).toBe(false)
    end)

    test("permissions: CAMI answers first and registers scriptgo.<privilege> once", function()
        local registered, asked = {}, {}
        local cami = {
            GetPrivilege = function(name) return registered[name] end,
            RegisterPrivilege = function(p) registered[p.Name] = p end,
            PlayerHasAccess = function(ply, name, callback)
                asked[#asked + 1] = name
                if callback ~= nil then error("expected a synchronous call") end
                if name == "scriptgo.async.only" then error("an admin mod did not give an immediate answer") end
                return ply:GetUserGroup() == "admin" and name == "scriptgo.command.ban"
            end,
        }
        local w = world({ cami = cami })
        w.players[4] = fakePlayer({ userid = 4, nick = "adm", group = "admin" })
        local a = w.load({ config = { permissions = { admin = { "async.only" } } } })
        expect(a.permissions.has(4, "command.ban")).toBe(true)
        expect(registered["scriptgo.command.ban"].MinAccess).toBe("superadmin")
        expect(a.permissions.has(4, "command.ban")).toBe(true)
        expect(a.permissions.has(4, "command.mute")).toBe(false)
        -- An admin mod that only answers asynchronously falls back to config.json.
        expect(a.permissions.has(4, "async.only")).toBe(true)
        local n = 0
        for _ in pairs(registered) do n = n + 1 end
        expect(n).toBe(3)
    end)

    test("config: config.json values, then convars that exist (empty means unset)", function()
        local w = world({ convars = { sv_lan = "1", scriptgo_api = "" } })
        local a = w.load({ config = { resources = { shop = { currency = "eddies" } }, convars = { motd = "hi" } } })
        expect(a.config.get("shop", "currency")).toBe("eddies")
        expect(a.config.get("shop", "missing")).toBeNil()
        expect(a.config.get("other", "currency")).toBeNil()
        expect(a.config.get(nil, "motd")).toBe("hi")
        expect(a.config.get(nil, "sv_lan")).toBe("1")
        expect(a.config.get(nil, "scriptgo_api")).toBeNil()
        expect(a.config.get(nil, "no_such_convar")).toBeNil()
    end)

    test("ui: a chat line to one player, or to everyone for -1", function()
        local w = world()
        w.players[5] = fakePlayer({ userid = 5, nick = "Ada" })
        local a = w.load()
        a.ui.notify(5, { title = "Shop", message = "Bought" })
        a.ui.notify(-1, { resource = "events", message = ("x"):rep(400) })
        a.ui.notify(42, { message = "nobody" })
        expect(w.players[5].chat[1]).toBe("[Shop] Bought")
        expect(w.broadcast[1].kind).toBe(3)
        expect(#w.broadcast[1].text).toBe(240)
        expect(#a.notifications).toBe(3)
    end)

    test("http: content type goes in `type`, answers and failures are mapped", function()
        local w = world()
        local a = w.load()
        local got
        a.http.request({ method = "post", url = "http://127.0.0.1:4100/v1/licenses/verify",
            headers = { ["content-type"] = "application/json", ["x-trace"] = "1" }, body = "{}" }, function(r) got = r end)
        local req = w.http[1]
        expect(req.method).toBe("POST")
        expect(req.type).toBe("application/json")
        expect(req.headers["content-type"]).toBeNil()
        expect(req.headers["x-trace"]).toBe("1")
        req.success(200, '{"valid":true}', { ["Content-Type"] = "application/json" })
        expect(got.status).toBe(200)
        expect(got.body).toBe('{"valid":true}')
        req.failed("late failure after an answer is ignored")
        expect(got.status).toBe(200)

        local failure
        a.http.request({ url = "http://127.0.0.1:9/" }, function(r) failure = r end)
        expect(w.http[2].type).toBeNil()
        expect(w.http[2].method).toBe("GET")
        w.http[2].failed("Couldn't connect to server")
        expect(failure.status).toBe(0)
        expect(failure.error).toBe("Couldn't connect to server")

        local refused
        world({ httpStarts = false }).load().http.request({ url = "http://x/" }, function(r) refused = r end)
        expect(refused.error).toBe("request_failed")
    end)

    test("the core host runs a resource from the mock LUA path through this adapter", function()
        local w = world()
        w.files["LUA:scriptgo/resources/counter/scriptgo.lua"] = 'resource "counter"\nversion "1.0.0"\nscriptgo_version ">=0.1.0"\nserver_script "server.lua"\n'
        w.files["LUA:scriptgo/resources/counter/server.lua"] = table.concat({
            'local n = (ScriptGo.storage.get("n") or 0) + 1',
            'ScriptGo.storage.set("n", n)',
            'exports("count", function() return n, ScriptGo.runtime.environment() end)',
        }, "\n")
        local a = w.load()
        local host = scriptgo.newHost({ adapter = a })
        expect(host:addResource("LUA:scriptgo/resources/counter")).toBeTruthy()
        expect(host:start("counter")).toBe(true)
        local n, env = host:callExportSync("counter", "count")
        expect(n).toBe(1)
        expect(env).toBe("garrysmod")
        expect(w.files["DATA:scriptgo/storage/counter.json"]).toContain('"n":1')
        expect(host:hasCapability("http")).toBe(true)
    end)

    test("player match: presence follows HTTP() and reports only in address mode (no HMAC in GLua)", function()
        expect(world({ http = false }).load().capabilities.presence).toBe(false)
        local cfg = { scriptgo_api = "http://api.test", scriptgo_server_token = "sg_srv_gmod", scriptgo_presence = "on" }
        local function run(extra)
            local convars = {}
            for k, v in pairs(cfg) do convars[k] = v end
            for k, v in pairs(extra or {}) do convars[k] = v end
            local w = world({ convars = convars })
            local ada = fakePlayer({ userid = 7, nick = "Ada" })
            function ada:IPAddress() return "203.0.113.9:27005" end
            w.players[7] = ada
            local a = w.load()
            expect(a.capabilities.presence).toBe(true)
            local host = scriptgo.newHost({ adapter = a })
            host:tick()
            return w, host
        end
        -- Without address mode: no report, the reason says why; /link exists all the same.
        local w, host = run()
        expect(#w.http).toBe(0)
        expect(host:_presenceClient().status().reason).toBe("presence unavailable: no HMAC on this host")
        expect(host:hasCommand("link")).toBe(true)
        -- Address mode: the normalised address goes to the API, with the environment.
        w = run({ scriptgo_presence_addr = "on" })
        expect(#w.http).toBe(1)
        expect(w.http[1].url).toBe("http://api.test/v1/presence")
        local body = scriptgo.json.decode(w.http[1].body)
        expect(body.environment).toBe("garrysmod")
        expect(body.adapterVersion).toBe("garrysmod-0.1.0")
        expect(body.players[1].player).toBe("steam:76561198000000007")
        expect(body.players[1].addr[1]).toBe("203.0.113.9")
        expect(body.players[1].fp).toBeNil()
    end)
end)
