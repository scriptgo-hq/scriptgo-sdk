---
title: CLI
description: The scriptgo command line for creating, testing, verifying, publishing and installing resources.
order: 5
---

> [!WARNING]
> The CLI is in preview. Its flags and output may change before the first stable release. When a
> command and this page disagree, `scriptgo --help` wins.

The CLI is called `scriptgo`. It talks to the same HTTP API as the website (see
[API reference](/docs/api)) and authenticates with a personal access token.

## Install

The CLI ships as the `@scriptgo/cli` package and runs on Node.js 22 or later. Installation
instructions for a published build will appear here once the package is released. Inside the
SCRIPT//GO repository, run it as `node packages/cli/bin/scriptgo.mjs <command>`.

`test`, `run` and `verify` also need Lua interpreters: the ones `tools/build-lua.ps1` builds into
`tools/runtimes/bin`, or `lua`/`luajit` on the `PATH`.

## Sign in with an access token

The CLI never asks for your password. It uses a personal access token.

1. Open [Dashboard → Settings](/dashboard/settings), section **Access tokens**.
2. Create a token. It starts with `sg_pat_` and is **shown once**. Copy it then.
3. Give it to the CLI:

```bash
scriptgo login --token sg_pat_...      # or --token - to read it from stdin
```

`login` checks the token against the API and saves it in `~/.scriptgo/credentials.json`.
`--api <url>` picks the API (default `http://localhost:4100`). The environment variables
`SCRIPTGO_TOKEN` and `SCRIPTGO_API` win over the saved file.

The CLI sends the token as `Authorization: Bearer sg_pat_...` on every request. A token is
scoped to one user. Revoke it from the same settings page if it leaks.

> [!NOTE]
> Keep tokens out of resource folders and repositories. In CI, store the token as a secret
> variable.

## Commands

| Command | What it does |
|---|---|
| `scriptgo init <name>` | Creates a resource folder: manifest, `shared/`, `server/`, `client/`, `tests/` |
| `scriptgo validate <dir>` | Checks the manifest, the naming and sandbox rules and the referenced files |
| `scriptgo test <dir>` | Runs the resource's `test_script` files in the standalone host |
| `scriptgo run <dir>...` | Runs resources in the standalone host, in simulated or real time |
| `scriptgo verify <dir>` | Runs the resource on its environments and writes compatibility reports |
| `scriptgo pack <dir>` | Builds the `.zip` you can upload on the website: the same archive `publish` sends, README and tests included. `--target open77` builds an OPEN//77 resource folder instead |
| `scriptgo login` | Saves a personal access token |
| `scriptgo publish [dir]` | Uploads a release of the resource and publishes it |
| `scriptgo add creator//package` | Installs a package into `./resources` |
| `scriptgo license activate\|verify` | Activates a deployment or verifies a license |

### scriptgo init

```bash
scriptgo init inventory_pro
```

Creates `inventory_pro/` with a `scriptgo.lua` manifest, `shared/config.lua`, `server/main.lua`,
`client/main.lua` and `tests/main_test.lua`. `--dir` picks the parent folder, `--author` the
author. The resource name is 3 to 64 characters of `a-z`, `0-9` and `_`, starting with a letter,
and must match the folder name. See [Quickstart](/docs/quickstart) for what each file is for.

### scriptgo test

```bash
scriptgo test inventory_pro
```

Parses `scriptgo.lua` with the same grammar as the registry, then runs every `test_script` in the
standalone host, once per Lua interpreter found (Lua 5.4, 5.1, LuaJIT; `--lua` picks one). A
failed expectation or an uncaught error fails the run and the command exits with a non-zero
status, so it fits in CI.

Test scripts are never shipped to clients.

### scriptgo verify

```bash
scriptgo verify inventory_pro --env all
```

Runs the resource and writes one `CompatibilityRun` JSON report per run into the repository's
`verification/reports/` (`--out` to change it). `--env` is `standalone` (the default, one run
per Lua interpreter), `open77`, `luanti`, `love2d`, `godot`, `neovim`, `dotnet` or `all`:

- `open77` packs the resource and starts a real OPEN//77 dedicated server given with
  `--open77-server` (or `OP77_SERVER_EXE`). Only the server half runs.
- `luanti` runs the official Luanti server image in Docker, with no network.
- `love2d` runs LÖVE headless (`lovec`) on `examples/love2d/demo`, ticked by real frames. The
  binary comes from `--love`, `SCRIPTGO_LOVE` or `tools/runtimes/love`.
- `godot` runs Godot headless on `examples/godot/demo` with lua-gdextension, ticked by real
  frames. The binary comes from `--godot`, `SCRIPTGO_GODOT` or `tools/runtimes/godot`; run
  `examples/godot/demo/setup.ps1` once first.
