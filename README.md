<p align="center"><img src="docs/readme/banner.png" alt="SCRIPT//GO SDK" width="100%"></p>

# SCRIPT//GO SDK

**Write a script once. Run it in every world.** The SDK is everything a script developer or a
platform needs: the portable runtime, one adapter per environment, the `scriptgo` CLI, the protected
release loader, and the guides to bring SCRIPT//GO to a platform of your own.

> This repository is published from the SCRIPT//GO monorepo (`scriptgo-hq/scriptgo`) by
> `tools/split/publish-sdk.sh`, with its history. Changes are made there, not here.

## What is inside

| Folder | What it is |
|---|---|
| [`sdk/lua`](sdk/lua) | The portable core in pure Lua (5.1, 5.4, LuaJIT): manifest, scheduler, events, exports, sandbox, licensing, `ScriptGo.perks` |
| [`sdk/adapters`](sdk/adapters) | One folder per environment, each with a README and a SETUP |
| [`sdk/native`](sdk/native) | `libscriptgo`: the C library (libsodium) that opens protected releases. Windows x64 and Linux x64 |
| [`sdk/dotnet`](sdk/dotnet) | The .NET host kit (`ScriptGo.Host`: Lua 5.4, JavaScript, TypeScript guests) and the `ScriptGo.Escrow` package |
| [`sdk/conformance`](sdk/conformance) | Probe packages every adapter must pass (`sg_probe`, `sg_probe_net`, …) |
| [`sdk/packages`](sdk/packages) | Official kits: `sg_eventbus`, `sg_inventory`, `sg_permissions` |
| [`sdk/examples`](sdk/examples), [`examples`](examples) | Example hosts (a fictional third-party engine included) and demo projects |
| [`packages/cli`](packages/cli) | The `scriptgo` CLI, with the manifest parser, the protected-release format, the API contract and the TypeScript types it uses |
| [`docs/spec`](docs/spec) | The contracts: runtime, manifest, multi-language IDL, escrow, perks, the API |
| [`docs/guides`](docs/guides), [`docs/site`](docs/site) | The guides, and the documentation pages of the website (their links point to the website) |

## Environments

| Environment | State |
|---|---|
| Standalone Lua, LÖVE, Godot 4, Luanti, Neovim | Verified in the real runtime |
| OPEN//77 (server) | Verified on a dedicated server; protected releases need the server's `resourceEscrow` feature |
| Rust (Oxide and Carbon) | Verified on a dedicated server, protected releases included |
| Garry's Mod | Beta, server side, verified on a dedicated server |
| .NET host | Experimental: Lua, JavaScript and TypeScript guests |
| FiveM, BeamMP, CC: Tweaked, Hytale | Built, not yet verified in the real runtime |

Each adapter's README says exactly what was run and what was not.

## Quick start

Requirements: Node 22+, Corepack (pnpm). Lua interpreters for the Lua tests; the .NET 10 SDK for
the .NET kit.

```bash
corepack pnpm install
node packages/cli/bin/scriptgo.mjs init my-script
node packages/cli/bin/scriptgo.mjs test my-script
node packages/cli/bin/scriptgo.mjs verify my-script --env standalone
```

Run the tests:

```bash
corepack pnpm -r run test          # CLI and its packages
pwsh -File tools/build-lua.ps1     # once: Lua 5.1, 5.4 and LuaJIT into tools/runtimes/bin
node tools/lua-test.mjs            # the Lua core on every interpreter found
pwsh -File sdk/native/build.ps1    # once: libscriptgo (sdk/native/build-linux.sh on Linux)
dotnet test --project sdk/dotnet/ScriptGo.Host.Tests
```

## Bring SCRIPT//GO to your platform

- **An adapter** gives the core a clock, persistence, players, privileges and output:
  [`docs/site/create-adapter.md`](docs/site/create-adapter.md), and any folder of
  [`sdk/adapters`](sdk/adapters) as a model.
- **Protected releases** on your own host:
  [`docs/guides/bring-escrow-to-your-platform.md`](docs/guides/bring-escrow-to-your-platform.md),
  with [`sdk/examples/custom-adapter-dotnet`](sdk/examples/custom-adapter-dotnet), a fictional
  engine that uses `ScriptGo.Escrow` and nothing else.

Protection is deterrence, traceability and revocation: server code encrypted at rest, keys never
shipped, a key released per server, revoked on a refund. The operator of a machine can ultimately
recover what their own process runs; SCRIPT//GO never claims otherwise.

## Licence

All rights reserved for now: the SDK's licence is being decided, and this repository is private
until then.

Game, engine and provider names are trademarks of their owners; no endorsement is implied.
