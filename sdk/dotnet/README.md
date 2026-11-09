# SCRIPT//GO .NET kit

`ScriptGo.Host` runs SCRIPT//GO resources inside a .NET 10 program: an engine or game server written
in C# embeds it, and resources written for any SCRIPT//GO environment run there in Lua, TypeScript
or JavaScript. It is the `dotnet` environment of `scriptgo verify`. Status: experimental, measured
on Windows x64.

| Project | What it is |
|---|---|
| `ScriptGo.Host` | The library: manifests (`scriptgo.lua`, `scriptgo.json`), resources and dependencies, events, exports across languages, quotas, native modules, and the guests: Lua 5.4 on KeraLua, JavaScript on Jint |
| `ScriptGo.Host.Standalone` | `scriptgo-dotnet`, a console host: `run`, `verify`, `version` (setup in `SETUP.md`) |
| `ScriptGo.Host.Tests` | MSTest suite: `dotnet test` |

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
(`sdk/conformance/vectors/codec.json`) and the shared manifest fixtures (`sdk/lua/spec/fixtures`).
