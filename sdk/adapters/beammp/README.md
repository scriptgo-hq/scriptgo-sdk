# SCRIPT//GO for BeamMP

One BeamMP server plugin, `scriptgo`, runs SCRIPT//GO resources (and portable OPEN//77 resources)
on a BeamMP server (BeamNG.drive multiplayer). Resources keep their format: a `scriptgo.lua`
manifest, shared and server scripts, events, exports, commands, storage.

Status: **planned**. The adapter is written and unit-tested on a mock of BeamMP's Lua API, but it
has not run on a real BeamMP server yet: BeamMP-Server refuses to start without an AuthKey from
https://keymaster.beammp.com, which only the server owner can obtain (ADR-0019).

## Install

```bash
scriptgo pack my_resource --target beammp --out dist          # plugin + resource + dependencies
node sdk/adapters/beammp/build.mjs --with sdk/packages/sg_inventory   # or build the plugin by hand
```

Copy `dist/beammp/Resources` over the server's folder: the plugin is
`Resources/Server/scriptgo/`. BeamMP runs every top-level `.lua` file of a plugin folder in that
plugin's own Lua state; `main.lua` is the only one, the core is in `core/` and the adapter in
`lib/`. Resources live in `resources/<name>/` (more folders with `"resourceDirs"`).

Optional `Resources/Server/scriptgo/scriptgo.json`:

```json
{
  "resources": { "sg_inventory": { "slots": 30 } },
  "convars": { "scriptgo_api": "https://api.scriptgo.dev" },
  "permissions": { "beammp:123456": ["*"], "Ada": ["command.giveitem", "shop.*"] },
  "start": ["sg_inventory"],
  "dataDir": "Resources/Server/scriptgo/data",
  "http": true,
  "httpAllowedHosts": ["api.scriptgo.dev"]
}
```

## How the runtime maps onto BeamMP

Measured against the BeamMP-Server v3.9.3 sources (`src/TLuaEngine.cpp`, `src/LuaAPI.cpp`,
`src/TServer.cpp`, `src/TConsole.cpp`, `src/TPluginMonitor.cpp`).

| SCRIPT//GO | BeamMP |
|---|---|
| Lua | 5.3.5 (vcpkg `lua 5.3.5#6`, sol2 3.3.1), one Lua state per plugin, all standard libraries open |
| Sides | Server only. Client scripts do not run; `TriggerClientEvent` answers `network_unavailable` |
| Tick | `MP.CreateEventTimer("scriptgo_tick", 25)` calling the global `ScriptGo_Tick` (25 ms is the shortest interval BeamMP accepts without a warning). A client can trigger any non-reserved server event by name, so a tick that carries arguments is ignored |
| Clock | `MP.CreateTimer():GetCurrent()`, a 32-bit float of seconds, rebased every 1000 s |
| Players | `MP.GetPlayers`, `MP.GetPlayerName`, `onPlayerJoin`, `onPlayerDisconnect`. BeamMP ids start at 0 and SCRIPT//GO reserves 0 for the console, so BeamMP id `n` is player `n + 1` |
| `players.identifier` | `beammp:<account id>` from `MP.GetPlayerIdentifiers` (the IP is never used); guests get `beammp-guest:<name>` |
| `permissions.has` | Grants in `scriptgo.json`, by identifier, or by name for players who are not guests |
| `RegisterCommand` | Chat lines starting with `/` (the `onChatMessage` handler returns 1, so the line is not broadcast) and the server console (`onConsoleInput`, as the console) |
| `storage` | `<dataDir>/storage/<resource>.json`, written to a `.tmp` file and renamed with `FS.Rename` |
| `config.get` / `GetConvar` | `scriptgo.json` `resources` and `convars` |
| `ui.notify` | `MP.SendNotification(id, "[title] message")` (`-1` = everyone); `MP.SendChatMessage` on servers without it |
| Logging | `Util.LogInfo` / `LogWarn` / `LogError` / `LogDebug` |
| Files | `io.open` for reads and writes, `FS.ListFiles` / `FS.ListDirectories` for listings, `FS.CreateDirectory` |
| `http`, `licensing` | `curl` started in the background (`os.execute` + `start /B` on Windows, `&` elsewhere), writing body, headers and exit code to files under `<dataDir>/http/` that the tick polls: a request never blocks the plugin. BeamMP's own `Http.CreateConnection(host, port):Get(path, headers)` returns nothing (cpp-httplib's response is dropped) and has no POST, so it cannot carry a license check |
| `presence` | Not available. The adapter answers a player's address (`MP.GetPlayerIdentifiers(pid).ip`), but BeamMP's Lua has no HMAC and perks are not switched on. Not run |
| Shutdown, reload | `onShutdown` stops every resource. BeamMP re-runs `main.lua` when it changes (plugin monitor): the old host is stopped and its timer cancelled first |

The server console accepts `scriptgo` (list), `scriptgo start|stop|restart <name>`, and any
resource command.

## Verify

```bash
export BEAMMP_AUTH_KEY=<the owner's key>        # PowerShell: $env:BEAMMP_AUTH_KEY = '<key>'
scriptgo verify sdk/conformance/sg_probe --env beammp --beammp-server <path>/BeamMP-Server.exe
scriptgo verify sdk/conformance/sg_probe_net --env beammp --stub-api --beammp-server <path>/BeamMP-Server.exe
```

`verify --env beammp` builds the plugin with the resource, its dependencies and its README example
into a temporary server folder, writes a `ServerConfig.toml` that binds `127.0.0.1:30814`
(`--beammp-port`), `Private = true` (never listed), `InformationPacket = false`, no guests, and
starts the real BeamMP-Server there. The key reaches the server only through `BEAMMP_AUTH_KEY`;
every other `BEAMMP_*` variable is removed from its environment, because BeamMP lets them override
the file. The plugin's verify mode starts only the resource under test (then the README example),
lets it run (`--beammp-seconds`, 3 by default) and writes the report; the CLI then checks the
listening sockets (`listens_on_loopback_only`) and BeamMP's own Lua error lines
(`no_plugin_errors`), stops the server with the console's `exit` (a kill if that fails) and
deletes the folder, which by then holds the key in the `ServerConfig.toml` BeamMP rewrote.
Without a server binary or without a key the run is `skipped` and no report is written.

Without a key, BeamMP-Server 3.9.3 logs `No AuthKey specified in the "…ServerConfig.toml" file`
and exits with code 1 after ten seconds (measured on 2026-11-09).

## Tests

`packages/cli/test/beammp.test.ts` runs `test/plugin_test.lua` on every interpreter in
`tools/runtimes/bin` (Lua 5.3.5 first, BeamMP's Lua, built strict by `tools/build-lua.ps1`). It
uses `test/mock_beammp.lua`, a **mock** of BeamMP's Lua API written from the server's sources: it
is not BeamMP, and a run on it never produces a verification report. It covers discovery, the
verify report (sg_probe 25/25), the 25 ms tick, the id shift, chat and console commands,
permissions, notifications, atomic storage, hot reload, shutdown, and `ScriptGo.http` plus
licensing through background curl against the schema-checked stub API.
