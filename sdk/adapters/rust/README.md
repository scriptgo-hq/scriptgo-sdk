# SCRIPT//GO for Rust (Oxide/Carbon)

One Oxide (uMod) / Carbon plugin, `ScriptGo.cs`, runs SCRIPT//GO resources on a Rust dedicated server.
Resources keep their format: a `scriptgo.lua` manifest, server scripts, events, exports, commands,
storage. Rust's plugin frameworks dropped their Lua support long ago, so the plugin embeds its own
Lua 5.4 VM through [KeraLua](https://github.com/nlua/KeraLua), the binding OPEN//77's server uses.

**Status: planned.** The plugin compiles against Oxide and Carbon, and the bridge passes its tests in a
plain .NET process, but no run on a real Rust server has passed yet. See "What has run" below.

## Layout

| Path | What |
|---|---|
| `lua/adapter.lua` | The adapter table of the portable core, built on the host functions `H.*` |
| `lua/runtime.lua` | Discovery, start, players, commands and the verify report, in Lua |
| `bridge/` | `ScriptGo.Bridge.dll` (netstandard2.0): one KeraLua state, the host services, the native loader |
| `plugin/ScriptGo.cs` | The Oxide/Carbon plugin: maps the framework onto the bridge's services |
| `tests/` | Bridge tests in a plain .NET process with fake services: **not the real environment** |
| `build.mjs` | Builds `dist/rust/` (bridge, KeraLua, lua54, plugin) |
| `compile-check.mjs` | Compiles the plugin against Rust's, Oxide's or Carbon's assemblies, C# 7.3 |

The bridge is thin on purpose. Its service interfaces (`IHostClock`, `IHostStorage`, `IHostPlayers`,
`IHostPermissions`, `IHostConfig`, `IHostUi`, `IHostHttp`, `IHostLog`) follow the names of the
planned .NET kit `ScriptGo.Host` (`docs/plan/MULTI-LANGUAGE-SANDBOX.md`). Once that kit is merged,
the plugin's service classes move onto it and `ScriptGo.Bridge` goes away.

## How the runtime maps onto Rust

| SCRIPT//GO | Rust (Oxide/Carbon) |
|---|---|
| Sides | Server only: Rust has no client-side plugins |
| Tick | `timer.Every(tickIntervalSeconds)`, 0.02 s by default, on the server's main thread |
| Execution budget | 250 ms per resume (`budgetMs`) by default. `os.clock` is the bridge's monotonic clock: C's `clock()` counts every server thread on Linux |
| Players | `BasePlayer`. Steam ids become small integer ids that stay stable while the plugin is loaded. `players.identifier(id)` is `steam:<steamid64>` |
| Events | `OnPlayerConnected` and `OnPlayerDisconnected` become `playerJoining`, `onPlayerConnected`, `playerDropped` and `onPlayerDisconnected` |
| Commands | A chat line `/name args` reaches a resource command through `OnPlayerCommand`. A restricted command needs `scriptgo.command.<name>` |
| Permissions | Oxide permissions. A privilege `p` is `scriptgo.p`, registered on first use; `scriptgo.admin` holds every privilege. The console holds every privilege |
| Storage | Data files: `<data>/ScriptGo/storage/<key>.json` through `Interface.Oxide.DataFileSystem` |
| Config | The plugin config: `resources.<name>.<key>` and `convars.<name>`. Rust's own server convars are not exposed, because `rcon.password` is one of them |
| UI | Chat: `ui.notify` sends a colored line to one player or to everyone |
| HTTP, licensing | Oxide/Carbon web requests (`webrequest.Enqueue`), answered on a later tick. Only the status and body come back, so response headers are empty. `httpAllowedHosts` limits the hosts when it is set |
| Files | Resource folders under `<data>/ScriptGo/resources` and `resourceFolders`. Reads cannot leave a resource folder |

Admin command, in the server console, RCON or chat (`/scriptgo`, which needs `scriptgo.admin`):
`scriptgo status | commands | start <res> | stop <res> | restart <res> | run <command line>`.

## Native library: how `lua54` is found

KeraLua calls Lua through `[DllImport("lua54")]`. Neither framework loads native libraries for a
plugin. `// Reference:` only resolves managed assemblies: Oxide uses `RustDedicated_Data/Managed/`;
Carbon tries `carbon/extensions/`, then `carbon/managed/lib/`, then `RustDedicated_Data/Managed/`.
The native library is left to the runtime, Unity's Mono, and to the OS loader.

So before KeraLua's first call, the bridge loads the library by its full path (`NativeLua.Preload`).
On Windows that is `LoadLibraryW`. On Linux it is `dlopen` with `RTLD_NOW | RTLD_GLOBAL`. Every later
lookup then finds the module already in the process. Windows matches a loaded module by base name.
glibc matches an already loaded object by its SONAME, and KeraLua's `liblua54.so` has the SONAME
`liblua54.so`. The plugin tries these folders in order:

1. `nativeLibraryFolder` from the plugin config, when it is set;
2. `RustDedicated_Data/Plugins/x86_64/` (recommended). Unity keeps the server's own native plugins
   there, and on Linux `runds.sh` adds it to `LD_LIBRARY_PATH`;
3. the server root;
4. `RustDedicated_Data/Managed/` and `RustDedicated_Data/Managed/x64/`. Oxide's own native
   `sqlite3.dll` is in `Managed/x64/`, and its old Lua extension put `lua52` there too.

The binaries are KeraLua 1.4.9's (Lua 5.4.8). `lua54.dll` (win-x64) imports only `KERNEL32.dll`, so it
needs no Visual C++ runtime. `liblua54.so` (linux-x64) needs `libc`, `libm` and `libdl`.

These are inferences until a real server runs the plugin:
- Unity's Mono JIT marshals KeraLua's callbacks without `[MonoPInvokeCallback]`, which only AOT
  needs;
- Mono resolves `DllImport("lua54")` to the module that is already loaded.

## Verify

```bash
scriptgo verify sdk/conformance/sg_probe --env rust --rust-server <folder with RustDedicated>
```

The server folder needs Oxide or Carbon installed (see SETUP.md); `SCRIPTGO_RUST_SERVER` works too.
The runner then:
1. builds `dist/rust` and copies the plugin files into the server;
2. puts the package and its dependencies in a temporary resource folder;
3. swaps in a verify config, which it restores afterwards;
4. starts `RustDedicated` on loopback: game port 28115, web RCON on 28116 with a random password,
   Steam query also on 28116 over UDP, Rust+ off, and a 1000 m world `sgverify`;
5. lets the plugin run the package for `--rust-seconds` (15 s by default) and write the report.

The plugin then quits the server. The first boot generates the map and takes minutes; the run's
limit is 20 minutes. Without a server folder the run is reported as skipped, never as verified.
`--stub-api` works: the stub's host becomes the only allowed HTTP host.

## What has run

- `dotnet run --project sdk/adapters/rust/tests -c Release`: 20 bridge tests in a **plain .NET 10
  process**. The services are fakes; the KeraLua Lua 5.4.8 VM, the portable core, this glue, the
  conformance probe and the official kits are the real ones. On that host, `sg_probe` passes 25/25
  SGCHECKs. This is not a Rust server and does not count as verification.
- `node sdk/adapters/rust/compile-check.mjs`: the plugin compiles with Roslyn, `-nostdlib`, C# 7.3
  against Rust's `RustDedicated_Data/Managed` (public branch). It compiles once with
  Oxide.Rust 2.0.7900's assemblies on top, and once with Carbon 2.0.264's.
- `packages/cli/test/verify-rust.test.ts`: the runner's skip path, framework detection, install plan,
  loopback arguments, and a config whose keys the plugin declares.

## Limits

- Server only. The game client is never involved.
- HTTP responses carry no headers, because Oxide's web request callback has only the status and the
  body.
- A player's id stays the same for the plugin's lifetime, including across reconnects. FiveM-style
  hosts give a new id each time.
- Replacing `ScriptGo.Bridge.dll` or `KeraLua.dll` needs a server restart; reloading the plugin does
  not unload them.
