# Client code escrow: encrypted, bytecode-only client scripts (spec v1, design)

The cross-language contract for protecting a SCRIPT//GO script's **client** code on hosts that run a
SCRIPT//GO client VM. Today only OPEN//77 qualifies (it embeds PUC Lua in its game client); the format
is written platform-neutrally so another client VM host could adopt it. **Status: design.** The packer
(`packages/escrow`), the master key endpoint (`apps/api`), the native loader (`sdk/native`) and the
.NET kit (`sdk/dotnet/ScriptGo.Escrow`) implement exactly this when it is built; nothing here has run.

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
(control flow, string constants) without the original identifiers and, under full strip, without line
numbers. Bytecode-only + stripped (+ permuted, when step 3 lands) is a **higher bar than FiveM's
in-memory source**, and still not secrecy against the machine's operator-equivalent (here, the player).

## Why bytecode and not source

FiveM's asset escrow decrypts resource client code as **source** in the game client's memory. A
dump of that memory yields readable Lua. This format never lets source reach the client: client
scripts are compiled to bytecode at publish time, stripped, and only ever enter the VM through
`luaL_loadbufferx(..., "b")` **in the loader**, after verification. There is deliberately **no
resource-reachable `load`** and no `"b"` path outside the loader — Lua does not verify bytecode, so an
unsigned-bytecode door is a memory-safety hole, and this format has none.

## Cryptographic primitives (vetted only; never hand-rolled)

Identical to `assets.md`: AES-256-GCM (AEAD), X25519 + HKDF-SHA256 + AES-256-GCM (ECIES) for key
wrap, ed25519 for the release/header signature, SHA-256. libsodium in the native loader and .NET
backend; Node `crypto` in the packer and reference reader. The release signer and the licence
verify-token signer stay separate keys (as code escrow).

## Bytecode compilation (publish time, in the SDK)

