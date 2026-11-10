---
title: The SDK
description: What the SDK is made of, the two ways to integrate it in an engine or a server, and what is not built yet.
order: 7
---

A SCRIPT//GO package is written once, against one API. The SDK is what runs that API on each
host. This page lists its pieces, how an engine or a game server integrates it, and what is still
on the roadmap. The short version is on the [SDK page](/sdk).

## The pieces

| Piece | Where | What it is |
|---|---|---|
| Lua core | `sdk/lua/scriptgo` | Pure Lua. It runs on any Lua host (Lua 5.1 to 5.4, LuaJIT) and implements everything that does not depend on an engine: the manifest parser, the scheduler, events, exports, the value codec, the sandbox and the capability registry |
| Adapters | `sdk/adapters/<host>/` | One per host. Each maps the API onto what that host has. The contract is in [Create an adapter](/docs/create-adapter) |
| .NET host kit | `sdk/dotnet` | `ScriptGo.Host`, a .NET 10 library, and `scriptgo-dotnet`, its console host. Lua 5.4 (KeraLua) and JavaScript or TypeScript (Jint) side by side. Experimental. See [Embed the .NET kit](/docs/dotnet-kit) |
| CLI | `packages/cli` | `scriptgo`: `init`, `validate`, `test`, `run`, `pack --target`, `verify --env`, `publish`, `add`, `license activate` and `license verify`. See [CLI](/docs/cli) |
| `@scriptgo/types` | `packages/types` | TypeScript declarations for resources, generated from `docs/spec/runtime-idl.json` by `tools/gen-types.mjs` |
| Specs | `docs/spec` | `runtime.md` ([Runtime API](/docs/runtime)), `manifest.md` ([Manifest](/docs/manifest)), `multi-language.md`, `runtime-idl.md`, `api.md` ([HTTP API](/docs/api)) and `native-module.schema.json` |

## The API packages see

Every host gives packages the same runtime:

- threads and timers: `CreateThread`, `Wait`, `SetTimeout`;
- events on one host-wide bus, and network events between the server and client sides;
- exports between packages, and promises for calls that answer later (`exports.call`);
- `RegisterCommand`, `GetConvar` and the lifecycle and player events;
- the `ScriptGo` namespace: `storage`, `players`, `permissions`, `config`, `ui.notify`, `http`,
  `licensing`, `log`, `json`, `time`, `capabilities`.

What a host cannot offer is a missing **capability**, never a different API. A package declares
the capabilities it needs; a call to one the host lacks fails with
`capability_unavailable:<capability>@<environment>`. See
[SDK and capabilities](/docs/sdk/capabilities).

## Two ways to integrate

### Write an adapter, for a host that runs Lua

Engines, mod frameworks and game servers that already embed Lua keep their own VM. The core runs
in it unchanged; you write one adapter table (a clock, file reads, storage, privileges, config,
notifications and, optionally, players and HTTP) and call `host:tick()` from your main loop.

How the adapter ships depends on the host:

