# Escrow format and key release (spec v1)

The cross-language contract for SCRIPT//GO creator protection. The TypeScript packer
(`packages/escrow`), the master key endpoint (`apps/api`) and the .NET loader
(`sdk/dotnet/ScriptGo.Host/Escrow`) all implement exactly this. The plan and the honest stance are in
`docs/plan/CREATOR-PROTECTION.md`; the decision is DECISIONS.md ADR-0023/0024.

## Honest stance (normative)

Escrow is **deterrence, traceability and revocation**, never a guarantee against the operator of a
host that must decrypt and run the code. We claim: encrypted at rest and in transit, keys never
shipped, per-server binding (a leaked copy will not run on an unbound server), instant revocation,
tamper-evident signing, and attributable leaks. We never claim "unbreakable". Real code secrecy holds
only where a host can hold a key from its operator (the .NET and native kits); on a **pure-Lua host,
and on OPEN//77 via the disk-loading path, escrow degrades to license-only and no code-secrecy claim
is made.**

## Cryptographic primitives (vetted only; never hand-rolled)

| Purpose | Primitive | TypeScript | .NET |
|---|---|---|---|
| Content encryption | AES-256-GCM (AEAD) | Node `crypto` (OpenSSL) | `System.Security.Cryptography.AesGcm` |
| Content-key wrapping | X25519 + HKDF-SHA256 + AES-256-GCM (ECIES) | Node `crypto` | NSec (libsodium), pinned 24.4.0 |
| Release signature | ed25519 | Node `crypto` | NSec (libsodium) |

The license verify-token signer stays a **separate** ed25519 key from the release signer, so
compromising one never forges the other.

## Bundle layout

An escrow bundle is a deterministic zip:

- `escrow.json` — the clear manifest (see below).
- `payload.enc` — AES-256-GCM(contentKey, nonce, innerZip, aad), ciphertext with the 16-byte tag
  appended. `innerZip` is a zip of the **encrypted** files.
- the clear-text allowlist files at their own paths (manifest, docs, creator-named config).

`escrow.json` fields: `format` (`scriptgo-escrow/1`), `package`, `version`, `cipher`
(`AES-256-GCM`), `kdf` (`HKDF-SHA256+X25519`), `aad` (`${package}@${version}`),
`payload{nonce,sha256,bytes}`, `clearFiles[{path,sha256,bytes}]`, `encryptedFiles[]`, `allowlist[]`,
`signerPublicKey` (ed25519 raw, base64url), `watermark` (HMAC over the release id, or null),
`signature` (ed25519 over the canonical manifest with `signature` emptied).

**Canonical JSON** (for the signature): `JSON.stringify` of the manifest with keys recursively sorted
and `signature` set to `""`. The .NET loader reproduces this exactly
(`EscrowBundle.CanonicalManifestWithoutSignature`); the cross-language vector proves parity.

**Allowlist** (FiveM `escrow_ignore` style): the manifest and docs are always clear; the creator adds
globs (`config.lua`, `stream/*.yft`, `stream/**/*.yft`). Everything else is encrypted.

## Content key wrapping (ECIES)

`wrapped = { epk, nonce, wrapped }`, base64url. `epk` is an ephemeral X25519 public key.
`shared = X25519(ephemeralPriv, serverPub)`; `kek = HKDF-SHA256(ikm=shared, salt=epk‖serverPub,
info="scriptgo.escrow.keywrap.v1", 32)`; `wrapped = AES-256-GCM(kek, nonce, contentKey, aad)`. Only
the server holding the matching X25519 private key can unwrap it — a copied folder on an unbound box
cannot. The `aad` binds the wrap to the exact release.

## Key release (`POST /v1/licenses/key`)

Request: one of `licenseKey`/`deploymentToken`, `package`, `version?`, `environment`,
`adapterVersion?`, `serverPublicKey?`. Gated on the verify checks plus binding (the deployment must
carry a server public key; registered on first use, anti-swap after) and that the release is
escrowed. Success → `{ valid:true, wrappedKey, aad, signerPublicKey, deliveryWatermark,
offlineGraceUntil, expiresAt }`. Definitive refusal → `{ valid:false, reason }` (reasons: the verify
reasons plus `unbound`, `not_escrowed`). A 4xx/5xx means the API could not answer and the loader
applies offline grace. Rate-limited by hashed key, audited; the content key is never cached at rest.

