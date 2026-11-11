# SCRIPT//GO for Rust (Oxide/Carbon)

One Oxide (uMod) / Carbon plugin, `ScriptGo.cs`, runs SCRIPT//GO resources on a Rust dedicated server.
Resources keep their format: a `scriptgo.lua` manifest, server scripts, events, exports, commands,
storage. Rust's plugin frameworks dropped their Lua support long ago, so the plugin embeds its own
Lua 5.4 VM through [KeraLua](https://github.com/nlua/KeraLua), the binding OPEN//77's server uses.

**Status: experimental.** On a real Windows dedicated server with Oxide, the conformance probe is
verified and the escrow chain passes end to end, and both again with Carbon in place of Oxide, and
on a Linux dedicated server with Oxide in a container. No connected player has been measured. See
"What has run" below.

Encrypted (escrowed) packages are supported through the native library of `sdk/native`, off by
default: see "Escrow". That part is planned too, and proven only in the bridge's test process.

## Layout

| Path | What |
|---|---|
| `lua/adapter.lua` | The adapter table of the portable core, built on the host functions `H.*` |
| `lua/runtime.lua` | Discovery, start, players, commands and the verify report, in Lua |
| `bridge/` | `ScriptGo.Bridge.dll` (netstandard2.0): one KeraLua state, the host services, the native loader |
| `bridge/Escrow/` | Escrow: the manifest reader, the P/Invoke layer over `libscriptgo`, the licence state machine |
| `plugin/ScriptGo.cs` | The Oxide/Carbon plugin: maps the framework onto the bridge's services |
| `tests/` | Bridge tests in a plain .NET process with fake services: **not the real environment** |
| `build.mjs` | Builds `dist/rust/` (bridge, KeraLua, lua54, plugin; the escrow library with `--native`) |
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

The escrow library (`scriptgo.dll`, `libscriptgo.so`) is found the same way, in the same folders or
at `escrow.nativeLibrary`, and only when an escrowed resource starts. It does not link Lua: it
compiles a script by calling `luaL_loadbufferx` of the Lua library the VM runs on. The bridge finds
that library by asking the VM for the address of one of its own C functions and taking the module
that address is in, so two copies of `lua54` in one process are never mixed (the test process
loads two).

## Escrow (encrypted packages)

A paid package can ship its scripts encrypted. They stay encrypted on disk. When the resource
starts, the bridge asks the SCRIPT//GO master for the release's key, the native library
`libscriptgo` (`sdk/native`) unwraps it, decrypts in its own memory and compiles each script
straight into the Lua VM. Rust has no client side, so every script of a package can be covered.

**Status: planned, like the rest of this adapter.** Everything below is proven in the bridge's test
process (a plain .NET process with a fake clock, fake files and a fake key service) with the real
native library for Windows x64. No Rust server has run it. See "What has run" and "Escrow limits".

### What it is, and what it is not

- **It is** deterrence, licence binding, revocation and traceability. A copied resource folder does
  not run on a server the licence is not bound to. A revoked licence stops the resource. A release
  is signed, so a modified one is refused. Each key delivery carries a marker naming the licence
  and the deployment it went to.
- **It is not** a guarantee. The operator of the machine can ultimately recover what their own
  server process runs: the script has to exist, decrypted, in the memory of a process they
  control. A debugger, a memory dump or a replaced `lua54` library sees it. Nothing here claims
  otherwise, and there is no obfuscation.

### On disk

A resource is escrowed **if and only if its folder holds `escrow.json`** (format:
`docs/spec/escrow.md`).

```text
resources/<name>/scriptgo.lua       the manifest, clear, part of the signed release
resources/<name>/escrow.json        clear, signed description of the release
resources/<name>/payload.enc        the encrypted files (AES-256-GCM)
resources/<name>/server/main.lua    a STUB at the path of each encrypted script: one comment line
resources/<name>/...                the other files of the release, clear (docs, a config)
```

A stub names the release and is never executed:

```lua
-- scriptgo-escrow/1 creator//name@1.4.0 sha256=<sha256 of payload.enc> path=server/main.lua
```

The stub is what discovery, script globs and file listings see. A script the manifest lists needs
its stub. An encrypted module that only `require` reaches does not: the bridge answers its stub
itself. `scriptgo escrow install <bundle.escrow.zip> --target rust --out <resources folder>` writes
this layout from a bundle without decrypting anything: the unzipped bundle plus a stub for every
encrypted Lua file.

### Configuration

Off by default. In the plugin config (`oxide/config/ScriptGo.json`, `carbon/configs/ScriptGo.json`):

```json
"escrow": {
  "enabled": true,
  "master": "https://api.scriptgo.dev",
  "environment": "rust",
  "identityFile": "escrow/identity.key",
  "tokensDirectory": "escrow/tokens",
  "trustedSigners": [],
  "strictClearFiles": false,
  "nativeLibrary": null
}
```

| Field | Meaning |
|---|---|
| `enabled` | Off by default. While off, an escrowed folder is refused with one log line (`escrow_disabled`), nothing native is loaded and every other resource runs as before |
| `master` | Base URL of the key service. The bridge posts to `<master>/v1/licenses/key`. It must be `https`; `http` is accepted for a loopback address only, because the deployment token travels in the request. Its host is always allowed, whatever `httpAllowedHosts` says |
| `environment` | The licence environment asked for. Default `rust` |
| `identityFile` | Where the native library keeps this server's X25519 key pair. Licences are bound to its public half. Relative paths are under `<data>/ScriptGo/` |
| `tokensDirectory` | A folder with one `<resource>.token` file per escrowed resource. Relative paths are under `<data>/ScriptGo/` |
| `trustedSigners` | ed25519 public keys (base64url) allowed to sign a release. Empty: the signer the key service names for the licence |
| `strictClearFiles` | Refuse a start when any clear file differs from the signed release. Default `false`: see "Clear files" |
| `nativeLibrary` | Full path of `scriptgo.dll` / `libscriptgo.so`. Default: the folders `lua54` is searched in |
| `renewRetrySeconds` | Seconds between two attempts while the key service refuses or cannot be reached. Default 60, at least 5 |

**No secret goes in the config or in a resource folder.**

- The **deployment token** of each escrowed resource is a file: `<tokensDirectory>/<resource>.token`,
  one line. With the defaults that is `oxide/data/ScriptGo/escrow/tokens/<resource>.token`. Keep the
  folder readable by the server's account only. The token is read into the server's memory and sent
  to the key service in the request body.
- The **identity** is created on the first escrowed start, in `identityFile`. The private key never
  leaves the native library. On Windows the file is sealed with DPAPI for the account the server
  runs as; elsewhere it is a `0600` file. Back it up with the server: a server that loses it, or
  moves to another account or machine without it, has to be bound again (`unbound`).
- The content key and the decrypted scripts exist only inside the native library and the Lua VM.
  The bridge's managed code sees the encrypted payload, the wrapped key (useless without the
  private key) and the token.

