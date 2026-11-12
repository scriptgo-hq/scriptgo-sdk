-- Capability names, error helpers, and the declared support matrix per environment.
-- The matrix is what each adapter *implements*; whether an environment is *verified* comes from
-- real runs (tools/verify), never from this table.
local R = ...
local M = {}

M.ALL = { "events", "logging", "storage", "players", "permissions", "commands", "config", "ui", "http", "licensing", "perks", "presence" }

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
    perks = "Player perks: what the operator sold to a player from their own store, asked from the SCRIPT//GO API.",
    presence = "Player match: tells SCRIPT//GO which players are connected (opt-in), as keyed fingerprints of their addresses, or on a host with no HMAC in address mode (a second opt-in), and serves the /link command, so a buyer on a shop is tied to their player.",
}

function M.unavailable(cap, environment)
    return "capability_unavailable:" .. tostring(cap) .. "@" .. tostring(environment)
end

-- support: "supported" | "partial" | "fallback" | "unavailable"
-- integration: how the environment runs packages, shown on its page (ADR-0022).
--   type: "cli" | "library" | "addon" | "mod" | "plugin" | "program" | "shim" | "kit"
--   runtime: the host and its Lua, as measured or as built against; summary: one or two sentences.
-- blockedOn: for an adapter that is written but has not passed a real run, what that run waits for,
--   said neutrally. Whether adapter code exists and whether a real run passed are not declared here:
--   tools/gen-environments.mjs reads them from the repository and from verification/reports.
-- protection: what a buyer's server gets there (ADR-0027), as { tier, state, note }.
--   tier "escrow": the host runs compiled code outside the guest VM and can hold a key, so an
--     encrypted release is decrypted in memory. tier "license": licence check and signed releases
--     only; the host is plain script and its operator can read what it loads, so no code-secrecy
--     claim. tier "none": the adapter has no licence check, so a package runs there without one.
--   state "available" | "planned": whether that tier works there today. note: one honest sentence.
--   optIn = true: the tier is a feature the server operator switches on (default off), not something
--     every server of that platform has; the site then says "as an opt-in server feature".
--   The tier follows what the adapter can do (ADR-0037): gen-environments refuses a tier above
--     "none" that is "available" without the licensing capability, and "none" on an adapter that has it.
-- platformRules, platformRulesNote: what the platform's own rights holder says about paid scripts,
--   as information for the operator who runs a script there and answers for it (ADR-0037). It is
--   never a SCRIPT//GO rule and gates nothing: no environment blocks or conditions a sale.
--   "no_restriction" (the default): none known, or the terms allow it. "restricts_paid": the terms
--   restrict or forbid paid scripts. "unsettled": no published rule, or it depends on the script.
--   The note is one factual, neutral sentence with its source.
M.ENVIRONMENTS = {
    standalone = {
        protection = { tier = "license", state = "available", note = "Licence check and signed releases. The host runs plain script, so its operator can read what it loads: no code-secrecy claim." },
        name = "Lua Standalone",
        status = "available",
        dialects = { "5.1", "5.4", "luajit" },
        summary = "Runs scripts on plain Lua, with no engine: the place to test them.",
        sides = { "server", "client" },
        capabilities = {
            events = "supported", logging = "supported", storage = "supported", players = "partial",
            permissions = "supported", commands = "supported", config = "supported", ui = "fallback",
            http = "partial", licensing = "supported", perks = "partial", presence = "partial",
        },
        notes = {
            perks = "Implemented in the core, over curl. The players are the simulated local ones, so the identifier is local:<name>: for tests and tooling, not for real players.",
            presence = "Implemented in the core, over curl. Simulated players with simulated addresses (a run script's `join 2 Bob @203.0.113.7`); the HMAC comes from the system `openssl` executable when it is on the PATH, else presence says it is unavailable and only /link works. Proven by sg_probe_presence on Lua 5.4, 5.1 and LuaJIT against the stub API, with OpenSSL's fingerprints equal to Node's HMAC-SHA256, and against the platform's player match end-to-end run (real API, site and browsers), with fingerprints and, with OpenSSL withheld, in address mode (`scriptgo_presence_addr`, default off; the owner's decision on it is pending): the normalised address is sent and SCRIPT//GO fingerprints it at once. For tests and tooling, not real players.",
            players = "Simulated local players (one by default).",
            ui = "Notifications are printed to the console.",
            http = "Uses the system curl executable when present.",
        },
        limitations = { "No rendering: `ui` falls back to console output.", "HTTP needs curl on the PATH." },
        integration = {
            type = "cli",
            runtime = "PUC Lua 5.4 and 5.1, or LuaJIT 2.1, from the PATH",
            summary = "The `scriptgo` CLI runs resources on a plain Lua interpreter, with no engine. `scriptgo run` ticks the host in simulated or real time and `scriptgo test` runs test scripts; it is the reference host the other environments are compared with.",
        },
    },
    love2d = {
        protection = { tier = "license", state = "available", note = "Licence check and signed releases. The host runs plain script, so its operator can read what it loads: no code-secrecy claim." },
        name = "LÖVE",
        status = "beta",
        dialects = { "luajit" },
        summary = "Scripts in 2D games made with LÖVE.",
        sides = { "server", "client" },
        capabilities = {
            events = "supported", logging = "supported", storage = "supported", players = "partial",
            permissions = "supported", commands = "supported", config = "supported", ui = "supported",
            http = "partial", licensing = "partial", perks = "unavailable", presence = "unavailable",
        },
        notes = {
            perks = "Not switched on: a single local player, with no account to tie a purchase to.",
            presence = "A single local player: nobody to match with a buyer.",
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
        integration = {
            type = "library",
            runtime = "LÖVE 11.5 (LuaJIT 2.1)",
            summary = "A Lua module the game loads, `scriptgo_love.lua`. It runs the core in LÖVE's LuaJIT, ticks it from `love.update` through `sg:update(dt)` and draws notifications with `sg:draw()`. Server and local client share the game process.",
        },
    },
    godot = {
        protection = { tier = "license", state = "planned", note = "Licence check and signed releases, once the adapter has HTTP. The adapter is script-level, so the operator can read what it loads; a native GDExtension loader would be a later upgrade." },
        name = "Godot 4",
        status = "beta",
        dialects = { "5.4", "luajit" },
        summary = "Scripts in Godot 4 games, through a Lua add-on.",
        sides = { "server", "client" },
        capabilities = {
            events = "supported", logging = "supported", storage = "supported", players = "partial",
            permissions = "supported", commands = "supported", config = "supported", ui = "supported",
            http = "unavailable", licensing = "unavailable", perks = "unavailable", presence = "unavailable",
        },
        notes = {
            perks = "Needs http, which this adapter does not have.",
            presence = "Needs http, which this adapter does not have.",
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
        integration = {
            type = "addon",
            runtime = "Godot 4.5.2 with lua-gdextension 0.7.0 (Lua 5.4 or LuaJIT)",
            summary = "An autoload node, `ScriptGoHost`, creates a Lua state through the lua-gdextension addon, runs the core in it and ticks it from `_process`. Server and local client share the game process.",
        },
    },
    luanti = {
        protection = { tier = "license", state = "available", note = "Licence check and signed releases. The host runs plain script, so its operator can read what it loads: no code-secrecy claim." },
        name = "Luanti",
        status = "beta",
        dialects = { "5.1", "luajit" },
        summary = "Scripts on Luanti (formerly Minetest) servers, through one regular mod.",
        sides = { "server" },
        capabilities = {
            events = "partial", logging = "supported", storage = "supported", players = "supported",
            permissions = "supported", commands = "supported", config = "supported", ui = "fallback",
            http = "partial", licensing = "partial", perks = "unavailable", presence = "partial",
        },
        notes = {
            perks = "Not switched on: the core implements perks over http and the player identifier, which this adapter has, but it has not been wired or run here.",
            presence = "With http: /link works, and presence reports only in address mode (`scriptgo_presence_addr`, default off; the owner's decision on it is pending): the normalised address is sent and SCRIPT//GO fingerprints it at once, from core.get_player_ip; Luanti has no HMAC. The identifier is the player name, which is not an account other servers share. Unit-tested through the core; not run on a Luanti server with a connected player.",
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
        integration = {
            type = "mod",
            runtime = "Luanti 5.18.0 server (LuaJIT 2.1)",
            summary = "One regular Luanti mod, `scriptgo`, runs the core in the server's Lua and ticks it from a globalstep. It needs no trusted-mod entry; HTTP needs the server owner to list it in `secure.http_mods`.",
        },
    },
    open77 = {
        protection = { tier = "escrow", state = "available", optIn = true, note = "Code escrow, an opt-in server feature: a protected release is decrypted in memory, with a key released to the licensed server only. Client scripts can ship as encrypted, stripped Lua bytecode (client code escrow, scriptgo publish --client-escrow), compiled into the game only for a session the licensed server admits; web_files stay clear. The operator of the machine can still inspect their own process, and a player can read and decompile what their own game runs; that takes real effort and the copy is traceable." },
        name = "OPEN//77",
        -- A layer on top of an existing game (players need the game); every other entry is an engine
        -- or runtime that hosts Lua itself.
        kind = "mod_platform",
        status = "beta",
        platformRules = "unsettled",
        platformRulesNote = "A script is your own code. CD PROJEKT RED's own rules cover the game's content.",
        dialects = { "5.4" },
        summary = "Scripts on OPEN//77 servers, packed as regular OPEN//77 resources.",
        sides = { "server", "client" },
        capabilities = {
            events = "supported", logging = "supported", storage = "supported", players = "supported",
            permissions = "supported", commands = "supported", config = "supported", ui = "supported",
            http = "partial", licensing = "partial", perks = "partial", presence = "partial",
        },
        notes = {
            perks = "Server side, in the shim: the core's perks module over Open77.http.request (the operator allows the API host) and Open77.players.identifier. The shim is packed per resource, so each resource that uses perks polls on its own; the cache is kept in the resource's kvp.",
            presence = "Server side, in the shim: the /link command works over Open77.http.request. Presence reporting reads Open77.players.endpoint (permission players.identity.sensitive, requested in the packed manifest only for a resource that declares presence) and needs an HMAC-SHA256 native, which OPEN//77 build 2.50.0+op77.208 does not have: until it does, presence reports only in address mode (`scriptgo_presence_addr`, default off; the owner's decision on it is pending): the normalised address is sent and SCRIPT//GO fingerprints it at once; otherwise it says it is unavailable and only /link works. One resource per server should declare it. Ran on an OPEN//77 server (sg_probe_presence): the shim loads, the permission is accepted, status says no HMAC; no game client was connected, so neither /link nor address mode has run with a real player (address mode is unit-tested against stub natives).",
            storage = "Open77.kvp on both sides, values stored as JSON text.",
            players = "Server side: GetPlayers, GetPlayerName, Open77.players.identifier.",
            permissions = "Server side: the server ACL (Open77.acl.isAllowed, permission acl.read).",
            config = "Server side: convar <resource>:<key>, then the resource's tunables.",
            ui = "Server: Open77.notifications; client: the open77_notifications package.",
            http = "Server side, through Open77.http.request (permission http.request). Off until the operator sets server.jsonc http.enabled and lists each host in http.allowedHosts; redirects are never followed.",
            licensing = "Server side, over Open77.http.request to the scriptgo_api convar; the operator allows the API host.",
        },
        limitations = {
            "Outbound HTTP, and so licensing and perks, needs the server operator to allow the SCRIPT//GO API host; the client side has no HTTP.",
            "The client side has no wall clock: ScriptGo.time.now() is nil there.",
            "Real runs cover the server side; the client side has not been run in a verification yet.",
        },
        integration = {
            type = "shim",
            runtime = "OPEN//77's own Lua 5.4 runtime, on its dedicated server and game client",
            summary = "OPEN//77 runs its own Lua runtime with the same resource shape. `scriptgo pack --target open77` adapts a package to it: a generated `open77.lua` manifest, the package's files, and a three-file shim (shared, server, client), loaded first, that maps `ScriptGo.*` onto OPEN//77's `Open77.*` API. The packed manifest asks only for the permissions the package's capabilities need.",
        },
    },
    openresty = { name = "OpenResty", status = "planned", dialects = { "luajit" }, summary = "Lua HTTP services on Nginx.", sides = { "server" }, protection = { tier = "license", state = "planned", note = "Licence check and signed releases. The host runs plain script, so its operator can read what it loads: no code-secrecy claim." }, capabilities = { perks = "unavailable", presence = "unavailable" }, notes = { perks = "No adapter yet.", presence = "No adapter yet." }, limitations = {} },
    defold = { name = "Defold", status = "planned", dialects = { "luajit" }, summary = "2D games with Defold.", sides = { "server", "client" }, protection = { tier = "license", state = "planned", note = "Licence check and signed releases. The host runs plain script, so its operator can read what it loads: no code-secrecy claim." }, capabilities = { perks = "unavailable", presence = "unavailable" }, notes = { perks = "No adapter yet.", presence = "No adapter yet." }, limitations = {} },
    neovim = {
        protection = { tier = "license", state = "available", note = "Licence check and signed releases. The host runs plain script, so its operator can read what it loads: no code-secrecy claim." },
        name = "Neovim",
        status = "beta",
        dialects = { "luajit" },
        summary = "Scripts inside the Neovim editor, as an ordinary plugin.",
        sides = { "server", "client" },
        capabilities = {
            events = "supported", logging = "supported", storage = "supported", players = "partial",
            permissions = "supported", commands = "supported", config = "supported", ui = "supported",
            http = "partial", licensing = "partial", perks = "unavailable", presence = "unavailable",
        },
        notes = {
            perks = "Not applicable: an editor has no players to sell a perk to.",
            presence = "Not applicable: an editor has no players to match.",
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
        integration = {
            type = "plugin",
            runtime = "Neovim 0.12.6 (LuaJIT 2.1)",
            summary = "An ordinary Neovim plugin. `setup()` starts the core in Neovim's LuaJIT, a libuv timer ticks it on the main loop, and `:ScriptGo <command>` runs resource commands. Server and local client run in the editor.",
        },
    },
    cctweaked = {
        protection = { tier = "none", state = "available", note = "No licence check in this adapter, so a package runs there without one. Releases are still signed." },
        -- "Minecraft" only as the secondary part of the name, as the Minecraft Usage Guidelines ask.
        name = "CC: Tweaked (Minecraft)",
        -- A layer on top of a game players must own (Minecraft: Java Edition), like OPEN//77.
        kind = "mod_platform",
        status = "experimental",
        platformRules = "restricts_paid",
        platformRulesNote = "The Minecraft EULA lets you do what you want with your mods \"as long as you don't sell them for money\" (minecraft.net/en-us/eula).",
        dialects = { "5.2" },
        summary = "Scripts on a ComputerCraft computer in a Minecraft: Java Edition world, through the CC: Tweaked mod. Not an official Minecraft product; not approved by or associated with Mojang or Microsoft.",
        sides = { "server", "client" },
        capabilities = {
            events = "supported", logging = "supported", storage = "supported", players = "partial",
            permissions = "supported", commands = "supported", config = "supported", ui = "fallback",
            http = "partial", licensing = "unavailable", perks = "unavailable", presence = "unavailable",
        },
        notes = {
            perks = "Not implemented, for the reason given for licensing.",
            presence = "Not implemented, for the reason given for licensing.",
            events = "Server and client run on the same computer; network events between them are looped back through the value codec.",
            players = "One player: the person at the computer's terminal (id 1). The world's other players are not visible.",
            storage = "JSON files on the computer's own disk (/scriptgo/data/<key>.json), within the server's computer_space_limit (1 MB by default).",
            permissions = "Privileges per player id from /scriptgo/config.json.",
            commands = "Typed at the computer's sg> prompt; they run as the terminal player.",
            config = "Per-resource values from /scriptgo/config.json; convars from config.json, then the computer's settings.",
            ui = "Notifications are lines on the computer's terminal.",
            http = "CC: Tweaked's asynchronous http API. The server owner decides in computercraft-server.toml whether it is on and which hosts answer ([[http.rules]]; private and local addresses are denied by default). Redirects are not followed.",
            licensing = "Not implemented: this adapter was built without a licence check, after the Minecraft Usage Guidelines, which allow a mod only if it \"cannot be used to directly or indirectly verify whether a player owns or has access to out-of-game content, products, or services that affect in-game features and functions\" (minecraft.net/en-us/usage-guidelines).",
        },
        limitations = {
            "Experimental: one real server run so far, the conformance probe (35 of 35 checks). The official kits fail there only because they do not declare cctweaked yet. Each run needs the operator's own acceptance of the Minecraft EULA.",
            "No licence check in this adapter (see the licensing note). What the Minecraft EULA says about paid mods is the platform's own rule, shown as the platform note.",
            "Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft. Not affiliated with the CC: Tweaked developers.",
            "Lua 5.2 (Cobalt VM): no // or bitwise operators (use bit32), no collectgarbage.",
            "Everything runs on one computer: code that runs for about 7 seconds without yielding is stopped by CC: Tweaked (\"Too long without yielding\").",
            "Pinned for runs: Minecraft 1.20.1, Fabric loader 0.20.1, CC: Tweaked 1.121.0. Other versions are not measured.",
            "Fast tests use the cc-core harness (CC: Tweaked's own core and Lua VM without Minecraft); those runs are an emulator and do not count as verification.",
        },
        integration = {
            type = "program",
            runtime = "CC: Tweaked 1.121.0 on a Minecraft 1.20.1 Fabric server (Cobalt, Lua 5.2)",
            summary = "A program on one ComputerCraft computer, which the CC: Tweaked mod adds to a Fabric server. It runs the core in the computer's Lua 5.2 VM, ticked by a CC timer every server tick; the server and client sides both run on that computer.",
        },
    },
    dotnet = {
        protection = { tier = "escrow", state = "available", note = "Code escrow: the kit's compiled loader decrypts in memory with a key released to this server only. The operator of the machine can still inspect their own process; that takes real effort and the copy is traceable." },
        name = ".NET kit",
        status = "experimental",
        dialects = { "5.4" },
        languages = { "lua", "ts", "js" },
        summary = "A library that C# engines and servers embed to run Lua, TypeScript and JavaScript scripts.",
        sides = { "server", "client" },
        capabilities = {
            events = "supported", logging = "supported", storage = "supported", players = "partial",
            permissions = "supported", commands = "supported", config = "supported", ui = "fallback",
            http = "supported", licensing = "supported", perks = "partial", presence = "partial",
        },
        notes = {
            perks = "Lua guests: the kit runs the core's perks module in the guest, over IHostHttp and IHostPlayers.Identifier. JavaScript and TypeScript guests do not have it yet (capability_unavailable).",
            presence = "Lua guests: the kit runs the core's presence module over IHostHttp, IHostPlayers.Identifier and the optional IHostPlayerAddresses, with .NET's HMACSHA256. JavaScript and TypeScript guests do not have it (capability_unavailable). Proven in the kit's tests with a fake API (reports, removal, /link), and by sg_probe_presence through the kit's runner against the stub API, the fingerprint equal to Node's HMAC-SHA256. One Lua resource per host should declare it.",
            players = "The console host simulates players; an integrating engine supplies its own through IHostPlayers.",
            storage = "The integrator's IHostStorage; the console host keeps it in memory, or in JSON files with --data.",
            ui = "The console host writes notifications to its log; an engine implements IHostUi.",
            http = "HttpClient off the host thread; the answer is delivered on the next tick.",
            licensing = "Through the kit's HTTP, against the SCRIPT//GO API (checked against the API schemas by --stub-api).",
        },
        limitations = {
            "TypeScript must be compiled first (scriptgo pack or scriptgo verify do it with esbuild); the kit loads x.ts.js next to x.ts.",
            "The JavaScript memory quota bounds what one entry allocates on the host thread, not the live heap (Jint has no per-engine heap limit).",
            "Server and client run in one process: no real network between them.",
            "C# guests are not available yet (planned).",
            "Measured with .NET 10 on Windows x64 only.",
        },
        integration = {
            type = "kit",
            runtime = ".NET 10, with KeraLua 1.4.9 (Lua 5.4) and Jint 4.17.0",
            summary = "An embedded host kit: `ScriptGo.Host`, a .NET 10 library that a C# engine or server references and ticks from its own loop. It runs Lua 5.4 (KeraLua) and JavaScript or TypeScript (Jint) side by side, one VM per resource side and language. Its console host, `scriptgo-dotnet`, runs the verification.",
        },
    },
    -- Planned mod platforms (docs/research/game-modding-landscape.md). No adapter yet: no
    -- capabilities, no install steps. `platformRules` reports the platform's own terms on paid scripts.
    hytale = {
        protection = { tier = "escrow", state = "planned", note = "Code escrow is planned: a JVM plugin with a native library would hold the key. Until it exists, licence check and signed releases only." },
        -- The plugin is built (sdk/adapters/hytale, ADR-0017) but has not run on a real Hytale server:
        -- the server files need the owner's Hytale account. Planned until a real run passes.
        name = "Hytale", kind = "mod_platform", status = "planned", dialects = { "5.2" }, sides = { "server" },
        summary = "Scripts on Hytale servers, through one server plugin. Players install nothing.",
        platformRules = "no_restriction", platformRulesNote = "The game's terms allow paid mods and plugins.",
        capabilities = {
            events = "partial", logging = "supported", storage = "supported", players = "supported",
            permissions = "supported", commands = "partial", config = "supported", ui = "fallback",
            http = "partial", licensing = "partial", perks = "unavailable", presence = "unavailable",
        },
        notes = {
            perks = "Not switched on: the core implements perks over http and the player identifier, which this adapter has, but it has not been wired or run here.",
            presence = "The adapter has no player address to read, and perks are not switched on.",
            events = "Server side only: Hytale plugins run on the server and players install nothing.",
            logging = "The server log, through the plugin's logger.",
            storage = "JSON files in the plugin's data folder (mods/ScriptGo_ScriptGo/storage/<key>.json).",
            players = "Connect and disconnect events; session ids, names, identifier hytale:<uuid>.",
            permissions = "Hytale permission nodes scriptgo.admin or scriptgo.<privilege>, then the grants in scriptgo.json.",
            commands = "Commands known when the server starts become /commands; any command also runs as /sg <command>.",
            config = "Per-resource values and convars from scriptgo.json in the plugin's data folder.",
            ui = "Notifications are sent as chat messages.",
            http = "java.net.http, off until the operator lists hosts in scriptgo.json http.allowedHosts; redirects are never followed.",
            licensing = "Available exactly when http is.",
        },
        limitations = {
            "Not run on a real Hytale server yet: the bridge passes the conformance probe on a plain JVM only (Cobalt, Lua 5.2).",
            "No client side.",
            "Lua 5.2 in the JVM (Cobalt): no io library and no C modules; os has time, clock, date and difftime.",
            "Commands a resource registers after the server has started are reached through /sg <command>.",
            "HTTP, and so online license checks, only to hosts the operator allows.",
        },
        integration = {
            type = "plugin",
            runtime = "Hytale server (Java, JDK 25) with Cobalt 0.9.9 (Lua 5.2)",
            summary = "A Java server plugin that embeds Cobalt, a Lua 5.2 VM written in Java, and runs the core on its own host thread, never on a world thread. Players install nothing.",
        },
        blockedOn = "Waiting for the Hytale server files, which come with a Hytale account, and for a JDK 25 to build the plugin against them.",
    },
    garrysmod = {
        protection = { tier = "license", state = "available", note = "Licence check and signed releases. The host runs plain script, so its operator can read what it loads: no code-secrecy claim." },
        name = "Garry's Mod", kind = "mod_platform", status = "beta", dialects = { "luajit" }, sides = { "server" },
        summary = "Scripts on Garry's Mod servers (roleplay, sandbox, game modes), through one server addon.",
        platformRules = "no_restriction", platformRulesNote = "The developer allows selling mods you own, outside the Steam Workshop.",
        capabilities = {
            events = "partial", logging = "supported", storage = "supported", players = "supported",
            permissions = "supported", commands = "supported", config = "supported", ui = "fallback",
            http = "supported", licensing = "supported", perks = "unavailable", presence = "partial",
        },
        notes = {
            perks = "Not switched on: the core implements perks over http and the player identifier, which this adapter has, but it has not been wired or run here.",
            presence = "With HTTP(): /link works, and presence reports only in address mode (`scriptgo_presence_addr`, default off; the owner's decision on it is pending): the normalised address is sent and SCRIPT//GO fingerprints it at once, from Player:IPAddress(); GLua has no HMAC (util.SHA256 only). Unit-tested against a mock GLua; not run on a srcds server with a connected player.",
            events = "Server side only; client scripts do not run yet. The scheduler ticks on the Think hook, every server frame.",
            logging = "The server console (and garrysmod/console.log with -condebug).",
            storage = "JSON files under garrysmod/data/scriptgo/storage/.",
            players = "The player's UserID() is its id; identifier steam:<SteamID64>, bot:<id> for bots. Join and drop come from PlayerInitialSpawn and player_disconnect.",
            permissions = "superadmin, then CAMI (privilege scriptgo.<name>, for ULX, SAM and other admin mods), then grants by usergroup, SteamID64 or SteamID in data/scriptgo/config.json.",
            commands = "Chat /name or !name for commands a resource registered; console `scriptgo run <line>`.",
            config = "data/scriptgo/config.json per resource; GetConvar reads its convars, then the server's convars.",
            ui = "Notifications are chat lines (ChatPrint, PrintMessage).",
            http = "The engine's asynchronous HTTP(): any method, status, body and headers. Loopback and private addresses need srcds -allowlocalhttp.",
            licensing = "Over HTTP() to the scriptgo_api convar (default https://api.scriptgo.dev).",
        },
        limitations = {
            "Server side only: client scripts (HUD, Derma) need a game client and are not run yet.",
            "Verified on the Windows dedicated server (public branch, 32-bit LuaJIT 2.0.4 and 64-bit LuaJIT 2.1), headless, with a bot as the player; Linux servers and real Steam players are not measured yet.",
            "An empty server hibernates and stops ticking unless sv_hibernate_think is 1.",
            "CAMI is implemented but not yet run with a real admin mod.",
        },
        integration = {
            type = "addon",
            runtime = "Garry's Mod dedicated server: GLua on LuaJIT 2.0.4 (32-bit) or LuaJIT 2.1 (64-bit)",
            summary = "One server addon, `scriptgo`, carries the core and runs it in the server's GLua, ticked on the `Think` hook. `scriptgo pack --target garrysmod` turns each package into its own addon.",
        },
    },
    rust = {
        protection = { tier = "escrow", state = "available", note = "Code escrow: the compiled bridge next to the plugin has the native loader decrypt in memory, with a key released to this server only. It is off until the operator turns it on in the plugin config. Measured on Windows servers with Oxide and with Carbon, and on a Linux server with Oxide in a container. The operator of the machine can still inspect their own process; that takes real effort and the copy is traceable." },
        name = "Rust (Oxide/Carbon)", kind = "mod_platform", status = "experimental", dialects = { "5.4" }, sides = { "server" },
        summary = "Scripts on Rust servers, through one Oxide or Carbon plugin.",
        platformRules = "no_restriction", platformRulesNote = "The developer allows selling mods you own.",
        capabilities = {
            events = "partial", logging = "supported", storage = "supported", players = "supported",
            permissions = "supported", commands = "supported", config = "supported", ui = "fallback",
            http = "partial", licensing = "supported", perks = "partial", presence = "partial",
        },
        notes = {
            perks = "Implemented in the core, over the plugin's web requests; the player is steam:<steamid64>. The cache is kept in the plugin's data files. Proven in the bridge's .NET test process with fake services; not run on a Rust server yet.",
            presence = "Implemented in the core: the address is the player's connection address (net.connection.ipaddress), the HMAC is .NET's HMACSHA256 in the bridge. Proven in the bridge's .NET test process with fake services; not run on a Rust server with a connected player yet.",
            events = "Server side only: Rust has no client-side plugins. Lua 5.4 runs in KeraLua inside the plugin.",
            storage = "Oxide/Carbon data files: <data>/ScriptGo/storage/<key>.json.",
            players = "BasePlayer. Steam ids get integer ids that stay stable while the plugin is loaded; identifier is steam:<steamid64>.",
            permissions = "Oxide permissions: privilege p is scriptgo.p; scriptgo.admin holds every privilege.",
            commands = "Chat commands (/name) through OnPlayerCommand; the console command scriptgo manages resources.",
            config = "The plugin config (ScriptGo.json): resources.<name> and convars. Rust's own server convars are not exposed.",
            ui = "Notifications are sent as colored chat lines.",
            http = "Oxide/Carbon web requests. Response headers are not available; httpAllowedHosts can limit the hosts.",
            licensing = "Over the plugin's web requests, to the scriptgo_api convar.",
        },
        limitations = {
            "Measured on Windows dedicated servers with Oxide and with Carbon, and on a Linux dedicated server with Oxide in a container, with no player connected: the conformance probe and the escrow chain. What a connected player triggers (chat commands, permissions of real Steam ids) is not measured, nor Carbon on Linux.",
            "No client side.",
            "KeraLua's native Lua 5.4 (lua54.dll or liblua54.so) must be installed in RustDedicated_Data/Plugins/x86_64.",
            "HTTP responses carry no headers.",
        },
        integration = {
            type = "plugin",
            runtime = "Rust dedicated server with Oxide or Carbon; KeraLua (Lua 5.4)",
            summary = "One C# plugin, `ScriptGo.cs`, the same file for Oxide and Carbon. Rust's plugin frameworks no longer run Lua, so the plugin loads a small bridge that runs the core in a KeraLua (Lua 5.4) VM, ticked by a framework timer.",
        },
    },
    -- BeamMP has an adapter (sdk/adapters/beammp, ADR-0019) but no run on a real server yet:
    -- BeamMP-Server refuses to start without the owner's Keymaster AuthKey, so it stays planned.
    beammp = {
        protection = { tier = "license", state = "planned", note = "Licence check and signed releases, once the adapter has passed a run on a real server. The server plugin is plain Lua, so the operator can read what it loads: no code-secrecy claim." },
        name = "BeamMP", kind = "mod_platform", status = "planned", dialects = { "5.3" }, sides = { "server" },
        summary = "Scripts on BeamMP servers (BeamNG.drive multiplayer), through one server plugin.",
        platformRules = "unsettled", platformRulesNote = "Neither BeamNG nor BeamMP publishes a rule on selling mods.",
        capabilities = {
            events = "partial", logging = "supported", storage = "supported", players = "supported",
            permissions = "supported", commands = "supported", config = "supported", ui = "partial",
            http = "partial", licensing = "partial", perks = "unavailable", presence = "partial",
        },
        notes = {
            perks = "Not switched on: the core implements perks over http and the player identifier, which this adapter has, but it has not been wired or run here.",
            presence = "With curl: /link works, and presence reports only in address mode (`scriptgo_presence_addr`, default off; the owner's decision on it is pending): the normalised address is sent and SCRIPT//GO fingerprints it at once, from MP.GetPlayerIdentifiers(pid).ip; BeamMP's Lua has no HMAC. Not run on a BeamMP server with a connected player.",
            events = "Server side only: the plugin runs no client scripts, and TriggerClientEvent answers network_unavailable.",
            storage = "JSON files in the plugin's data/storage folder (scriptgo.json dataDir), replaced atomically.",
            players = "MP.GetPlayers and the join and disconnect events. BeamMP id n is SCRIPT//GO player n + 1 (0 is the console); identifier is beammp:<account id>, beammp-guest:<name> for guests.",
            permissions = "Grants in scriptgo.json, by beammp:<account id>, or by name for players logged in to BeamMP: BeamMP has no server-side roles.",
            commands = "Chat commands (/name ...; the line is not broadcast) and the server console, where they run as the console.",
            config = "scriptgo.json resources and convars.",
            ui = "MP.SendNotification (a toast in the BeamMP client); its display is not verified, as no game client runs here.",
            http = "curl started in the background through os.execute and polled each tick, so a request never blocks the plugin; needs curl on the server's PATH. BeamMP's own Http.CreateConnection has no POST and drops the response.",
            licensing = "Over the same curl path, to the scriptgo_api convar.",
        },
        limitations = {
            "Not verified on a real server yet: BeamMP-Server (3.9.3) refuses to start without an AuthKey from keymaster.beammp.com, which only the server owner can get. Until then the adapter has passed unit tests on a mock of BeamMP's Lua API only.",
            "Server side only: BeamNG.drive client mods are out of scope, and no game client is run.",
            "HTTP, and so online license checks, needs curl on the server's PATH.",
        },
        integration = {
            type = "plugin",
            runtime = "BeamMP-Server 3.9.3 (Lua 5.3)",
            summary = "One BeamMP server plugin, `scriptgo`, runs the core in the plugin's own Lua 5.3 state, ticked by a 25 ms event timer. `scriptgo pack --target beammp` builds it with the package and its dependencies.",
        },
        blockedOn = "Waiting for a server key: BeamMP-Server does not start without an AuthKey from the BeamMP Keymaster, which the server owner requests.",
    },
    roblox = {
        protection = { tier = "license", state = "planned", note = "Licence check and signed releases at most, once an adapter exists. No code-secrecy claim." },
        name = "Roblox", kind = "mod_platform", status = "planned", dialects = { "luau" }, sides = { "server", "client" },
        summary = "A Luau compatibility layer for Roblox experiences.",
        platformRules = "unsettled", platformRulesNote = "Roblox sells creations through its own store.",
        capabilities = { perks = "unavailable", presence = "unavailable" }, notes = { perks = "No adapter yet.", presence = "No adapter yet." }, limitations = {},
    },
    fivem = {
        protection = { tier = "none", state = "available", note = "No licence check in the shim, so a package runs there without one. Releases are still signed." },
        -- ADR-0020. Adapter and `scriptgo pack --target fivem` written and unit-tested against a
        -- stub of the natives; planned until a real FXServer run passes (it needs the owner's
        -- Cfx.re registration key).
        name = "FiveM", kind = "mod_platform", status = "planned", dialects = { "5.4" }, sides = { "server", "client" },
        summary = "Scripts on FiveM servers, packed as regular FiveM resources.",
        platformRules = "restricts_paid", platformRulesNote = "The platform's creator terms keep paid server content on its own marketplace (Rockstar Games Creator Platform License Agreement, 2026-09-10, §3.1(6)).",
        capabilities = {
            events = "supported", logging = "supported", storage = "supported", players = "supported",
            permissions = "supported", commands = "supported", config = "supported", ui = "fallback",
            http = "partial", licensing = "unavailable", perks = "unavailable", presence = "partial",
        },
        notes = {
            perks = "Not switched on: the shim does not carry the core's perks module.",
            presence = "Server side, in a resource that declares presence: `scriptgo pack --target fivem` keeps the shim's player match section, with the core's presence module included word for word. /link works over PerformHttpRequest; presence reports only in address mode (`scriptgo_presence_addr`, default off; the owner's decision on it is pending), from GetPlayerEndpoint, since FiveM's Lua has no HMAC. Unit-tested against stub natives; not run on an FXServer with a connected player.",
            events = "FiveM's own events and exports; TriggerEvent runs its handlers at once instead of on the next tick.",
            logging = "print to the server console (channel script:<resource>) or the client console, with the level in front.",
            storage = "Resource KVP (GetResourceKvpString / SetResourceKvp) on both sides, values stored as JSON text.",
            players = "Server side: GetPlayers, GetPlayerName, and the license: identifier.",
            permissions = "Server side: ACE (IsPlayerAceAllowed), granted with add_ace in server.cfg.",
            commands = "RegisterCommand; restricted commands check the ACE command.<name>.",
            config = "Server side: the convar <resource>:<key> (set in server.cfg).",
            ui = "Chat messages (chat:addMessage, handled by FXServer's chat system resource).",
            http = "Server side, through PerformHttpRequest; redirects are not followed. No host allow-list: the server owner decides what a resource may call.",
            licensing = "Not implemented: the shim has no licence check. It was written without one after Rockstar's Creator Platform License Agreement (2026-09-10, §3.1(6)), which forbids a third-party marketplace that sells or licenses server content.",
        },
        limitations = {
            "Planned: no run on a real FXServer has passed yet. FXServer does not start without a Cfx.re registration key (sv_licenseKey).",
            "No licence check: `scriptgo pack --target fivem` refuses a package that needs one (`licensed true`, or the licensing capability), because the shim could not enforce it.",
            "Only the server half can be verified; the client half needs the game.",
            "`require` finds no resource module on FiveM: list every module as a script.",
            "The client has no `os`: ScriptGo.time.now() is nil there.",
            "RedM: `scriptgo pack --target redm` packs for it with the same shim (game rdr3); not run either.",
        },
        integration = {
            type = "shim",
            runtime = "FXServer and the FiveM client (Lua 5.4)",
            summary = "FiveM already runs this resource shape. `scriptgo pack --target fivem` emits a resource folder with a generated `fxmanifest.lua` and one shared shim file, loaded first, that maps `ScriptGo.*` onto FiveM natives. Threads, events and exports stay FiveM's own.",
        },
        blockedOn = "Waiting for a server key: FXServer does not start without a Cfx.re registration key (sv_licenseKey).",
    },
    redm = {
        protection = { tier = "none", state = "available", note = "It runs the FiveM shim, which has no licence check, so a package runs there without one. Releases are still signed." },
        -- `scriptgo pack --target redm`: the FiveM shim and fxmanifest with game "rdr3" and RedM's
        -- rdr3_warning. Unit-tested only; planned until a real FXServer run passes (a Cfx.re key).
        name = "RedM", kind = "mod_platform", status = "planned", dialects = { "5.4" }, sides = { "server", "client" },
        summary = "Scripts on RedM roleplay servers, the same way as on FiveM.",
        platformRules = "restricts_paid", platformRulesNote = "The platform's creator terms keep paid server content on its own marketplace (Rockstar Games Creator Platform License Agreement, 2026-09-10, §3.1(6)).",
        capabilities = {
            events = "supported", logging = "supported", storage = "supported", players = "supported",
            permissions = "supported", commands = "supported", config = "supported", ui = "fallback",
            http = "partial", licensing = "unavailable", perks = "unavailable", presence = "unavailable",
        },
        notes = {
            perks = "Not switched on: the shim does not carry the core's perks module.",
            presence = "Not on RedM yet: `scriptgo pack --target redm` leaves the shim's player match section out, and refuses a package that requires presence.",
            events = "Cfx.re's own events and exports, as on FiveM; TriggerEvent runs its handlers at once instead of on the next tick.",
            logging = "print to the server console (channel script:<resource>) or the client console, with the level in front.",
            storage = "Resource KVP (GetResourceKvpString / SetResourceKvp) on both sides, values stored as JSON text.",
            players = "Server side: GetPlayers, GetPlayerName, and the license: identifier.",
            permissions = "Server side: ACE (IsPlayerAceAllowed), granted with add_ace in server.cfg.",
            commands = "RegisterCommand; restricted commands check the ACE command.<name>.",
            config = "Server side: the convar <resource>:<key> (set in server.cfg).",
            ui = "Chat messages (chat:addMessage, handled by the server's chat resource).",
            http = "Server side, through PerformHttpRequest; redirects are not followed. No host allow-list: the server owner decides what a resource may call.",
            licensing = "Not implemented: the FiveM shim has no licence check (see FiveM).",
        },
        limitations = {
            "Planned: no run on a real FXServer has passed yet. FXServer does not start without a Cfx.re registration key (sv_licenseKey).",
            "The shim is FiveM's: it calls only CitizenFX natives both games have. Nothing of it has run on RedM.",
            "No licence check: `scriptgo pack --target redm` refuses a package that needs one (`licensed true`, or the licensing capability), because the shim could not enforce it.",
            "Only the server half can be verified; the client half needs the game.",
            "`require` finds no resource module: list every module as a script. The client has no `os`.",
        },
        integration = {
            type = "shim",
            runtime = "FXServer (gamename rdr3) and the RedM client (Lua 5.4)",
            summary = "RedM runs the FiveM resource shape on the same FXServer. `scriptgo pack --target redm` emits a resource folder with a generated `fxmanifest.lua` (`game \"rdr3\"` and the `rdr3_warning` RedM requires) and the FiveM shim, loaded first, which maps `ScriptGo.*` onto CitizenFX natives. Threads, events and exports stay Cfx.re's own.",
        },
        blockedOn = "Waiting for a server key: FXServer does not start without a Cfx.re registration key (sv_licenseKey).",
    },
    kcdmp = {
        protection = { tier = "license", state = "planned", note = "No adapter yet. Licence check and signed releases are planned with it; the host would run plain script, so its operator could read what it loads: no code-secrecy claim." },
        name = "KCD:MP", kind = "mod_platform", status = "planned", dialects = { "5.4" }, sides = { "server", "client" },
        summary = "Game modes and client scripts for KCD:MP medieval roleplay servers (Kingdom Come: Deliverance II).",
        platformRules = "restricts_paid", platformRulesNote = "The game's developer does not allow selling mods.",
        capabilities = { perks = "unavailable", presence = "unavailable" }, notes = { perks = "No adapter yet.", presence = "No adapter yet." }, limitations = {},
    },
    zomboid = {
        protection = { tier = "license", state = "planned", note = "No adapter yet. Licence check and signed releases are planned with it; the host would run plain script, so its operator could read what it loads: no code-secrecy claim." },
        name = "Project Zomboid", kind = "mod_platform", status = "planned", dialects = { "5.1" }, sides = { "server", "client" },
        summary = "Project Zomboid server and client mods, for survival and roleplay servers.",
        platformRules = "restricts_paid", platformRulesNote = "The game's terms do not allow selling mods without approval.",
        capabilities = { perks = "unavailable", presence = "unavailable" }, notes = { perks = "No adapter yet.", presence = "No adapter yet." }, limitations = {},
    },
    dst = {
        protection = { tier = "license", state = "planned", note = "No adapter yet. Licence check and signed releases are planned with it; the host would run plain script, so its operator could read what it loads: no code-secrecy claim." },
        name = "Don't Starve Together", kind = "mod_platform", status = "planned", dialects = { "5.1" }, sides = { "server", "client" },
        summary = "Don't Starve Together server and client mods.",
        platformRules = "restricts_paid", platformRulesNote = "The game's developer does not allow paid or paywalled mods.",
        capabilities = { perks = "unavailable", presence = "unavailable" }, notes = { perks = "No adapter yet.", presence = "No adapter yet." }, limitations = {},
    },
}

M.ORDER = { "standalone", "love2d", "godot", "luanti", "open77", "openresty", "defold", "neovim", "cctweaked", "dotnet",
    "hytale", "garrysmod", "rust", "beammp", "roblox", "fivem", "redm", "kcdmp", "zomboid", "dst" }

return M
