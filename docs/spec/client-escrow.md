# Client code escrow: encrypted, bytecode-only client scripts (spec v1)

The cross-language contract for protecting a SCRIPT//GO script's **client** code on hosts that run a
SCRIPT//GO client VM. Today only OPEN//77 qualifies (it embeds PUC Lua in its game client); the format
is written platform-neutrally so another client VM host could adopt it. **Status: implemented in
v0.1.11 and run in the real game.** The compiler and packer (`packages/escrow`), the CLI
(`scriptgo publish --client-escrow`, `scriptgo escrow lines`), the platform (key endpoint
`kind: "client"`, per-copy sealing, the line map), the native loader (`sdk/native`, `sg_clink_*`) and
the .NET kit (`sdk/dotnet/ScriptGo.Escrow` 0.4.0) implement this file. OPEN//77 is the first host; the
in-game proof and the measurements are in "Measured" below.

This extends, and does not change, `docs/spec/escrow.md` (code escrow for **server** scripts) and
`docs/spec/assets.md` (asset escrow for client-delivered content). It reuses asset escrow's container
shape, its per-session client key wrap, and its native plumbing; the new parts are **bytecode-only
client scripts** and a **session channel** instead of a boot HTTP fetch.

## Honest stance (normative)

Client code escrow is **deterrence, licence binding, revocation and traceability, raised to a
bytecode-only, source-free bar**. We claim: the client holds **no Lua source** and **no loadable
source** for an escrowed client script — only **stripped Lua bytecode**, encrypted at rest and in
transit, decrypted into native memory and compiled into the client VM **only** inside the escrow
loader, **after** the release signature and the per-chunk AEAD tag have both verified; a per-deployment
key wrapped per authenticated session; instant revocation of new sessions; a per-delivery watermark;
tamper-evident signing.

We **never** claim unbreakable. A player can read their own game process memory (how FiveM's asset
escrow was extracted in 2025) and run a 5.4 decompiler over the bytecode to recover the **logic**
(control flow, every constant, every global and field name) without the original local names and,
under full strip, without line numbers. "Measured" shows exactly that. Bytecode-only + stripped
(+ permuted, if step 3 is ever built) is a **higher bar than FiveM's in-memory source**, and still not
secrecy against the machine's operator-equivalent (here, the player).

## Why bytecode and not source

FiveM's asset escrow decrypts resource client code as **source** in the game client's memory. A
dump of that memory yields readable Lua. This format never lets source reach the client: client
scripts are compiled to bytecode on the platform, stripped, and only ever enter the VM through
`luaL_loadbufferx(..., "b")` **in the loader**, after verification. There is deliberately **no
resource-reachable `load`** and no `"b"` path outside the loader — Lua does not verify bytecode, so an
unsigned-bytecode door is a memory-safety hole, and this format has none.

## Cryptographic primitives (vetted only; never hand-rolled)

Identical to `assets.md`: AES-256-GCM (AEAD), X25519 + HKDF-SHA256 + AES-256-GCM (ECIES) for key
wrap, ed25519 for the header signature, SHA-256. libsodium in the native loader and .NET backend;
Node `crypto` in the packer and reference reader. The release signer and the licence verify-token
signer stay separate keys (as code escrow).

## Bytecode compilation

- **The compiler.** PUC Lua 5.4.8's own parser and code generator, built to WebAssembly
  (`packages/escrow/luac/`; `luac-5.4.8.wasm`, its SHA-256 pinned in `luac.ts`: the loader refuses any
  other module), with a dumper that writes the standard 5.4 format. It compiles source with mode `"t"`
  only: it never reads bytecode. Its `stock` mode is byte for byte `string.dump(f, true)` of a native
  Lua 5.4.8 (tested).
- **Who compiles.** Opt-in per release: `scriptgo publish --client-escrow [--client-strip full|names]
  [--client-lines <file>]`. The CLI compiles each client script locally (a script that does not compile
  stops the publish before anything is uploaded) and writes the creator's line map. The **platform**
  then compiles every buyer's copy again from the release's uploaded **source** with the same compiler;
  it never takes bytecode from a creator (a crafted chunk could target the client VM). The compiler is
  deterministic, so the CLI's map matches every copy (each chunk's `sha256` in the map is the
  bytecode's). The OPEN//77 server gets neither a compiler nor the source: it relays ciphertext and keys.
