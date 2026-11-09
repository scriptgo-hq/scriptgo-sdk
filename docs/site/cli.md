---
title: CLI
description: The scriptgo command line for creating, testing, verifying, publishing and installing resources.
order: 5
---

> [!WARNING]
> The CLI is in preview. The commands below are the ones the specs commit to; their flags and
> output may change before the first stable release. When a command and this page disagree,
> `scriptgo --help` wins.

The CLI is called `scriptgo`. It talks to the same HTTP API as the website (see
[API reference](/docs/api)) and authenticates with a personal access token.

## Install

The CLI ships as the `@scriptgo/cli` package and runs on Node.js 22 or later. Installation
instructions for a published build will appear here once the package is released. Inside the
SCRIPT//GO repository, it is available from the workspace.

## Sign in with an access token

The CLI never asks for your password. It uses a personal access token.

1. Open [Dashboard → Settings](/dashboard/settings), section **Access tokens**.
2. Create a token. It starts with `sg_pat_` and is **shown once**. Copy it then.
3. Give it to the CLI.

The CLI sends the token as `Authorization: Bearer sg_pat_...` on every request. A token is
scoped to one user. Revoke it from the same settings page if it leaks.

> [!NOTE]
> Keep tokens out of resource folders and repositories. In CI, store the token as a secret
> variable.

## Commands

| Command | What it does |
|---|---|
| `scriptgo init` | Creates a resource folder: manifest, `shared/`, `server/`, `tests/`, README |
| `scriptgo test` | Runs the resource's `test_script` files in the standalone host |
| `scriptgo verify` | Runs the resource in real runtimes and writes a compatibility report |
| `scriptgo publish` | Uploads a release of the resource in the current folder |
| `scriptgo add creator//package` | Installs a package into your project |

### scriptgo init

```bash
scriptgo init inventory_pro
```

Creates `inventory_pro/` with a `scriptgo.lua` manifest. The resource name must be a lowercase
slug (`a-z`, `0-9`, `_`, `-`, up to 64 characters) and must match the folder name. See
[Quickstart](/docs/quickstart) for what each file is for.

### scriptgo test

```bash
scriptgo test
```

Parses `scriptgo.lua` with the same rules as the registry, then runs every `test_script` in the
standalone host. A failed `assert` or an uncaught error fails the run and the command exits with
a non-zero status, so it fits in CI.

Test scripts are never shipped to clients.

### scriptgo verify

```bash
scriptgo verify
```

Runs the resource in the real runtimes available on the machine and writes one
`CompatibilityRun` JSON report per environment into `verification/reports/`. These reports are
what the registry ingests to show a compatibility status. The shape is defined in the
[API reference](/docs/api):

```ts
CompatibilityRun = { runId, package: "scriptgo//event-bus", version, environment,
                     status: "verified" | "failing",
                     runtimeVersion, adapterVersion, luaVersion, ranAt, durationMs, log,
                     checks: { name, status, message }[], evidence: { kind, path }[] }
```

A report you produce locally is evidence for you. The registry shows **Verified** only for runs
it ingested from its own CI with the ingest token, never for a status a creator types in.

### scriptgo publish

```bash
scriptgo publish
```

1. Packs the resource folder into a zip archive.
2. Calls `POST /v1/creator/packages/:name/releases` with the archive.
3. The API stores the archive by SHA-256, parses the manifest and starts validation.

The release then appears in your dashboard as **Validating**. Finish it there: review the
validation checklist, declare your rights to the code, then publish. A published version is
immutable: to fix `1.5.0`, publish `1.5.1`.

You need a creator profile before you can publish. Create one from the dashboard.

### scriptgo add

```bash
scriptgo add kestrel//inventory-pro
```

Package identifiers use the `creator//package` form everywhere in the CLI and the UI. URLs use
`/packages/creator/package`. The command downloads the release archive. The registry sends the
archive's SHA-256 in the `X-Sha256` header, so the download can be checked against it.

Paid packages install like free ones; the license is checked at runtime by the resource itself.
See [Licensing API](/docs/licensing-api).

## Exit codes and errors

Commands exit with `0` on success and a non-zero code on failure. API errors are printed with
their code and message, taken from the standard error body:

```json
{ "error": { "code": "snake_case", "message": "Human sentence." } }
```

Manifest errors carry the code from the parser, for example `invalid_resource_name` or
`script_glob`. [Troubleshooting](/docs/troubleshooting) lists them with fixes.