- `neovim` runs `nvim --headless --clean -l` on the plugin's verify mode, ticked by the plugin's
  own timer on Neovim's event loop. The binary comes from `--nvim`, `SCRIPTGO_NVIM` or
  `tools/runtimes/neovim`.
- `dotnet` runs the console host of the .NET kit (`sdk/dotnet`): Lua on KeraLua, JavaScript on
  Jint. The resource and its dependencies are copied to a temporary folder where every
  TypeScript entry is compiled with esbuild, then verified there. Needs the .NET 10 SDK
  (`--dotnet`, `SCRIPTGO_DOTNET` or the default install); the host is built on first use.

`--lang lua|ts|js` says which guest language the run is evidence for; by default the resource's
own (`ts` when it has TypeScript scripts). The `dotnet` reports are tagged per language
(`dotnet-lua`, `dotnet-ts`); every other environment runs Lua only and skips another language.

Without the server binary, Docker or the engine, that run is reported as skipped and writes no
report. `--stub-api` starts a local stand-in for the licensing API and gives the resource its URL
and a valid key (standalone, LÖVE, Neovim and OPEN//77 runs); `--api <url> --license-key <key>` uses a
real API instead.

#### The README example runs too

Mark one Lua block of your `README.md` as runnable:

````md
```lua runnable
CreateThread(function()
    print(exports.sg_eventbus:publish("shop.sale", { item = "water", price = 3 }))
end)
```
````

Every run then starts that block as the server script of a resource `<name>_readme`, which
depends on your package, next to it. What it prints is in the run's log, the check
`readme_example` says whether it started, and an error in it fails `no_runtime_errors`. The
registry's home page shows this block beside the output each environment recorded, so the code
a README shows is code that ran there. `--no-readme-example` leaves it out.

Call other resources' exports from a thread, a handler or `onResourceStart`, never at file scope:
every SCRIPT//GO host refuses that with `resource_preparing`, so you find out on your machine rather
than on a live server.

These reports are what the registry ingests to show a compatibility status. The shape is defined
in the [API reference](/docs/api):

```ts
CompatibilityRun = { runId, package: "sg_eventbus" | "scriptgo//event-bus", version, environment,
                     status: "verified" | "failing",
                     runtimeVersion, adapterVersion, luaVersion, ranAt, durationMs, log,
                     checks: { name, status, message }[], evidence: { kind, path }[] }
```

`scriptgo verify` writes the resource name as `package`.

A report you produce locally is evidence for you. The registry shows **Verified** only for runs
ingested through `POST /v1/admin/compatibility-runs` with an admin ingest token, never for a
status a creator types in.

### scriptgo publish

```bash
scriptgo publish --owns-code
```

1. Packs the resource folder into a zip archive: the manifest, every referenced file, the test
   scripts and `README.md`, `CHANGELOG.md` or `LICENSE` when present.
2. Creates the package on first publish. Its name is the resource name with `_` turned into `-`,
   or `--package <slug>`.
3. Calls `POST /v1/creator/packages/:name/releases` with the archive. The API stores it by
   SHA-256, parses the manifest and starts validation.
4. Waits for validation (`--timeout`, 120 seconds by default) and prints the checks.
5. With `--owns-code`, declares your rights to the code and publishes. Add
   `--targets-proprietary-game` when the code targets or includes content from a proprietary game.

Without `--owns-code` the release stays validated but unpublished; you can finish it from your
dashboard. `--dry-run` only packs. A published version is immutable: to fix `1.5.0`, publish
`1.5.1`.

You need `scriptgo login` and a creator profile before you can publish. Create the profile from
the dashboard.

### scriptgo add

```bash
scriptgo add kestrel//inventory-pro
```

Package identifiers use the `creator//package` form everywhere in the CLI and the UI, with an
optional `@version`. URLs use `/packages/creator/package`. The command downloads the release
archive and checks its SHA-256 against the `X-Sha256` header and the registry listing. On a
mismatch nothing is written. It then extracts the resource into `./resources/<resource>`
(`--dir` to change it; `--force` replaces an existing folder).

Paid packages install like free ones; the license is checked at runtime by the resource itself.
See [Licensing API](/docs/licensing-api).

## Exit codes and errors

Commands exit with `0` on success, `2` on a usage error and another non-zero code on failure.
`scriptgo license verify` exits `1` when the API refuses the license and `3` when the API could
not answer. API errors are printed with their code and message, taken from the standard error
body:

```json
{ "error": { "code": "snake_case", "message": "Human sentence." } }
```

Manifest errors carry the code from the parser, for example `invalid_resource_name` or
`invalid_version`. [Troubleshooting](/docs/troubleshooting) lists them with fixes.
