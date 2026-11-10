# Working on the SCRIPT//GO SDK

Read this before changing anything. It applies to people and coding agents alike. Machine-specific
notes (accounts, local folders, ports) are never committed: if a `CLAUDE.local.md` exists next to
this file, read it too.

## Repositories

| Repository | What it holds |
|---|---|
| `scriptgo-hq/scriptgo-sdk` (this one, public, MIT) | The SDK: Lua core, adapters, `libscriptgo`, the .NET kit, the CLI, the npm packages, the specs and the website's documentation pages |
| `scriptgo-hq/scriptgo-api` (private) | The platform: API, worker, database, licensing, commerce. It uses this SDK by tag |
| `scriptgo-hq/scriptgo-web` (public, proprietary licence) | The website, scriptgo.dev. It renders `docs/` from this SDK by tag |
| `scriptgo-hq/.github` (public) | The organisation's profile page |

This repository is the source of the SDK. The platform pins a tag (`v<version>`): a change here
reaches the API and the website when they move to that tag. A change to the API contract
(`packages/shared`, `docs/spec/api.md`) is made here first, tagged, then adopted by the API.

## Rules

**Owner's decisions**
- Never merge into `main`, push, tag, publish (npm, NuGet) or open a pull request without the
  owner's go.
- Never create accounts, obtain keys or tokens, or accept licence agreements or terms on the
  owner's behalf.

**What gets committed**
- No secrets, `.env`, keys, tokens, absolute local paths, usernames or e-mail addresses.
- No build output (`bin/`, `obj/`, `dist/`): it carries local paths.
- Commits are made with the project's own Git identity, never a personal one.
- Everything here is MIT. Third-party code keeps its licence and is listed in
  `sdk/native/THIRD-PARTY-NOTICES.txt` or next to it.

**Git**
- Work on a branch. Never `git stash` bare (the stash is shared between worktrees).
- Never rewrite history that has been pushed.

**Security**
- Vetted cryptography only (libsodium, NSec, Node crypto): never hand-rolled. Keys are never
  written to disk in clear and never shipped to a client.
- Never oversell protection: encryption at rest and in transit, keys never shipped, per-server
  binding, revocation, traceability. Never "unbreakable". Obfuscation is a labelled speed bump.

**Wording**
- A script is a SCRIPT//GO script that *runs on* platforms, never "for" one. A platform's own terms
  are information for the operator, never a SCRIPT//GO rule.
- An adapter's README says exactly what was run in the real runtime and what was not.

## Proving a change

```bash
corepack pnpm install
corepack pnpm -r run typecheck && corepack pnpm -r run test && corepack pnpm -r --filter "./packages/*" run build
node tools/lua-test.mjs                                  # after: pwsh -File tools/build-lua.ps1
(cd sdk/dotnet && dotnet test --project ScriptGo.Host.Tests)   # after: sdk/native/build.ps1 or build-linux.sh
node packages/cli/bin/scriptgo.mjs verify <package> --env <env>
```

CI (`.github/workflows/ci.yml`) runs the packages, the Lua core and the .NET kit on Linux. Say
what was not run and why. A green unit test is not a run in the real environment.
