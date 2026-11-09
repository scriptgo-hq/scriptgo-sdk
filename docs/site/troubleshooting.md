---
title: Troubleshooting
description: Error codes and symptoms you may meet, what causes them, and how to fix them.
order: 8
---

Each entry gives the symptom, the cause and the fix. Codes in `monospace` are the exact strings
the runtime, the manifest parser or the API returns.

## Runtime

### `capability_unavailable:<capability>@<environment>`

**Cause.** The resource requires a capability the host does not provide, for example
`capability_unavailable:http@godot`. The host refuses to start the resource. The same error is
raised when code uses a member of a missing capability, or calls
`ScriptGo.capabilities.require(c)`.

**Fix.** If the resource can work without it, move it from `capabilities` to
`optional_capabilities` and guard each call with `ScriptGo.capabilities.has(c)`. Otherwise, run
the resource in an environment that provides it. See [SDK and capabilities](/docs/sdk/capabilities).

### `environment_undeclared` warning

**Cause.** The manifest declares `environments`, and the current one is not in the list. The
resource still starts.

**Fix.** Add the environment to `environments` once you have tested it there. Until a run passes,
the registry shows it as **Not tested**.

### A global is `nil`: `io`, `os.execute`, `load`, `debug`...

**Cause.** The sandbox does not expose `io`, `os.execute` and the rest of `os` (except
`os.time`, `os.clock`, `os.date`, `os.difftime`), `debug`, `package`, `load`, `loadstring`,
`dofile`, `loadfile`, `coroutine`, or `collectgarbage` (except `"count"`). OPEN//77 has no `os`
at all.

**Fix.** Use the runtime instead: `ScriptGo.storage` for persistence, `ScriptGo.resource.readFile`
for files inside the resource, `require` for modules inside the resource, `CreateThread` and
`Wait` instead of coroutines. See [Runtime](/docs/runtime).

### An event or export arrives without its value

**Cause.** Values crossing sides or resources go through the value codec, which refuses
functions, coroutines, userdata, cyclic tables, nesting deeper than 32 and encoded data larger
than 1 MiB.

**Fix.** Send plain data: strings, numbers, booleans and tables of them. Break cycles, pass ids
instead of objects, and split large payloads.

### `exports.call` returns `nil, reason`

**Cause.** The target resource is not started, the export does not exist, or an argument could
not be copied. The reason string says which.

**Fix.** Declare the target in `dependencies` so it starts first, check the export name, and
always handle the second return value:

```lua
local p, reason = ScriptGo.exports.call("sg_inventory", "add", playerId, "water", 1)
if not p then
  ScriptGo.log.warn("give failed: " .. reason)
  return
end
local result, err = p:await()
```

### A network event never reaches its handler

**Cause.** Only names registered with `RegisterNetEvent` receive network events.

**Fix.** Register the name on the receiving side before the sender triggers it.

## Manifest

The manifest is parsed, never executed. Errors stop the release; warnings are shown and kept.

| Code | Cause | Fix |
|---|---|---|
| `missing_directive` | `resource` or `version` is absent | Add both; they are required |
| `invalid_resource_name` | The name breaks the resource name rule | Use 3 to 64 characters of `a-z`, `0-9` and `_`, starting with a letter. No `-` |
| `invalid_version` | `version` is not semver, e.g. `"1.0"` | Use three numbers: `"1.0.0"` |
| `invalid_range` | `scriptgo_version` or `open77_version` is not a valid range | Use a range such as `">=0.1.0"` |
| `duplicate_directive` | A single-value directive appears twice | Keep one |
| `unsafe_path` | A path uses `..`, a leading `/`, a drive letter or `\` | Use resource-relative paths with `/` |
| `script_not_lua` | A script entry is not a `.lua` file | Point script directives at `.lua` files |
| `cross_resource_include` | A path such as `@other/file.lua` | Share code through `dependencies` and exports |
| `unknown_capability` | A capability name is not one of the ten | Fix the spelling, or use an `x-` extension name |
| `invalid_lua_dialect` | An unknown entry in `lua` | Use the dialects listed in [Manifest](/docs/manifest) |
| `invalid_dependency` | A dependency is not `"name"` or `"name >=1.2.0"` | Fix the format or the range |
| `empty_resource` | No scripts and no files | Declare at least one script or file |
| `manifest_too_large` | The manifest exceeds 256 KiB | Move data into files |
| `unexpected_character`, `unterminated_string` | The manifest contains code or a broken string | Keep only directives; manifests cannot contain function calls like `os.execute(...)` |
| `missing_file`, `pattern_empty` | A listed script is missing, or a `files` pattern matches nothing. Script entries are checked as exact paths, so a `*` in one also gives `missing_file` | Check the path against the archive; list each script explicitly |

| Warning | Meaning |
|---|---|
| `unknown_directive` | A directive SCRIPT//GO does not use, such as one specific to an environment. It is kept, so one manifest can serve several environments |
| `unknown_environment` | An environment slug SCRIPT//GO does not list yet; it shows as not tested |
| `unknown_category` | The category will be shown as `other` |
| `license_not_spdx` | The license does not look like an SPDX expression |
| `missing_scriptgo_version` | Declare `scriptgo_version` so hosts can check compatibility |

## Licensing

`POST /v1/licenses/verify` answers HTTP 200 with `valid: false` and one of these reasons:

| Reason | Fix |
|---|---|
| `expired` | Renew at the provider, then verify again |
| `revoked` | Read the reason on the license page in the dashboard |
| `refunded` | The payment was refunded; the license no longer grants use |
| `deactivated` | The deployment was deactivated; activate it again |
| `environment_not_covered` | The plan does not include this environment |
| `deployment_limit` | Deactivate an unused deployment on the license page |
| `unknown_key` | Check the key and the package; the key may have been rotated |

A 4xx or 5xx answer means the API could not answer, not that the license is refused.

Details: [Licensing API](/docs/licensing-api).

## Registry and purchases

### "Checkout not available yet"

**Cause.** One of the gates that protect every real payment is closed:

- checkout is turned off for the platform until the payment provider approves it in writing;
- the creator's store is not approved yet (it stays in **Sandbox** or **Checkout off**);
- the offer is classified **Pending review**, because it touches a proprietary third-party game
  or its rights are unclear. Its button reads **Under review** until a reviewer approves it.

**Fix.** As a customer, use the free tier if there is one, or ask to be notified. As a creator,
check [Dashboard → Stores](/dashboard/stores) and your offer's classification.

### My package does not show "Verified"

**Cause.** **Verified** appears only after a compatibility run passed in the real runtime for that
release. Declaring an environment in the manifest makes it show as **Not tested**. A run made
with an adapter older than the environment's current one shows **Stale**.

**Fix.** Nothing to set by hand. The status changes when a passing `scriptgo verify` run for the
release is ingested by the registry (staff ingest runs through `POST /v1/admin/compatibility-runs`;
uploaded code is not executed by the registry yet). Run `scriptgo verify` locally to find failures
before that, including a README example marked `lua runnable`, which every run executes.

### A release is stuck in "Validation failed"

**Cause.** A required check failed: archive safety, the manifest, integrity (referenced files) or
the Lua syntax check. Unit tests and environment runs are advisory and do not fail a release; a
missing rights declaration blocks publishing, not validation.

**Fix.** Open the release in the dashboard. The failing row shows the error and the file
position. Fix it and upload a new release; published versions cannot be changed.
