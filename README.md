<p align="center"><img src="docs/readme/banner.png" alt="SCRIPT//GO SDK" width="100%"></p>

# SCRIPT//GO SDK

**Write a script once. Run it in every world.** The SDK is everything a script developer or a
platform needs: the portable runtime, one adapter per environment, the `scriptgo` CLI, the protected
release loader, and the guides to bring SCRIPT//GO to a platform of your own.

MIT-licensed: use it, change it, and sell what you build with it.

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
| [`packages/cli`](packages/cli) | The `scriptgo` CLI |
| [`packages/shared`](packages/shared), [`manifest`](packages/manifest), [`escrow`](packages/escrow), [`types`](packages/types) | The npm packages: the API contract, the manifest parser, the protected-release format, the TypeScript declarations of the runtime |
| [`docs/spec`](docs/spec) | The contracts: runtime, manifest, multi-language IDL, escrow, perks, the API |
| [`docs/site`](docs/site), [`docs/guides`](docs/guides) | The documentation of [scriptgo.dev/docs](https://scriptgo.dev/docs): the website is built from these files (their links point to the website) |

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

## Install the CLI

Node.js 22 or later:

```bash
npm install -g https://github.com/scriptgo-hq/scriptgo-sdk/releases/download/v0.1.8/scriptgo-cli-0.1.8.tgz
scriptgo init my_script
scriptgo test my_script        # needs lua, lua5.4 or luajit on the PATH
```

The CLI talks to the production API, `https://api.scriptgo.dev`. `--api <url>` or `SCRIPTGO_API`
points it at another one (a local API in development).

## Work on the SDK

Requirements: Node 22+, Corepack (pnpm). Lua interpreters for the Lua tests; the .NET 10 SDK for
the .NET kit.

```bash
corepack pnpm install
node packages/cli/bin/scriptgo.mjs init my_script
node packages/cli/bin/scriptgo.mjs test my_script
node packages/cli/bin/scriptgo.mjs verify my_script --env standalone
```

Run the tests:

```bash
corepack pnpm -r run test          # CLI and its packages
pwsh -File tools/build-lua.ps1     # once: Lua 5.1, 5.4 and LuaJIT into tools/runtimes/bin
node tools/lua-test.mjs            # the Lua core on every interpreter found
pwsh -File sdk/native/build.ps1    # once: libscriptgo (sdk/native/build-linux.sh on Linux)
dotnet test --project sdk/dotnet/ScriptGo.Host.Tests
```

## npm packages

| Package | What it is |
|---|---|
| `@scriptgo/shared` | The API contract: zod schemas and TypeScript types |
| `@scriptgo/manifest` | The manifest parser and validator |
| `@scriptgo/escrow` | Protected releases: format, signing, sealing, watermarking |
| `@scriptgo/types` | TypeScript declarations of the runtime API, for scripts in TypeScript |
| `@scriptgo/cli` | The `scriptgo` command line, bundled into one file with the SDK's Lua core and adapters |

In this repository they run from their TypeScript sources; `pnpm run build` emits `dist/`, which is
what npm receives. A tag `v<version>` publishes them (`.github/workflows/release.yml`): its GitHub
release carries the tarballs, installable by URL
(`https://github.com/scriptgo-hq/scriptgo-sdk/releases/download/v<version>/scriptgo-<package>-<version>.tgz`),
and npm gets them once the scope is live. `ScriptGo.Escrow` for NuGet is packed by
[`sdk/dotnet/pack.ps1`](sdk/dotnet/pack.ps1).

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

## Contributing

Issues and pull requests are welcome. A change is done when it is proven where it runs: the tests
above, and for an adapter a run in the real runtime, written down in its README.
[`AGENTS.md`](AGENTS.md) holds the rules of this repository, for people and coding agents alike.

The SCRIPT//GO platform (the API and the website) is a separate, proprietary project. It consumes
this SDK by tag: a change here reaches it when it moves to a new tag.

## Licence

[MIT](LICENSE). Third-party components keep their own licences: libsodium and miniz in
[`sdk/native/THIRD-PARTY-NOTICES.txt`](sdk/native/THIRD-PARTY-NOTICES.txt).

Game, engine and provider names are trademarks of their owners; no endorsement is implied.
