# SCRIPT//GO .NET kit

`ScriptGo.Host` runs SCRIPT//GO resources inside a .NET 10 program: an engine or game server written
in C# embeds it, and resources written for any SCRIPT//GO environment run there in Lua, TypeScript
or JavaScript. It is the `dotnet` environment of `scriptgo verify`. Status: experimental, measured
on Windows x64.

| Project | What it is |
|---|---|
| `ScriptGo.Host` | The library: manifests (`scriptgo.lua`, `scriptgo.json`), resources and dependencies, events, exports across languages, quotas, native modules, and the guests: Lua 5.4 on KeraLua, JavaScript on Jint |
| `ScriptGo.Escrow` | Escrow on its own, for **any** .NET host: verify a signed, encrypted release, get its key released to this server, decrypt in native memory (`libscriptgo`, `sdk/native`), load Lua chunks into your own VM. No dependency on `ScriptGo.Host`. Its own readme: `ScriptGo.Escrow/README.md` |
| `ScriptGo.Host.Standalone` | `scriptgo-dotnet`, a console host: `run`, `verify`, `version` (setup in `SETUP.md`) |
| `ScriptGo.Host.Tests` | MSTest suite for both libraries: `dotnet test` |

The rules every language follows (codec, events, exports, quotas, failure tokens) are in
`docs/spec/multi-language.md`; the API resources see is `docs/spec/runtime-idl.json`.

## Embedding

```csharp
using ScriptGo.Host;

var services = new HostServices
{
    Log = new ConsoleLog(),
    Storage = new FolderStorage("data/storage"),
    // Players, Permissions, Config, Ui and Http are the engine's: implement IHostPlayers, ...
};
using var host = new ScriptGoHost(services, new HostOptions { Environment = "dotnet" });

// Natives the engine offers, described once (docs/spec/native-module.schema.json).
var world = NativeModule.FromJson("""
    { "name": "world", "global": true,
      "functions": [{ "name": "greet", "params": [{ "name": "who", "type": "string" }], "returns": "string" }] }
    """);
world.Bind("greet", call => [SgValue.Of($"hi {call.Arg(0).AsText()} from {call.Language}")]);
host.RegisterNativeModule(world);

host.AddResource("resources/sg_inventory");
var started = host.Start("sg_inventory");
if (!started.Ok) Console.WriteLine($"not started: {started.Reason}");

host.PlayerJoin(1, "Ann");
host.RunFor(100);          // or host.Tick() once per engine frame
host.StopAll();
```

- **One thread.** The host and every guest run on the thread that calls `Tick`; HTTP answers are
  completed off-thread and delivered on a later tick.
- **Services** (`IHostServices`): clock, resource files, log, storage, players, permissions,
  config, UI, HTTP. Without storage, permissions, config, UI or HTTP the matching capability is
  absent, and calls that need it answer `capability_unavailable:<cap>@<env>`.
- **Natives** appear as `ScriptGo.natives.<module>.<function>` (and as a global `<module>` when
  `global` is set). `NativeModule.ToTypeScript()` and `ToLuaAnnotations()` write their typings.
  A permission on a native must be declared in the resource's manifest and granted by
  `HostOptions.GrantPermission`.
- **Quotas** (`HostOptions.Quotas`): Lua instructions and heap; JavaScript statements, wall time,
  allocation and call depth; threads, handlers, exports, queued events. They are per host-level
  entry, so a resource cannot reset another's budget by calling it in a loop. A runaway loop is
  stopped in both languages; the tests prove it (`QuotaTests`).
- **TypeScript** is loaded compiled: `x.ts.js` next to `x.ts`, as `scriptgo pack` and
  `scriptgo verify` produce it (esbuild, pinned in `packages/cli`).

## Escrowed resources

An escrowed release (`scriptgo pack --escrow`) ships encrypted; its key is released by the master
only to a licensed server, wrapped to that server's own key. `ScriptGo.Host` runs one through
`ScriptGo.Escrow`:

```csharp
using ScriptGo.Escrow;

var files = new EscrowResourceFiles();                       // escrow releases + folders on disk
using var host = new ScriptGoHost(new HostServices { Files = files }, new HostOptions { Environment = "dotnet" });
using var identity = EscrowIdentity.LoadOrCreate("data/scriptgo.identity");
var keys = new HttpEscrowKeyService(http, new("sg_dep_...", "creator//name", "dotnet"));

var loaded = await EscrowLoader.LoadAsync(bundleBytes, files, identity, keys, trustedSignerPublicKey);
if (!loaded.Ok) { Console.Error.WriteLine(loaded.Reason); return; }     // refused:revoked, unwrap_failed:...
var name = host.AddResource(loaded.ResourceRoot!, checkFolderName: false);
host.Start(name);
EscrowLoader.BindLease(host, name, loaded.Content!);        // renew the key; stop the resource on revocation
```

- **Lua** scripts of an escrowed resource, `require`d modules included, are compiled by the native
  library straight into the guest's `lua_State`: the source is never a managed string or array
  (`loaded.Content.ManagedCopies` stays 0; `EscrowHostTests` asserts it).
- **JavaScript and TypeScript** guests read their source through the managed door
  (`EscrowContent.ReadAllBytes`), because Jint takes managed source. That path is weaker against
  memory inspection, and it is the engine's limit, not a setting.
- `EscrowMaterializer` writes a decrypted release to a folder for hosts that can only load from
  disk. That is the **license-only-grade fallback**: no code-secrecy claim is left on it.
- The native library must be built once (`pwsh -ExecutionPolicy Bypass -File sdk/native/build.ps1`,
  Windows x64). Without it the default backend fails closed with a message that says so; the
  managed fallback is an explicit opt-in.

Escrow is deterrence, traceability and revocation. The operator of the machine can still recover a
running resource from their own process; nothing in this kit claims otherwise. The guide for
platform owners is `docs/guides/bring-escrow-to-your-platform.md`; a runnable example is
`sdk/examples/host-escrow-dotnet`.

`pwsh -ExecutionPolicy Bypass -File sdk/dotnet/pack.ps1` packs `ScriptGo.Escrow` and `ScriptGo.Host`
into `sdk/dotnet/artifacts/` (gitignored). Neither package is published.

## Limitations

- JavaScript memory is bounded per entry (what the host thread allocates while the entry runs),
  not as a live heap size: Jint has no per-engine heap limit.
- Server and client sides run in one process with one local player; there is no network between
  them.
- C# guests are not built yet (phase 3). Guests derive from the internal `Guest` class, and
  `ScriptGoHost` picks one per script language; a `.cs` script is refused by the manifest today.
- Declarative manifest `exports` are found as global functions; a TypeScript bundle's top-level
  functions are not globals, so TypeScript resources register exports with `exports(name, fn)`.

## Tests

```bash
dotnet test sdk/dotnet/ScriptGo.Host.Tests
```

They cover the guests, cross-language calls and events, quotas, natives, the shared codec vectors
(`sdk/conformance/vectors/codec.json`) and the shared manifest fixtures (`sdk/lua/spec/fixtures`),
and escrow: the cross-language vector on the native and the managed backend, every refusal on both,
the lease with a manual clock, identity persistence, and the third-party example run as a process.
The escrow tests need the native library on Windows x64 (they fail, naming the build command, when
it is missing). On platforms where it has not been built, the native-only tests are inconclusive
and the tests that cover both backends still run on the managed one.
