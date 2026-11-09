# Runtime API (`scriptgo_version` 0.1)

Every SCRIPT//GO host exposes the same runtime to resources. The shape is the familiar multiplayer
resource shape — `CreateThread`, `Wait`, events, exports, `RegisterCommand` — so a resource author moves
between environments without relearning anything. Environment differences live in **adapters**
and are expressed as **capabilities**.

## Hosts and sides

| Host | Sides | Implementation |
|---|---|---|
| `standalone` | server + one local client, in-process | `sdk/lua/scriptgo` + `sdk/adapters/standalone` (CLI) |
| `love2d` | server + local client, in-process | `sdk/adapters/love2d` |
| `godot` | server + local client, in-process | `sdk/adapters/godot` (lua-gdextension) |
| `luanti` | server only (mods are server-side) | `sdk/adapters/luanti` (a Luanti mod) |
| `open77` | real dedicated server + real clients | `scriptgo pack --target open77` adds a three-file shim that maps `ScriptGo.*` onto `Open77.*` (see [open77.md](open77.md)) |

In single-process hosts the client side is player `1` and network events are looped back through
the value codec, so isolation rules are identical to a real network.

## Globals

| Global | Notes |
|---|---|
| `CreateThread(fn)` | Runs `fn` in a scheduler-owned coroutine |
| `Wait(ms)` | Yields; `Wait(0)` resumes on the next host tick |
| `SetTimeout(ms, fn)` → id, `ClearTimeout(id)` | One-shot timers |
| `AddEventHandler(name, fn)` → handler id, `RemoveEventHandler(id)`, `TriggerEvent(name, ...)` | Server: one host-wide bus, delivered on the next tick in resource-name order, no `source`. Client: local to the resource side |
| `RegisterNetEvent(name, fn?)` | Only registered names receive network events |
| `TriggerServerEvent(name, ...)` | Client → server; returns `true` or `false, reason` |
| `TriggerClientEvent(name, target, ...)` | Server → client; `target = -1` for every player |
| `source` | Inside a network handler on the server: the sending player id |
| `exports(name, fn)` | Publishes an export of this resource side |
| `exports.other:name(...)` | Calls another resource's export inline and returns its values; failures raise `export other:name <reason>`. From file scope, while the calling resource is still loading, it raises `resource_preparing` (as on OPEN//77): call exports from a thread, a handler or `onResourceStart` |
| `GetInvokingResource()` | Inside an export: the calling resource |
| `RegisterCommand(name, fn(source, args, raw), restricted?)` | Case-insensitive, runs on the next tick, a duplicate name raises; `restricted` checks `command.<name>`; `source = 0` for the console |
| `GetCurrentResourceName()`, `GetResourceState(name)` | `started`, `stopped`, `missing` ... |
| `GetConvar(name, default)` | Host configuration value |
| `require(module)` | Confined to the resource: `a.b` → `a/b.lua` or `a/b/init.lua`; `@lib/mod` reads a declared dependency. Returns `nil, reason` on failure. **Client-only on OPEN//77**: portable server code keeps to one file per concern or shared scripts |
| `print(...)` | Routed to the host log with the resource name |

Lifecycle events: `onResourceStart(name)`, `onResourceStop(name, reason)` (server side),
`onClientResourceStart(name)`, `onClientResourceStop(name, reason)` (client side). Player events
(server side): `playerJoining(playerId)` and `playerDropped(reason)`, both with the player in
`source`; `onPlayerConnected(playerId)` and `onPlayerDisconnected(playerId, reason)`.

Every global, namespace member and host event, with its failure tokens, is listed in
[runtime-idl.json](runtime-idl.json) ([format](runtime-idl.md)). JavaScript and TypeScript
resources, and resources that mix languages, are covered in [multi-language.md](multi-language.md).

## `ScriptGo` namespace

`Open77` is provided as an alias of the portable subset, so resources written for the `open77`
environment that only use that subset run unchanged on every host.

