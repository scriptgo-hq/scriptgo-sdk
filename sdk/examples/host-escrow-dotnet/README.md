# The same escrowed resource, in the full SCRIPT//GO sandbox

`../custom-adapter-dotnet` shows a host with its own sandbox doing the escrow wiring by hand. This
one uses `ScriptGo.Host`, the complete SCRIPT//GO sandbox (events, exports, quotas, Lua and
JavaScript guests), which does that wiring itself:

```csharp
var files = new EscrowResourceFiles();                                   // escrow + folders on disk
using var host = new ScriptGoHost(new HostServices { Files = files });
var loaded = await EscrowLoader.LoadAsync(bundle, files, identity, keys, trustedSigner);
var name = host.AddResource(loaded.ResourceRoot!, checkFolderName: false);
host.Start(name);
EscrowLoader.BindLease(host, name, loaded.Content!);                     // renew; stop on revocation
```

What the host does with the release:

| Files | Path | Plaintext in managed memory? |
|---|---|---|
| Lua scripts, and Lua modules loaded with `require` | compiled by libscriptgo straight into the guest's `lua_State` | **No** |
| JavaScript and compiled TypeScript | read through `EscrowContent.ReadAllBytes` and given to Jint | **Yes.** Jint takes managed source; this is the weaker door, and `content.ManagedCopies` counts it |
| Data files a resource reads itself | the same managed door | Yes |
| The manifest, README, creator-named config | clear files of the bundle | They were never secret |

So a creator who wants the stronger path on this host writes the server side in Lua. That is a
property of the JavaScript engine, not something a setting changes, and we would rather say it than
have it discovered.

## Run it

Same flags and exit codes as Acme (see [`../README.md`](../README.md)); use the same `--identity`
file as the other example, since the demo endpoint binds the deployment to one server key.

```
dotnet run --project sdk/examples/host-escrow-dotnet -- \
  --bundle sdk/examples/tools/.demo/demo-1.0.0.escrow.zip --master http://127.0.0.1:4180 \
  --deployment-token sg_dep_demo_token --package kestrel//demo --environment dotnet \
  --trusted-signer 0EqyMnQrtKs6E2i9RhXk5tAiSrcaAWuvhSCjMsl3hzc --identity ./acme.identity --once
```

```
[info] demo:server escrow secret ok 42
[info] host started demo 1.0.0
[info] demo:server escrow handler ok
started demo (backend=native, managed copies=0)
```
