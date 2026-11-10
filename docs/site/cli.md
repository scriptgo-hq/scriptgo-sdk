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
| `scriptgo grant create\|list\|revoke` | Grants, lists or revokes free licenses for your own packages. Nothing is sold |
| `scriptgo escrow inspect\|install\|identity\|load` | Protected releases: read a bundle, install it encrypted for OPEN//77, or open it with the reference loader |

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

#### Publish a protected release

```bash
scriptgo publish --escrow --escrow-ignore config.lua --owns-code
```

`--escrow` encrypts the release on your machine before it is uploaded.

- **What is encrypted:** your server-side code. Files a host sends to game clients (shared and
  client scripts, `files`, `web_files`) cannot be secret, so they stay readable. So do the manifest,
  `README.md`, `CHANGELOG.md` and `LICENSE`, and anything you name with `--escrow-ignore <glob>`
  (repeatable), for example a config file an operator must edit.
- **Who signs:** the bundle's `escrow.json` is signed with your own key. The CLI creates it on first
  use in `~/.scriptgo/release-signing.key`; `SCRIPTGO_SIGNING_KEY` (a base64 32-byte seed) overrides it.
  Keep that file: buyers pin its public key.
- **Where the key goes:** the content key is sent to SCRIPT//GO once, in the upload, and sealed there.
  This command never writes it to disk and never prints it.
- A package that can run on OPEN//77 gets its `open77.lua` and shim generated into the bundle as
  signed readable files.

`scriptgo pack --escrow` writes the bundle and a separate key file instead of uploading. Publish
that pair later with `scriptgo publish --bundle <file.escrow.zip> --escrow-key <file.json> --package <slug> --owns-code`.
The key file is a secret: never commit it and never ship it with the bundle.

Protection is deterrence and traceability, not DRM. A licensed operator can still read what their
own host decrypts. See [Protect your work](/docs/protect-your-work).

### scriptgo add

```bash
scriptgo add kestrel//inventory-pro
```

Package identifiers use the `creator//package` form everywhere in the CLI and the UI, with an
optional `@version`. URLs use `/packages/creator/package`. The command downloads the release
archive and checks its SHA-256 against the `X-Sha256` header and the registry listing. On a
mismatch nothing is written. It then extracts the resource into `./resources/<resource>`
(`--dir` to change it; `--force` replaces an existing folder).

Every published release is signed by the registry, and `add` checks that signature before it
writes a file. The first time it talks to a registry it pins that registry's release keys in
`~/.scriptgo/trusted-keys.json` and says so. A release signed by a key that is not pinned is refused:
if the registry rotated its key, compare the fingerprint and pass `--trust-new-key`. Set
`SCRIPTGO_RELEASE_KEYS` (comma-separated public keys) to pin keys yourself, for example in CI.
`--allow-unsigned` exists only for a registry older than release signing.

Paid packages install like free ones; the license is checked at runtime by the resource itself.
See [Licensing API](/docs/licensing-api).

A **protected** release arrives as its encrypted bundle, and only for a licensed customer: log in
as the license holder, or pass `--deployment-token`. The bundle is saved as
`./resources/<resource>-<version>.escrow.zip` and is not extracted.

### scriptgo grant

```bash
scriptgo grant create inventory-pro --to <account id> --deployments 2 --expires-days 90 --note "Night City RP"
scriptgo grant create inventory-pro --server-key <server public key> --environment standalone --name their-server
scriptgo grant list   inventory-pro
scriptgo grant revoke <license id> --reason "the partnership ended"
```

Grants a **free license** for one of your own packages, so a protected release runs on the servers
you chose. Nothing is sold and no payment provider is involved. It needs `scriptgo login` as the
package's creator.

- `--to` names another account by its account id (`scriptgo login` prints it; it is also in
  Dashboard → Settings) or by a creator username. An e-mail address is refused.
- `--server-key` is for an operator without an account. They run `scriptgo escrow identity` on
  their server and send you the public key. You hold the license, its one deployment is bound to
  that key, and the deployment token is printed **once** for you to hand over. It does not work on
  another server.
- `list` shows each grant with its status, and says why when no new grant can be issued (a
  moderation hold, no published release, the daily allowance used up).
- `revoke` needs `--reason`. The key endpoint refuses the license from then on; a running server
  stops when its offline grace ends.

A granted license is an ordinary license: same binding, same key endpoint, same revocation. See
[Protect without selling](/docs/protect-your-work#protect-without-selling).

### scriptgo escrow

```bash
scriptgo escrow inspect  resources/inventory_pro-1.5.0.escrow.zip
scriptgo escrow identity --identity ./server-identity.json
scriptgo escrow load     --bundle resources/inventory_pro-1.5.0.escrow.zip \
    --package kestrel//inventory-pro --environment standalone \
    --deployment-token "$SCRIPTGO_DEPLOYMENT_TOKEN" --identity ./server-identity.json \
    --trusted-signer <the creator's key> --once --out resources/inventory_pro
scriptgo escrow install  resources/inventory_pro-1.5.0.escrow.zip --target open77 --out <resources folder>
```

- `inspect` prints what a bundle holds, readable and encrypted, and checks its signature. It needs
  no key.
- `identity` creates the server's key pair. The private half stays in that file, on that server.
  The licence page shows the fingerprint once the deployment is bound.
- `load` is the **reference loader, not a compiled host**. It checks the bundle, asks SCRIPT//GO for
  the key wrapped to this server, decrypts in memory and adds the delivery marker. `--out` writes
  the decrypted copy to disk for a host that only reads files: that is licence-only protection,
  because the operator can read the disk. `--lua lua54` runs the resource once in the standalone
  host. Without `--once` it stays up, asks again before each answer expires, and stops when the
  offline grace of its last valid answer ends. It exits `0` when the resource ran, `1` when it
  was refused, `3` when it stopped at the end of grace, `4` when the API could not answer at
  start. A key is never written to disk, so a start always needs the API.
- `install --target open77` writes an OPEN//77 resource folder with the scripts still encrypted.
  It decrypts nothing: a server with that feature switched on does it. It refuses a bundle that was
  not packed for OPEN//77.

For code that stays in memory, use a compiled host: the [.NET kit](/docs/dotnet-kit).

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
