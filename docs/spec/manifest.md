# Resource manifest: `scriptgo.lua` / `scriptgo.json`

A SCRIPT//GO package is a **resource**: a folder with a declarative manifest, shared/client/server
scripts (Lua, JavaScript or TypeScript, see [Script languages](#script-languages)), optional files. Anyone who has written a resource for a multiplayer game server already
knows the format.

```text
inventory_pro/
  scriptgo.lua          manifest
  shared/core.lua       portable business logic, no host calls
  server/main.lua       wires the core to the runtime (exports, events, storage)
  client/main.lua       optional client side (UI)
  env/love2d/hud.lua    optional environment-specific scripts
  tests/core_test.lua   run by `scriptgo test`, never shipped to clients
  README.md
```

## Parsing rules

- The manifest is **parsed, never executed**. Both parsers (Lua: `sdk/lua/scriptgo/manifest.lua`,
  TypeScript: `packages/manifest`) implement the same grammar and share the fixtures in
  `sdk/lua/spec/fixtures/manifests/`.
- A manifest is a sequence of directives. A directive is an identifier followed by one or more
  arguments. Each argument is a string, a boolean, a number, or a table. Call parentheses are
  optional: `resource "x"` and `resource("x")` are equivalent. Curried forms are allowed:
  `environment_script "godot" "env/godot/ui.lua"`.
- Tables hold either a list of scalars (`{ "a", "b" }`) or string keys (`{ key = "v" }`).
  Trailing commas and `;` separators are accepted.
- Comments: `-- line` and `--[[ block ]]` (any `=` level).
- Singular and plural forms are equivalent (`server_script` / `server_scripts`). Repeated list
  directives accumulate in order.
- **Unknown directives are kept and reported as warnings, never errors**, so directives specific
  to one environment and future ones do not break parsing. Hosts that also ignore directives they
  do not know can share a single manifest.
- Limits: manifest ≤ 256 KiB; the resource name is 3 to 64 lowercase letters, digits or `_`,
  starting with a letter (`^[a-z][a-z0-9_]{2,63}$`, the OPEN//77 rule), and must match the folder
  name when loaded from a folder.

## Core directives

| Directive | Value | Meaning |
|---|---|---|
| `resource` | string, **required** | Stable resource name (slug) |
| `version` | semver string, **required** | Resource version |
| `auto_start` | boolean | Start when the host starts (default `true`) |
| `shared_script(s)` | path(s) | Run on both sides, before side scripts |
| `server_script(s)` | path(s) | Run on the authoritative side only, never sent to clients |
| `client_script(s)` | path(s) | Run on the client side |
| `dependency/dependencies` | `"name"` or `"name >=1.2.0"` | Required resources, started first |
| `permission/permissions` | string(s) | Capabilities the resource asks the host for (an environment's own permission strings are accepted verbatim) |
| `file/files` | glob(s) | Extra files shipped with the resource |
| `export(s)` / `server_export(s)` | name(s) | Declarative exports of the client side (`exports`) and of the server side (`server_exports`): global functions of that name, published after the side's last script; a missing one fails the start with `manifest_export_missing:<name>`. Names match `^[a-z0-9][a-z0-9_-]{0,63}$` |
| `web_ui_page`, `web_file(s)` | path / glob | WebUI (hosts without a WebUI ignore them) |
| `open77_version` | range | OPEN//77 compatibility, read only by the OPEN//77 environment |

Paths are relative, use `/`, may not contain `..`, a drive letter or a leading `/`.
Script entries are `.lua`, `.js` or `.ts` paths or globs (OPEN//77 semantics: `*` and `?` stay in
one path segment, `**/` needs at least one intermediate directory, a trailing `**` matches
anything; matches run in sorted order). Cross-resource includes (`@other/file.lua`) are refused:
share code through `dependencies` + exports.

## SCRIPT//GO directives

| Directive | Value | Meaning |
|---|---|---|
| `scriptgo_version` | range | Runtime API range, e.g. `">=0.1.0"` |
| `title` | string | Display name, e.g. `"Inventory Pro"` |
| `description` | string | One-line summary |
| `author` | string | Creator username |
| `license` | SPDX id | `"MIT"`, `"Apache-2.0"`, `"LicenseRef-Proprietary"` ... |
| `repository` | URL | Source repository |
| `category` | slug | `inventory`, `permissions`, `economy`, `events`, `ui`, `admin`, `framework`, `vehicles`, `housing`, `quests`, `library`, `other` |
| `lua` | list | Lua dialects the code supports: `"5.1"`, `"5.4"`, `"luajit"` |
| `environments` | list | Environments the creator targets: `standalone`, `love2d`, `godot`, `luanti`, `open77`, ... |
| `capabilities` | list | Capabilities the resource **requires** (see `runtime.md`) |
| `optional_capabilities` | list | Capabilities used when present, with a fallback otherwise |
| `environment_script(s)` | `"<env>" "<path>"` or `"<env>" { ... }` | Scripts loaded only in that environment, after side scripts |
| `test_script(s)` | path(s) | Test files run by `scriptgo test` in the standalone host |
| `licensed` | boolean | The resource verifies a license at start (`ScriptGo.licensing`) |

## `scriptgo.json`

`scriptgo.json` is the same manifest in JSON, for tools and languages that would rather not write
the Lua DSL. Both parsers turn it into the same directive list, so every rule above applies:

- The file holds one JSON object; otherwise `invalid_json` (also for a syntax error).
- Each member is one directive, its key the directive name (singular and plural forms as in the
  DSL; a key given twice in both forms accumulates, in member order).
- A string, number or boolean is the directive's one argument; an array is a list of scalars. An
  object is accepted only for `environment_script(s)`, mapping each environment to a path or a list
  of paths. `null`, an object elsewhere, or a nested array or object inside a list is
  `invalid_value`, as is a value of the wrong type (`"licensed": "yes"`).
- `$schema` is ignored. Unknown members are kept and reported as `unknown_directive` warnings,
  like unknown DSL directives.
- Diagnostics carry no line number.

```json
{
  "resource": "inventory_pro",
  "version": "1.4.1",
  "scriptgo_version": ">=0.1.0",
  "capabilities": ["events", "storage"],
  "shared_script": "shared/core.lua",
  "server_scripts": ["server/main.ts"],
  "environment_scripts": { "love2d": "env/love2d/hud.lua" },
  "test_script": "tests/core_test.lua"
}
```

## Script languages

A script's language comes from its extension:

| Extension | Language | Runs as |
|---|---|---|
| `.lua` | `lua` | Lua source |
| `.js` | `js` | JavaScript source |
| `.ts` | `js` | the JavaScript the CLI compiled from it, `<entry>.js` (see [multi-language.md](multi-language.md#typescript)) |

- Any other extension in a script entry (`.cs` included) is `unsupported_script`. `test_script(s)`
  must be `.lua` (`unsupported_script` otherwise): `scriptgo test` runs them in the standalone Lua
  host.
- A host that cannot run a language one of its scripts uses refuses to start the resource with
  `language_unavailable:<language>@<environment>`. Only the scripts that host would run count: the
  shared scripts, the scripts of the sides it runs, and its own environment's scripts. The portable
  Lua core runs `lua` only; the .NET kit runs `lua` and `js`.
- A `.ts` entry whose compiled `<entry>.js` is missing fails the start with
  `typescript_not_compiled:<entry>`. A glob does not pick up `<entry>.ts.js` next to its `.ts`.
- One resource may mix languages; how values, events and exports cross between them is in
  [multi-language.md](multi-language.md).

## Resolution rules

1. A host looks for `scriptgo.lua`, then `scriptgo.json`, then an environment's native manifest
   name (`open77.lua` for the `open77` environment), and reads the first it finds; an `open77.lua`
   resource runs unchanged as long as it uses the portable API subset.
2. If a required capability is missing in the current environment, the resource **does not
   start**, and the host reports `capability_unavailable:<cap>@<environment>`.
3. If `environments` is declared and the current environment is not listed, the resource starts
   with a warning (`environment_undeclared`). The registry shows that environment as *Not tested*.
4. Script order: `shared_scripts`, then side scripts, then `environment_scripts` for the current
   environment, each in declaration order.

## Example

```lua
resource "inventory_pro"
version "1.4.1"
scriptgo_version ">=0.1.0"
open77_version ">=0.0.1"

title "Inventory Pro"
description "Stacks, weights, persistence and events."
author "kestrel"
license "MIT"
category "inventory"

lua { "5.1", "5.4", "luajit" }
environments { "standalone", "love2d", "godot", "luanti", "open77" }
capabilities { "events", "storage" }
optional_capabilities { "ui", "players" }

shared_script "shared/core.lua"
server_script "server/main.lua"
client_script "client/main.lua"
environment_script "love2d" "env/love2d/hud.lua"

test_script "tests/core_test.lua"

permissions { "local.events", "network.events", "filesystem.read", "filesystem.write" }
```
