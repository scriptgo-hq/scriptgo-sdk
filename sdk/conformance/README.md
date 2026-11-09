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