| Integration type | What it is | For example |
|---|---|---|
| Command-line host | The `scriptgo` CLI on a plain interpreter | [Lua Standalone](/environments/standalone) |
| Lua library | A module the game loads and ticks | [LÖVE](/environments/love2d) |
| Addon | Installed in the engine or the game server | [Godot 4](/environments/godot), [Garry's Mod](/environments/garrysmod) |
| Mod | A regular server mod | [Luanti](/environments/luanti) |
| Plugin | Loaded by the application or server | [Neovim](/environments/neovim), [Hytale](/environments/hytale), [Rust](/environments/rust), [BeamMP](/environments/beammp) |
| Computer program | Runs on an in-game computer | [CC: Tweaked](/environments/cctweaked) |
| Shim and pack target | For hosts that already run this resource shape: `scriptgo pack --target <host>` adds a shim that maps `ScriptGo.*` onto the host's own API | [FiveM](/environments/fivem) |

A host that has no Lua of its own embeds one: the Hytale plugin carries Cobalt (Lua 5.2 in Java),
the Rust plugin carries KeraLua (Lua 5.4 for .NET).

Each environment page has an **Integration** section: the type, the runtime and its Lua, the
sides, the selling rule, and what real runs proved there.

### Embed a host kit, for an engine without Lua

A host kit is a library in the engine's own language. The engine supplies its services and
describes its natives once; its users write Lua, TypeScript or JavaScript. The
[.NET kit](/docs/dotnet-kit) is the only kit today, and it is experimental. Native C, Node and
JVM kits are planned (below).

## Sides

A package has a server side and a client side, and a host declares which ones it runs:

- **Single-process hosts** run both in one process, with one local player. Network events are
  looped back through the value codec, so packages behave as on a real network.
- **Server-only hosts** run the server side only: Garry's Mod, Luanti, Hytale, Rust and BeamMP
  today.
- **Networked hosts** run real servers and real clients. Without a game client, only their server
  half can be verified.

## What counts as proof

Two separate facts are shown for every environment:

- **Adapter state**, read from the repository and from the reports: *Real run passed*, *Adapter
  written, awaiting a real run*, or *Not started* (no adapter code yet).
- **Status**, `available`, `beta`, `experimental` or `planned`. A written adapter does not change
  it: Hytale, Rust, BeamMP and FiveM stay `planned` until a real run passes.

A real run is `scriptgo verify` in the real runtime, which writes a report to
`verification/reports/`. Unit tests against a mock, a stub of the natives, a plain JVM or .NET
process, or an emulator are useful, but they never write a report and never count.

## Languages

| Language | Where | State |
|---|---|---|
| Lua | Every environment, on the host's own Lua (5.1, 5.2, 5.3, 5.4 or LuaJIT) | Runs everywhere |
| TypeScript and JavaScript | The .NET kit. TypeScript is compiled by esbuild at `scriptgo pack` and `scriptgo verify` time; hosts never compile | Experimental |
| C# | Planned as guest scripts compiled against an allowed API, with quotas | Next (phase 3), not started |

The API is defined once in `docs/spec/runtime-idl.json` and bound in each language's idiom:
`nil, reason` in Lua, `ScriptGoError` and promises in JavaScript. How values, events and exports
cross between languages is fixed in `docs/spec/multi-language.md`.

## On top of the SDK

- **Licensing and verification**: license keys, one activation per deployment, verification with
  an offline grace period, signed verification tokens. See [Licensing API](/docs/licensing-api).
- **Shops**: paid packages sell through the creator's own Tebex store, and SCRIPT//GO issues the
  license after a verified payment event. The Tebex connector has not run against a live store
  yet, and checkout stays off until written approval.
- **Compatibility proof**: statuses and package badges come from verification reports.
- **Imports**: `scriptgo add creator//name` downloads a release and checks its SHA-256 and the
  registry's signature before it writes a file.
- **Protection**: every published release is signed. A creator can also publish an encrypted
  release (`scriptgo publish --escrow`, or the option on the new-release page): the key is
  released only to a licensed server bound by its own key, and a refund or a revocation stops the
  next release. The .NET kit decrypts in memory. A host that runs plain script gets the licence
  check and the signature, and no code-secrecy claim. It deters copying and makes leaks
  traceable; it does not make copying impossible. See [Protect your work](/docs/protect-your-work).

## Not built yet

| Item | State | What it is |
|---|---|---|
| Native C ABI kit | Not started (phase 4) | `libscriptgo` with C headers, for C and C++ engines: Lua 5.4 or LuaJIT, and JavaScript on QuickJS |
| Node kit | Not started (phase 4, after the C kit) | For Node, Bun and Deno servers: Lua and JavaScript in WebAssembly, isolated per resource |
| JVM kit | Later | A general kit for Java servers. Only the Hytale plugin runs the core on a JVM today |
| C# guests | Not started (phase 3) | A spike and a security review come first; until then a `.cs` script is refused |
| In-memory escrow on more hosts | Planned | Today the in-memory loader is in the .NET kit. Other hosts that run compiled code are marked planned on the [environments page](/environments#protection); hosts that run plain script stay on licence and signing |
| SDK packages on NuGet and npm | Not published | The .NET kit, the CLI and `@scriptgo/types` |
| Linux and macOS | Partly measured | The desktop hosts (LÖVE, Godot, Neovim) were measured on Windows only. The .NET kit's test suite and the native escrow library also pass on Linux x64, in a container. Nothing was measured on macOS |