- **Who.** The SDK CLI, at `scriptgo publish --escrow`, compiles each **encrypted client script** to
  Lua **bytecode** with a vendored compiler built from the **exact** target Lua source
  (OPEN//77: PUC Lua 5.4.8, the version and build flags its client embeds — see "Bytecode target").
  The OPEN//77 server is **not** given a compiler or the client source: it only relays ciphertext.
- **Strip.** Default **full strip**: no local names, no upvalue names, no source name, no line info
  (the dump `strip` flag; `luaU_dump(..., strip=1)`). A creator may choose `strip: "names"` (names
  stripped, line info kept — line numbers are not secret, and on-client errors then carry a line).
- **Chunk name.** `=<package>@<version>/<relative>` — resolvable, no local filesystem path. (The `=`
  prefix tells Lua to use the name verbatim in messages.)
- **Creator/platform line map (errors stay useful).** Under full strip the release **keeps, on the
  creator/platform side and never shipped to a client**, the unstripped bytecode (or its PC→line
  table) per chunk, so a crash report naming a chunk resolves to a line. Served only to the creator or
  staff, audited (the asset/code-escrow marker-lookup tooling).
- **Never trust creator-supplied bytecode.** The SDK compiles from the creator's **source**; it never
  accepts precompiled bytecode as input (a malicious chunk could target the client VM). Source in, the
  SDK's own compiler, bytecode out.

### Bytecode target

A release declares a **bytecode target** for each client VM it was compiled for. For OPEN//77:

```
lua        = "5.4.8"
luacHeader = { version: 0x54, format: 0, data: "<LUAC_DATA bytes>", intSize, sizetSize,
               instructionSize, luaIntegerSize, luaNumberSize, integerFormat, numberFormat }
endianness = "little"   # encoded in luacHeader's LUAC_INT / LUAC_NUM check values
```

The loader checks the incoming LUAC header **against the client's own** before loading and refuses a
mismatch (fail closed, never run as source — there is none). A client on a different Lua config is a
new target; a release targets the ones it was compiled for. Document the compatibility story for
operators: a release loads on the client builds it targets.

## Bundle layout (`scriptgo-client-escrow/1`)

Reuses the asset-escrow container (`assets.md`, "Layout"), distinct magic and format string so a
reader cannot confuse the two:

```text
"SGCE" | version u8 = 1 | 3 zero bytes | headerLength u32 LE | header (canonical JSON, UTF-8) | body
```

`header`: `{ format: "scriptgo-client-escrow/1", cipher: "AES-256-GCM", kdf: "HKDF-SHA256+X25519",
package, version, release, deployment, target (the bytecode target above), strip ("full" | "names"),
permGeneration (u32, 0 until step 3), keyId, fingerprint,
chunks: [{ path, bytes, sha256, nonce, offset, length }], signerPublicKey, signature }`.

- `path` is the resource-relative client-script path (a clear manifest value; not a secret).
- `bytes` is the stripped-bytecode length; `sha256` is over the **plaintext bytecode**; `length =
  bytes + 16` (one AEAD tag per chunk); chunks are contiguous at `offset` in the body.
- `signature` is ed25519 over `canonicalJson(header with signature = "")` by the platform's
  fingerprint signer (the same signer asset escrow uses); `fingerprint` is the copy's delivery marker
  or null. Header at most 4 MiB.

### Keys and wrapping

A **distinct** content key — never the server-script key, never the asset key:

```text
clientKey   = HKDF-SHA256(ikm = releaseSecret, salt = "scriptgo.client-escrow.cek.v1", info = deployment, 32)
keyId       = base64url( SHA-256("scriptgo.client-escrow.keyid.v1" ‖ clientKey)[0..16] )
```

`releaseSecret` (the same per-release 32 bytes asset escrow keeps sealed, or a sibling — see
"Open decisions") never leaves the platform. One content key per deployment: a key lifted from one
licensed server opens no other server's container.

Each chunk is AES-256-GCM(clientKey, nonce, stripped bytecode, aad):

```text
nonce = HKDF-SHA256(ikm = clientKey, salt = "scriptgo.client-escrow.nonce.v1",
                    info = path + "\n" + SHA-256(plaintext bytecode), 12)
aad   = "scriptgo-client-escrow/1\n" + package + "@" + version + "\n" + path
```

Key wrapping is asset escrow's, with client-escrow info/aad strings:

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
   Audited in `escrow_key_events` with `kind = client`.
2. **Server → client, over the authenticated game session** (not a boot HTTP fetch — the player is
   already authenticated at join; see the OPEN//77 note below). The client makes an X25519 session key
   pair in memory for one connection and sends the public half with the `keyId`s it needs; the server
   answers each `keyId` it holds, re-wrapped to that session (client aad), with its trusted signer.
3. **Client.** Unwrap the session key (kind `SG_ASSET_WRAP_CLIENT`), open the container with the
   signer pinned and the LUAC target checked, bind, then **per chunk** `sg_clink_lua_load` — decrypt
   the bytecode in `sodium_malloc` memory, verify the AEAD tag, `luaL_loadbufferx(state, bytecode, n,
   chunkName, "b")` into the host's `lua_State`, wipe the buffer. No plaintext bytecode enters the host
   language heap and none is written to disk.

**Revocation.** From the server's next refused renewal (or when offline grace runs out) it holds no
key and answers no session; a client that joins after that cannot load the escrowed client scripts. A
client already running keeps what it compiled until it disconnects. A server operator who lifts the key
from their own process is not stopped by the protocol — but for client code the operator is only a
relay (it holds bytecode, not source), and the per-delivery watermark names the licence.

## The native interface (`sg_clink_*`)

`libscriptgo` (`sdk/native`, `escrow.h`, section "client code escrow") adds, beside the `sg_asset_*`
calls a client hook already uses:

| Call | Does |
|---|---|
| `sg_clink_container_open(bytes, len, signerOrNull, &handle)` | every check of "Reading" over a `SGCE` container, signer pinned when given |
| `sg_clink_target_check(handle, luacHeader, len) -> ok` | the container's bytecode target equals the host VM's LUAC header |
| `sg_clink_container_bind(handle, key)` | binds the per-session content key (its `keyId` must match the header) |
| `sg_clink_lua_load(handle, lua_State*, path) -> status` | decrypt that chunk's bytecode in guarded memory, verify the tag, `luaL_loadbufferx(…, "b")` into the state, wipe; leaves one function on the stack or an error |
| `sg_clink_container_free(handle)` | wipes the key and any buffers |

`sg_clink_lua_load` is the **only** way bytecode enters a VM through this library. There is no
`sg_clink_copy` / `sg_clink_read`: an escrowed client chunk is never handed to the host as bytes, only
compiled into a state. (Contrast asset escrow's documented `sg_asset_reader_read` copy door, which
client code deliberately lacks.)

**Reading (normative, as `assets.md` "Reading").** Before any key is used: magic, version, zero
bytes, header length, canonical header JSON, `format`, `cipher`, the ed25519 signature (and the pinned
signer when configured), every chunk's path rules, `length = bytes + 16`, contiguous offsets, a body
length equal to the sum, and each chunk's plaintext-bytecode `sha256` is checked after decryption.
Then the LUAC target must match and `keyId` must match the key. Any tag failure is an error, never a
partial result. Closing wipes the key.

**Path rules** are `escrow.md`/`assets.md`'s: resource-relative, `/` separators; refused leading `/`,
empty/`.`/`..` segment, backslash, colon, control character.

## Anti-decompiler hardening

- **Steps 1 (bytecode-only) and 2 (never-unsigned-load) are v1.** They already exceed FiveM (source in
  memory): stripped bytecode, no source anywhere, no loadable-source door.
- **Step 3, opcode permutation — specified, not in v1.** The client embeds the VM, so the opcode↔
  semantics mapping lives in the client binary. A **permutation generation** (`permGeneration`): the
  SDK emits bytecode for a generation, the client supports the current + a rolling window of recent
  generations (a permuted VM opcode enum, or an un-permute table in the loader) and refuses an unknown
  generation (fail closed); generations rotate rarely and deliberately; the release declares its
  generation. Invasive (it touches the VM/loader and the SDK compiler together and narrows which
  clients a release loads on), so deferred. Constant-pool encryption is **not** pursued separately: the
  whole container is already AEAD-encrypted, so it adds nothing until the per-session key is already
  lifted from memory, at which point the opcodes are too.
- **Measurement (to run when the compiler exists; not yet run).** `unluac` against stripped 5.4.8
  bytecode is expected to recover control flow and string constants with gensym local/upvalue names and
  no line numbers (readable, de-identified); against permuted bytecode with a stock `unluac`, garbage
  until the reverser retargets it to the permutation read from the client binary. Both results go,
  verbatim, into this file and `docs/site/protect-your-work.md`.

## Vector

The cross-language vector (`sdk/dotnet/ScriptGo.Host.Tests/Fixtures/escrow-vector.json`,
`sdk/native/tests/`, built by `packages/escrow/tools/gen-vectors.ts`) gains a `SGCE` container with
one or more stripped-bytecode chunks, the deployment content key, a server wrap, a client wrap, another
deployment's key (must not open it), and the plaintext-bytecode hashes. The TypeScript, C and .NET
tests open the same container, refuse the same tampered chunks (bad tag, wrong `keyId`, a chunk whose
LUAC target differs, path traversal), and — where a Lua VM is available in the test — load a chunk and
observe its effect. Compiling the chunk for the vector pins the exact 5.4.8 bytecode bytes.

## OPEN//77 (the one client VM host today)

- **Channel: at join, over the session**, not a boot HTTP fetch — the client is already authenticated
  by the join's master connect ticket, and the resource set (and thus which client scripts are
  escrowed) is known only after join. The escrowed container `clientcode.sgce` travels with the
  resource package (ciphertext; safe to cache); one session control message carries the client's
  session public key + `keyId`s up and the per-session wraps down. The server re-wraps with
  `ScriptGoAssetKeys`/`AssetKeyService` keyed `kind:"client"`.
- **Load:** the client's `ResourceHost::Prepare` gains an escrowed-client branch: for an encrypted
  client script it calls `sg_clink_lua_load` into the resource's own `lua_State` instead of
  `ReadTextFile` + `luaL_loadbufferx(…, "t")`. A one-line stub stands at each encrypted client script's
  path so discovery and the cache digest work on disk; the stub is never compiled. Each client resource
  has its own state (`lua_newstate` per instance), so a sibling cannot reach an escrowed chunk.
- **NUI / WebUI: clear in v1.** `web_files` reach CEF through the client's custom resource/scheme
  handler. Feeding CEF from memory through that handler (decrypt on the scheme thread, answer from
  memory, never touch the web cache) is feasible in a later phase but is **not** in v1: `web_files` stay
  clear, like FiveM's `nui` files. Stated plainly in the operator and creator docs.
- OPEN//77 research: `base/docs/research/resource-escrow.md`, Phase 6.

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

- **`releaseSecret` reuse.** Derive the client content key from the same per-release secret as asset
  escrow (one sealed secret per release, different HKDF salt), or a sibling secret. One secret is
  simpler and the salts already separate the keys; a sibling isolates a future key-rotation of one from
  the other. Proposed: **one secret, separate salts** (above).
- **Opcode permutation (step 3).** When to invest, and how wide a generation window the client carries.
- **A true in-memory, no-disk guarantee for NUI.** Only once the CEF scheme-from-memory path is built
  and proven.