### How a start goes

Oxide and Carbon web requests are asynchronous: the answer comes on a later tick. So an escrowed
resource does not start inside the call that starts it.

1. The folder is checked against the signed release, before any request: `escrow.json`, its
   signature, `payload.enc` (size and SHA-256), the manifest, the stubs, and that every script the
   manifest would run belongs to the release.
2. The key is asked for. The resource is now **`pending_key`**: `scriptgo status` shows it, the
   other resources start normally, and a resource that depends on it waits with it.
3. The answer arrives, at most `httpTimeoutSeconds` later. Granted: the native library opens the
   release, the folder is checked once more, and the resource starts. Refused or no answer: the
   resource is `failed` with a reason code, and its dependents fail with it.

An answer is kept in memory for the run of the server. `scriptgo restart <res>` inside its lifetime
asks nothing new. After a server restart there is no earlier answer: if the key service cannot be
reached then, escrowed resources do not start until an operator starts them again.

### While it runs

The licence is renewed before the answer expires (a fifth of its lifetime ahead, at most two
minutes).

- **The key service says no** (revoked, refunded, expired): the resource keeps running until the
  `offlineGraceUntil` of its last valid answer, then it is stopped. The log says so when the
  refusal is first seen, with the time it will stop, and again when it stops.
- **The key service cannot be reached**: the same grace applies. If it answers again in time,
  nothing happens.
- The bridge asks again every `renewRetrySeconds` (60) in between. A stopped resource does not come
  back on its own: `scriptgo start <res>` asks the key service again.

### Refusals

A refused resource is `failed`. One error line is logged, starting with the reason code, and
`scriptgo status` shows the same text: `paid 1.2.0  failed  [escrow tampered: payload.enc does not
match the signed release]`.

