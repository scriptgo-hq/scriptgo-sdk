# SCRIPT//GO for Garry's Mod

One server addon, `scriptgo`, runs SCRIPT//GO resources (and portable OPEN//77 resources) on a
Garry's Mod dedicated server, in GLua. Resources keep their format: a `scriptgo.lua` manifest,
shared and server scripts, `CreateThread`/`Wait`, events, exports, commands, storage, licensing.

Only the server side runs. Client scripts (HUD, Derma, client events) need a game client, which
no verify run drives yet: a resource's `client_script` files are packed but not executed.

## Install

```bash
node sdk/adapters/garrysmod/build.mjs                    # -> dist/garrysmod/scriptgo/
node sdk/adapters/garrysmod/build.mjs --with sdk/packages/sg_inventory --with sdk/packages/sg_eventbus
```

Copy `dist/garrysmod/scriptgo/` into the server's `garrysmod/addons/`. It is a plain addon
(`lua/autorun/server/scriptgo.lua` loads it), not a Workshop item.

Resources go in one of three places:

- each resource as its own addon, made by `scriptgo pack <dir> --target garrysmod`:
  `scriptgo_<name>/lua/scriptgo/resources/<name>/`, copied into `garrysmod/addons/`;
- bundled into the runtime addon with `--with`;
- `garrysmod/data/scriptgo/resources/<name>/`, for a server owner's own resources.

Every resource with `auto_start true` (the default) starts when the map has loaded
(`InitPostEntity`), dependencies first.

Optional `garrysmod/data/scriptgo/config.json`:

```json
{
  "resources": { "sg_inventory": { "slots": 30 } },
  "convars": { "scriptgo_api": "https://api.scriptgo.dev" },
  "permissions": { "admin": ["command.giveitem"], "76561198000000000": ["shop.*"] },
  "start": ["sg_inventory"]
}
```

`permissions` keys are usergroups, SteamID64s or SteamIDs; `*` and `prefix.*` work. `start`,
when present, replaces auto-start with an explicit list. The `scriptgo_api` convar (or
`server.cfg`) points licensing at the SCRIPT//GO API.

## How the runtime maps onto Garry's Mod

| SCRIPT//GO | Garry's Mod |
|---|---|
| Lua | GLua: LuaJIT with Lua 5.1 semantics (2.0.4 in the 32-bit `srcds.exe`, 2.1 in `srcds_win64.exe`). GLua has no `loadstring`, `load` or `dofile`: the core is compiled with `CompileString` and `setfenv` |
| Sides | Server only, for now |
| Tick | The `Think` hook, every server frame. An empty server hibernates and stops thinking unless `sv_hibernate_think 1` |
| Clock | `SysTime()` |
| Files | `file.Read` / `file.Find` on the `LUA` path (every addon's `lua/`, merged) or `DATA` |
| Players | `UserID()` is the id; `players.identifier(id)` is `steam:<SteamID64>`, or `bot:<id>` for bots |
| `playerJoining` / `playerDropped` | `PlayerInitialSpawn` / the `player_disconnect` game event (with its reason) |
| `RegisterCommand` | Chat `/name` or `!name`, for names a resource registered (other chat lines go on untouched); console `scriptgo run <line>` |
| `permissions.has` | superadmin; then CAMI (privilege `scriptgo.<name>`, registered for superadmin, so ULX, SAM or another admin mod can grant it); then `config.json` grants |
| `storage` | One JSON file per resource side in `data/scriptgo/storage/` |
| `config.get` / `GetConvar` | `config.json`, then the server's convars |
| `ui.notify` | A chat line to the player (`ChatPrint`), or to everyone for `-1` (`PrintMessage`) |
| `http`, `licensing` | The engine's asynchronous `HTTP()`: any method, status, body, headers. Loopback and private addresses need `-allowlocalhttp` on the srcds command line |
| Log | The server console; `-condebug` also writes `garrysmod/console.log`. `scriptgo_debug 1` shows debug lines |

Console: `scriptgo` lists the resources and their state; `scriptgo start|stop|restart <name>`
needs the server console, a superadmin, or the CAMI privilege `scriptgo.admin`. Other addons reach
the host through the global `SCRIPTGO` (`SCRIPTGO.host:callExport(...)`).

## Verify

```bash
scriptgo verify <resourceDir> --env garrysmod --gmod-server <dir>   # or SCRIPTGO_GMOD_SERVER
```

installs the runtime addon and an addon with the resource, its dependencies and its README example
into a dedicated server folder, writes `data/scriptgo/verify.json`, and starts `srcds` on
`127.0.0.1:27115` (LAN mode, `sv_hibernate_think 1`, `-allowlocalhttp` only with `--stub-api` or
`--api`). The addon's verify mode starts only that resource, has a bot join, say the lines of
`botChat` and leave (the engine's own `PlayerInitialSpawn`, `PlayerSay` and `player_disconnect`),
and writes a report with the same schema as the other hosts. GMod refuses `quit` from Lua, so the
runner stops `srcds` by its PID once the report exists, then removes everything it installed (it
marks its folders and never touches an operator's own `addons/scriptgo`). `[ERROR]` lines in the
console log fail the run.

Options: `--gmod-binary srcds_win64.exe` (64-bit), `--gmod-port`, `--gmod-seconds` (run length,
default 4), `--gmod-timeout` (hard limit, default 120000 ms), and `--gmod-verify <file.json>` with
more config and bot chat lines: `test/sg_gmod_paths.verify.json` drives commands, permissions,
config and notifications through the bot.

On Windows, `srcds -console` exits at once (code 100, `CTextConsoleWin32::GetLine`) when its
standard input is a pipe or `NUL`, so the runner starts it through PowerShell `Start-Process` in a
hidden window.

Measured on 2026-11-09 with the Windows dedicated server, public branch (2026.09.17): `sg_probe`
25/25 self-checks on 32-bit (LuaJIT 2.0.4) and 64-bit (LuaJIT 2.1.0-beta3); `sg_probe_net` with the
loopback stub API (http, five licensing checks, request bodies schema-checked); `sg_gmod_paths`
15/15 (chat commands, a refused restricted command, usergroup and wildcard grants, config,
convars, notifications, join and drop). See `TEST_RESULTS.md`.

`sdk/lua/spec/garrysmod_adapter_spec.lua` tests the adapter against a mock of the GLua API; it
checks the mapping only and is not evidence that anything runs on Garry's Mod.
