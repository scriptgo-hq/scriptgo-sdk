---
title: Embed the .NET kit
description: Run SCRIPT//GO packages written in Lua, TypeScript or JavaScript inside a .NET 10 engine or game server.
order: 8
---

> [!WARNING] Experimental
> The .NET kit has been measured with .NET 10 on Windows x64 (its test suite also passes on Linux
> x64 in a container), and it is not on NuGet yet:
> reference it from the repository. Its API may change.

The .NET kit is a library, `ScriptGo.Host`, that a game engine or server written in C# embeds.
Packages written for any SCRIPT//GO environment then run inside it, in Lua or in TypeScript and
JavaScript, with the same runtime API they have everywhere else. Use it when your engine has no Lua
of its own; when it has one, [an adapter](/docs/create-adapter) is lighter.

## What is in `sdk/dotnet`

| Project | What it is |
|---|---|
| `ScriptGo.Host` | The library: manifests (`scriptgo.lua`, `scriptgo.json`), resources and dependencies, events, exports across languages, quotas, native modules, and the guests: Lua 5.4 on KeraLua, JavaScript on Jint |
| `ScriptGo.Host.Standalone` | `scriptgo-dotnet`, a console host: `run`, `verify`, `version`. It is the `dotnet` environment of `scriptgo verify` |
| `ScriptGo.Host.Tests` | The MSTest suite: guests, cross-language calls and events, quotas, natives, the shared codec vectors and manifest fixtures, and the embedding example below |

## Reference it

You need the .NET 10 SDK. The kit is not published as a package, so add a project reference to
`sdk/dotnet/ScriptGo.Host/ScriptGo.Host.csproj`:

```xml
<ItemGroup>
  <ProjectReference Include="path/to/sdk/dotnet/ScriptGo.Host/ScriptGo.Host.csproj" />
</ItemGroup>
```

## Embed it

This is the embedding example of the kit's README. The kit's test suite runs the same code
(`EmbeddingTests`), with its paths moved to a temporary folder.

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

In your engine, call `host.Tick()` once per frame or server step instead of `RunFor`, and
`PlayerJoin` / `PlayerDrop` when players come and go.

## One thread

The host and every guest run on the thread that calls `Tick`. HTTP answers are completed off that
thread and delivered on a later tick, so scripts never run on another thread.

## Services

`HostServices` holds what your engine provides. Each service is an interface:

| Service | Interface | Without it |
|---|---|---|
| Clock | `IHostClock` | The system clock |
| Resource files | `IResourceFiles` | Files from disk |
| Log | `IHostLog` | `ConsoleLog` |
| Storage | `IHostStorage` | `MemoryStorage`; `FolderStorage` keeps JSON files |
| Players | `IHostPlayers` | The players the host was told about (`PlayerJoin`) |
| Permissions, config, UI, HTTP | `IHostPermissions`, `IHostConfig`, `IHostUi`, `IHostHttp` | The capability is absent |

A call that needs a missing capability answers `capability_unavailable:<capability>@<environment>`,
the same token every host uses.

## Natives

Describe your engine's functions once, as a native module (`docs/spec/native-module.schema.json`):
name, parameters and their types, results, the side they run on, and an optional permission. Bind
a handler to each function and register the module. Every guest then sees it as
`ScriptGo.natives.<module>.<function>`, and as a global `<module>` when `global` is set.

- Arguments are checked against the declared types before your handler runs
  (`invalid_argument:<name>`), and values cross through the value codec: no functions, no cycles.
- A permission on a native must be declared in the resource's manifest and granted by
  `HostOptions.GrantPermission`.
- `NativeModule.ToTypeScript()` and `ToLuaAnnotations()` write the module's typings.

## Quotas

Each resource side has its own limits, set in `HostOptions.Quotas`. The defaults:

| Limit | Default |
|---|---|
| Lua instructions | 1,000,000 per entry |
| Lua heap | 64 MiB per state |
| JavaScript statements | 1,000,000 per entry |
| JavaScript wall time | 2 s per entry |
| JavaScript allocation | 64 MiB per entry |
| JavaScript call depth | 256 |
| Threads, event handlers, exports | 1,024, 2,048, 256 |
| Queued events | 4,096 host-wide |

Budgets are counted per host-level entry: a guest's tick, one event delivery, one call from your
engine. Nested calls in the same entry, synchronous exports across resources and languages
included, draw on what is left, so a resource cannot hand another a fresh budget by calling it in
a loop. A runaway loop is stopped in both languages, and the tests prove it (`QuotaTests`).

## TypeScript

Hosts never compile. `scriptgo pack` and `scriptgo verify` compile each TypeScript entry with
esbuild into `x.ts.js` next to `x.ts`, and the kit loads that file. Without it, a host fails with
`typescript_not_compiled`.

## Verify a package on the kit

```bash
scriptgo verify resources/sg_inventory --env dotnet
scriptgo verify resources/my_ts_resource --env dotnet --lang ts
```

The first run builds the console host. The `dotnet` environment page lists what passed.
An engine that embeds the kit is its own environment (`HostOptions.Environment`); to be listed,
run the conformance probes in it, as described in [Create an adapter](/docs/create-adapter#conformance).

## Limitations

- JavaScript memory is bounded per entry (what the host thread allocates while the entry runs),
  not as a live heap size: Jint has no per-engine heap limit.
- The console host runs the server and client sides in one process with one local player; there
  is no network between them.
- C# guests are not built yet (phase 3 of the plan). A `.cs` script is refused by the manifest.
- Declarative manifest `exports` are found as global functions; a TypeScript bundle's top-level
  functions are not globals, so TypeScript resources register exports with `exports(name, fn)`.
- Measured on Windows x64. On Linux x64 its test suite passes in a container, the escrow tests
  included, with the native library built there; no game or engine was run on Linux. Not measured
  on macOS.