| Reason | Meaning |
|---|---|
| `escrow_disabled` | The folder is escrowed and `escrow.enabled` is false, or `escrow.master` is not a usable `https` URL |
| `native_missing` | `scriptgo.dll` / `libscriptgo.so` is not installed, is not ABI version 1, cannot find `luaL_loadbufferx` in the VM's Lua library, or the CPU has no hardware AES |
| `invalid_manifest` | `escrow.json` is malformed, of another format, or names no clear resource manifest |
| `signature` | The signature does not verify, or the signer is not a trusted one |
| `tampered` | The payload, the manifest, a stub or the script list does not match the signed release |
| `token_missing` | There is no usable `<resource>.token` file |
| `not_licensed` | The key service does not know this token for this package, the licence does not cover `rust` or this many servers, or the release is not escrowed there |
| `unbound` | The licence is bound to another server's identity, the key was released to another identity, or this server's identity file cannot be opened |
| `revoked` | The licence was revoked, refunded or deactivated |
| `expired` | The licence has expired |
| `unreachable` | The key service did not answer (no answer, an HTTP status other than 200, an unreadable body) and no earlier answer is still inside its offline grace |

### Clear files

A creator leaves files clear so that operators can edit them: a config, a locale table. An edited
or missing clear file is **allowed** by default and logged once per start; `strictClearFiles: true`
refuses the start instead. Three things are always enforced, because they decide what runs beside
the encrypted scripts: the resource manifest is byte for byte the signed one, every script it runs
is part of the release (a file added to the folder is refused, also behind a glob), and what sits
at the path of an encrypted file is its stub.

A clear file that the manifest runs as a script (`shared_script "config.lua"`) is code the operator
can replace, and it runs in the resource's own environment, next to the encrypted scripts. That is
the creator's choice when they leave a script clear.

### What shares the VM

The bridge runs every resource in **one** KeraLua state. An escrowed resource is not given a VM of
its own: exports, events, dependencies and commands all live in one core host object in that
state, and the core has no notion of a resource in another VM. The planned .NET kit gives each
resource its own VM (DECISIONS.md, ADR-0015); this bridge does not (ADR-0033).

So here is what another resource in the same VM, written by the operator or by anybody else, can
and cannot do to an escrowed one. `escrow.shared_vm_isolation` in the tests shows each line.

It **can**:
- call its exports, trigger and hear events: that is its public interface;
- use up the VM's memory and time: one state is one budget.

It **cannot**, by any way we know:
- reach its globals, replace its functions, stop it, or use the host services in its name. A
  promise used to carry the core's host object, which led to every resource's environment; the
  core no longer exposes it (`sdk/lua/scriptgo/host.lua`). The environments are still a
  separation between resources of one VM, not a hardened sandbox: treat a shared VM accordingly;
- read the script: the text is never a Lua value. It goes from the native library's memory into
  the compiler;
- turn a function into bytecode: `string.dump` is removed for the whole VM while escrow is on, and
  `load`, `debug`, `io` and `package` are not available to resources;
- read a function's `local`s or upvalues: that needs `debug`. What a script keeps in locals, and
  does not return, stays out of reach of other resources;
- load an encrypted file of the release into its own environment: `require("@paid/...")` answers
  `module_load_failed`;
- replace the string methods other resources call: with escrow on, `("x"):upper()` resolves in a
  private copy and `getmetatable("")` answers `false`.

Those two changes (`string.dump`, the string metatable) apply to every resource of a server that
turns escrow on. The conformance probe and the kits pass with them (`escrow.enabled_keeps_conformance`).

None of this is about the operator. The operator is not limited to writing resources.

### Escrow limits

- **Not run on a Rust server.** The bridge tests run on CoreCLR. Under Unity's Mono these are
  inferences: `DllImport("scriptgo")` resolves to the library loaded by full path; a `SafeHandle`
  passes as an argument; `Marshal.GetFunctionPointerForDelegate` gives back the native address of
  a Lua C function (used to find the Lua library the VM runs on; if it does not, the bridge falls
  back to the `lua54` it loaded by path, or refuses with `native_missing`).
- **Linux is measured in a container only.** `libscriptgo.so` is built (`sdk/native/README.md`),
  the 45 bridge tests pass there in a plain .NET 10 process (17 with the real library), and the
  escrow chain passes on a Linux Rust dedicated server with Oxide ("What has run"). The server was
  started directly, as root, with `LD_LIBRARY_PATH` set by the runner: `runds.sh`, a service
  account and Carbon on Linux are not covered.
- The identity is sealed for the account the server runs as. Running the server under another
  account, or as a service after a first start from a console session, gives `unbound` until the
  licence is bound again.
