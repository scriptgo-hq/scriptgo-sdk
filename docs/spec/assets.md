# Assets: client-delivered content (spec v1)

A SCRIPT//GO package can carry **assets**: maps, interiors, models, textures, sounds, translations,
any data a game client downloads and loads. Assets are sold exactly like scripts: one package can
hold scripts, assets or both, the same licences, grants, deployments and refunds apply (ADR-0037,
ADR-0038), and there is no separate category or gate per asset type. The seller and the operator
choose what to sell and run; staff act on reports.

This document is normative for the manifest section, the inspection every builder runs, `scriptgo
pack`, the per-buyer build the platform makes at download, and the asset-escrow container format.
The code is in `packages/manifest/src/assets.ts` (inspection), `packages/manifest/src/zip.ts` (the
strict zip reader), `packages/escrow/src/fingerprint.ts` and `packages/escrow/src/asset-escrow.ts`,
and `packages/cli/src/lib/assets.ts`, `asset-targets.ts`, `asset-verify.ts`.

## Honest stance (normative)

A client that renders an asset holds it in clear: in its memory, then in GPU memory. Whatever
SCRIPT//GO does, a player who controls their machine can extract an asset their game draws. So:

- **v1 protection is: licence-gated download, a fingerprinted copy per buyer, signed releases, and
  takedown on report.** Say "licensed, fingerprinted, traceable". Do not say "encrypted" or
  "escrow" for v1 assets, and never "unbreakable".
- A fingerprint identifies a copy; it does not prevent copying. Repacking the files removes it.
- **Asset escrow** (below) is a format, a key protocol and a client hook. It needs work in each
  platform's game client; OPEN//77 is the first environment with that work (on a branch, not
  released). Say "encrypted at rest and in transit, a key per session, revocable". It raises the
  cost of copying an asset from a server, from a distribution channel or from a player's disk
  while the game is not running; it does not prevent extraction from a running client.

## Manifest

Four directives (`docs/spec/manifest.md`). The Lua, JSON and .NET parsers share their fixtures
(`sdk/lua/spec/fixtures/manifests*/assets*`).

| Directive | Value | Meaning |
|---|---|---|
| `asset(s)` | glob(s) | Generic assets: delivered on every environment that takes generic files, in that environment's form |
| `environment_asset(s)` | `"<env>" "<path>"` or `"<env>" { ... }` | Assets in one environment's native form (an OPEN//77 preload package, FiveM `stream/` files, a Rust map ...) |
| `game_build(s)` | `"<env>" "<build>"` or `"<env>" { ... }` | Game builds the assets were made for, as the platform names them (`"2.31"`, `"3095"`). `^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$` |
| `data_file(s)` | `"<TYPE>" "<path>"` or `"<TYPE>" { ... }` | FiveM/RedM `data_file` lines: type (`^[A-Z0-9_]{1,64}$`) and an asset path (a file, or a folder of asset files) |

`scriptgo.json` keys: `assets`, `environment_assets`, `game_builds`, `data_files`. Parsed fields:
`assets`, `environmentAssets`, `gameBuilds`, `dataFiles`.

Parser errors: `unsafe_path`; `reserved_path` (`.scriptgo/` is reserved for the fingerprint);
`invalid_environment`; `invalid_game_build`; `invalid_data_file`. A package may hold assets and no
script: `empty_resource` is raised only when there are no scripts, no files and no assets.

```lua
resource "night_market"
version "2.0.0"
scriptgo_version ">=0.1.0"
environments { "open77", "fivem", "garrysmod" }

server_script "server/market.lua"
assets "media/*.png"                                   -- resource files / content, where taken
environment_asset "open77" "dist/night_market.zip"     -- a REDengine preload package
environment_asset "fivem" { "stream/*", "data/night_market.meta" }
data_file "DLC_ITYP_REQUEST" "data/night_market.meta"
game_build "open77" "2.31"
game_build "fivem" "3095"
```

## Data only

An asset is data. `inspectAssets` refuses, with `asset_not_data`:

- an extension of code a host, a client or an OS runs (`CODE_EXTENSIONS`: native binaries and
  installers, mod loaders (`.asi`, `.reds`), scripts and bytecode (`.lua`, `.js`, `.py`, `.jar`,
  `.gd`, `.ysc` ...), and documents that run script (`.html`, `.svg`, `.swf`);
- a file that starts like an executable whatever its name: `MZ`, ELF, Mach-O, `CAFEBABE`, `#!`, Lua
  bytecode (`1B 4C 75 61`), LuaJIT bytecode (`1B 4C 4A`), WebAssembly.

Archives (`.zip`, `.7z`, `.rpf`, `.gma`, `.vpk` ...) are refused as loose assets (`asset_archive`)
and accepted only as an environment's declared container (`environment_asset` of `open77`,
`beammp` or `hytale`). Inside a container, every entry is checked the same way, and a nested
archive is refused (`asset_nested_archive`).

