# SCRIPT//GO for Luanti

One regular Luanti mod, `scriptgo`, runs SCRIPT//GO resources (and portable OPEN//77 resources)
on a Luanti server. Resources keep their format: a `scriptgo.lua` manifest, shared and server
scripts, events, exports, commands, storage.

## Install

```bash
node sdk/adapters/luanti/build.mjs                       # -> dist/luanti/scriptgo/
node sdk/adapters/luanti/build.mjs --with sdk/packages/sg_inventory --with sdk/packages/sg_eventbus
```

Copy `dist/luanti/scriptgo/` into the server's `mods/` folder (or the game's) and enable it for
the world (`load_mod_scriptgo = true` in `world.mt`). The mod is not a trusted mod: it needs no
entry in `secure.trusted_mods`.

Put resources in `<world>/scriptgo/resources/<name>/` or bundle them with `--with`. Every
resource with `auto_start true` (the default) starts with the server, dependencies first.

Optional `<world>/scriptgo.json`:

```json
{
  "resources": { "sg_inventory": { "slots": 30 } },
  "convars": { "scriptgo_api": "https://api.example.com" },
  "permissions": { "alice": ["command.giveitem", "permissions.manage"] },
  "start": ["sg_inventory"]
}
```

`start`, when present, replaces auto-start with an explicit list.

## How the runtime maps onto Luanti

| SCRIPT//GO | Luanti |
|---|---|
| Sides | Server only. Client scripts do not run: Luanti mods are server-side |
| Tick | `core.register_globalstep` |
| Players | Names become session-stable integer ids (1, 2, ...); `players.identifier(id)` is `luanti:<name>` |
| `playerJoining` / `playerDropped` | `core.register_on_joinplayer` / `on_leaveplayer` (`left` or `timed_out`) |
| `RegisterCommand` | Ordinary chat commands (`/giveitem ...`), through `core.register_on_chatcommand`; Luanti's own commands are untouched |
| `permissions.has` | `server` or `scriptgo_admin` privilege grants everything; otherwise the grants in `scriptgo.json` |
| `storage` | Mod storage, one JSON document per resource |
| `config.get` / `GetConvar` | `scriptgo.json`, then the server's settings for convars |
| `ui.notify` | A coloured chat line to the player, or to everyone for `-1` |
| `http`, `licensing` | `core.request_http_api()` — only when the owner adds `scriptgo` to `secure.http_mods`; otherwise both capabilities are unavailable and say so |

`/scriptgo` lists the resources and their state; `/scriptgo start|stop|restart <name>` needs
`server` or `scriptgo_admin`.

## Verify

```bash
scriptgo verify <resourceDir> --env luanti
```

builds the mod into a throwaway game, puts the resource and its dependencies in the world, and runs
the official server image `ghcr.io/luanti-org/luanti` in Docker with no network. The mod's verify
mode (`scriptgo_verify`, `scriptgo_verify_seconds`, `scriptgo_verify_report` settings) starts only
that resource, lets it run, writes a report with the same schema as the other hosts, and shuts the
server down.

Measured on 2026-11-09 with Luanti 5.18.0 (LuaJIT 2.1): `sg_probe` 25/25 self-checks, and
`sg_eventbus`, `sg_permissions`, `sg_inventory` verified. No player joins a verify run, so the
join, chat-command and chat-notification paths are covered by reading the code, not by a run yet.
