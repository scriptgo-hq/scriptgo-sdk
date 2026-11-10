# Acme Engine: escrow on a third-party host

"Acme Engine" is a made-up game server. It has **its own** Lua sandbox (KeraLua, a few host
functions, its own `require`) and no SCRIPT//GO code in it except one package, `ScriptGo.Escrow`.
It runs an escrowed SCRIPT//GO resource. If you maintain a platform and wonder what integrating
escrow costs, this folder is the answer: two files, under 400 lines, the sandbox included.

| File | What is in it |
|---|---|
| `Program.cs` | The five steps: identity, open the release, read the manifest, run the scripts, renew and stop on revocation. Acme's own tiny manifest reader is at the bottom |
| `AcmeSandbox.cs` | Acme's Lua sandbox. The three places escrow touches it are marked (1), (2), (3) |

## The five steps

```csharp
using var identity = EscrowIdentity.LoadOrCreate(path);                      // 1
var keys = new HttpEscrowKeyService(http, new(token, package, environment));
using var content = await EscrowSession.OpenAsync(bundle, identity, keys, trustedSigner);   // 2
var manifest = content.ClearFiles["scriptgo.lua"];                           // 3  (public)
content.LoadLuaChunk(lua.Handle, "server/main.lua", "@demo/server/main.lua", loader);       // 4
lua.PCall(0, 0, 0);
content.Revoked += (_, e) => stopOnMainThread(e.Reason);                     // 5
content.StartRenewal();
```

Step 4 is the one that matters. `LoadLuaChunk` hands the script to Acme's own `lua_State` from the
native library's memory: Acme never sees the source as a string or a byte array, and
`content.ManagedCopies` stays at 0 (Acme prints it). Acme's `require` does the same for modules,
so a resource split over several files stays in native memory too.

## Run it

See [`../README.md`](../README.md) for the demo key endpoint and a table of things to try.

```
acme-engine --bundle <release>.escrow.zip --master <url> --deployment-token sg_dep_... \
            --package <creator//name> --environment <slug> --trusted-signer <key> \
            [--identity <file>] [--once] [--allow-managed-fallback]
```

| Flag | Meaning |
|---|---|
| `--bundle` | The `.escrow.zip` release (from `scriptgo pack --escrow`) |
| `--master` | Base URL of the key endpoint |
| `--deployment-token` | This server's deployment token. A secret: Acme never prints it |
| `--package` | The package identifier, `creator//name` |
| `--environment` | The environment slug the license must cover |
| `--trusted-signer` | The release-signing public key you trust (ed25519, base64url). Without it the signature proves integrity only, and Acme warns |
| `--identity` | The server identity file. Created on first run, never replaced. Default: next to the executable |
| `--once` | Run the resource's server scripts, print their output, exit |
| `--allow-managed-fallback` | Only when the native library is missing: decrypt in managed memory instead. Weaker against memory inspection; Acme prints a warning. Without this flag a missing library is an error |

| Exit code | Meaning |
|---|---|
| 0 | The resource ran (`--once`), or the server was stopped with Ctrl+C |
| 1 | Refused or failed. stderr has the reason: `acme: escrow refused: refused:revoked` |
| 2 | Bad command line |
| 3 | The key service could not be reached. Not a refusal: retry |
| 4 | The license was revoked while running and offline grace ran out |

`EscrowExampleTests` in `sdk/dotnet/ScriptGo.Host.Tests` runs this executable as a process against
a key endpoint over HTTP: first run, second run with the persisted identity, a refusal, and an
unreachable endpoint.

## From another repository

Inside this repository the project references `ScriptGo.Escrow` by path. In yours:

1. Build the packages: `pwsh -ExecutionPolicy Bypass -File sdk/native/build.ps1`, then
   `pwsh -ExecutionPolicy Bypass -File sdk/dotnet/pack.ps1`. They land in `sdk/dotnet/artifacts/`.
2. Put `ScriptGo.Escrow.0.1.0.nupkg` on a feed your build reads (a folder is enough):

   ```xml
   <!-- nuget.config -->
   <configuration>
     <packageSources>
       <add key="scriptgo" value="path/to/artifacts" />
     </packageSources>
   </configuration>
   ```

3. Reference it: `<PackageReference Include="ScriptGo.Escrow" Version="0.1.0" />`.

The native library comes with the package (`runtimes/win-x64/native/scriptgo.dll`) and is copied to
your output by the build. Nothing else to install. This was checked with a project outside this
repository consuming the `.nupkg` from a folder feed.

NuGet caches packages by version: when you rebuild `0.1.0` after a change, clear the cached copy
(`dotnet nuget locals global-packages --clear`, or delete `~/.nuget/packages/scriptgo.escrow`) or
your build keeps the old one.

## What this example is not

Acme's sandbox is a sketch: no instruction or memory quota, no scheduler, strings only in events.
A real engine has its own. And nothing here hides code from the operator of the Acme server: they
could attach a debugger to it. Escrow is deterrence, traceability and revocation; see
`docs/guides/bring-escrow-to-your-platform.md`, section 1.