- Timing uses the server's clock against the absolute times the key service sends. Keep the clock
  synchronised. An answer that is still valid never stops a resource, whatever the clocks say.
- Revocation needs the real key service. An operator who points `escrow.master` at a service that
  replays an old answer keeps a resource running. That is part of the ceiling above.
- A Lua error in an encrypted script reports what Lua reports: the file's path, a line number and
  the message, and for a syntax error the token it stopped near. The source is never logged.
- Only scripts are loaded from the payload. An encrypted file that is not Lua (a data file) cannot
  be read by the resource: `ScriptGo.resource.readFile` gives its stub or nothing.
- The key service's answer comes through the framework's web request, as the token goes out:
  whatever can read the server's HTTP traffic in process sees both. Neither is the content key.
- The native library stays loaded until the server restarts, like `lua54`.

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

- **A real Rust dedicated server** (2026-11-10: the public build of 2026-11-07, Oxide 2.0.7900,
  Windows x64, bound to loopback, no player connected):
  - `scriptgo verify sdk/conformance/sg_probe --env rust --rust-server <folder>`: verified, 30
    checks, in about a minute. The report is `verification/reports/sg_probe-0.1.0-rust.json`.
  - `node tools/escrow-e2e.mjs --environment rust --require-output --loader-stays-up --start-window
    200 --stop-window 150 --loader "node tools/rust-escrow-loader.mjs --rust-server <folder>"`:
    32/32. An encrypted release runs when licensed and bound, is refused without a licence, from a
    second identity, when tampered, after a refund and after a staff revoke, and a running server
    stops the resource by itself at the end of the offline grace (6.4 s after the refund, grace 9 s).
  What that settles: under Unity's Mono, `lua54.dll` and `scriptgo.dll` are found by full path, the
  function-pointer round trip to `luaL_loadbufferx` works, the identity file is created and reused,
  and Oxide compiles the plugin. The same two commands pass on that build with Carbon 2.0.264 in
  place of Oxide (verified, 30 checks; 32/32). What it does not settle: anything a connected player
  triggers.
- **A real Rust dedicated server on Linux** (2026-11-10: the public Linux build, Oxide 2.0.7900 for
  Linux, in a container of `mcr.microsoft.com/dotnet/sdk:10.0`, Ubuntu 24.04, as root, loopback):
  `pwsh -File tools/rust-server-linux.ps1 -RustServer <folder> -Mode both`. The probe is verified,
  30 checks, and the escrow chain is 32/32, with `liblua54.so` and `libscriptgo.so` loaded by full
  path (`dlopen`) under Unity's Mono and the POSIX identity file. Two things seen there and handled
  by the test tools, neither about escrow: two server starts out of about twenty-five never reached
  their plugins (the wrapper now restarts once and says so), and a request sent after minutes of waiting
  failed on a connection the API had closed (the script no longer reuses connections).
- `dotnet run --project sdk/adapters/rust/tests -c Release`: 50 bridge tests in a **plain .NET 10
  process** (2026-11-11: 33 passed, 17 skipped without the native library). The services are fakes; the KeraLua Lua 5.4.8 VM, the portable core, this glue, the
  conformance probe and the official kits are the real ones. On that host, `sg_probe` passes 25/25
  SGCHECKs. This is not a Rust server and does not count as verification by itself.
- 5 of the 50 are perks tests (`perks.*`): asked at join with the `steam:` identifier, events
  pulled, applied and acknowledged, the cache kept in the data files across a restart, an unlinked
  server keeping nothing, no perks without http. The API there is a fake. **Perks have not run on a
  Rust server**: no Rust server was available for a run with `sdk/conformance/sg_probe_perks`.
- 25 of the 50 are escrow tests. 17 of those use the real native library (`scriptgo.dll`, Windows
  x64, built from `sdk/native`) and are **skipped, with a message**, when it is not found: set
  `SCRIPTGO_NATIVE_DIR`, or copy the library to `sdk/adapters/rust/native/<rid>/` (gitignored). The
  key service, the clock and the files are fakes there too. One of them runs a bundle packed by the
  TypeScript packer (the cross-language vector of `sdk/dotnet`), so the packer, the native library
  and this bridge agree on the format. The other 8 need no native library.
- `node sdk/adapters/rust/build.mjs --native <build of sdk/native>`: `dist/rust/` with
  `scriptgo.dll` next to `lua54.dll`, and `libscriptgo.so` when `sdk/native/build-linux.ps1` has
  built it.
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
- Escrow has its own list: "Escrow limits".
