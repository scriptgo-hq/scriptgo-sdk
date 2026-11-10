# The OPEN//77 target

A Lua SCRIPT//GO resource and an OPEN//77 resource have the same shape: a folder with a
declarative Lua manifest and shared, server and client scripts written against the FiveM-shaped
runtime (`CreateThread`, `Wait`, events, exports, `RegisterCommand`). OPEN//77 runs Lua only, so a
TypeScript resource does not run there. This page describes the two directions between them and how
compatibility is measured.

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
server_script "scriptgo_shim_server.lua"  -- players, permissions, config, notifications, http, licensing
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
| `http.request{ method, url, headers, body }` | `Open77.http.request` (permission `http.request`) awaited on a promise; answers `{ status, body, headers, error }`, `status = 0` when the exchange did not complete; a request the server refuses at once answers `nil, reason` (`host_not_allowed`, `http_unavailable`...) | server |
| `licensing.activate/verify` | POST to the `scriptgo_api` convar (default `https://api.scriptgo.dev`) over `Open77.http.request`, same request and answer shapes as every SCRIPT//GO host (`/v1/licenses/*`) | server |
| `perks.*` | The portable core's module `sdk/lua/scriptgo/perks.lua`, included word for word in the server shim by `scriptgo pack`, over `Open77.http.request`, `Open77.players.identifier`, `Open77.time.unix` and the resource's kvp (key `scriptgo.perks`). Convars `scriptgo_api`, `scriptgo_server_token`, optionally `scriptgo_perks_poll_seconds`. Nothing payment-related is in OPEN//77: see `docs/spec/perks.md` | server |
| events, exports, commands, promises | native OPEN//77 globals, untouched | both |

### Least privilege

The side files are cut by capability: a `-- @capability <name>` ... `-- @end` section is kept only
when the manifest lists that capability (required or optional). The packed resource therefore
names no native it does not use, and `pack` adds exactly the OPEN//77 permissions the kept
sections need: `acl.read` for `permissions`, `network.events` for `ui`, `http.request` for `http`
and `licensing`. Each kept section also switches its capability on, so
`ScriptGo.capabilities.has(c)` is true exactly where the packed resource can call `c`.

### Outbound HTTP is the operator's decision

OPEN//77 keeps outbound HTTP off until the server operator turns it on, and then only towards the
hosts they list. A resource that uses `http` or `licensing` needs, in `server.jsonc`:

```jsonc
"http": { "enabled": true, "allowedHosts": ["api.scriptgo.dev"] },
"convars": { "scriptgo_api": "https://api.scriptgo.dev" }
```

`scriptgo_api` can be left out: it defaults to `https://api.scriptgo.dev`. `pack` prints this as a
warning. Anything not on the list answers `nil, "host_not_allowed"` before a
byte leaves the server, and redirects are never followed. The licence key itself goes in the
`<resource>:license_key` convar (or a tunable), never in the resource folder.

### What `pack` refuses

| Code | Why |
|---|---|
| `open77_no_os`, `open77_no_io`, `open77_no_debug`, `open77_no_package`, `open77_no_load` | The OPEN//77 sandbox has no `os`, `io`, `debug`, `package`, `loadstring`, `dofile` or `loadfile` |
| `open77_client_no_metatables` | `setmetatable` / `getmetatable` in a shared or client script |

`--allow-unportable` packs despite these, with each finding as a warning.
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

With `--stub-api`, verify also starts a loopback stand-in for the licensing API that parses every
request with the API's own schemas (`VerifyBody`, `ActivateBody`) and answers in its shapes. The
resource gets the stub's URL and a valid key as config (`api`, `license_key`) and `scriptgo_api`;
on OPEN//77 the server's outbound HTTP is switched on with `127.0.0.1` as the only allowed host. The
report gains `api:bodies_valid`, `api:environment` and `api:adapter_version`. `--api <url>
--license-key <key>` does the same against a real SCRIPT//GO API (no `api:*` checks there: only the
stub sees the requests); `tools/acceptance.mjs` uses it.

On both, a resource can report its own checks by printing `SGCHECK PASS <name>`,
`SGCHECK FAIL <name> <detail>` and finally `SGCHECK DONE ...`; each line becomes a check of the
report, and started checks that never print `DONE` fail.

## Evidence

`sdk/conformance/sg_probe` runs 25 such checks (namespace, storage, clocks, capability refusals,
player-id guards, promises, synchronous and asynchronous cross-resource exports, the EventBus and
Permissions kits). On 2026-11-09 it passed 25/25 on the standalone host under Lua 5.4, 5.1 and
LuaJIT, and 25/25 on an OPEN//77 dedicated server (Lua 5.4), alongside the three official
packages. See `TEST_RESULTS.md`.

`sdk/conformance/sg_probe_net` checks `http` and `licensing` against that stub: GET, a 404 that is an
answer and not a failure, verify (valid and unknown key), activate, verify by deployment token,
activate refused with `unknown_key`, and on OPEN//77 the allow-list refusal of any other host. On
2026-11-09 it passed 9/9 on the standalone host (Lua 5.4, 5.1, LuaJIT) and 10/10 on an OPEN//77
dedicated server; the sample paid package Inventory Pro reached `license active` through the same
path on both.

The README example of each official package (EventBus 1.0.1, Permissions 1.0.1, Inventory 1.0.1)
and of Inventory Pro 1.4.2 ran next to its package on the same server, and its output is in the
stored reports. The first attempt found a real difference: the examples called exports at file
scope, which OPEN//77 refuses with `resource_preparing` while the caller is still loading. Every
SCRIPT//GO host now refuses it the same way (`sdk/lua/spec/host_spec.lua`), so the mistake shows up
on the standalone host before it reaches an OPEN//77 server.

The acceptance journey (`tools/acceptance.mjs`) ends on OPEN//77 too: a key bought through the
mock provider, issued by the real API and given to the server as a convar, puts Inventory Pro in
`license active` on a real dedicated server, with the API host as the only host in
`http.allowedHosts`.

Not yet measured: the client half on OPEN//77 (it needs a running game client), and packages
whose behaviour depends on connected players (no player joins a verify run on OPEN//77, so the
README examples that react to `playerJoining` show only their start-up output there).
