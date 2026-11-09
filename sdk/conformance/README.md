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