Code belongs in scripts, where escrow, the portability scan and the runtime apply.

## Containers

Every container is read by one strict reader (`packages/manifest/src/zip.ts`, a byte-identical copy
in `packages/escrow/src/zip.ts`, held equal by a test). It reads the central directory and refuses:
zip64, multi-disk archives, encrypted entries, methods other than stored (0) and deflate (8),
duplicate paths, unsafe paths (absolute, `\`, `:`, control characters, empty, `.` or `..`
segments, over 1024 bytes), symbolic links, a local header that names another file than its
central record, any byte before the first entry, between entries, before the central directory or
after the end record, and a CRC-32 mismatch. At most 16 384 entries.

## Limits

Defaults (`ASSET_LIMITS`); the platform may lower them (an owner decision, see the end).

| Limit | Default |
|---|---|
| One asset file or container | 256 MiB |
| Expanded size of one container | 512 MiB |
| All assets of a release | 1 GiB |
| Asset files of a release | 16 384 |

Environment limits on top: OPEN//77 at most 8 preload packages of 256 MiB each; Luanti media files
about 16 MB at most ("the engine is unable to handle files over ~16MB", api.luanti.org/mods); GMod
16 MB per direct download by default (`net_maxfilesize`, 64 MB at most), FastDL above; FiveM warns
on streamed assets over 16 MiB.

## The download size per player

`inspectAssets` reports, per environment, the files delivered and `downloadBytes`: what each
player downloads there, the files as delivered (a container counts at its packed size). The
registry shows it on the package page per environment. Bundled hosts report 0: no player
downloads anything.

## Game builds

REDengine archives and GTA streamed files are made for a game build and can break on the next one.
`game_build "<env>"` records the builds a package was made and tested for; it is information for
the operator and the store page, never a load gate. A package with OPEN//77 preloads or FiveM native
assets and no `game_build` for that environment gets the warning `asset_game_build_missing`.

## Delivery per environment

`ASSET_RULES` in `packages/manifest/src/assets.ts`, also published per environment in
`sdk/environments.json` (`assets`). "Real run" says what was executed against the real runtime.

| Environment | Support | Generic `assets` | `environment_asset` | `scriptgo pack --target` writes | Real run |
|---|---|---|---|---|---|
| OPEN//77 | supported | resource `files`: every player downloads them before the resource starts; scripts and the WebUI read them | `.zip` preload packages under `archive/pc/mod/` (`.archive`, `.xl`), `r6/tweaks/` (`.yaml`, `.yml`, `.tweak`), `engine/config/` (`.ini`); `.archive` must start with `RDAR` | `open77/<name>/` with `preload_mod(s)` lines, `dependency "archivexl"` when a preload holds `.xl` | not run (needs an OPEN//77 server and a game client; see below) |
| FiveM | supported | `stream/` files are streamed; others listed in `files {}` | `stream/` (`.ydr .ydd .yft .ytd .ybn .ymap .ytyp .ynd .ynv .ycd .ypt .ymt ...`) and `data_file` targets | `fivem/<name>/fxmanifest.lua` with `files`, `data_file`, `this_is_a_map "yes"` for a `.ymap`; no shim for an asset-only package | not run (an FXServer run needs a Cfx.re licence key; no client) |
| RedM | partial | as FiveM | as FiveM | not built yet (validated only) | not run |
| Garry's Mod | supported | content under `materials/ models/ sound/ maps/ resource/ particles/` | the same, `.bsp` maps in `maps/` | `garrysmod/scriptgo_<name>/` with the content and `lua/autorun/server/sgassets_<name>.lua` (`resource.AddSingleFile` per file) | **run**: srcds loads the addon, every file is found in the GAME file system and added to the download list |
| Luanti | supported | media under `textures/ sounds/ models/ media/ locale/ fonts/` in the formats Luanti sends (`.png .jpg .tga .ogg .x .b3d .obj .gltf .glb .ttf .woff .tr .po`) | the same | `luanti/mods/sgmedia_<name>/` (`mod.conf`, `init.lua`, media); with scripts also `mods/scriptgo/` | **run**: the official server image announces every file with the SHA-1 of its bytes |
| BeamMP | supported | refused (BeamMP sends mod zips only) | `.zip` BeamNG mods | `beammp/Resources/Client/<mod>.zip` (and `Resources/Server/scriptgo/` with scripts) | not run (BeamMP-Server needs an AuthKey; none here) |
| Rust | partial | refused | one `.map` | `rust/<map>.map` and the `server.levelurl` step | not run |
| Hytale | partial | refused | an asset pack `.zip`: `manifest.json` with `"IncludesAssetPack": true` and no `Main`, `Common/`, `Server/` | `hytale/mods/<pack>.zip` | not run (no Hytale server files here) |
| standalone, LÖVE, Godot, .NET, Neovim, CC: Tweaked | bundled | files of the resource (`resource.readFile`) | files of the resource | (the resource itself) | no client exists to deliver to |
| Roblox, KCD MP, Project Zomboid, DST | unsupported | error `assets_unsupported` | error | none | - |

Notes per environment:

- **OPEN//77.** Preload packages are mounted when the game boots, so a new or changed package needs
  a server restart, and every player downloads it before joining. The OPEN//77 server accepts a
  preload only when every file lands under one of its mod roots and none executes; a file anywhere
  else refuses the whole package (OPEN//77's `ModRootPolicy`). ArchiveXL is executable on the
  client: a server whose preloads need it runs in OPEN//77's unsecured mode, and `pack` says so.
- **FiveM / RedM.** FXServer streams `stream/` itself; `files` makes clients download the rest,
  and `data_file` tells the game to load a file as data. A native file outside `stream/` that no
  `data_file` names is an error (`fivem_asset_unused`): FiveM would ship it and never load it. The
  FiveM shim has no licence check, so a package **with scripts** that needs one is refused by
  `pack`; an asset-only package packs, its licence gates the download.
- **Garry's Mod.** A `.bsp` is downloaded like any content; to play on it the operator sets it as
  the server's map, which also makes GMod send it. Upper-case paths are a warning (Linux servers and
  `.gma` lower-case them).
- **Luanti.** Media names are one namespace for every mod: a name that does not start with
  `<resource>_` or `<resource>.` is a warning. Luanti does not load a mod folder without
  `init.lua` (measured on 5.18: the folder is skipped and its media is not collected), so the media
  mod has a one-line `init.lua`.
- **Rust.** A custom map is served from a URL the operator hosts (`server.levelurl`); the server and
  every player download it from there. A plugin cannot send files to players, so a `.map` is all a
  package can deliver on Rust, one per server. The map is a loose file: copies are not fingerprinted
  per buyer.
- **Hytale.** Asset packs go in the server's `mods/` folder and the server sends their assets to
  players. The rules above come from Hytale's documentation and the SDK's own plugin manifest;
  no Hytale server has loaded a pack built this way yet.

## Packing

`scriptgo pack <dir> --target <t>` runs `inspectAssets` for the target and writes its native form.
Nothing is dropped silently:

- any inspection error, for any environment, stops the pack (the package is one product);
- an asset the target cannot deliver is an error (`assets_unsupported`, `fivem_asset_unused`,
  `rust_asset_type` ...);
- a package with assets none of which the target delivers is `assets_not_for_target`, unless
  `--without-assets` asks for that build on purpose; the output then lists what was left for the
  other targets;
- `pack --target scriptgo` (the upload) carries every environment's assets, and `publish` and that
  target refuse a buyer's fingerprinted copy (`asset_fingerprinted`).

`scriptgo validate` runs the same inspection and prints the per-environment report.

## Signed releases

The registry signs every published release (ADR-0028): ed25519 over
`{ v, package, version, sha256, size, escrow, publishedAt }`, checked by `scriptgo add` before a
file is written. A per-buyer copy has its own bytes, so for a release with assets **the platform
signs each delivered copy**: the same payload with the copy's `sha256` and `size`, plus
`release: { sha256 }` (the published archive) and `fingerprint: <marker>`, and sends the marker as
`X-ScriptGo-Fingerprint`. `scriptgo add` checks `package`, `version` and `sha256` against the
downloaded bytes as for any release; for a copy (the header present) it also requires the signature,
checks that the signed `fingerprint` is the header's and that `release.sha256` is the version the
registry lists, instead of comparing the listed hash with the copy's. Each fingerprint record is
also signed (below).

## Per-buyer builds (fingerprint `scriptgo-asset-fingerprint/1`)

At download the platform gives each licence (and deployment) its own copy of the release archive.
A signed record naming the licence is added to the archive and to every container in it, so the
SHA-256 of the archive and of each container differ per buyer, and a copy found elsewhere names
where it came from.

### The record

```text
marker = base64url( HMAC-SHA256( fingerprintSecret,
           "scriptgo.asset-fingerprint.v1\n" + release + "\n" + licence + "\n" + deployment ) )
record = { format: "scriptgo-asset-fingerprint/1", package, version, release, licence, deployment,
           container, marker, signerPublicKey, signature }
signature = base64url( ed25519( canonicalJson(record with signature = "") ) )
```

`fingerprintSecret` is at least 32 bytes and never leaves the platform: only the platform can
recompute a marker. `container` is the container's path in the release archive, `""` for the
release archive itself. `deployment` is `""` when the download is not tied to one server.
`canonicalJson` is the escrow canonical JSON (sorted keys, no spaces). The entry's bytes are
`canonicalJson(record)` in UTF-8.

### Where the record goes

| Container | Entry path |
|---|---|
| the release archive | `<resource>/.scriptgo/fingerprint.json` |
| an OPEN//77 preload | `archive/pc/mod/<stem>.scriptgo-fingerprint.json`, `<stem>` = the container's file name without `.zip`, characters outside `A-Za-z0-9_.-` replaced by `_` |
| any other container | `.scriptgo/fingerprint.json` |

`fingerprintEntryPath(environment, containerPath)` in `@scriptgo/manifest` gives it. OPEN//77
accepts a preload's files under its mod roots only, so the record lives in `archive/pc/mod/`, as an
inert `.json` the game does not load (it mounts `.archive` files; ArchiveXL reads `.xl`). That the
file is ignored by the game client is an inference from those loaders' documented inputs: it has
not been run in the game.

### The algorithm

Input: the published release archive (exactly the uploaded bytes), its resource root `<name>/`, the
list of containers (`{ path, entry }`), the identity `{ package, version, release, licence,
deployment }`, the fingerprint secret and the fingerprint signer's seed.

1. For each container, in path order: take its bytes from the release archive (inflated if
   stored deflated); refuse it if it already holds a fingerprint entry; append one **stored** entry
   at `entry` holding the record with `container = path` (`appendStoredEntry`).
2. Put the stamped containers back (`replaceEntries`): every other entry keeps its bytes, method,
   flags, times and attributes; each replaced entry is written stored; offsets are recomputed.
3. Append `<root>.scriptgo/fingerprint.json` (record with `container = ""`) to the result.

Every entry written has DOS date `0x0021`, time `0`, the UTF-8 flag, method 0, and a fresh central
directory and end record (no comment change). The output is **deterministic**: the same inputs give
the same bytes, so a copy can be cached by `(release, licence, deployment)` or rebuilt on demand,
and its SHA-256 is known before it is served. Output: the copy, its SHA-256, the marker, and each
container's new SHA-256 and size.

### What it survives and what it does not

- It survives: copying the archive, unzipping and re-zipping the outer archive with the containers
  untouched (each container keeps its record and its per-buyer SHA-256), and installing a
  container as is (an OPEN//77 server serves the stamped preload to every player, a BeamMP server
  the stamped mod zip).
- It does not survive: deleting the record, or repacking a container (unzip and rezip), which
  changes every hash; extracting the assets themselves (a `.archive`, a texture) from the container;
  loose files (FiveM `stream/` files, GMod content, Luanti media, a Rust map): those are identical in
  every buyer's copy, only the folder's `.scriptgo/fingerprint.json` identifies the copy, as long as
  it is kept.
- Lookup: by the copy's or a container's SHA-256 (exact copy), or by a record found in a file
  (its marker is checked against the platform's secret). Traceability, never prevention.

`scriptgo assets fingerprint <copy.zip|folder>` reads and verifies every record of a copy.
`packages/escrow/test/vectors/asset-vectors.json` holds a complete worked example.

## Asset escrow (`scriptgo-asset-escrow/1`)

A container of encrypted asset files, readable in random access, so a client hook can decrypt a
file's bytes in memory when the engine reads them. Vetted primitives only (Node crypto here;
libsodium or the OS crypto in a hook): AES-256-GCM, HKDF-SHA256, X25519, ed25519, SHA-256.

### Layout

```text
"SGAE" | version u8 = 1 | 3 zero bytes | headerLength u32 LE | header (canonical JSON, UTF-8) | body
```

`header`: `{ format: "scriptgo-asset-escrow/1", cipher: "AES-256-GCM-STREAM", kdf:
"HKDF-SHA256+X25519", package, version, release, deployment, chunkBytes, keyId, fingerprint,
files: [{ path, bytes, chunks, offset, length, noncePrefix, sha256 }], signerPublicKey, signature }`.
`signature` is ed25519 over `canonicalJson(header with signature = "")` by the platform's signer;
`fingerprint` is the copy's marker or null. Header at most 4 MiB. `chunkBytes` is 4096 to 16 MiB
(default 1 MiB).

### Keys

```text
contentKey  = HKDF-SHA256(ikm = releaseSecret, salt = "scriptgo.asset-escrow.cek.v1", info = deployment, 32)
keyId       = base64url( SHA-256("scriptgo.asset-escrow.keyid.v1" ‖ contentKey)[0..16] )
noncePrefix = HKDF-SHA256(ikm = contentKey, salt = "scriptgo.asset-escrow.nonce.v1",
                          info = path + "\n" + SHA-256(plaintext), 8)
```

`releaseSecret` (32 random bytes per release) never leaves the platform. One content key per
deployment: a key copied from one licensed server opens no other server's container.

### Body

Each file, in path order, is cut into chunks of `chunkBytes` (the last may be shorter; an empty
file is one empty chunk). Chunk `i`:

```text
nonce = noncePrefix (8 bytes) ‖ u32 BE i
aad   = "scriptgo-asset-escrow/1\n" + package + "@" + version + "\n" + path + "\n" ‖ u32 BE i ‖ u8 final
ct    = AES-256-GCM(contentKey, nonce, plaintext chunk, aad) ‖ 16-byte tag
```

`final` is 1 for the last chunk. A file's chunks are contiguous at `offset` (relative to the body);
`length` is their total; `sha256` is the SHA-256 of that ciphertext. The aad binds every chunk to
its package, version, path, index and position, so chunks cannot be swapped, reordered, truncated
or moved between files even by someone who can re-sign the header (tested).

### Reading (normative for every reader)

Before any key is used: magic, version, the zero bytes, header length, header JSON in canonical
form, `format`,
`cipher`, chunk size bounds, the signature (and the pinned signer when one is configured), every
file's path rules, `chunks`, `length = bytes + 16 × chunks`, contiguous offsets, a body length equal
to the sum, and each file's ciphertext SHA-256. Then `keyId` must match the key. A read of
`(path, offset, length)` decrypts only the chunks it covers; any tag failure is an error, never a
partial result. Closing a reader wipes its key.

### Key wrapping

- **To a licensed server**: the escrow ECIES wrap (`docs/spec/escrow.md`), `info =
  "scriptgo.escrow.keywrap.v1"`, with `aad = "scriptgo-asset-escrow/1\nserver\n" + package + "@" +
  version + "\n" + deployment`.
- **To a player's session**, by the server: `kek = HKDF-SHA256(ikm = X25519(ephemeral,
  clientSessionPublic), salt = epk ‖ clientSessionPublic, info =
  "scriptgo.asset-escrow.client-keywrap.v1", 32)`, `wrapped = AES-256-GCM(kek, nonce, contentKey,
  aad)` with `aad = "scriptgo-asset-escrow/1\nclient\n" + package + "@" + version + "\n" + keyId`.
  The session key pair lives in the client's memory for one connection.

### The key protocol

Three hops. No hop carries a key in clear, and the `releaseSecret` never leaves the platform.

```text
API ──(1) POST /v1/licenses/key {kind:"assets"}──▶ licensed server   wrapped to the server identity, server aad
licensed server ──(2) per player session────────▶ game client      re-wrapped to the session key, client aad
game client ──(3) in memory─────────────────────▶ engine loader    sg_asset_reader_read
```

1. **API to server.** `POST /v1/licenses/key` with `kind: "assets"` and the usual body
   (`deploymentToken`, `package`, `version`, `environment`, `serverPublicKey`). The checks and their
   order are those of code escrow (`api.md`), plus `not_escrowed` when the release has no asset
   escrow. A granted answer is the code-escrow answer plus `keyId` and `version`; `aad` is the
   server aad of "Key wrapping". The server checks `aad` against the package, version and
   deployment it expects before it unwraps (`sg_asset_key_unwrap`, kind `SG_ASSET_WRAP_SERVER`;
   .NET `AssetKey.UnwrapForServer`) and keeps the key in guarded native memory. It renews on the
   code-escrow cadence; a definitive refusal (revoked, refunded, deployment unbound or deactivated)
   makes it drop the key and stop handing it out. Every grant and refusal is in the key audit
   (`escrow_key_events`, `kind = assets`).
2. **Server to client.** The client makes an X25519 session key pair in memory for one connection
   and sends the public half with the `keyId`s it needs; the server answers each `keyId` it holds
   with `sg_asset_key_wrap` (a fresh ephemeral key and nonce per answer; .NET
   `AssetKey.WrapForClient`) and the signer it trusts. The transport is the environment's own (for
   OPEN//77, below).
3. **Client.** `sg_asset_key_unwrap` (kind `SG_ASSET_WRAP_CLIENT`), `sg_asset_container_open` with
   the signer pinned, `sg_asset_container_bind`, then reads. The session private key and the
   content key live in `sodium_malloc` memory and are wiped on free.

**What a revocation does.** From the next renewal (or once offline grace has run out) the server
holds no key and answers no client; a client that starts after that cannot open a container. A
client already running keeps what it decrypted until it exits. A server operator who copies the
key out of their own process is not stopped by this protocol; the fingerprint in each container's
header still names the licence.

### The client hook (interface)

A platform implements five calls in its game client, in native code. `libscriptgo`
(`sdk/native`, `escrow.h`, section "asset escrow") implements all five; a hook links or loads it:

| Call | Does |
|---|---|
| `session_key() -> publicKey` | creates an X25519 key pair for this connection, in memory; returns the public half to send to the server |
| `accept_key(wrapped, aad) -> keyId` | unwraps the content key the server sent for this session (`unwrapAssetKeyOnClient`) |
| `open(container, keyId) -> handle` | runs every check of "Reading" on a container the client downloaded |
| `read(handle, path, offset, length) -> bytes` | decrypts the chunks covering the range, into memory handed to the engine's loader |
| `close(handle)` | wipes the key and the decrypted buffers |

The goal is that decrypted bytes go to the engine's file system layer in memory and are never
written to disk. Where an engine cannot mount from memory, a hook may materialise files for the
life of the process only, and must say so (OPEN//77 below). `AssetContainerReader` in
`packages/escrow/src/asset-escrow.ts` is the reference decryptor and `sdk/native/src/asset.c` the
native one; `scriptgo assets seal` and `scriptgo assets open` make and read containers (`open` also
reads an escrowed OPEN//77 preload). `asset-vectors.json` and `sdk/native/tests/asset_vector.h`
hold a container, its key, a server wrap, a client wrap, another deployment's key and an escrowed
OPEN//77 copy, with the plaintext hashes; the TypeScript, C and .NET tests read the same vector.

### OPEN//77 (escrowed preloads)

A release published with `scriptgo publish --asset-escrow` (refused together with code `--escrow`,
and without an OPEN//77 container) is stored as usual, plus a random `releaseSecret` the API keeps
sealed. On a download **by a deployment token**, each OPEN//77 preload container
(`dist/<stem>.zip`) of the buyer's copy is replaced by an **escrowed preload**: a zip holding
`archive/pc/mod/<stem>.sgae` (the preload's files sealed for that deployment, signed by the
platform's fingerprint signer, with the copy's marker as `fingerprint`) and the usual fingerprint
record (`escrowedPreloadTransform` through `buildFingerprinted({ transform })`). The rest of the
copy (scripts, media) is the normal fingerprinted copy. A licence download without a deployment
gets containers sealed for the deployment `""`, which no key answer ever opens; creator and staff
account copies stay plain and fingerprinted.

The OPEN//77 server distributes the escrowed preload through its existing preload channel
(`/mods/v1/`), and the launcher copies the `.sgae` into `<game>/archive/pc/mod/`, where the engine
ignores it. The key path:

| Step | Who | What |
|---|---|---|
| 1 | server | at start and on renewal, `POST /v1/licenses/key {kind:"assets"}` per escrowed resource; unwraps with its escrow identity |
| 2 | client plugin, at boot, before the engine mounts archives | finds `archive/pc/mod/*.sgae`, makes a session key pair, asks the server it was launched for (`OP77_CONNECT`): `POST /assets/v1/keys {sessionPublicKey, keyIds}` |
| 3 | server | answers each `keyId` it holds, re-wrapped to that session (client aad), with its trusted signer; logged per request |
| 4 | client plugin | opens each container with that signer pinned, binds, decrypts |

**What OPEN//77 cannot do yet, said plainly.** REDengine mounts archives from files under
`archive/pc/mod/` at boot; no in-memory mount is known for 2.5. The OPEN//77 hook therefore
decrypts in memory and then **materialises the files for the life of the game process**: written
at boot next to the container, listed in a journal, deleted when the process exits, and swept at
the next boot if the process died. While the game runs, the plaintext is on the player's disk.
What it still buys: the asset is encrypted on the server, in the distribution channel, in the
launcher's cache and on the player's disk whenever the game is not running, and a client that is
not launched for a licensed, unrevoked server gets no key. A true in-memory mount (hooking the
depot's archive loading) is future work and needs reverse engineering of the 2.5 binary.

Who may ask for a key at step 2 is the server's policy: by default any client that can reach the
server, as for the preload files themselves. Binding it to a player identity (a master connect
ticket) is an open decision below.

### Client work per environment

| Environment | Client work escrow needs | Feasibility | What it would buy |
|---|---|---|---|
| OPEN//77 | the key exchange at boot and a decryptor in the RED4ext client plugin (built, see "OPEN//77"); a true in-memory mount needs the depot's archive loading hooked | key exchange and decryption: built and tested outside the game; in-memory mount: unresearched for REDengine 2.5 | an escrowed preload is useless off a licensed, unrevoked server; while the game runs the files are on disk, and extraction from a running client remains |
| FiveM / RedM | none possible from a resource: the client is Cfx.re's. FiveM's own Asset Escrow encrypts stream files tied to Cfx.re accounts and server keys; on 2025-08-08 Cfx.re reported a flaw that let assets be extracted from the game client, and on 2025-10-16 added an obfuscation layer for 3D models and a re-encrypt button ([Asset Security Update](https://forum.cfx.re/t/asset-security-update/5344773), [Introducing Asset Escrow](https://forum.cfx.re/t/introducing-asset-escrow-for-your-resources/4777151)) | not by SCRIPT//GO | sellers on FiveM rely on the platform's own escrow and on enforcement against servers |
| Garry's Mod | a binary module on every client; GMod clients do not load server-sent binary modules | not feasible | - |
| Luanti | an engine fork (media are hashed and cached by the client) | not feasible without forking the engine | - |
| BeamMP | the BeamMP launcher or a BeamNG mod with native code | open; BeamNG loads zips through its own virtual file system | - |
| Rust | Facepunch's client | not feasible | - |
| Hytale | the official client | not feasible today | - |
| bundled hosts | the host itself can call `AssetContainerReader` (one process, the operator's machine) | feasible, but the operator holds the key, so it protects nothing from them | at-rest encryption only |

v1 never depends on escrow: every target above ships v1 assets without it.

## What the platform (API) must do

The SDK fixes the formats; the API and website build these.

### Data model

- `release_assets` (one row per release with assets): `release_id`, `files` (the inspection's
  `[{ path, bytes, sha256 }]`), `total_bytes`, `environments` (the inspection's per-environment
  report: support, files, containers with `sha256`, `entries`, `expanded_bytes`, `roots`,
  `download_bytes`, `needs`, `game_builds`), `containers` (`[{ path, environment, entry }]`, the
  entry from `fingerprintEntryPath`), `inspected_with` (SDK version).
- `asset_deliveries` (one row per copy built): `id`, `release_id`, `licence_id`, `deployment_id`
  (nullable), `marker`, `sha256`, `size`, `container_hashes` (`[{ path, sha256, size }]`),
  `created_at`, `last_downloaded_at`, `download_count`. Unique `(release_id, licence_id,
  deployment_id)`. Indexes on `sha256`, `marker`, and on each container hash (a side table
  `asset_delivery_hashes(sha256 → delivery_id)`).
- Secrets, outside the database rows (a secret store, as the escrow keys): one **fingerprint
  secret** (≥ 32 bytes) and one **fingerprint signer** ed25519 seed per platform, with key ids so
  they can rotate (old keys kept for lookup and verification); for asset escrow, one
  `releaseSecret` per release, stored sealed (as the code-escrow key material) and never served.
- `asset_reports` (takedown): `id`, `package`, `release_id`, `reporter`, `evidence` (a hash, a
  record, a URL), `resolved_delivery_id`, `status` (`open`, `actioned`, `rejected`), `action`,
  timestamps, audited.

### Upload limits and inspection

- Accept uploads up to the release limit (1 GiB default) as a **stream to storage**, never fully in
  memory; reject on `Content-Length` above it and stop reading at the limit.
- Run `inspectAssets` (`@scriptgo/manifest`, the same version as the CLI tag) on the stored archive
  with the strict reader, reading entries one at a time; refuse the release on any error and show
  the errors to the creator verbatim. Refuse an upload whose report lists `fingerprinted`
  containers or that holds `<root>/.scriptgo/` (`asset_fingerprinted`): a buyer's copy is never
  re-published.
- Store the report in `release_assets`; show per environment on the package page: support, files,
  download size per player, needs (`archivexl`, `tweakxl`, `levelurl`, `fastdl`,
  `this_is_a_map`), game builds.

### The per-buyer build

On a download by a licence holder (or a deployment token):

1. resolve `(release, licence, deployment)`; the deployment is the token's, or none for an account
   download;
2. if `asset_deliveries` has the row and the cached copy's SHA-256 matches, serve it; otherwise
   call `buildFingerprinted({ zip: published bytes, root: "<name>/", containers:
   release_assets.containers.map(c => ({ path: "<name>/" + c.path, entry: c.entry })), identity,
   secret, signerSeed })`;
3. insert or update the row (`marker`, `sha256`, `size`, container hashes) **before** serving, so
   every byte that leaves is resolvable;
4. sign the copy (see "Signed releases") and serve it.

The build is deterministic: caching is an optimisation, never a requirement. Memory: a release is
at most 1 GiB; the build reads each container once and writes the copy once (stream the output to
a temporary object for large releases).

### The download endpoint

`GET /v1/packages/:creator/:name/versions/:version/download`, unchanged in authorisation (the
licence holder's session or token, `X-ScriptGo-Deployment-Token`, or `X-ScriptGo-License-Key`;
otherwise 403 `license_required`). For a release with assets it answers the buyer's copy:
`X-Sha256` (the copy's), `X-ScriptGo-Artifact: plain`, the copy's release signature, and
`X-ScriptGo-Fingerprint: <marker>`. `Cache-Control: private, no-store`. Audited with the delivery
id. Creator and staff downloads get a copy fingerprinted to their own account (never the
unstamped original, except `?variant=original` for staff, audited). Rate limits as other downloads.

### The key endpoint (asset escrow)

`POST /v1/licenses/key` with `kind: "assets"`: the same checks, order and binding as code escrow,
plus `not_escrowed`; then `contentKey = deriveAssetContentKey(releaseSecret, deploymentId)`,
wrapped to the server with the server aad above. The answer adds `keyId` and `version`; its
`deliveryWatermark` is the deployment copy's fingerprint marker when one was built. Audited in
`escrow_key_events` with `kind = assets`. The server re-wraps the key to each player's session
("The key protocol").

### Takedown and lookup

- **Lookup** (staff, and the creator for their own packages): by SHA-256 of a file (a copy, or a
  container) through `asset_delivery_hashes`; by a fingerprint record (verify its signature, then
  recompute the marker for the candidate licences of that release, or look the marker up);
  returns licence, account, deployment, server, dates, download count.
- **Takedown on report**: a report is recorded with its evidence; resolving it to a delivery
  enables, with the existing licence machinery: revoke the licence or deactivate the deployment
  (code escrow and verify then refuse), hide or withdraw the release, and the report decisions of `api.md` (restrict a
  release or the sales, suspend the listing or the seller's store; there is no account suspension). A
  takedown notice to a third-party host is a human step, recorded in `asset_reports`.
- Every lookup and action is audited. Records and hashes are not personal data by themselves; the
  join to an account is staff-only.

## Verification

`scriptgo verify <dir> --env luanti|garrysmod` runs the packed assets in the real server and
writes a report `<package>-<version>-<env>-assets.json` (`lib/asset-verify.ts`); an asset-only
package has no script run there. `sdk/conformance/sg_assets_probe` is the fixture.

- Luanti (official image, Luanti 5.18.0): every file is announced to clients with the SHA-1 of its
  bytes (`Server: <sha1> is <name>`).
- Garry's Mod (srcds): every file is found in the GAME file system and added to the download list.
- No game client was run on any platform: a player's download and the engine loading the asset on
  the client are not proven by these runs.

## Open decisions (owner)

- **Who may ask a server for an asset key.** Any client that reaches the server (the default, like
  the preload files), or only a player holding a master connect ticket or a signed identity.
- **A true in-memory mount for OPEN//77.** Until the depot's archive loading is hooked, escrowed
  preloads are on the player's disk while the game runs.

- **Size caps.** The defaults above (256 MiB per file, 1 GiB per release) are a proposal; storage
  and egress cost scale with them and with the per-buyer copies.
- **Storage of copies.** Cache every copy (fast, storage × buyers) or rebuild on demand (CPU per
  download, nothing stored); the algorithm allows either.
- **Game-build breakage.** What happens when a game update breaks an asset: a flag on the release,
  a refund window, or nothing beyond `game_build`.
- **Rights in game-derived content.** Assets made from scratch, assets that modify or derive from a
  game's own files, and assets that include extracted game files are different cases under each
  game's terms. SCRIPT//GO can ask the creator to state which case applies and act on reports; what
  each game's terms allow is not decided here and this document is not legal advice.