- **v1 scope.** The release must list `environments = { "open77" }` alone (another host would receive
  the stubs), its `client_scripts` must be Lua, and it cannot ship its own `clientcode.sgce`
  (`@scriptgo/manifest` `clientEscrowIssues`, the CLI's and the platform's one verdict).
  `--client-escrow` is refused together with `--escrow` (server-code escrow) in this version
  (`client_escrow_with_escrow`); it combines with `--asset-escrow`.
- **Strip.** Default **full**: no local or upvalue names and no line info. Each instruction carries an
  opaque **position** instead of a line (the main function's first instruction is 1, then every
  instruction of the chunk in dump order), so a runtime error names a position and nothing about the
  source. `--client-strip names` drops names and keeps real line numbers (lines are not secret).
- **Chunk name.** `<name>@<version>/<path>`: the package name **without** its creator part, no local
  path. Under full strip it ends in `:pos`, so an error reads
  `night-market@1.0.0/client/main.lua:pos:40: attempt to index a nil value`; the dump keeps that name
  as the main function's source. Under `names` it is the `=` chunk name with real lines. Lua keeps 59
  bytes of a name: a longer one keeps its end behind `...`.
- **Line map (errors stay useful).** `scriptgo-client-escrow-lines/1`: per chunk, its bytecode
  `sha256` and the source line of each position. Never shipped to a client. The platform stores it (no
  source) and serves it to the creator only, `GET /v1/creator/releases/:id/client-lines` (`api.md`);
  `--client-lines <file>` writes the same file at publish. `scriptgo escrow lines <file> "<message>"`
  rewrites every `…:pos:<n>:` in a message or a log to `<path>:<line>:`. Measured in game: the error
  above resolved to `client/main.lua:16: attempt to index a nil value`, the deliberate line.

### Bytecode target

A container's header carries its **bytecode target**: the Lua version and the 31-byte 5.4 dump header
(signature, version `0x54`, format 0, `LUAC_DATA`, instruction / integer / number sizes, `LUAC_INT`
and `LUAC_NUM`; 5.4's header holds no int or size_t size, and the two check values pin byte order and
number formats). For OPEN//77 (`LUA_548_TARGET`):

```
lua        = "5.4.8"
luacHeader = "1b4c7561540019930d0a1a0a04080878560000000000000000000000287740"
```

The host passes the header of a `lua_dump` made by its own VM to `sg_clink_target_check`; a mismatch is
`SG_ERR_TARGET_MISMATCH` (fail closed, never run as source — there is none). `sg_clink_lua_load` also
checks that each decrypted chunk starts with that header. A client on a different Lua build is a new
target: a release loads on the client builds it was compiled for.

## Bundle layout (`scriptgo-client-escrow/1`)

Reuses the asset-escrow container (`assets.md`, "Layout"), with a distinct magic and format string so
a reader cannot confuse the two:

```text
"SGCE" | version u8 = 1 | 3 zero bytes | headerLength u32 LE | header (canonical JSON, UTF-8) | body
```

`header`: `{ format: "scriptgo-client-escrow/1", cipher: "AES-256-GCM", kdf: "HKDF-SHA256+X25519",
package, version, release, deployment, target: { lua, luacHeader }, strip ("full" | "names"),
permGeneration (0; readers refuse any other in v1), keyId, fingerprint,
chunks: [{ path, bytes, ciphertextSha256, nonce, offset, length }], signerPublicKey, signature }`.

- `path` is the resource-relative client-script path (a clear manifest value; not a secret).
- `bytes` is the stripped-bytecode length; `length = bytes + 16` (one AEAD tag per chunk); chunks are
  contiguous at `offset` in the body.
- `ciphertextSha256` is the SHA-256 (hex) of the chunk's `length` body bytes: ciphertext and tag. It
  reveals nothing about the bytecode. With `keyId` fixing the key, the signed hash of the ciphertext
  still fixes the bytecode the signature vouches for: a holder of the content key (a game server)
  cannot swap a chunk under the platform's signature.
- **Legacy chunks** (containers sealed before SDK 0.1.12 / libscriptgo 0.2.0) carry `sha256`, the
  SHA-256 of the **plaintext bytecode**, instead of `ciphertextSha256`. Bytecode compiles
  deterministically, so that hash lets anyone confirm a guessed source or match a copy. Readers accept
  both; a chunk carries exactly one of the two. Writers emit `sha256` only with the transition option
  `legacyPlaintextSha256` (`sealClientContainer`), for game clients whose libscriptgo predates 0.2.0:
  those refuse a chunk without `sha256` (`SG_ERR_BAD_CONTAINER`). The format string stays
  `scriptgo-client-escrow/1`, so AADs, nonces and wraps are unchanged.
