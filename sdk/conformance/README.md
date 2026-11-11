# Conformance

Resources that run the same checks on every host, so that "works the same everywhere" is
measured.

`sg_probe` checks, from a server script: runtime and resource identity, storage round trip and
delete, `time.now` and `time.monotonic`, declared capabilities and the `capability_unavailable`
refusal, player-id guards, console permissions, config defaults, local promises,
synchronous and asynchronous cross-resource exports (including a refusal), and the EventBus and
Permissions kits (topic definition, schema rejection, delivery on the host bus, retained value,
ownership, runtime roles, cycle refusal).

It prints one `SGCHECK PASS|FAIL <name>` line per check and `SGCHECK DONE` at the end;
`scriptgo verify` turns those lines into checks of its report.

```bash
scriptgo test sdk/conformance/sg_probe                     # standalone, every Lua dialect
scriptgo verify sdk/conformance/sg_probe --env all --open77-server <Open77.Server.exe>
```

## sg_probe_net

`sg_probe_net` checks `ScriptGo.http` and `ScriptGo.licensing` against a SCRIPT//GO API: a GET, a
404 that is an answer (not a transport failure), `licensing.verify` with a valid and an unknown key,
`licensing.activate`, `verify` by deployment token, and `activate` refused with `unknown_key`. On
OPEN//77 it also checks that the operator's allow-list refuses any other host. It needs the
config `api` and `license_key`, which `scriptgo verify --stub-api` provides with a loopback stub
that validates every request against the API's own schemas.

```bash
scriptgo verify sdk/conformance/sg_probe_net --env all --stub-api --open77-server <Open77.Server.exe>
```

## sg_probe_perks

`sg_probe_perks` checks `ScriptGo.perks` against a SCRIPT//GO API (`docs/spec/perks.md`): a held
perk answered by the API then from the cache, a perk not held, an invalid key, `list`, `catalog`,
a purchase link and its `already_held` and `not_purchasable` refusals, a `granted` event pulled
from the queue (with `player` nil: the buyer is not connected), and `status()` linked with a
cursor. Players are given as identifier strings, so no player has to connect. It needs the host
settings `scriptgo_api` and `scriptgo_server_token`, which `scriptgo verify --stub-api` provides
with a loopback stub holding fixed data and checking every body against the API's own schemas
(`packages/cli/src/lib/stub-perks.ts`).

```bash
scriptgo verify sdk/conformance/sg_probe_perks --env all --stub-api --open77-server <Open77.Server.exe>
```

## sg_probe_ts

The same checks as `sg_probe`, written in TypeScript (`server/probe.ts`), with the same check
names and SGCHECK lines; it calls the Lua kits (EventBus, Permissions, Inventory) through their
exports and events. It runs on hosts with a JavaScript guest, today the .NET kit; a Lua-only host
reports it as skipped.

```bash
scriptgo verify sdk/conformance/sg_probe_ts --env dotnet --search sdk/conformance --search sdk/packages
```

## sg_xlang_lua and sg_xlang_ts

A pair that calls across languages. The Lua half calls TypeScript exports (synchronous, several
values, codec round trip, empty table, integer kinds, asynchronous, error, a refused yield, the
invoking resource, a refused function argument) and sends it an event that comes back; then it
starts the TypeScript half, which runs the same kind of checks against Lua exports and events and
reports back. The Lua half prints the DONE line for both. On a Lua-only host, its test script
checks that the TypeScript half is refused with `language_unavailable`.

```bash
scriptgo verify sdk/conformance/sg_xlang_lua --env dotnet --search sdk/conformance
```

## Codec vectors

`vectors/codec.json` lists Lua and JavaScript expressions with the value (or refusal) each must
give once it crosses the codec, in a rendering every implementation can produce. The portable Lua
core runs them on every interpreter (`sdk/lua/spec/codec_vectors_spec.lua`); the .NET kit runs
them through its Lua and JavaScript guests and crosses every accepted value into the other
language and back (`sdk/dotnet/ScriptGo.Host.Tests/CodecVectorTests.cs`).