## Binding and revocation

A server generates an X25519 key pair at activation and registers the public key with its deployment
(`license_activations.server_public_key`). The content key is per-release (releases are immutable);
rotation = a new release. Revocation (refund/dispute/sub-end — already modelled) makes the next key
release fail; within offline grace the resource keeps running, then stops. No new revocation
machinery: escrow hangs off the existing license state.

## Watermarking (traceability, not prevention)

A release-level watermark (HMAC over `${package}@${version}`) is baked into the signed manifest; a
per-delivery marker (HMAC over release+license+deployment) is returned by the key endpoint and
stamped into the decrypted copy by the loader. Both attribute a leak; neither prevents one.

## Loader (ScriptGo.Host.Escrow)

`EscrowLoader.LoadAsync` verifies the signature (optionally against a pinned trusted key), requests
the wrapped key, unwraps with the server identity, decrypts **in managed memory**, verifies the
payload and clear-file hashes, stamps the delivery marker, zeroes the content key, and serves the
plaintext through `EscrowResourceFiles` (an `IResourceFiles`) — the host's local-resource path, never
the guest VM. `EscrowMaterializer` is the Option A hand-off for disk-reading hosts (OPEN//77); see
`sdk/adapters/open77/escrow/PROPOSAL.md`.

## Native loader and the `ScriptGo.Escrow` package (added 2026-11-10)

This section extends the spec; nothing above changes on the wire. It supersedes the paragraph
"Loader (ScriptGo.Host.Escrow)": the loader is now its own package, `ScriptGo.Escrow`, over a native
library, `libscriptgo` (`sdk/native`). `ScriptGo.Host` uses it and no longer contains the crypto.
The integration guide is `docs/guides/bring-escrow-to-your-platform.md`; ADR-0025 and ADR-0026
record the decisions.

### Implementations

| | Where | Content key and plaintext | Crypto |
|---|---|---|---|
| Packer and reference decryptor | `packages/escrow` (TypeScript) | Node buffers | Node `crypto` (OpenSSL) |
| Native loader | `sdk/native` (`libscriptgo`, C ABI, `SG_ABI_VERSION` 1) | native memory from `sodium_malloc`: guarded, locked when the OS allows, read-only once written, wiped on free | libsodium 1.0.22, statically linked: `crypto_aead_aes256gcm`, `crypto_scalarmult` (X25519), `crypto_kdf_hkdf_sha256`, `crypto_sign_verify_detached`, `crypto_hash_sha256` |
| .NET loader, native backend (default) | `sdk/dotnet/ScriptGo.Escrow` | as the native loader, which it calls | as the native loader |
| .NET loader, managed backend (explicit fallback) | `sdk/dotnet/ScriptGo.Escrow`, `EscrowBackend.Managed` | managed arrays; weaker against memory inspection | `System.Security.Cryptography` AES-GCM; NSec 24.4.0 for X25519 and ed25519 |

The native loader needs hardware AES (AES-NI and PCLMUL on x86-64, the crypto extensions on ARM64)
and reports `SG_ERR_NO_AES` without it; it has no software fallback. It is built and tested on
Windows x64 only; the Linux and macOS builds are written and unbuilt.

The honest stance at the top of this document applies unchanged. Moving the key and the plaintext
into native memory raises the cost of reading them out of a process. It does not stop the operator
of the machine, and no implementation may claim that it does.

### Loader behaviour (normative for every implementation)

A loader performs these steps in this order, and stops at the first failure:

1. Parse the bundle. Refuse an entry whose path is unsafe (see below).
2. Check `format`, `cipher` and `kdf`; when a trusted signer key is pinned, require
   `signerPublicKey` to equal it; verify the ed25519 signature over the canonical manifest.
3. Check every `clearFiles` entry against its SHA-256.
4. **Only then** request the key. A bundle that fails steps 1 to 3 must not cause a key request.
5. Check SHA-256(`payload.enc`) against `payload.sha256`.
6. Unwrap the content key; a failure means the key was wrapped to another server or another
   release, and is reported as such (`unwrap_failed`), distinct from a tampered payload.
7. Decrypt the payload; wipe the content key and every intermediate secret before reading the
   inner archive.
8. Read the inner zip under the archive rules below.

**Archive rules.** Stored (0) and deflate (8) entries only; the CRC-32 of every file is checked;
zip64, multi-disk archives, encrypted entries and duplicate paths are refused; a local header must
name the same file as its central directory record. Limits: 256 MiB of payload, 64 MiB per file,
512 MiB in total, 16 384 entries, 1024 bytes per path.

**Path rules.** A path is resource-relative with `/` separators. Refused: a leading `/`; an empty,
`.` or `..` segment; a backslash; a colon; a control character. Both loaders apply the same rules
to the outer bundle and to the inner archive, so no entry can leave the resource root when a host
joins it onto a directory.

**Lua.** A script is compiled with `luaL_loadbufferx` in mode `"t"` (text only): a precompiled
chunk inside a release is refused by Lua. The native loader compiles straight from its own memory
into the host's `lua_State` (`sg_bundle_lua_load`); the plaintext is not copied into the host
language's heap on that path.

**The copy door.** Copying a decrypted file out of the loader (`sg_bundle_copy`,
`EscrowContent.CopyTo` / `ReadAllBytes`) is a separate, documented operation, needed for script
engines that take source from the host language (JavaScript on Jint) and for data files. It is the
weaker path and implementations count or otherwise expose its use.

**Delivery marker.** When the key answer carries `deliveryWatermark`, the loader exposes it as the
file `.scriptgo-escrow` of the decrypted resource (the token followed by a newline). It is not
listed among the encrypted files. Traceability only.

### The lease (re-verification and revocation)

The key answer is a lease. `expiresAt` is when it stops being valid; `offlineGraceUntil` is the
last instant the resource may run without a fresh valid answer.

- A loader asks again before `expiresAt` (the .NET loader: a third of the lease ahead, between 1
  second and 5 minutes; never more often than once a second).
- **Granted:** the lease is replaced by the new answer.
- **Definitive refusal** (`{ valid:false, reason }`) or **no answer** (network error, 4xx/5xx): the
  lease is not extended, the resource keeps running, and the loader keeps asking. A later grant
  restores the lease.
- **At `offlineGraceUntil` without a grant:** the loader tells the host to stop the resource, then
  wipes the decrypted files. The reason is `refused:<reason>` after a refusal and
  `offline_grace_exhausted:...` after an outage. No file is served afterwards.
- The lease also ends by the clock alone: a host that never renews gets nothing from the loader
  past `offlineGraceUntil`.
- When the key service gives no `expiresAt`, the .NET loader assumes 15 minutes; when it gives no
  `offlineGraceUntil`, it assumes none.

Stopping the VM that already holds compiled code is the host's part: no loader can do it.

### Identity file

One format for the native library and for the managed backend, so a server keeps its identity when
it moves between them:

```
"SGIDENT1" (8) | protection (1) | X25519 public key (32) | length (u32 LE) | protected private key
```

`protection` 1: Windows DPAPI (`CryptProtectData`, current user, entropy
`scriptgo.escrow.identity.v1`). `protection` 2: the raw key, in a file with mode 0600, refused when
group or others can read it. A loader derives the public key from the private key and refuses a file
whose stored public key differs. A file that exists and cannot be opened is an error: a loader
never replaces an identity on its own, because that would unbind the server.

### Vector

`sdk/dotnet/ScriptGo.Host.Tests/Fixtures/escrow-vector.json` and `sdk/native/tests/escrow_vector.h`
are the same vector, written together by `packages/escrow/tools/gen-vectors.ts`. Besides the bundle
and the keys it carries `canonicalManifest` (the exact bytes the signature covers, to test a
canonicaliser against) and `hostile`: payloads that authenticate under the vector's content key and
must still be refused (not a zip, a wrong CRC, and five shapes of path traversal). The native
suite and the .NET suite, on both backends, open the same bundle and refuse the same payloads.
