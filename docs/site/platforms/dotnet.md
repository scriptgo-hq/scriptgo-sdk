---
title: .NET kit
description: How SCRIPT//GO scripts run on .NET kit: setup, capabilities, protection, limits and the real runs behind its status.
---

A library that C# engines and servers embed to run Lua, TypeScript and JavaScript scripts.

This page is generated from the SDK's platform registry (`sdk/environments.json`) and the adapter's `SETUP.md`. The [.NET kit page](/environments/dotnet) on the site is the short version.

| | |
|---|---|
| Status | Experimental: first real runs passed, more to measure |
| Runs on | Server and client |
| Languages | Lua 5.4; TypeScript; JavaScript |
| Protection | Code escrow |
| Runtime | .NET 10, with KeraLua 1.4.9 (Lua 5.4) and Jint 4.17.0 |

## How it runs

An embedded host kit: `ScriptGo.Host`, a .NET 10 library that a C# engine or server references and ticks from its own loop. It runs Lua 5.4 (KeraLua) and JavaScript or TypeScript (Jint) side by side, one VM per resource side and language. Its console host, `scriptgo-dotnet`, runs the verification.

The adapter's code and README: [`sdk/dotnet`](https://github.com/scriptgo-hq/scriptgo-sdk/tree/main/sdk/dotnet).

## Set up

The .NET kit is a library (`ScriptGo.Host`, .NET 10) that a C# engine or server embeds, plus a
console host (`scriptgo-dotnet`) that runs and verifies resources without an engine. It runs Lua
resources (Lua 5.4 through KeraLua) and TypeScript or JavaScript resources (Jint). It is
experimental and has been measured on Windows x64 only.

1. Install the .NET 10 SDK. The `scriptgo` CLI finds it on the `PATH`, in `DOTNET_ROOT`, in the
   default install folder, or through `--dotnet <path>` / `SCRIPTGO_DOTNET`.

2. Verify a resource on the kit. The first run builds the console host; TypeScript entries are
   compiled with esbuild into a temporary copy (the source folder is not changed):

   ```bash
   scriptgo verify resources/sg_inventory --env dotnet
   scriptgo verify resources/my_ts_resource --env dotnet --lang ts
   ```

3. Run resources with the console host. It loads compiled TypeScript (`x.ts.js` next to `x.ts`),
   which a `scriptgo pack` archive contains:

   ```bash
   dotnet sdk/dotnet/ScriptGo.Host.Standalone/bin/Release/net10.0/scriptgo-dotnet.dll run resources/sg_inventory --search resources --for 2000
   ```

4. Privileges, per-resource values and convars come from a JSON file (`--config`), as in the
   standalone host; `--data <dir>` keeps storage in JSON files instead of memory:

   ```json
   {
     "permissions": { "1": ["inventory.give"] },
     "resources": { "sg_inventory": { "slots": 12 } },
     "convars": { "scriptgo_api": "https://api.scriptgo.dev" }
   }
   ```

To embed the kit in an engine, see `sdk/dotnet/README.md`.

### Player perks

Player perks (`ScriptGo.perks`, `docs/spec/perks.md`): the server asks SCRIPT//GO which of the operator's perks a player has. It needs the server linked to the operator's account (Dashboard, Perks, Servers) and the link's token, a secret, in the host's settings.

```json
{ "convars": { "scriptgo_api": "https://api.scriptgo.dev", "scriptgo_server_token": "sg_srv_..." } }
```

Lua guests have `ScriptGo.perks`: the kit runs the portable perks module in the guest, over
`IHostHttp` and `IHostPlayers.Identifier` (the engine's own account id). JavaScript and TypeScript
guests do not have it yet: `capability_unavailable:perks@dotnet`. The cache is kept in memory.

## Capabilities

What the adapter provides. See [SDK and capabilities](/docs/sdk/capabilities) for what each one is.

| Capability | Support | Note |
|---|---|---|
| `events` | Supported |  |
| `logging` | Supported |  |
| `storage` | Supported | The integrator's IHostStorage; the console host keeps it in memory, or in JSON files with --data. |
| `players` | Partial | The console host simulates players; an integrating engine supplies its own through IHostPlayers. |
| `permissions` | Supported |  |
| `commands` | Supported |  |
| `config` | Supported |  |
| `ui` | Fallback | The console host writes notifications to its log; an engine implements IHostUi. |
| `http` | Supported | HttpClient off the host thread; the answer is delivered on the next tick. |
| `licensing` | Supported | Through the kit's HTTP, against the SCRIPT//GO API (checked against the API schemas by --stub-api). |
| `perks` | Partial | Lua guests: the kit runs the core's perks module in the guest, over IHostHttp and IHostPlayers.Identifier. JavaScript and TypeScript guests do not have it yet (capability_unavailable). |

## Protection

Code escrow: the kit's compiled loader decrypts in memory with a key released to this server only. The operator of the machine can still inspect their own process; that takes real effort and the copy is traceable.

See [Protect your work](/docs/protect-your-work) for what protection does and does not do.

## Assets

Maps, models, textures, sounds and other files players download. See [Selling assets](/docs/selling-assets).

| | |
|---|---|
| Support | Bundled with the resource |
| `assets` | files of the resource (resource.readFile) |
| `environment_asset` | files of the resource |

No game client downloads anything: assets are files of the resource.

Asset escrow: The host can read containers itself, but its operator holds the key: at-rest encryption only.

## Limits

- TypeScript must be compiled first (scriptgo pack or scriptgo verify do it with esbuild); the kit loads x.ts.js next to x.ts.
- The JavaScript memory quota bounds what one entry allocates on the host thread, not the live heap (Jint has no per-engine heap limit).
- Server and client run in one process: no real network between them.
- C# guests are not available yet (planned).
- Measured with .NET 10 on Windows x64 only.

## Real runs

Each row is a `scriptgo verify` run on .NET kit itself, not on a mock or an emulator: the package started there and its own tests reported back. Rows marked *probe* are SCRIPT//GO's conformance probes, which exercise the runtime and are never published as packages. See [how a status is earned](/docs/environments#how-a-status-is-earned).

| Script | Version | Ran on | Adapter | Checks passed | Date |
|---|---|---|---|---|---|
| `sg_probe` *probe* | 0.1.0 | .NET 10.0.11; KeraLua 1.4.9 (Lua 5.4); Jint 4.17.0 | dotnet-0.1.0 | 31/31 | 2026-11-09 |
| `sg_probe_net` *probe* | 0.1.0 | .NET 10.0.11; KeraLua 1.4.9 (Lua 5.4); Jint 4.17.0 | dotnet-0.1.0 | 18/18 | 2026-11-09 |
| `sg_probe_ts` *probe* | 0.1.0 | .NET 10.0.11; KeraLua 1.4.9 (Lua 5.4); Jint 4.17.0 | dotnet-0.1.0 | 32/32 | 2026-11-09 |
| `sg_xlang_lua` *probe* | 0.1.0 | .NET 10.0.11; KeraLua 1.4.9 (Lua 5.4); Jint 4.17.0 | dotnet-0.1.0 | 26/26 | 2026-11-09 |
