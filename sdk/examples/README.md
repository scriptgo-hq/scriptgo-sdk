# Escrow examples

Two small hosts that run the same escrowed SCRIPT//GO resource, and a demo key endpoint to run them
against on one machine.

| Folder | What it shows |
|---|---|
| [`custom-adapter-dotnet/`](custom-adapter-dotnet) | **"Acme Engine"**: a fictional third-party server with its own Lua sandbox. It uses the `ScriptGo.Escrow` package and nothing else from SCRIPT//GO. Start here if you have your own platform |
| [`host-escrow-dotnet/`](host-escrow-dotnet) | The same resource in the full SCRIPT//GO sandbox (`ScriptGo.Host`), which does the wiring for you |
| [`tools/demo-master.mjs`](tools/demo-master.mjs) | A demo of the one endpoint a host talks to (`POST /v1/licenses/key`), over the repository's test vector. Not the real master; holds no real key |

The guide that goes with them: `docs/guides/bring-escrow-to-your-platform.md`.

## Run it

Needs the .NET 10 SDK, Node 22.18 or newer, and the native library built once
(`pwsh -ExecutionPolicy Bypass -File sdk/native/build.ps1`, Windows x64).

```
# terminal 1: the demo key endpoint (loopback only; writes the demo bundle next to itself)
node sdk/examples/tools/demo-master.mjs

# terminal 2: Acme Engine runs the escrowed resource once
dotnet run --project sdk/examples/custom-adapter-dotnet -- \
  --bundle sdk/examples/tools/.demo/demo-1.0.0.escrow.zip --master http://127.0.0.1:4180 \
  --deployment-token sg_dep_demo_token --package kestrel//demo --environment demo \
  --trusted-signer 0EqyMnQrtKs6E2i9RhXk5tAiSrcaAWuvhSCjMsl3hzc --identity ./acme.identity --once
```

```
acme: server public key DMYRvnuZ... (new identity)
[demo] escrow secret ok 42
acme: started demo 1.0.0 (backend=native, encrypted files=4, managed copies=0)
```

Things to try, each of which is what a real deployment meets:

| Try | What happens |
|---|---|
| Run it again | Same public key: the identity was loaded from `acme.identity`, not recreated |
| `--identity ./other.identity` | `escrow refused: refused:unbound`, exit 1. The deployment is bound to the first server's key: this is the copied-server case |
| A wrong `--trusted-signer` | `signature:signer is not the trusted release key`, exit 1, and no key request is made |
| Stop the demo endpoint | `key_service_unreachable:...`, exit 3: retry later, it is not a refusal |
| Drop `--once`, start the endpoint with `--ttl 6 --grace 14`, then `curl -X POST http://127.0.0.1:4180/demo/revoke` | The license check turns to `grace (refused:revoked)`; when grace runs out Acme stops the resource, the decrypted files are wiped, exit 4 |
| `curl -X POST http://127.0.0.1:4180/demo/offline` | The endpoint answers 503: the license check turns to `grace (key_service_unreachable:http_503)`, the resource keeps running, and when grace runs out it stops with `offline_grace_exhausted:...`, exit 4 |

`POST /demo/restore` undoes a revoke or an outage; a license check made after it is granted again
(that recovery is covered by `EscrowLeaseTests`, not by a run of the demo).

Use the same `--identity` file for both example hosts: the demo endpoint, like the real master,
binds a deployment to the first server key it sees.

Every row of the table was run on Windows x64. The demo material (signing key, content key, bundle) is the
fixed test vector of this repository and protects nothing.
