---
title: Protect your work
description: Signed releases, per-server licences and encrypted releases. How to publish them, how a server runs them, and what they do not do.
order: 7
---

SCRIPT//GO protects work a creator owns: the scripts you wrote and the content you made for them
(configs, data, assets). It never sells, ships, decrypts or redistributes a game's own files. This
page is for creators who publish a protected release and for operators who run one.

> [!NOTE]
> Protection here means deterrence, traceability and revocation. It is not DRM and it does not
> promise to stop all copying. The last section says exactly what it does not do.

## What is yours

What SCRIPT//GO protects is your work:

- The scripts you wrote, in Lua or TypeScript. C# is next.
- The configs, data and schemas you made for them.
- The assets you created yourself: interface, images, sounds.

You declare your rights on every release. Publishing, protecting or selling through SCRIPT//GO
transfers none of them to us.

**On someone else's game.** Take a multiplayer platform built on a AAA open-world game. The game
belongs to its publisher. A server operator on that platform still owns every script they write
for their server. They can license it, protect it and sell it from their own store, and the
publisher's rights are untouched.

Ownership only matters if it can be enforced. Per-server licences and encrypted releases are what
enforce it: the script runs where a licence allows it, and stops where one ends.

## Three layers

| Layer | Applies to | What it gives you |
|---|---|---|
| Release signing | Every published release | Anyone can check that a release is the one the registry published, unaltered |
| Per-server licence | Paid packages, and packages you grant a free licence for | Only a licensed server runs the package, and a refund or a revocation ends that |
| Encrypted release (escrow) | Releases you choose to protect | The files are delivered encrypted; the key goes to a licensed, bound server only |

