---
title: Selling assets
description: Sell maps, interiors, models, textures and sounds like scripts: what a package holds, how each platform delivers it, what protection means for assets, and what it does not.
order: 6
---

A SCRIPT//GO package can carry **assets**: files players download and their game loads. That
covers maps, interiors, vehicles, models, textures, sounds and translations. You sell them exactly
like scripts: the same offers, licences, grants and refunds. A package can hold scripts, assets or
both.

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
data_file "DLC_ITYP_REQUEST" "data/night_market.meta"  -- FiveM: load this file as data
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

What it does not do: a game has to have an asset in clear to draw it, so a player who wants to can
extract it from their game. Unzipping and re-packing a copy removes its fingerprint. Assets are
licensed, fingerprinted and traceable. They are not encrypted, and nothing makes them impossible to
copy.

An encrypted asset format exists in the SDK for platforms that build support for it into their
game client ([the spec](https://github.com/scriptgo-hq/scriptgo-sdk/blob/main/docs/spec/assets.md)).
No platform has that support today.

## Check a copy

```bash
scriptgo assets fingerprint night_market-2.0.0.zip
```

It prints the licence each fingerprint names, and whether the signature is valid.
