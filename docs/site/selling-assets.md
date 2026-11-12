---
title: Selling assets
description: Sell maps, interiors, models, textures and sounds like scripts on every platform that delivers files to players: what a package holds, how each platform delivers it, what protection means for assets, encrypted assets on OPEN//77, and Cfx.re's own escrow on FiveM and RedM.
order: 6
---

A SCRIPT//GO package can carry **assets**: files players download and their game loads. That
covers maps, interiors, vehicles, models, textures, sounds and translations. You sell them exactly
like scripts: the same offers, licences, grants and refunds. A package can hold scripts, assets or
both.

Assets ship on every platform where a server sends files to its players: OPEN//77, FiveM, RedM,
Garry's Mod, Luanti and BeamMP, and in part on Rust (one custom map) and Hytale (asset packs). One
package can carry each platform's form. On OPEN//77 you can also choose to deliver them encrypted
([below](#encrypted-assets-on-open77)). On FiveM and RedM, `scriptgo pack` builds the upload for
Cfx.re's own asset escrow, which you run on your own Cfx.re account
([below](#fivem-and-redm-cfxres-asset-escrow)).

## What you can sell

Assets are data. A package's assets cannot contain code: no `.exe`, `.dll`, `.lua`, `.js`, no
script, no bytecode, whatever the file is named. `scriptgo validate` checks every file, including
the files inside an archive. Code goes in scripts.

Whether you may sell a given asset is up to you and the game's terms. A model you made from scratch,
an edit of the game's own files and a file taken from the game are different cases. Say which case
yours is when you publish (`scriptgo publish --asset-rights original|game-edits|game-extracted`, or
the release page): operators see it on the package page. SCRIPT//GO acts on reports.

## Declare them

Add the files to `scriptgo.lua`:

```lua
assets "media/*.png"                                   -- delivered where the platform takes plain files
environment_asset "open77" "dist/night_market.zip"     -- one platform's own format
environment_asset "fivem" { "stream/*", "data/night_market.meta" }
environment_asset "redm" "stream/rdr/*"                -- RedM: its own files (RDR2, not GTA V)
data_file "DLC_ITYP_REQUEST" "data/night_market.meta"  -- FiveM / RedM: load this file as data
game_build "fivem" "3095"                               -- the game build you made it for
```

Then check it:

```bash
scriptgo validate .
```

`validate` lists, per platform, how many files each player downloads and anything the server needs
(ArchiveXL, a map URL, FastDL).

## How each platform delivers them

| Platform | What you ship | What the server owner does |
|---|---|---|
| OPEN//77 | plain files, and `.zip` preload packages of REDengine archives (`archive/pc/mod/`), tweaks and engine config | installs the resource and restarts; players download it before joining |
| FiveM | `stream/` files, data files with `data_file` | installs the resource |
| RedM | the same form with Red Dead Redemption 2 files, declared with `environment_asset "redm"` | installs the resource |
| Garry's Mod | content in `materials/`, `models/`, `sound/`, `maps/` ... | copies the addon into `addons/` |
| Luanti | textures, sounds, models, translations | copies the media mod into `mods/` |
| BeamMP | BeamNG mod `.zip` files | copies them into `Resources/Client` |
| Rust | one custom `.map` | hosts the map at a URL and sets `server.levelurl` |
| Hytale | an asset pack `.zip` | copies it into the server's `mods/` |
| Standalone, LÖVE, Godot, .NET | files of the resource | nothing: there are no players to send them to |

`scriptgo pack . --target <platform>` builds each platform's form. If a file cannot reach players
on that platform, the pack stops and says why: nothing is left out without telling you. Each
platform page says what was tested on its real server: see [Environments](/docs/environments).

## Protection

For assets, SCRIPT//GO gives you:

- **A licence-gated download.** Only licence holders can download a release.
- **A fingerprinted copy per buyer.** Every buyer's download is different: it carries a signed
  record of its licence, so a copy found elsewhere can be traced back to who downloaded it.
- **Signed releases.** The CLI checks a download is the one SCRIPT//GO published.
- **Takedown on report.** Report a leak with the file; staff look it up and can revoke the licence,
  stop the server's deployment, and restrict or suspend the listing or the seller's store.

These four apply on every platform above, to what a buyer downloads from SCRIPT//GO.

What it does not do: a game has to have an asset in clear to draw it, so a player who wants to can
extract it from their game. Unzipping and re-packing a copy removes its fingerprint. Loose files
(FiveM and RedM `stream/` files, Garry's Mod content, Luanti media, a Rust map) are the same in
every copy: only the copy's `.scriptgo/fingerprint.json` names its buyer, as long as it is kept.
Assets are licensed, fingerprinted and traceable. Outside OPEN//77's encrypted assets and Cfx.re's
own escrow (below) they are not encrypted, and nothing makes them impossible to copy.

## Encrypted assets on OPEN//77

On OPEN//77 you can also publish a release with its preload packages **encrypted** (asset escrow):

```bash
scriptgo publish --asset-escrow --asset-rights original --owns-code
```

- **Encrypted at rest and in transit.** Each server's copy carries its preloads sealed for that
  server's deployment. On the server, in the download channel and on a player's disk while the game
  is not running, the archives are encrypted.
- **A key per deployment, never shipped.** The key is released only to the licensed server bound to
  that deployment. A copy taken from one server opens on no other.
- **Only for admitted players.** The server re-wraps the key for one player's session, and only for
  a player the OPEN//77 master admits to that server (enrolled, not banned, owns the game).
- **Revocable.** Revoke the licence or stop the deployment: from the next key renewal the server
  holds no key, and a game started after that cannot open the archives.
- **Still traceable.** Every encrypted copy is also fingerprinted to its licence.

What it does not do: the game engine loads archives from files, so while the game runs the
decrypted archives are on the player's disk, and a player can copy what their game loads. It needs
an OPEN//77 server and game client with asset escrow. It cannot be combined with `--escrow` (code
escrow) on the same release.

**Why SCRIPT//GO encrypts only on OPEN//77.** Decrypting an asset has to happen inside the game
client. On the other platforms that client belongs to the platform, and a SCRIPT//GO resource cannot
run a decryptor in it.

## FiveM and RedM: Cfx.re's asset escrow

Cfx.re runs its own asset escrow for FiveM and RedM. **Cfx.re encrypts, not SCRIPT//GO**: you
upload your resource to your own Cfx.re account, Cfx.re encrypts it there, and a server starts it
only if its Cfx.re key holds the asset. SCRIPT//GO builds the folder you upload:

```bash
scriptgo pack . --target fivem --cfx-escrow     # or --target redm
```

It writes `dist/fivem-cfx-escrow/<name>/` and `<name>-<version>.zip`, the zip you upload. Its
`fxmanifest.lua` adds `lua54 "yes"` and an `escrow_ignore` list. To leave files readable for the
server owner, such as a config, name them in `scriptgo.lua`:

```lua
cfx_escrow_ignore { "config.lua", "locales/*.lua" }
```

The SCRIPT//GO shim (`scriptgo_shim.lua`, MIT) is always left readable, so a server owner can see
what talks to SCRIPT//GO. The pack lists the files Cfx.re will encrypt and the ones it will not.

What Cfx.re's escrow does, from Cfx.re's documentation:

- It encrypts **Lua scripts and `.ydr`, `.ydd` and `.yft` models**. Everything else stays as you
  uploaded it: textures (`.ytd`), maps (`.ymap`), `.ytyp` and the other streamed types, data
  files, JavaScript, and NUI pages, which are sent to each player's browser.
- An upload is at most 1 GB. Escrowed Lua must be Lua 5.4.
- Servers need FiveM server build 5181 or later, or RedM server build 12735 or later.
- You upload at portal.cfx.re, under Created Assets. Escrowed assets are sold through a Tebex
  package linked to the asset, and cannot be transferred to another account.
- In 2025 Cfx.re reported a flaw that let assets be extracted from the game client, and added an
  obfuscation layer for 3D models. A player's game still draws the models it receives.

**How it fits with SCRIPT//GO.** These are two different deliveries:

- A copy a buyer **downloads from SCRIPT//GO** is licence-gated, fingerprinted to that buyer and
  signed. On FiveM and RedM it is not encrypted.
- The **escrowed upload** reaches buyers through Cfx.re, as **one copy for every buyer**. SCRIPT//GO
  delivers none of it, and its per-buyer fingerprint is not in it: Cfx.re ties each server to the
  asset through its own accounts.

If you sell both ways, the copies SCRIPT//GO delivers are not encrypted. The Cfx.re account, the
upload and the Tebex package are yours, under Cfx.re's and Tebex's terms: SCRIPT//GO holds no key and
does not see who bought through Cfx.re.

The pack refuses a buyer's fingerprinted copy: the upload is the creator's, from their own sources.
No FiveM or RedM server has run these builds here: an FXServer does not start without a Cfx.re
key.

## Other platforms

Garry's Mod, Luanti, BeamMP, Rust and Hytale have no supported way to keep a seller's assets
encrypted until the game loads them. What each one delivers, and what protects it:

| Platform | What players receive | What protects it |
|---|---|---|
| Garry's Mod | the addon's content, from the server or FastDL, in clear | licence-gated download; one fingerprint record for the addon folder |
| Luanti | media files the server sends and each client caches, in clear | licence-gated download; one fingerprint record for the media mod |
| BeamMP | the mod `.zip` files from `Resources/Client`, in clear | licence-gated download; a fingerprint record inside each mod zip |
| Rust | the `.map` from the URL the operator hosts, in clear | licence-gated download; the map is a loose file, so copies are not fingerprinted |
| Hytale | the asset pack's assets, sent by the server | licence-gated download; a fingerprint record inside the pack zip |

Two platform features come close, and neither is asset encryption, so SCRIPT//GO does not count them
as protection. BeamMP's `protectmod` makes a server stop sending a mod: each player gets the file
elsewhere and still has it in clear. RustEdit, a third-party map editor, can encrypt its own data in
a map, which its server extension reads; the map's Rust data stays readable. The detail per platform
is in
[the spec](https://github.com/scriptgo-hq/scriptgo-sdk/blob/main/docs/spec/assets.md#client-work-per-environment).

## Check a copy

```bash
scriptgo assets fingerprint night_market-2.0.0.zip
```

It prints the licence each fingerprint names, and whether the signature is valid.