Signing covers every release, in every environment. The licence check needs a host whose adapter
can reach the licensing API. The third layer needs a loader on the server, and how strong it is
depends on the host. See [the tiers](#tiers).

## Signed releases

The registry signs every release when it is published. The signature covers the package, the
version and the SHA-256 of the file a buyer downloads.

`scriptgo add creator//name` checks that signature before it writes a file. A file that was altered
in storage or on the way is refused, even if its hash header was altered with it. The registry's
public keys are served by `GET /v1/signing-keys`.

Three separate keys are in play, so that one leaked key never forges the others:

- the **registry's release key** signs every published release;
- a **per-creator key** signs the manifest of an encrypted bundle
  (`GET /v1/creators/<username>/signing-keys`);
- the **licence-token key** signs licence answers (`GET /v1/licenses/public-key`).

## Publish an encrypted release

You can do it from the site or from the CLI. Both give the buyer the same kind of bundle.

### From the site

1. Open **Dashboard → Packages**, pick the package, then **New release**.
2. Tick **Protect this release (escrow)**.
3. Add the patterns to leave in clear text, if any (see [the allowlist](#the-allowlist)).
4. Upload the plain archive, as for any release.

The master runs the usual checks, builds the encrypted bundle and signs it with a key it holds
sealed for you. It keeps the bundle and the sealed key. It does not keep the plain archive.

### From the CLI

```bash
scriptgo publish --escrow --owns-code
scriptgo publish --escrow --escrow-ignore "config.lua" --escrow-ignore "locales/*.json" --owns-code
```

The CLI builds the bundle on your machine and signs it with your own key. It uploads the bundle and
hands the content key to the master over the authenticated API. The master seals the key at rest.
It never stores it in the clear, never logs it and never returns it.

`scriptgo pack --escrow` builds the same bundle without publishing, if you want to look at it first.

### The allowlist

An operator has to read and edit some files: the manifest, the docs, a config file. The allowlist
names what stays in clear text. It works like `escrow_ignore` on FiveM.

- The manifest, `README.md`, `CHANGELOG.md` and the licence file are always clear.
- You add patterns: `config.lua`, `locales/*.json`, `data/**/*.json`.
- Everything else is encrypted.

The allowlist is public. It is shown on the release page and on the package page, with the names of
the encrypted files (names only).

### Releases stay immutable

A published release cannot change, encrypted or not. Each release has its own content key. To rotate
a key, publish a new version.

## Buy, bind and run

This is the chain for a buyer's server:

1. **Pay** on the creator's own Tebex store. In development, a mock provider plays that part.
   Real checkout is not live yet: it stays off, for every shop, until Tebex approves it in writing.
2. **A licence is issued**, only after a verified payment event.
3. **Add a deployment** on the licence page, or let the server activate itself. You get a
   deployment token for that one server.
4. **The server binds itself.** The loader creates a key pair on the server and sends the public
   half. The first key it sends is bound to the deployment. The private half never leaves the server.
5. **The key is released**, wrapped to that server's key and short-lived. The loader decrypts,
   checks the signatures, and the package runs. It is checked again on a schedule.

Download the bundle from the licence page, or with `scriptgo add creator//name` signed in as the
account that holds the licence. A buyer never receives the plain archive.

### Loaders

| Host | Loader | What happens to the decrypted code |
|---|---|---|
| The .NET kit | Built into `ScriptGo.Host` | Stays in memory. Nothing is written to disk |
| A pure-script host | `scriptgo escrow load`, the reference loader | Written to disk on the bound server, with a delivery marker |

`scriptgo escrow load` is a reference loader, not a compiled host. It checks the licence, unwraps
the key and decrypts on the bound server. On a host that runs plain script it then writes the copy
to disk so the host can load it. That is licence-only protection: the operator can read those files.

```bash
scriptgo escrow load --bundle inventory_pro-1.4.3.escrow.zip \
  --package kestrel//inventory-pro --environment standalone \
  --deployment-token "$SCRIPTGO_DEPLOYMENT_TOKEN" --identity ./server-identity.json \
  --trusted-signer <bundle signer public key>
```

The CLI is in preview: when this page and `scriptgo escrow --help` disagree, the command wins. Pin
`--trusted-signer` to the bundle signer shown on the package page, so a bundle signed by anyone
else is refused.

### Moving a server

The binding follows the server's key, not its hardware. If you reinstall or move to a new machine,
the new key does not match and the key endpoint answers `server_key_mismatch`.

Open the licence in **Dashboard → Licenses** and use **Reset server key** on that deployment. The
next key the server sends is bound in its place. Each reset is recorded in the licence history, and
resets are rate-limited.

### When a licence ends

A refund, a lost payment dispute, an ended subscription or a revocation closes the licence.

- The **next key release fails at once**.
- A server that is already running **keeps going until its offline grace ends** (72 hours by
  default), then stops. The grace exists so that a short outage of the API never stops a paying
  server.

## Protect without selling

You do not have to sell a package to protect it. You can grant a **free licence** for one of your
own packages, so that an encrypted release runs on the servers you chose: your own, a partner's, a
tester's. Nothing is sold and no payment provider is involved. There is no offer, no checkout and no
store behind a granted licence.

A granted licence is an ordinary licence in every other way. It is bound to one server per
deployment, every key delivery is logged, the copy carries a delivery marker, and you can revoke it.

### Grant to an account

The recipient has a SCRIPT//GO account. Ask them for their **account id**: it is on their
**Dashboard → Settings** page, and `scriptgo login` prints it. It is not a secret. A creator username
works too. An e-mail address is not accepted, because the answer would tell you whether that address
has an account.

Open **Dashboard → Packages**, pick the package, and use **Grant a free license** under
*Free licenses*. Or from the CLI:

```bash
scriptgo grant create inventory-pro --to <account id> --note "Night City RP"
```

The recipient gets an e-mail and finds the licence under **Dashboard → Licenses**, marked as granted
by you. From there the chain is the one above: reveal the key once, add a deployment, let the server
bind itself.

### Grant to a server key

The operator has no account, or does not want one. They create the server's identity and send you
the public key it prints:

```bash
scriptgo escrow identity --identity ./server-identity.json
# public key   <43 characters>      ← this is what they send you. The file stays on their server.
```

A compiled host prints the same key when it starts. You grant to that key:

```bash
scriptgo grant create inventory-pro --server-key <public key> --environment standalone --name their-server
```

You hold this licence. Its one deployment is bound to that server key from the start, and its
**deployment token is shown once**: hand it to the operator over a private channel. With the token
they download the bundle and start their loader:

```bash
scriptgo add kestrel//inventory-pro --deployment-token <the token>
```

The token only works with the key you granted to. On any other server the key endpoint answers
`server_key_mismatch`, exactly as it does for a bought licence that was copied. If the operator
moves the server, use **Reset server key** on that licence in **Dashboard → Licenses**.

### Revoke

Use **Revoke** next to the grant, or `scriptgo grant revoke <licence id> --reason "<why>"`. The
reason is recorded and shown to the holder. Revocation behaves as described under
[When a licence ends](#when-a-licence-ends): the next key release fails at once, and a server that is
already running stops when its offline grace ends. A revocation cannot be undone; grant again.

You can revoke the licences you granted. You cannot revoke a licence someone paid for: that is for
the payment provider (a refund) or for SCRIPT//GO staff.

### Limits

- Only for your own packages, and only while the package can be delivered: a listing that
  SCRIPT//GO restricted or suspended after a report, or a package whose only release was yanked or
  restricted, cannot be granted. A private package cannot be granted either, because nobody but
  you could download it: make it unlisted.
- One live grant per account and per server key for a package. To change its terms, revoke it and
  grant again.
- 25 grants per package per day. Every grant and every revocation is in the audit log.

## Refusal reasons

`POST /v1/licenses/key` answers `200` with `valid: false` and one of these reasons. They are stable.
A `4xx` or `5xx` means the API could not answer; the loader then relies on its offline grace.

| Reason | Meaning | What to do |
|---|---|---|
| `unknown_key` | No licence matches this key or token for this package | Check the token and the package name |
| `expired` | The paid period is over | Renew at the provider |
| `revoked` | The licence was revoked | Read the reason on the licence page |
| `refunded` | The payment was refunded | Nothing: the licence has ended |
| `deactivated` | This deployment was deactivated | Add a deployment again |
| `environment_not_covered` | The licence does not cover this environment | Use a covered environment, or another offer |
| `deployment_limit` | More deployments are active than the licence allows | Deactivate one |
| `unbound` | The deployment has no server key yet | Let the loader send its public key |
| `server_key_mismatch` | The server's key is not the one bound to the deployment | Reset the server key on the licence page |
| `not_escrowed` | The release has no encrypted variant | Download it as a plain release |

## Watermarks

Two marks make a leaked copy traceable:

- a **release watermark** in the signed manifest of the bundle;
- a **delivery marker** that the loader stamps into the decrypted copy. It is tied to the licence
  and the deployment that received the key.

SCRIPT//GO staff can resolve a marker to a licence and a deployment, and each lookup is recorded.
A marker shows where a copy was delivered. It does not prevent the copy, and it does not by itself
prove who leaked it.

## Tiers

What a buyer's server gets depends on the host. Each environment has a tier, shown on
[the environments page](/environments#protection) and on each package page.

- **Code escrow.** The host runs compiled code outside the script VM and can hold a key. The
  release is decrypted in memory.
- **Licence and signing.** The host runs plain script, so its operator can read what it loads. An
  encrypted release is still delivered encrypted and bound to the server, then written to disk
  there. We make no code-secrecy claim on these hosts.
- **No licence check.** The adapter there has no licence check, so a package runs without one.
  Releases are still signed, so an altered file is detected. This is a technical fact about the
  adapter, not a selling rule: no environment decides what can be sold.

"Planned" next to a tier means it does not work on that host yet. The table on the
[Protect page](/protect#tiers-title) is read from the adapter registry, the same data as the
environments page, and each package page says what applies to that package.

## What we claim

- An encrypted release is encrypted at rest and in transit.
- The key is never shipped with the file. We hold it sealed and show it to no one.
- Per-server binding: a copied release does not open on a server that is not bound to the licence.
- Revocation at the next key release, on refund, lost dispute, ended subscription, admin decision
  or, for a licence you granted, your own decision. A server that is already running stops when its
  offline grace ends.
- Signed releases: a modified file is detected before it is installed.
- Traceable leaks: each delivery is marked with the licence and the deployment it went to.
- Getting past it takes real effort and leaves traces.

## What it does not do

- **It does not stop the operator of a server from reading code that runs on that server.** A host
  that must decrypt and run code can be inspected by whoever controls the machine. Encryption raises
  the cost and the watermark makes the copy traceable. Neither makes it impossible.
- **It does not hide code on a pure-script host.** There the protection is the licence check and
  the signature.
- **It protects server scripts only.** What a client receives can be read on that client.
- **It is not obfuscation.** Obfuscation is at most a speed bump, never protection. An optional
  minify step at packaging is in development; it is a speed bump too, and it is never counted as
  protection.
- **It is not DRM, and it does not promise to stop all copying.** It is deterrence, traceability
  and revocation. A marker shows where a copy was delivered; it does not by itself prove who leaked
  it.
- **It does not protect a game's files.** Game assets and code belong to their publisher. They do
  not belong in a package, encrypted or not.
- **It does not replace your terms.** The licence you sell under and the
  [rights declaration](/legal#creator-agreement) are what make a leak actionable.

## The game's IP

A game belongs to its publisher. A script written for it belongs to its author. SCRIPT//GO deals
only in the second.

- We do not sell a game, its content, or access to it.
- We do not ship, host or redistribute a game's code, models, textures, audio or maps.
- We do not decrypt, unpack or modify a game's files.
- We do not let encryption cover for them: a package that carries a game's files is refused or
  removed, encrypted or not.

Sellers declare their rights when they publish and answer for what they sell; SCRIPT//GO acts on
reports. See [the rules](/docs/selling#the-rules) and the [IP policy](/legal#ip-policy).

## Keep secrets on the server

The strongest protection is not shipping the secret at all. Keep prices, economy rules and
anti-cheat logic in server scripts, and send clients only what they need to display.
