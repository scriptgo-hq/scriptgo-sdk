# The OPEN//77 target

A SCRIPT//GO resource and an OPEN//77 resource are the same thing: a folder with a declarative Lua
manifest and shared, server and client scripts written against the FiveM-shaped runtime
(`CreateThread`, `Wait`, events, exports, `RegisterCommand`). This page describes the two
directions between them and how compatibility is measured.

Every OPEN//77 fact below was checked against the OPEN//77 devkit catalogue for build
`2.50.0+op77.156`, and the runtime claims were measured on a real OPEN//77 dedicated server (see
[Evidence](#evidence)).

## OPEN//77 resources on SCRIPT//GO hosts

A host loads `open77.lua` as well as `scriptgo.lua`. It provides the same globals, the `Open77`
alias of the portable namespace, declarative `exports` / `server_exports` (a global function of
that name, or `manifest_export_missing:<name>` at start), script globs with OPEN//77's `**/`
semantics, and OPEN//77's naming rules (resource `^[a-z][a-z0-9_]{2,63}$`, export
`^[a-z0-9][a-z0-9_-]{0,63}$`). An OPEN//77 resource that only uses the portable subset runs
unchanged; one that calls game natives (`Open77.vehicles`, `Open77.npcs`...) does not, and
`scriptgo verify` reports the missing global as a runtime error.

## SCRIPT//GO resources on OPEN//77

```bash
scriptgo pack my_resource --target open77 --out dist
# dist/open77/my_resource/  is a resource folder OPEN//77 loads as is
```

`pack` writes the referenced files, a generated `open77.lua`, and the shim, in this order so that
`ScriptGo` exists before any script of the resource runs (OPEN//77 loads scripts in manifest order):

```lua
shared_script "scriptgo_shim.lua"         -- the namespace, storage, events, exports
server_script "scriptgo_shim_server.lua"  -- players, permissions, config, server notifications
client_script "scriptgo_shim_client.lua"  -- client notifications
shared_script "shared/..."                -- then the resource's own scripts
```

The shim is three files because OPEN//77's validator rejects a server-only native named in a
shared script, and because its client sandbox has no `setmetatable`.

### Mapping

| `ScriptGo` member | OPEN//77 | Side |
|---|---|---|
| `log.*` | `Open77.log.*` | both |
| `json` | server `json`, client `Open77.json` | both |
| `time.monotonic()` | `Open77.time.monotonic()` | both |
| `time.now()` | `Open77.time.unix()`; `nil` on the client (no wall clock there) | server |
| `storage.*` | `Open77.kvp.*`, each value stored as its JSON text (kvp keeps scalars only) | both |
| `players.list/name/exists/identifier` | `GetPlayers`, `GetPlayerName`, `Open77.players.identifier`; ids < 1 answer `nil` instead of reaching the native, which would stop the resource | server |
| `permissions.has(id, privilege)` | `Open77.acl.isAllowed` (permission `acl.read`); id `0` is the console | server |
| `config.get(key, default)` | `GetConvar("<resource>:<key>")`, which falls through to the resource's tunables; JSON, booleans and numbers decoded | server |
| `ui.notify(target, payload)` | server: `Open77.notifications.send/broadcast` (permission `network.events`); client: the `open77_notifications` package's `show` export | both |
| `http`, `licensing` | not available: every call raises `capability_unavailable:<cap>@open77` | — |
| events, exports, commands, promises | native OPEN//77 globals, untouched | both |

### Least privilege

The side files are cut by capability: a `-- @capability <name>` ... `-- @end` section is kept only
when the manifest lists that capability (required or optional). The packed resource therefore
names no native it does not use, and `pack` adds exactly the OPEN//77 permissions the kept
sections need: `acl.read` for `permissions`, `network.events` for `ui`.

### What `pack` refuses

| Code | Why |
|---|---|
| `capability_unavailable:http@open77`, `capability_unavailable:licensing@open77` | A required capability OPEN//77 does not give SCRIPT//GO resources. Make it optional, or drop `open77` from `environments`. `--allow-unavailable` packs anyway |
| `open77_no_os`, `open77_no_io`, `open77_no_debug`, `open77_no_package`, `open77_no_load` | The OPEN//77 sandbox has no `os`, `io`, `debug`, `package`, `loadstring`, `dofile` or `loadfile` |
| `open77_client_no_metatables` | `setmetatable` / `getmetatable` in a shared or client script |
| version ranges with `\|\|` | OPEN//77 dependency constraints cannot express them; dropped with a warning (`^` and `~` become two comparators) |

`scriptgo validate` runs the same portability lint: an error when `environments` lists `open77`, a
warning when the package does not restrict its environments.

## Measuring compatibility

```bash
scriptgo verify my_resource --env all --open77-server path/to/Open77.Server.exe
```

writes one JSON report per run to `verification/reports/`:

- **standalone**, once per Lua dialect found (5.4, 5.1, LuaJIT): manifest, dependency resolution,
  start, declared exports, runtime errors, then the resource's `test_script` files;
- **open77**: packs the resource and its dependency closure, starts a real OPEN//77 dedicated
  server with only those resources (masterless, loopback ports `--port`..`--port+2`, nothing
  reachable from another machine), and reads its log: every resource must start and none may log
  an error. Only the server half runs; no game client is launched. Without a server binary
  (`--open77-server` or `OP77_SERVER_EXE`) the report is `skipped`, never `verified`.

On both, a resource can report its own checks by printing `SGCHECK PASS <name>`,
`SGCHECK FAIL <name> <detail>` and finally `SGCHECK DONE ...`; each line becomes a check of the
report, and started checks that never print `DONE` fail.

## Evidence

`sdk/conformance/sg_probe` runs 25 such checks (namespace, storage, clocks, capability refusals,
player-id guards, promises, synchronous and asynchronous cross-resource exports, the EventBus and
Permissions kits). On 2026-11-09 it passed 25/25 on the standalone host under Lua 5.4, 5.1 and
LuaJIT, and 25/25 on an OPEN//77 dedicated server (Lua 5.4), alongside the three official
packages. See `TEST_RESULTS.md`.

Not yet measured: the client half on OPEN//77 (it needs a running game client), and packages
whose behaviour depends on connected players.