- `signature` is ed25519 over `canonicalJson(header with signature = "")` by the platform's
  container signer (the same signer asset escrow uses); `fingerprint` is the copy's delivery marker
  or null. Header at most 4 MiB.

**The signer is pinned by the client, never taken from the container or from the game server.**
`signerPublicKey` in the header only says which key signed; a signature that verifies under it proves
integrity, not origin. A game server holds the deployment's content key (it re-wraps it to each
session), so it can seal bytecode of its choice under that key and sign the header with a key of its
own: that container verifies under the key it names. Only a signer the client pinned refuses it. A
client builds the signer into its own binary or configuration, from a source the game server does not
control; for containers the SCRIPT//GO platform seals that source is `PLATFORM_CONTAINER_SIGNERS` in
`@scriptgo/shared` (`packages/shared/src/signers.ts`) at the SDK tag the client ships with. Every
decrypting entry point requires it: `sg_clink_container_open` with a NULL signer is
`SG_ERR_INVALID_ARGUMENT` (libscriptgo 0.2.0), the .NET `ClientCodeContainer.Open(container,
trustedSigner)` and the TypeScript `ClientContainerReader` throw without one. Integrity-only reading
(a server that relays keys, a tool) uses `sg_clink_container_inspect` / `ClientCodeContainer.Inspect`
/ `readClientContainer` without a signer, and such a handle never binds a key.

In a delivered copy the container is `<root>clientcode.sgce`, and each escrowed client script's path
holds a stub that raises an error if a host ever runs it as source (a host without the loader fails
closed). The container's SHA-256 is a delivery hash: a leaked container resolves to its copy.

### Keys and wrapping

A **distinct** content key — never the server-script key, never the asset key:

```text
clientKey   = HKDF-SHA256(ikm = releaseSecret, salt = "scriptgo.client-escrow.cek.v1", info = deployment, 32)
keyId       = base64url( SHA-256("scriptgo.client-escrow.keyid.v1" ‖ clientKey)[0..16] )
```

`releaseSecret` is the per-release 32 bytes asset escrow keeps sealed (one secret, one salt per use);
it never leaves the platform. One content key per deployment: a key lifted from one licensed server
opens no other server's container.

Each chunk is AES-256-GCM(clientKey, nonce, stripped bytecode, aad):

```text
nonce = HKDF-SHA256(ikm = clientKey, salt = "scriptgo.client-escrow.nonce.v1",
                    info = path + "\n" + SHA-256(plaintext bytecode), 12)
aad   = "scriptgo-client-escrow/1\n" + package + "@" + version + "\n" + path
```

Key wrapping is asset escrow's, with client-escrow info and aad strings. The native unwrap kinds are
`SG_CLIENT_WRAP_SERVER` (3) and `SG_CLIENT_WRAP_SESSION` (4), distinct from asset escrow's 1 and 2;
a client-code key binds only to an `SGCE` container (an asset container refuses it, and an asset key
never binds here).

- **To a licensed server** (ECIES, `escrow.md`): `info = "scriptgo.escrow.keywrap.v1"`,
  `aad = "scriptgo-client-escrow/1\nserver\n" + package + "@" + version + "\n" + deployment`.
- **To a player session** (by the server): `kek = HKDF-SHA256(ikm = X25519(ephemeral,
  clientSessionPublic), salt = epk ‖ clientSessionPublic, info =
  "scriptgo.client-escrow.client-keywrap.v1", 32)`,
  `aad = "scriptgo-client-escrow/1\nclient\n" + package + "@" + version + "\n" + keyId`.

## The key protocol (three hops, no key ever in clear)

```text
API ──(1) POST /v1/licenses/key {kind:"client"}──▶ licensed server   wrapped to server identity, server aad
licensed server ──(2) over the game session──────▶ game client       re-wrapped to the session key, client aad
game client ──(3) in native memory───────────────▶ client VM         sg_clink_lua_load → luaL_loadbufferx(…,"b")
```

