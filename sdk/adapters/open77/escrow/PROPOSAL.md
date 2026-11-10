# Running SCRIPT//GO escrowed resources on an OPEN//77 server

Status: **proposal** (2026-11-10). Built and tested on the SCRIPT//GO side; the OPEN//77 side is
read-only here and nothing in this folder changes the OPEN//77 repo. It gives an operator two ways to
run an encrypted (escrowed) SCRIPT//GO resource on their own OPEN//77 server — **by the operator's
choice, never forced into OPEN//77's core.**

Honest ceiling (CREATOR-PROTECTION.md §1): escrow raises the cost of copying a resource off a server,
makes a leaked copy fail on an unbound server, and makes a leak traceable and revocable. It does
**not** make code the operator's own host runs impossible for that operator to recover. We never sell
it as unbreakable.

## The seam we found in OPEN//77 (read-only investigation)

`Open77.Server.Scripting.Hosting.ServerResourceHost` is constructed over a disk **resources root**.
- `Discover()` scans that root, reads each `open77.lua`, and builds a `ResourceSource` per folder
  (`ResourceManifestParser.ParseDirectory`).
- Scripts are read from disk by `PreparedResourceScripts.ReadFromDisk(source)` when a resource starts.
- There is **no in-process resource-provider interface** a dropped-in DLL can register to intercept
  loading or decryption. OPEN//77 does not load third-party plugin assemblies into its scripting host.

So a dropped-in DLL cannot, by itself, feed OPEN//77 a decrypted-in-memory resource today. That
single fact decides A vs B.

## Option A — standalone loader, **no OPEN//77 change** (recommended)

A SCRIPT//GO component the operator installs and runs next to their server. It:
1. verifies the escrow release signature (ed25519, provenance),
2. asks the master for the content key **wrapped to this server's X25519 key** (the key endpoint,
   gated on the existing license verify),
3. unwraps and **decrypts the resource in the loader** (the `ScriptGo.Escrow` package, whose native
   library libscriptgo holds the keys; before 2026-11-10 this was `ScriptGo.Host.Escrow`), never in the
   KeraLua VM,
4. writes the decrypted resource into the server's **resources root as a normal `open77.lua` folder**
   (`ScriptGo.Host.EscrowMaterializer`, over `ScriptGo.Escrow.EscrowDiskFallback`), which OPEN//77
   then discovers unchanged.

This is `ScriptGo.Escrow.dll` (with its native library) and `ScriptGo.Host.dll` (only to read the
resource name from the manifest) plus the thin runner in `runner/` (`scriptgo-open77-escrow`). **OPEN//77
needs no change and never references SCRIPT//GO.**

**The one honest caveat for OPEN//77 specifically:** because OPEN//77 reads scripts from disk, Option A
must write the decrypted scripts into the operator's own resources directory. On a box the operator
controls that is not a new secret exposure (the operator can read their own process memory anyway),
but it means **code secrecy on OPEN//77 via Option A is license-only-grade** — the real, defensible
claims there are binding (a leaked copy won't run on an unbound server), instant revocation,
tamper-evident signing, and traceability. Decryption itself still happens in compiled C#, and the
content key is only ever released, wrapped, to a licensed bound server. To keep the plaintext in
memory and off disk, use Option B.

Proven here end-to-end against the real host code path in `ScriptGo.Host.Tests`
(`EscrowHostTests.MaterializesAndRunsFromDiskLikeOpen77`): a bundle is materialized to a resources root
and then loaded **from disk** by a `ScriptGoHost` with the default `FolderFiles` provider — exactly
how `ServerResourceHost.Discover`/`ReadFromDisk` load a local resource — and the decrypted script
runs. An unbound or revoked server is refused before anything is written.

## Option B — one flag + one resource-provider hook in OPEN//77 (optional, their review)

If an operator wants the plaintext to **stay in memory** on OPEN//77, OPEN//77 gains a small,
default-off hook. The exact minimal change is in `option-b.patch` (NOT applied to base). It adds:

1. a new interface `IEscrowResourceProvider` in `Open77.Server.Scripting`;
2. one appended, optional constructor parameter on `ServerResourceHost` (`IEscrowResourceProvider?`,
   `null` by default — dormant);
3. in `Discover()`, after the disk scan, it also takes escrow-backed sources from the provider;
4. in `Start(...)`, one line: `input ??= _escrow?.Prepare(slot.Source) ?? PreparedResourceScripts.ReadFromDisk(slot.Source);`
   so an escrow resource's **in-memory** decrypted scripts are used instead of a disk read.

The provider is implemented in a **separate SCRIPT//GO assembly** that references `ScriptGo.Escrow`
(the decryptor), constructed by the server's composition root only when a per-server config flag
(`scripting.scriptgo.enabled` plus a deployment token) is set. Flag off → `null` provider → OPEN//77
behaves exactly as today. Only the clear `open77.lua` manifest ever needs a path (a temp dir the
provider owns); the scripts — the secret — never touch disk. This is the only way to get real
deterrence-grade code escrow on OPEN//77, and it is OPEN//77's own code behind their own review.

## Recommendation

Adopt **Option A now** (no OPEN//77 change; it is the operator's choice to install the loader).
Propose **Option B** to the OPEN//77 maintainers as an optional, flag-gated feature if/when operators
want in-memory decryption. Either way nothing here touches the OPEN//77 repo by itself.

## What still needs a real OPEN//77 server run

Everything above is proven on the SCRIPT//GO host and against the host's disk-loading code path. Not
yet proven on a live OPEN//77 dedicated server binary (we must not modify or build the shared `base`
checkout). The one command to prove Option A later, on a machine with the OPEN//77 server and a real
licensed escrow package:

```
dotnet run --project sdk/adapters/open77/escrow/runner -- \
  --bundle <release>.escrow.zip --resources-root <server>/resources \
  --master https://api.scriptgo... --deployment-token sg_dep_... \
  --package <creator//name> --environment open77 --trusted-signer <ed25519-pubkey>
# then start the OPEN//77 server over that resources root and confirm the resource starts.
```
