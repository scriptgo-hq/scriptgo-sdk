-- Capability names, error helpers, and the declared support matrix per environment.
-- The matrix is what each adapter *implements*; whether an environment is *verified* comes from
-- real runs (tools/verify), never from this table.
local R = ...
local M = {}

M.ALL = { "events", "logging", "storage", "players", "permissions", "commands", "config", "ui", "http", "licensing" }

M.DESCRIPTIONS = {
    events = "Local events, network events between sides, lifecycle events.",
    logging = "ScriptGo.log and print routed to the host log.",
    storage = "Per-resource persistent key/value storage (JSON values).",
    players = "Player list, names, join and drop events.",
    permissions = "Host privileges for a player (operators, privs, ACE).",
    commands = "RegisterCommand from the console or chat.",
    config = "Per-resource configuration and GetConvar.",
    ui = "ScriptGo.ui.notify: on-screen notifications or chat fallback.",
    http = "Outbound HTTP requests from the server side.",
    licensing = "License activation and verification against the SCRIPT//GO API.",
}

function M.unavailable(cap, environment)
    return "capability_unavailable:" .. tostring(cap) .. "@" .. tostring(environment)
end

-- support: "supported" | "partial" | "fallback" | "unavailable"
M.ENVIRONMENTS = {
    standalone = {
        name = "Lua Standalone",
        status = "available",
        dialects = { "5.1", "5.4", "luajit" },
        summary = "A command-line host. Runs resources without any engine; the reference environment for tests.",
        sides = { "server", "client" },
        capabilities = {
            events = "supported", logging = "supported", storage = "supported", players = "partial",
            permissions = "supported", commands = "supported", config = "supported", ui = "fallback",
            http = "partial", licensing = "supported",
        },
        notes = {
            players = "Simulated local players (one by default).",
            ui = "Notifications are printed to the console.",
            http = "Uses the system curl executable when present.",
        },
        limitations = { "No rendering: `ui` falls back to console output.", "HTTP needs curl on the PATH." },
    },
    love2d = {
        name = "LÖVE",
        status = "beta",
        dialects = { "luajit" },
        summary = "2D games with LÖVE. Server and local client run in the game process.",
        sides = { "server", "client" },
        capabilities = {
            events = "supported", logging = "supported", storage = "supported", players = "partial",
            permissions = "supported", commands = "supported", config = "supported", ui = "supported",
            http = "partial", licensing = "partial",
        },
        notes = {
            players = "Single local player (id 1), the game's own client side.",
            storage = "JSON files in the game's save directory (scriptgo/storage/<key>.json).",
            permissions = "Privileges per player id from the config table the game passes.",
            config = "Per-resource values and convars from the config table the game passes.",
            ui = "On-screen toasts drawn by sg:draw(); also logged. Without love.graphics (headless) they are only logged.",
            http = "curl through io.popen, run in a love.thread worker so frames keep running; unavailable when io.popen or curl is missing. Status and body only, no response headers.",
            licensing = "Available exactly when http is.",
        },
        limitations = {
            "Single-player only: no real network between server and client.",
            "HTTP needs io.popen and a curl executable (on the PATH, or opts.curl).",
            "Measured with LÖVE 11.5 (LuaJIT 2.1) on Windows, as a folder and as a .love archive, through lovec.exe; macOS, Linux, mobile and fused builds are not measured yet.",
        },
    },
    godot = {
        name = "Godot 4",
        status = "beta",
        dialects = { "5.4", "luajit" },
        summary = "Godot 4 projects through the lua-gdextension bridge. Server and local client run in the game process, ticked from _process.",
        sides = { "server", "client" },
        capabilities = {
            events = "supported", logging = "supported", storage = "supported", players = "partial",
            permissions = "supported", commands = "supported", config = "supported", ui = "supported",
            http = "unavailable", licensing = "unavailable",
        },
        notes = {
            players = "Single local player (id 1) joined by the scene; ScriptGoHost.join adds simulated ones.",
            storage = "JSON files at user://scriptgo/storage/<key>.json, written with FileAccess.",
            permissions = "Privileges per player id from the config passed to ScriptGoHost.boot.",
            config = "Per-resource values and convars from the config passed to ScriptGoHost.boot.",
            ui = "Queued for the scene (ScriptGoHost.notified signal) and logged; the demo draws them as toasts.",
            http = "Not implemented: no outbound HTTP from resources yet.",
            licensing = "Needs http.",
        },
        limitations = {
            "Needs the lua-gdextension addon, 0.7.0 for Godot 4.5 (it declares 4.4 as its minimum; the 0.8.x binaries are built for Godot 4.6 and refuse 4.5.2).",
            "No HTTP, so no online license checks.",
            "Single-player only: no real network between server and client.",
            "Measured with Godot 4.5.2 on Windows x86_64, headless and windowed, with the Lua 5.4 and LuaJIT builds of lua-gdextension 0.7.0; exported builds, macOS, Linux, mobile and Web are not measured yet.",
        },
    },
    luanti = {
        name = "Luanti",
        status = "beta",
        dialects = { "5.1", "luajit" },
        summary = "Luanti (formerly Minetest) servers. Resources run inside one regular, non-trusted mod.",
        sides = { "server" },
        capabilities = {
            events = "partial", logging = "supported", storage = "supported", players = "supported",
            permissions = "supported", commands = "supported", config = "supported", ui = "fallback",
            http = "partial", licensing = "partial",
        },
        notes = {
            events = "Server side only; client scripts do not run (Luanti mods are server-side).",
            players = "Player names get session-stable integer ids; identifier is luanti:<name>.",
            permissions = "server or scriptgo_admin privilege, then the grants in <world>/scriptgo.json.",
            commands = "Resource commands are ordinary chat commands.",
            ui = "Notifications are sent as chat messages.",
            http = "Needs the mod listed in secure.http_mods by the server owner.",
        },
        limitations = {
            "No client side.",
            "HTTP, and so online license checks, only when the server owner allows it.",
            "Verified headless on Luanti 5.18.0 (LuaJIT); paths that need a connected player are not yet covered by a run.",
        },
    },
    open77 = {
        name = "OPEN//77",
        status = "experimental",
        dialects = { "5.4" },
        summary = "OPEN//77 runs the resource format natively. `scriptgo pack --target open77` adds a shim that maps ScriptGo.* onto Open77.*.",
        sides = { "server", "client" },
        capabilities = {
            events = "supported", logging = "supported", storage = "supported", players = "supported",
            permissions = "supported", commands = "supported", config = "supported", ui = "supported",
            http = "partial", licensing = "partial",
        },
        notes = {
            storage = "Open77.kvp on both sides, values stored as JSON text.",
            players = "Server side: GetPlayers, GetPlayerName, Open77.players.identifier.",
            permissions = "Server side: the server ACL (Open77.acl.isAllowed, permission acl.read).",
            config = "Server side: convar <resource>:<key>, then the resource's tunables.",
            ui = "Server: Open77.notifications; client: the open77_notifications package.",
            http = "Server side, through Open77.http.request (permission http.request). Off until the operator sets server.jsonc http.enabled and lists each host in http.allowedHosts; redirects are never followed.",
            licensing = "Server side, over Open77.http.request to the scriptgo_api convar; the operator allows the API host.",
        },
        limitations = {
            "Experimental: pending technical and legal review.",
            "Outbound HTTP, and so licensing, needs the operator's allow-list; no HTTP from the client.",
            "No wall clock on the client: ScriptGo.time.now() is nil there.",
            "Verified on a dedicated server (server half); the client half is not verified yet.",
        },
    },
    openresty = { name = "OpenResty", status = "planned", dialects = { "luajit" }, summary = "Lua HTTP services on Nginx.", sides = { "server" }, capabilities = {}, notes = {}, limitations = {} },
    defold = { name = "Defold", status = "planned", dialects = { "luajit" }, summary = "2D games with Defold.", sides = { "server", "client" }, capabilities = {}, notes = {}, limitations = {} },
    neovim = { name = "Neovim", status = "planned", dialects = { "luajit" }, summary = "Editor plugins on Neovim's Lua runtime.", sides = { "client" }, capabilities = {}, notes = {}, limitations = {} },
}

M.ORDER = { "standalone", "love2d", "godot", "luanti", "open77", "openresty", "defold", "neovim" }

return M