1. **API → server.** `POST /v1/licenses/key` with `kind: "client"` and the usual body
   (`deploymentToken`, `package`, `version`, `environment`, `serverPublicKey`). Checks, order and
   binding are code escrow's (`api.md`), plus `not_escrowed` when the release has no client escrow. A
   grant adds `keyId` and `version`; `aad` is the server aad above. The server checks `aad`, unwraps
   with its escrow identity into guarded native memory, renews on the code-escrow cadence, and on a
   definitive refusal (revoked, refunded, deactivated, unbound) drops the key and stops handing it out.
   Audited in `escrow_key_events` with `kind = client`. The .NET kit asks with
   `HttpEscrowKeyService.RequestClientKeyAsync` and unwraps with `AssetKey.UnwrapClientCodeForServer`.
2. **Server → client, over the authenticated game session** (not a boot HTTP fetch — the player is
   already authenticated at join; see the OPEN//77 note below). The client makes an X25519 session key
   pair in memory for one connection and sends the public half with the `keyId`s it needs; the server
   answers each `keyId` it holds, re-wrapped to that session (client aad). The asset-key door and the
   client-code door are separate: neither ever hands out the other's key.
3. **Client.** Unwrap the session wrap (`SG_CLIENT_WRAP_SESSION`), open the container with the signer
   the client pinned (above: never one the server names), check the LUAC target, bind, then **per
   chunk** `sg_clink_lua_load` — decrypt the bytecode in `sodium_malloc` memory, verify the AEAD tag
   (and a legacy chunk's plaintext SHA-256) and the LUAC header, compile it
   with the host's own `luaL_loadbufferx(state, bytecode, n, "=" + path, "b")` (passed in as a function
   pointer, so the library links no Lua), wipe the buffer. No plaintext bytecode enters the host
   language heap and none is written to disk.

**Revocation.** From the server's next refused renewal (or when offline grace runs out) it holds no
key and answers no session; a client that joins after that cannot load the escrowed client scripts. A
client already running keeps what it compiled until it disconnects. A server operator who lifts the key
from their own process is not stopped by the protocol — but for client code the operator is only a
relay (it holds bytecode, not source), and the per-delivery watermark names the licence.

## The native interface (`sg_clink_*`)

`libscriptgo` (`sdk/native`, `escrow.h`, section "client code escrow") adds, beside the `sg_asset_*`
calls; `SG_ABI_VERSION` stays 1:

| Call | Does |
|---|---|
| `sg_clink_container_open(data, len, trustedSigner, &container)` | every keyless check of "Reading" over an `SGCE` container, the signer pinned (32 bytes, required: NULL is `SG_ERR_INVALID_ARGUMENT` since 0.2.0; another signer is `SG_ERR_UNTRUSTED_SIGNER`, -23); borrows `data` |
| `sg_clink_container_inspect(data, len, &container)` | the same checks against the key the header names: integrity, not origin. The handle reads fields and chunks; `sg_clink_container_bind` refuses it (`SG_ERR_UNTRUSTED_SIGNER`), so nothing it holds is ever decrypted. For a server or a tool, never for a client that runs the code |
| `sg_clink_target_check(container, luacHeader, len)` | the container's target equals the host VM's 31-byte LUAC header, else `SG_ERR_TARGET_MISMATCH` (-24); required before any load |
| `sg_clink_container_field(container, name, &value)` | a header field: `package`, `version`, `release`, `deployment`, `keyId`, `signerPublicKey`, `strip`, `lua`, `fingerprint` |
| `sg_clink_chunk_count(container, &n)`, `sg_clink_chunk_at(container, i, &path, &size)` | the chunks, in path order |
| `sg_clink_container_bind(container, key)` | binds the client-code key; `SG_ERR_KEY_MISMATCH` for another deployment's key or an asset key; `SG_ERR_UNTRUSTED_SIGNER` on an inspected container |
| `sg_clink_lua_load(container, path, lua_State*, loadbufferx, &luaStatus)` | decrypts that chunk into guarded memory, verifies tag, a legacy chunk's plaintext SHA-256 and the header, compiles it with the host's `luaL_loadbufferx` (mode `"b"`), wipes; `SG_OK` leaves the function on the stack, `SG_ERR_LUA_LOAD` (-17) leaves Lua's message, any other error pushes nothing |
| `sg_clink_container_free(container)` | wipes the key and frees; functions already compiled keep running |

`sg_clink_lua_load` is the **only** way bytecode enters a VM through this library. There is no
`sg_clink_copy` / `sg_clink_read`: an escrowed client chunk is never handed to the host as bytes, only
compiled into a state. (Contrast asset escrow's documented `sg_asset_reader_read` copy door, which
client code deliberately lacks.) The .NET kit wraps the same calls as `ClientCodeContainer`.

**Reading (normative, as `assets.md` "Reading").** Before any key is used: magic, version, zero
bytes, header length, canonical header JSON, `format`, `cipher`, `kdf`, `strip`, `permGeneration`, the
target's shape, the pinned signer and the ed25519 signature, every chunk's path rules, its keys
(`bytes`, `length`, `nonce`, `offset`, `path` and exactly one of `ciphertextSha256` / `sha256`),
`length = bytes + 16`, contiguous offsets, a body length equal to the sum, then each chunk's
`ciphertextSha256` over its body bytes (`SG_ERR_PAYLOAD_HASH`). A legacy chunk's plaintext `sha256`
is checked after decryption. Then the LUAC target must match and `keyId` must match the key. Any tag
failure is an error, never a partial result. Closing wipes the key. Inspection runs the same checks
with the header's own key in place of the pinned one.

**Path rules** are `escrow.md`/`assets.md`'s: resource-relative, `/` separators; refused leading `/`,
empty/`.`/`..` segment, backslash, colon, control character.

## Anti-decompiler hardening

- **Steps 1 (bytecode-only) and 2 (never-unsigned-load) are v1.** Stripped bytecode, no source
  anywhere, no loadable-source door. "Measured" shows what they do and do not stop.
- **Step 3, opcode permutation — specified, deferred, not built.** The client embeds the VM, so the
  opcode↔semantics mapping lives in the client binary. A **permutation generation** (`permGeneration`):
  the SDK emits bytecode for a generation, the client supports the current + a rolling window of recent
  generations (a permuted VM opcode enum, or an un-permute table in the loader) and refuses an unknown
  generation (fail closed); generations rotate rarely and deliberately; the release declares its
  generation. Invasive (it touches the VM/loader and the SDK compiler together and narrows which
  clients a release loads on), so deferred. It would only cost a reverser the time to read the
  permutation out of the client binary: a speed bump, not secrecy. v1 containers carry generation 0
  and readers refuse any other. Constant-pool encryption is **not** pursued separately: the whole
  container is already AEAD-encrypted, so it adds nothing once the content key is lifted from
  memory (the session only wraps the deployment's one key: lifting it from one client's memory opens
  that deployment's container for every session), at which point the opcodes are too.

## Vector

`packages/escrow/test/vectors/client-vectors.json` (built by `packages/escrow/tools/gen-client-vectors.ts`,
compiled into `sdk/native/tests/client_vector.h`): an `SGCE` container with stripped-bytecode chunks,
their source, the deployment content key, a server wrap, a session wrap, another deployment's key (must
not open it), the plaintext-bytecode hashes and the line map; the same chunks sealed the legacy way
(`legacyContainerBase64`, plaintext `sha256`, which every reader must still load); and a container
sealed under the same key but signed by a stranger (`strangerContainerBase64`, which a pinned open
must refuse and an inspection must read). The TypeScript, C and .NET tests open the same container and
refuse the same tampering (a flipped ciphertext byte, a bad tag, wrong `keyId`, a foreign LUAC target,
a wrong signer, a missing signer, path traversal); the C test compiles the chunks into a real Lua 5.4.8 and runs them, and
OPEN//77's client tests do the same through its own Lua.

## OPEN//77 (the one client VM host today)

- **Channel: at join, over the session**, not a boot HTTP fetch — the client is already authenticated
  by the join's master connect ticket, and the resource set (and thus which client scripts are
  escrowed) is known only after join. `clientcode.sgce` travels with the resource package (ciphertext;
  safe to cache). The key exchange is one reserved network event, `open77:clientcode:keys`, on the game
  session (no resource can send or receive the `open77:clientcode:` prefix): up
  `{ sessionPublicKey, keyIds }`, down one answer per key (`granted` with the session wrap, `pending`,
  `refused` with its reason, or `unknown`), rate-limited per player.
