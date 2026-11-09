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
        -- A layer on top of an existing game (players need the game); every other entry is an engine
        -- or runtime that hosts Lua itself.
        kind = "mod_platform",
        status = "experimental",
        sales = "review",
        salesNote = "Paid packages are reviewed first: the game's rights holder restricts commercial use of its IP.",
        dialects = { "5.4" },
        summary = "Packages run on OPEN//77 servers and clients through a small shim that maps ScriptGo.* onto Open77.* (`scriptgo pack --target open77`).",
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
    neovim = {
        name = "Neovim",
        status = "beta",
        dialects = { "luajit" },
        summary = "Neovim plugins. Server and local client run inside the editor, ticked by a libuv timer on the main loop.",
        sides = { "server", "client" },
        capabilities = {
            events = "supported", logging = "supported", storage = "supported", players = "partial",
            permissions = "supported", commands = "supported", config = "supported", ui = "supported",
            http = "partial", licensing = "partial",
        },
        notes = {
            players = "Single local player (id 1), the person at the keyboard.",
            storage = "JSON files under stdpath(\"data\")/scriptgo/storage/<key>.json.",
            permissions = "Privileges per player id from the config passed to setup().",
            config = "Per-resource values and convars from the config passed to setup().",
            commands = "Resource commands are typed as :ScriptGo <command> and run as the local player.",
            ui = "Notifications go to vim.notify; a headless run only logs them.",
            http = "curl through vim.system (Neovim 0.10 or later), asynchronous so the editor never waits; unavailable without curl. Status and body only, no response headers.",
            licensing = "Available exactly when http is.",
        },
        limitations = {
            "Single user: no real network between server and client.",
            "HTTP, and so online license checks, needs curl and Neovim 0.10 or later.",
            "Measured with Neovim 0.12.6 (LuaJIT 2.1) on Windows, headless (nvim --headless --clean -l); macOS, Linux and older Neovim releases are not measured yet.",
        },
    },
    cctweaked = {
        -- "Minecraft" only as the secondary part of the name, as the Minecraft Usage Guidelines ask.
        name = "CC: Tweaked (Minecraft)",
        -- A layer on top of a game players must own (Minecraft: Java Edition), like OPEN//77.
        kind = "mod_platform",
        status = "experimental",
        sales = "free_only",
        salesNote = "Free packages only: the Minecraft EULA lets you do what you want with your mods \"as long as you don't sell them for money\" (minecraft.net/en-us/eula).",
        dialects = { "5.2" },
        summary = "Packages run on a ComputerCraft computer in a Minecraft: Java Edition world, through the CC: Tweaked mod. Not an official Minecraft product; not approved by or associated with Mojang or Microsoft.",
        sides = { "server", "client" },
        capabilities = {
            events = "supported", logging = "supported", storage = "supported", players = "partial",
            permissions = "supported", commands = "supported", config = "supported", ui = "fallback",
            http = "partial", licensing = "unavailable",
        },
        notes = {
            events = "Server and client run on the same computer; network events between them are looped back through the value codec.",
            players = "One player: the person at the computer's terminal (id 1). The world's other players are not visible.",
            storage = "JSON files on the computer's own disk (/scriptgo/data/<key>.json), within the server's computer_space_limit (1 MB by default).",
            permissions = "Privileges per player id from /scriptgo/config.json.",
            commands = "Typed at the computer's sg> prompt; they run as the terminal player.",
            config = "Per-resource values from /scriptgo/config.json; convars from config.json, then the computer's settings.",
            ui = "Notifications are lines on the computer's terminal.",
            http = "CC: Tweaked's asynchronous http API. The server owner decides in computercraft-server.toml whether it is on and which hosts answer ([[http.rules]]; private and local addresses are denied by default). Redirects are not followed.",
            licensing = "Not offered: the Minecraft Usage Guidelines allow a mod only if it \"cannot be used to directly or indirectly verify whether a player owns or has access to out-of-game content, products, or services that affect in-game features and functions\" (minecraft.net/en-us/usage-guidelines).",
        },
        limitations = {
            "Experimental and not verified in Minecraft yet: a run needs the operator's own acceptance of the Minecraft EULA first.",
            "Free packages only, and no licence checks (see the sales rule and the licensing note).",
            "Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft. Not affiliated with the CC: Tweaked developers.",
            "Lua 5.2 (Cobalt VM): no // or bitwise operators (use bit32), no collectgarbage.",
            "Everything runs on one computer: code that runs for about 7 seconds without yielding is stopped by CC: Tweaked (\"Too long without yielding\").",
            "Pinned for runs: Minecraft 1.20.1, Fabric loader 0.20.1, CC: Tweaked 1.121.0. Other versions are not measured.",
            "Fast tests use the cc-core harness (CC: Tweaked's own core and Lua VM without Minecraft); those runs are an emulator and do not count as verification.",
        },
    },
    -- Planned mod platforms (docs/research/game-modding-landscape.md). No adapter yet: no
    -- capabilities, no install steps. `sales` says whether paid packages are possible there.
    hytale = {
        name = "Hytale", kind = "mod_platform", status = "planned", dialects = {}, sides = { "server" },
        summary = "A server plugin that runs SCRIPT//GO packages on Hytale servers; players install nothing.",
        sales = "allowed", salesNote = "The game's terms allow paid mods and plugins.",
        capabilities = {}, notes = {}, limitations = {},
    },
    garrysmod = {
        name = "Garry's Mod", kind = "mod_platform", status = "planned", dialects = { "luajit" }, sides = { "server", "client" },
        summary = "Packages on Garry's Mod servers and clients (roleplay, sandbox, game modes), through its Lua.",
        sales = "allowed", salesNote = "The developer allows selling mods you own, outside the Steam Workshop.",
        capabilities = {}, notes = {}, limitations = {},
    },
    rust = {
        name = "Rust (Oxide/Carbon)", kind = "mod_platform", status = "planned", dialects = { "5.4" }, sides = { "server" },
        summary = "An Oxide/Carbon plugin that runs SCRIPT//GO packages on Rust servers through an embedded Lua VM.",
        sales = "allowed", salesNote = "The developer allows selling mods you own.",
        capabilities = {}, notes = {}, limitations = {},
    },
    beammp = {
        name = "BeamMP", kind = "mod_platform", status = "planned", dialects = { "5.3", "luajit" }, sides = { "server", "client" },
        summary = "BeamMP server plugins and BeamNG.drive client mods, for driving and roleplay servers.",
        sales = "review", salesNote = "No published rule on selling mods: free packages only until the rights holder confirms in writing.",
        capabilities = {}, notes = {}, limitations = {},
    },
    roblox = {
        name = "Roblox", kind = "mod_platform", status = "planned", dialects = { "luau" }, sides = { "server", "client" },
        summary = "A Luau compatibility layer for Roblox experiences.",
        sales = "review", salesNote = "Roblox sells creations through its own store: free packages only until a legal review.",
        capabilities = {}, notes = {}, limitations = {},
    },
    fivem = {
        name = "FiveM", kind = "mod_platform", status = "planned", dialects = { "5.4" }, sides = { "server", "client" },
        summary = "A shim that runs SCRIPT//GO packages on FiveM servers, with the same threads, events and exports model.",
        sales = "free_only", salesNote = "The platform's creator terms keep paid content on its own marketplace: free packages only.",
        capabilities = {}, notes = {}, limitations = {},
    },
    redm = {
        name = "RedM", kind = "mod_platform", status = "planned", dialects = { "5.4" }, sides = { "server", "client" },
        summary = "The same shim on RedM roleplay servers.",
        sales = "free_only", salesNote = "The platform's creator terms keep paid content on its own marketplace: free packages only.",
        capabilities = {}, notes = {}, limitations = {},
    },
    kcdmp = {
        name = "KCD:MP", kind = "mod_platform", status = "planned", dialects = { "5.4" }, sides = { "server", "client" },
        summary = "Game modes and client scripts for KCD:MP medieval roleplay servers (Kingdom Come: Deliverance II).",
        sales = "free_only", salesNote = "The game's developer does not allow selling mods: free packages only.",
        capabilities = {}, notes = {}, limitations = {},
    },
    zomboid = {
        name = "Project Zomboid", kind = "mod_platform", status = "planned", dialects = { "5.1" }, sides = { "server", "client" },
        summary = "Project Zomboid server and client mods, for survival and roleplay servers.",
        sales = "free_only", salesNote = "The game's terms do not allow selling mods without approval: free packages only.",
        capabilities = {}, notes = {}, limitations = {},
    },
    dst = {
        name = "Don't Starve Together", kind = "mod_platform", status = "planned", dialects = { "5.1" }, sides = { "server", "client" },
        summary = "Don't Starve Together server and client mods.",
        sales = "free_only", salesNote = "The game's developer does not allow paid or paywalled mods: free packages only.",
        capabilities = {}, notes = {}, limitations = {},
    },
}

M.ORDER = { "standalone", "love2d", "godot", "luanti", "open77", "openresty", "defold", "neovim", "cctweaked",
    "hytale", "garrysmod", "rust", "beammp", "roblox", "fivem", "redm", "kcdmp", "zomboid", "dst" }

return M
