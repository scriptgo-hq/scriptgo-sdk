---
title: Protect your own server
description: You run a game server and want its scripts not to leak. Encrypt them, bind them to your server's key, revoke a copy. No sale, no store, no payment.
order: 7
---

This page is for the owner of a game server who wants to keep **their own server's scripts** from
leaking: a member of staff who leaves with a copy, a host or a developer who had access to the
files, another server that got hold of the folder. Nothing here involves a sale, a store, Tebex or a
payment.

What you do, in short: publish your scripts to SCRIPT//GO as a **private** package with an
**encrypted** release, grant a free licence to **your server's own key**, and put the deployment
token on that server. The key is released only to the holder of your server's **identity** (a key
pair the loader creates), and the scripts are decrypted in memory where the platform allows it. A
copy of the resources that does not carry that identity does not run, and you can cut it off.

> [!NOTE]
> This is deterrence, traceability and revocation, not a guarantee. Whoever controls the machine
> can, with real effort, read what their own server runs. What it stops is a copied resource folder:
> without your server's identity, it is ciphertext. **The identity file is what must not travel with
> it**: how well it is held depends on the OS ([below](#where-the-identity-lives)). See
> [what it does not do](#what-it-does-not-do).

## Where it works

An encrypted release needs a loader on the server, in compiled code, that holds the key. These
platforms have one:

| Platform | Loader | What was run |
|---|---|---|
| [OPEN//77](/docs/platforms/open77) | The server's `resourceEscrow` feature with the SCRIPT//GO adapter. Server scripts are decrypted in native memory | The full chain on a real OPEN//77 dedicated server, server side only (no game client) |
| [Rust (Oxide, Carbon)](/docs/platforms/rust) | The SCRIPT//GO plugin's bridge with the native library | The full chain on real Windows servers with Oxide and with Carbon, and Oxide on Linux in a container |
| [A C# server built on the .NET kit](/docs/dotnet-kit) | `ScriptGo.Host`, built in | The kit's tests and example hosts; it applies only if your server embeds the kit |

On these platforms it does **not** keep code secret, and we say so plainly:

- **Garry's Mod, Luanti, LÖVE, Neovim, the standalone host.** They run plain Lua. The reference
  loader (`scriptgo escrow load`) can decrypt on your bound server, but it then writes the scripts to
  disk so the host can load them, and a licence check written in Lua can be deleted by whoever has
  the files. That does not stop a leaked folder.
- **FiveM and RedM.** The SCRIPT//GO shim there has no licence check and no loader, so an encrypted
  release cannot run. Cfx.re's own asset escrow is the platform's way: upload the resource to your
  own Cfx.re account and Cfx.re encrypts its Lua scripts and `.ydr`/`.ydd`/`.yft` models; it then
  starts only on servers whose Cfx.re key belongs to that account. `scriptgo pack --target
  fivem|redm --cfx-escrow` builds that upload. Cfx.re does the encryption and holds the keys, not
  SCRIPT//GO; see [Selling assets](/docs/selling-assets#fivem-and-redm-cfxres-asset-escrow).
- **Hytale.** A loader (a plugin with a native library) is planned, not built.
- **BeamMP.** No loader; a licence check is planned.

Each [platform page](/docs/environments) says what its adapter can do.

## What you need

- A SCRIPT//GO account with a creator profile, an access token and the CLI
  ([Quickstart](/docs/quickstart)): `npm install -g @scriptgo/cli`, then
  `scriptgo login --token <your token>`.
- Your scripts as a SCRIPT//GO resource: a folder with a `scriptgo.lua` manifest that lists the
  platform in `environments`. `scriptgo init` writes one; `scriptgo validate` checks it.
- **Valuable logic in server scripts.** Code escrow encrypts server scripts only. Client scripts,
  shared scripts and UI files are sent to every player's game, so they stay readable; on OPEN//77,
  [client code escrow](/docs/protect-your-work#client-scripts-on-open77) ships client scripts as
  stripped bytecode instead, which a player can still decompile.

## The steps

### 1. Publish as a private package, encrypted

```bash
scriptgo publish my_scripts --escrow --private --owns-code
```

- `--escrow` encrypts the server scripts on your machine before upload. The content key goes to
  SCRIPT//GO once and is kept sealed; it is never written to your disk.
- `--private` makes the package invisible: no listing, no page, no search result. Only you see it,
  and the servers you grant it to.
- `--escrow-ignore config.lua` keeps a file readable, for a config your staff edit.

Already published? `scriptgo publish --private` makes the package private before the next upload,
or use **Dashboard → Packages → your package → Details → Visibility**.

### 2. Get your server's public key

The loader on your server creates the server's key pair the first time it runs with protection on,
and prints the public half. Only the public half is sent to SCRIPT//GO. The exact place is in the
platform sections [below](#on-open77). A new identity is a new server, so back the identity file up;
how it must be kept depends on the OS.

#### Where the identity lives

- **Windows.** The native loaders (OPEN//77, Rust, the .NET kit) seal the private key with DPAPI for
  the **Windows account the server runs as** (user scope). A copy of the file, alone, does not open
  on another machine or under another account. It is not bound to the hardware: whoever can run code
  as that account opens it, an administrator of the machine can extract it, and the account's DPAPI
  master key (in its profile) plus its password open it elsewhere. Run the server under its own
  account; a backup of the identity file is useful only with that account.
- **Linux (and other POSIX).** There is no OS key store: the private key sits **in clear** in a file
  of mode 0600, readable by that user and by root. Whoever copies the file has the identity: a copied
  server folder **with** the identity file and the token runs anywhere, and the platform sees the
  same server. Keep the identity file **outside the server folder** (an absolute path in the
  settings below) and outside anything you share or hand to staff, and back it up like a secret.
- **The reference loader** (`scriptgo escrow load`, any OS) also writes the key in clear: 0600 on
  POSIX, an ACL for the current user only on Windows (it says so, loudly, if it cannot set one).

### 3. Grant the package to that key

```bash
scriptgo grant create my-scripts --server-key <the 43-character key> --environment open77 --name main-server
```

Or **Dashboard → Packages → your package → Free licenses → Grant a free license → My own server**.

The licence is held by you. Its one deployment is bound to that key from the start. The
**deployment token is shown once**: copy it now. It is a secret, but on its own it is useless: it
only works together with your server's private key.

### 4. Put the encrypted release and the token on the server, and turn it on

Download the encrypted bundle with the token (or signed in as yourself, on any machine):

```bash
scriptgo add <you>//my-scripts --deployment-token <sg_dep_...>
```

Then install it for your platform and put the token where the loader reads it. The platform
sections below give the exact folders and settings. The loader asks SCRIPT//GO for the key, which is
wrapped for your server's key only, decrypts, and the scripts run. It renews the key on a schedule.

### 5. Revoke if you need to

```bash
scriptgo grant revoke <licence id> --reason "server retired"
```

Or **Revoke** next to the grant in the dashboard. The next key request is refused, and a fresh start
is refused. A server that is already running stops the scripts when the offline grace of its last
valid answer ends (72 hours by default). The OPEN//77 server stops sooner, at its next key renewal,
because the refusal of a revoked licence is marked final and it reads that mark. To move to a new machine, use **Reset server key** on that licence in
**Dashboard → Licenses** instead of revoking.

## On OPEN//77

1. Stage the escrow adapter next to the server: download `ScriptGo.Escrow.<version>.nupkg` from the
   [SDK releases](https://github.com/scriptgo-hq/scriptgo-sdk/releases) and follow
   [the adapter's steps](https://github.com/scriptgo-hq/scriptgo-sdk/tree/main/sdk/adapters/open77/escrow).
2. Turn the feature on in `server.jsonc`:

   ```jsonc
   "resourceEscrow": {
     "enabled": true,
     "master": "https://api.scriptgo.dev",
     "environment": "open77",
     "identityFile": "/srv/scriptgo-state/escrow-identity.bin",   // outside the server folder
     "tokensDirectory": ".open77/escrow-tokens",
     "trustedSigners": []
   }
   ```

3. Start the server once. It prints its public key at boot; that is the key for step 3:

   ```text
   INF Resource escrow loader ready: scriptgo/0.1.0, identity created, publicKey=<43 characters>.
   ```

4. Install the release still encrypted, and write the token in its file (one line):

   ```bash
   scriptgo escrow install my_scripts-1.0.0.escrow.zip --target open77 --out <resources folder>
   ```

   ```text
   .open77/escrow-tokens/my_scripts.token      the deployment token
   ```

5. Restart the server (or `ensure` the resource). It logs `escrow opened package=...` and the
   resource starts. Refusals are named in the log: `unbound`, `revoked`, `adapter_missing`...

On Windows the identity file is sealed for the account the server runs as; run the server under
that same account. On Linux it is the raw key: the default `.open77/escrow-identity.bin` sits inside
the server folder and travels with any copy of it, so point `identityFile` outside (as above) and
keep the token files out of shared copies too. `trustedSigners` may list your bundle signer (`scriptgo escrow inspect` prints
it) so that a bundle signed by any other key is refused.

**Assets too.** Maps and other preload packages can be protected the same way, in a package of their
own: `scriptgo publish --asset-escrow --asset-rights original --private --owns-code`, a grant to the
same server key with `--environment open77`, then `scriptgo add ... --deployment-token` gives your
server its own sealed copy and `scriptgo pack <copy> --target open77` writes the resource. The key
of each preload goes only to players the OPEN//77 master admits to your server. While the game runs,
the decrypted archives are on the player's disk: it stops the leaked server folder, not a player
who copies what their own game loaded. It needs an OPEN//77 server and client that include asset
escrow. A release cannot combine `--escrow` and `--asset-escrow`: keep scripts and assets in two
packages. See [Selling assets](/docs/selling-assets#encrypted-assets-on-open77).

## On Rust (Oxide or Carbon)

1. Install the SCRIPT//GO plugin with the native escrow library, as in
   [the Rust setup](/docs/platforms/rust) (*Encrypted (escrowed) packages*): `scriptgo.dll` (Linux
   `libscriptgo.so`) goes next to `lua54` in `RustDedicated_Data/Plugins/x86_64/`.
2. Install the release still encrypted:

   ```bash
   scriptgo escrow install my_scripts-1.0.0.escrow.zip --target rust --out oxide/data/ScriptGo/resources
   ```

3. Turn escrow on in `oxide/config/ScriptGo.json` (Carbon: `carbon/configs/ScriptGo.json`) and
   reload the plugin:

   ```json
   "escrow": { "enabled": true, "master": "https://api.scriptgo.dev", "trustedSigners": [] }
   ```

4. The first protected start creates the server's identity in
   `oxide/data/ScriptGo/escrow/identity.key` (sealed for the server's account on Windows, the raw key
   in a 0600 file on Linux: [where the identity lives](#where-the-identity-lives)) and logs
   `this server's public key is <43 characters>`. Grant to that key (step 3), then write the token:

   ```text
   oxide/data/ScriptGo/escrow/tokens/my_scripts.token      the deployment token
   ```

5. `scriptgo start my_scripts` in the server console asks for the key again. `scriptgo status` shows
   `started [escrow licensed, ...]`, or the refusal.

Rust has no client-side plugins, so everything a SCRIPT//GO resource runs there is server side.

## What it buys you

- **A leaked resource folder runs nowhere else.** The release is ciphertext; the key is released
  only to the server whose key you granted, wrapped for that key. Another machine with the same
  folder and the same token but another identity is refused (`server_key_mismatch`). A copy that
  carries the identity file too is the same server to SCRIPT//GO: on Windows that file only opens for
  the server's account, on Linux it opens anywhere ([where the identity lives](#where-the-identity-lives)).
- **Revocation.** You can cut a server off at any time; refunds and staff decisions do the same for
  sold licences.
- **A watermark names the copy.** Each delivery carries a marker tied to the licence and the
  deployment that received the key. SCRIPT//GO staff can resolve it after a report.
- **Tampering is refused.** Every release is signed; a changed file or bundle does not load.
- **Nothing is listed.** A private package has no public page, no search entry, no profile entry.

## What it does not do

- **It protects server scripts only.** Client scripts, shared scripts and UI (NUI, WebUI, HUD) are
  sent to every player. On OPEN//77,
  [client code escrow](/docs/protect-your-work#client-scripts-on-open77) ships client scripts as
  stripped bytecode, which a player can still decompile into working logic; everywhere else they
  arrive in clear. Keep prices, economy rules, anti-cheat and anything valuable on the server side.
- **The machine's operator can read their own process.** A server that must decrypt and run code
  can be inspected by whoever controls it. The encryption raises the cost and the marker makes a copy
  traceable; neither makes reading it impossible. Choose your host accordingly.
- **It is not obfuscation.** Obfuscation is at most a speed bump, never protection, and none is
  counted here.
- **It does not hide code on plain-script platforms** (Garry's Mod, Luanti and the others listed
  [above](#where-it-works)).
- **Your server needs SCRIPT//GO to start a protected script.** A running server keeps going
  through an outage until the offline grace ends. On OPEN//77 the key answers are kept in memory
  only, so a server restarted while SCRIPT//GO cannot be reached keeps protected scripts stopped
  until it answers.

## Limits

- One live grant per server key and package; 25 grants per package per day.
- A private package can be granted to a server key only. To give it to another person's account,
  make it unlisted (reachable by link only).
- The scripts must be yours: you declare your rights when you publish (`--owns-code`).

See also: [Protect your work](/docs/protect-your-work) for how protection works for every case,
and [the CLI](/docs/cli) for every flag.