- **Load:** the client's resource host holds the resource set back until every escrowed key has an
  answer, then compiles each escrowed client script with `sg_clink_lua_load` into that resource's own
  `lua_State`; the stubs are never compiled. `load`, `loadfile` and `string.dump` stay removed from the
  sandbox. A key that cannot be had (revoked licence, unknown key, no native library, a foreign target,
  no answer) disconnects the player with `client_code_escrow:<resource>:<reason>` instead of running a
  resource with its client half missing.
- **Signer: pinned in the client build.** The OPEN//77 client opens `clientcode.sgce` with the platform
  signer it carries (`PLATFORM_CONTAINER_SIGNERS`, "Bundle layout" above), never with a key the game
  server sends and never with NULL: libscriptgo 0.2.0 refuses NULL, and a client on an older DLL that
  passes NULL accepts any container a server signs itself. The game server only relays keys; when it
  reads a container (to learn its `keyId`s) it inspects it (`ClientCodeContainer.Inspect`).
- **NUI / WebUI: clear in v1.** `web_files` (HTML, JavaScript, CSS) are **not** escrowed: they reach
  the player as clear files, like FiveM's `nui` files. Feeding CEF from memory through the client's
  scheme handler is feasible later and is not built.
- OPEN//77 research: `base/docs/research/resource-escrow.md`, Phase 6.

