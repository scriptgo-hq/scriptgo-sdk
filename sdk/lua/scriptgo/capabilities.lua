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
            players = "Single local player.",
            http = "Uses curl through io.popen when LÖVE is not fused; LÖVE 12 lua-https support is planned.",
        },
        limitations = { "Single-player only: no real network between server and client." },
    },
    godot = {
        name = "Godot 4",
        status = "beta",
        dialects = { "5.4", "luajit" },
        summary = "Godot 4 projects through the lua-gdextension bridge.",
        sides = { "server", "client" },
        capabilities = {
            events = "supported", logging = "supported", storage = "supported", players = "partial",
            permissions = "supported", commands = "supported", config = "supported", ui = "supported",
            http = "unavailable", licensing = "unavailable",
        },
        notes = { players = "Single local player.", http = "Planned through HTTPRequest." },
        limitations = { "Requires the lua-gdextension addon.", "No HTTP yet, so no online license checks." },
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
            ui = "Notifications are sent as chat messages.",
            http = "Needs the mod listed in secure.http_mods by the server owner.",
        },
        limitations = { "No client side.", "HTTP only when the server owner allows it." },
    },
    open77 = {
        name = "OPEN//77",
        status = "experimental",
        dialects = { "5.4" },
        summary = "OPEN//77 runs the resource format natively. A shim maps ScriptGo.* onto Open77.*.",
        sides = { "server", "client" },
        capabilities = {
            events = "supported", logging = "supported", storage = "supported", players = "supported",
            permissions = "partial", commands = "supported", config = "partial", ui = "supported",
            http = "unavailable", licensing = "unavailable",
        },
        notes = {
            storage = "Server: Open77.io JSON files under data/; client: Open77.kvp.",
            permissions = "Operator list from the resource config.",
        },
        limitations = { "Experimental: pending technical and legal review.", "No outbound HTTP from resources." },
    },
    openresty = { name = "OpenResty", status = "planned", dialects = { "luajit" }, summary = "Lua HTTP services on Nginx.", sides = { "server" }, capabilities = {}, notes = {}, limitations = {} },
    defold = { name = "Defold", status = "planned", dialects = { "luajit" }, summary = "2D games with Defold.", sides = { "server", "client" }, capabilities = {}, notes = {}, limitations = {} },
    neovim = { name = "Neovim", status = "planned", dialects = { "luajit" }, summary = "Editor plugins on Neovim's Lua runtime.", sides = { "client" }, capabilities = {}, notes = {}, limitations = {} },
}

M.ORDER = { "standalone", "love2d", "godot", "luanti", "open77", "openresty", "defold", "neovim" }

return M