| Member | Capability | Notes |
|---|---|---|
| `log.debug/info/warn/error(msg)` | `logging` | Always available |
| `json.encode(v)`, `json.decode(s)` | — | Pure Lua, deterministic key order |
| `time.monotonic()`, `time.now()` | — | Seconds (float); Unix seconds, or `nil` where the side has no wall clock (OPEN//77 client) |
| `runtime.version()`, `runtime.luaVersion()`, `runtime.environment()`, `runtime.side()` | — | |
| `resource.name()`, `resource.version()`, `resource.state(n)`, `resource.hasPermission(p)`, `resource.readFile(path)` | — | `readFile` is confined to the resource |
| `events.on/off/emit` | `events` | Aliases of the globals |
| `net.emitServer(name, ...)`, `net.emitClient(name, target, ...)` | `events` | Aliases |
| `exports.call(resource, name, ...)` → promise or `nil, reason`; `promise:await()` → `result, err` | — | Values are copied through the codec; `nil, "resource_preparing"` from file scope |
| `capabilities.has(c)`, `capabilities.list()`, `capabilities.require(c)` | — | `require` raises `capability_unavailable:<c>@<env>` |
| `storage.get(key)`, `storage.set(key, value)`, `storage.delete(key)`, `storage.keys(prefix?)` | `storage` | Per-resource, JSON values, persisted by the host |
| `players.list()`, `players.name(id)`, `players.exists(id)`, `players.identifier(id)` | `players` | Server side. Ids are integers ≥ 1; invalid ids answer `nil`/`false` |
| `permissions.has(playerId, privilege)` | `permissions` | Host privileges (Luanti privs, OPEN//77 operators, standalone config) |
| `ui.notify(target, { type, title, message, durationMs })` | `ui` | `target` is a player id or `-1`; client side may pass `nil` |
| `config.get(key, default)` | `config` | Per-resource config from the host |
| `http.request({ method, url, headers, body })` → `{ status, headers, body }` or `nil, reason` | `http` | Server side, inside a thread (it waits for the answer); only where the host allows outbound HTTP |
| `licensing.activate(opts)`, `licensing.verify(opts)` → result or `nil, code, body` | `licensing` | Server side; `POST {scriptgo_api}/v1/licenses/activate|verify` |

## Capabilities

`events`, `logging`, `storage`, `players`, `permissions`, `commands`, `config`, `ui`, `http`,
`licensing`. The authoritative matrix lives in `sdk/lua/scriptgo/capabilities.lua` and is
exported to the registry (`/v1/environments`). Calling a member of a capability the host does not
provide raises `capability_unavailable:<capability>@<environment>`; nothing fails silently.

## Value codec

Network events and export calls copy values: `nil`, booleans, finite numbers, strings, and acyclic
tables with string or integer keys. Functions, coroutines, userdata, cycles, depth > 32 and
encoded size > 1 MiB are refused with a reason. Lua objects are never shared between sides or
resources.

## Sandbox

Each resource side gets its own environment: `string`, `table`, `math`, `utf8` (5.3+),
`os.time/os.clock/os.date` (standalone, LÖVE, Godot, Luanti, Neovim and CC: Tweaked hosts; on CC: Tweaked `os.time()` gives Unix seconds from the adapter's `wallTime`, not the in-game hour), `pcall`, `xpcall`, `error`, `assert`, `select`, `type`, `tostring`,
`tonumber`, `pairs`, `ipairs`, `next`, `rawget/rawset/rawequal/rawlen`, `setmetatable`,
`getmetatable`, `unpack`/`table.unpack`. Not exposed: `io`, `os.execute` and the rest of `os`,
`debug`, `package`, `load`, `loadstring`, `dofile`, `loadfile`, `coroutine` (the scheduler owns
coroutines), `collectgarbage` except `"count"` (refused where the host has no `collectgarbage`, as on CC: Tweaked).

**OPEN//77 is stricter.** Its sandbox has no `os` at all, and its client sandbox has no
`setmetatable` or `getmetatable`. A package that lists `open77` in `environments` must use
`ScriptGo.time` instead of `os`, and plain tables in shared and client scripts.
`scriptgo validate` and `scriptgo pack --target open77` refuse code that breaks these rules
(`open77_no_os`, `open77_client_no_metatables`, ...), because the standalone host would not.

The Lua sandbox is **not a security boundary for untrusted code**. Untrusted uploads are only
executed by the validation worker inside isolated containers (see `ARCHITECTURE.md`).
