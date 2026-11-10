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

## Rust (Oxide/Carbon) adapter: disk layout, native loader, asynchronous key (ADR-0031)

How `sdk/adapters/rust` loads an escrowed release. The format above is unchanged; this section
only fixes what that adapter reads and how it behaves. Status: **planned**. It is proven in the
bridge's test process with the real native library (Windows x64); no Rust server has run it.

**On disk.** A resource folder is escrowed if and only if it holds `escrow.json`. `payload.enc` sits
next to it, the clear files of the release are at their paths, and each encrypted script has a
one-line stub at its path:

```text
-- scriptgo-escrow/1 <package>@<version> sha256=<payload.sha256> path=<relative path>
```

A stub is never compiled. The resource manifest (`scriptgo.lua`) is one of the signed clear files.

**Checks before the key is asked for**, each with a stable reason code: `escrow.json` shape, format,
cipher and kdf (`invalid_manifest`); the pinned signer and the ed25519 signature over the canonical
JSON, through `sg_verify_manifest` (`signature`); `payload.enc` size and SHA-256, the resource
manifest byte for byte, the stub at each encrypted path, and that every script the manifest runs is
a file of the release (`tampered`); the deployment token file (`token_missing`). Other clear files
may differ unless `strictClearFiles` is set.

**Key request.** `POST <master>/v1/licenses/key` with `{ deploymentToken, package, version,
environment, adapterVersion, serverPublicKey }`, through the host's web requests. These are
asynchronous, so the resource is `pending_key` until the answer arrives on a later tick. HTTP 200
with `valid:false` is a definitive refusal (`not_licensed`, `unbound`, `revoked`, `expired`);
anything else is `unreachable`, and an earlier answer for the same release still inside its
`offlineGraceUntil` is used instead. With no pinned signer, the answer's `signerPublicKey` must be
the manifest's.

**Loading.** `sg_bundle_open`, `sg_bundle_set_marker` (the `deliveryWatermark`), then
`sg_bundle_lua_load` per script with the `luaL_loadbufferx` of the Lua library the VM runs on. The
adapter does not declare `sg_bundle_read` or `sg_bundle_copy`: no decrypted file enters managed
memory, so an encrypted file that is not a script is not readable by the resource.

**Renewal.** Before `expiresAt`. After a refusal or without an answer, the resource runs until the
`offlineGraceUntil` of its last valid answer, then it is stopped with the reason.

**Honest limit, specific to this adapter.** Every resource shares one Lua VM. Another resource in
that VM cannot obtain the script (text or bytecode) or a function's locals, but it can reach an
escrowed resource's global functions and tables through the core's host object. Deterrence, licence
binding, revocation and traceability hold; isolation between resources does not. The operator of
the machine can ultimately recover what their own process runs. See `sdk/adapters/rust/README.md`,
"Escrow".