## Measured (2026-11-12, OPEN//77 in game)

A throwaway SCRIPT//GO API, a local OPEN//77 master requiring connect tickets with game ownership
required, a local server and one Cyberpunk 2077 client. A lab resource published with
`--client-escrow` (full strip): one client script with a distinctive string, a float constant and a
deliberate runtime error.

- **Owner, ticket, session.** The client logged `client code escrow: cesclab_market: key received for
  this session; 1 script(s) load as bytecode` and the script's own output; the server logged
  `CLIENT CODE KEYS player=1 asked=1 granted=1 pending=0 refused=0 unknown=0`.
- **No ownership, no client code.** An identity with no account, then one linked to an account without
  ownership, got no ticket; the server refused the join (`connect_ticket_required`) and no key was
  asked for.
- **Revocation.** The creator revoked the licence; at its next renewal the server logged `no key is
  handed out … (revoked …); the key this server held is wiped`, with no restart, and the next session
  was answered `refused revoked` (`CLIENT CODE KEYS … refused=1 reason=revoked`) and left the server.
  A session already running keeps what it compiled.
- **Disk.** The licence copy, the server's packages, the client's resource cache and the whole client
  plugin folder hold neither the source text nor the bytecode constants (the string, or the float as an
  8-byte double): only the container and the stub. The client log holds what the script itself prints.
- **Memory.** A read-only scan of the running game (13.7 GiB) found the string and the float constant
  (the VM's own objects), no source comment, and no flat bytecode chunk: the decrypted buffer is wiped
  after compiling. The functions are in memory, as they must be to run.
- **Decompiler.** `unluac` 1.2.3.530 with `--nodebug` on the stripped chunk (byte-identical to the one
  the copy carries) recovered **the whole logic**: every string and number constant, every global and
  field name (`print`, `CreateThread`, `Wait`, `.field`), the loop and its arithmetic, the closures. It
  lost local names (`L0_1`, …), comments and line numbers. Without `--nodebug` it printed nothing; that
  is a quirk, not protection. A player who captures the chunk at load, or rebuilds it from the VM's
  memory, reads de-identified, working Lua. **That is the ceiling, stated plainly.**

## Public comparison with FiveM (state it this way)

> FiveM's Asset Escrow encrypts a resource's client files and decrypts them as **Lua source in the
> game client's memory**; on 2025-08-08 Cfx.re reported a flaw that let assets be extracted from the
> client, and later added a model-obfuscation layer. SCRIPT//GO client code escrow ships client scripts
> as **stripped Lua bytecode** — no source and no loadable source ever reach the client — decrypted
> into native memory and compiled into the VM only after a release signature and an AEAD tag verify, with
> a per-deployment key wrapped to one authenticated session, instant revocation of new sessions, a
> per-buyer watermark, and signed releases. That is a **higher bar than in-memory source**. It is still
> not unbreakable: a player can read their own game memory and run a decompiler to recover
> de-identified logic. We say so everywhere.

## Open decisions (owner)

- **Opcode permutation (step 3).** Whether to invest at all, and how wide a generation window the
  client carries.
- **NUI.** A true in-memory, no-disk path for `web_files`, only once the CEF scheme-from-memory path is
  built and proven.
- **Server-code escrow together with client code escrow** in one release (refused in v1).
