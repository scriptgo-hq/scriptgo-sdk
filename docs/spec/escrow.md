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

## Master side, as built (escrow/site, ADR-0028..0030)

This section describes what `apps/api`, `packages/licensing`, `packages/registry` and `packages/cli`
implement on top of the format above. Where it differs from an earlier paragraph, this one is current.

### Publishing

- `POST /v1/creator/packages/:name/releases`, multipart. Either `archive` = plain zip with
  `escrow=true` and optional `allowlist` (the master builds the bundle), or `archive` = a bundle with
  `contentKey` (base64, 32 bytes; `scriptgo publish --escrow` sends it). The bundle's `package` must be
  the registry identifier `creator//name` and its `aad` `${package}@${version}`.
- The master verifies the manifest signature, every clear-file hash and the payload hash, decrypts in
  memory with the key, checks the decrypted entries are exactly `encryptedFiles`, then runs the normal
  upload validation on the plaintext. It stores the bundle only and seals the key. A failed
  validation stores nothing.
- **Who signs `escrow.json`**: a bundle built by the master is signed with a per-creator key the
  master holds sealed (`creator_signing_keys`, origin `master`); a bundle built by the CLI is signed
  with the creator's own key (origin `creator`, public half recorded on first use). Neither is the
  registry's release-signing key, and neither is the licence-token signer.
- **The release watermark**: an HMAC from a master secret for a master-built bundle, an opaque random
  token for a CLI-built one. The master stores it with the release either way; resolving it is a
  lookup, not a recomputation.

### What is clear and what is encrypted

`prepareEscrowFiles` (`packages/manifest/src/open77.ts`) is the single rule, called by the CLI and by
the master:

- always clear: the manifest, `README.md`, `CHANGELOG.md`, `LICENSE*`;
- clear because a host sends them to game clients: shared scripts, client scripts, `files`,
  `web_files`, the web UI page, OPEN//77 environment scripts;
- clear and generated, for a package that can run on OPEN//77 (SCRIPT//GO format, every script Lua,
  `environments` empty or listing `open77`): `open77.lua` and `scriptgo_shim.lua`,
  `scriptgo_shim_server.lua`, `scriptgo_shim_client.lua`, exactly as `scriptgo pack --target open77`
  writes them. They are in `clearFiles`, so the release signature covers them;
- clear by the creator's choice: the `allowlist` globs;
- encrypted: everything else, in practice the server-side code. A bundle that would encrypt nothing
  is refused.

### Delivery

`GET /v1/packages/:creator/:name/versions/:version/download` serves the bundle
(`X-ScriptGo-Artifact: escrow`) to the licence holder's session or token, or to a request carrying
`X-ScriptGo-Deployment-Token` or `X-ScriptGo-License-Key`; otherwise 403 `license_required`. The
registry's release signature is in the headers. `?variant=plain` (creator and staff only, audited)
rebuilds the plaintext in memory.

### Key release, in full

Request and answer as above. Order of checks, each a definitive `200 { valid: false, reason }`:

1. the licence: `unknown_key`, then `expired` / `revoked` / `refunded` after bringing the licence up
   to date with time;
2. the deployment: `deactivated`, `environment_not_covered`, `deployment_limit`; a licence key
   without a deployment token is `unbound` (there is no server to wrap to);
3. the binding: no key bound and none sent is `unbound`; a key sent when none is bound is bound now
   (trust on first use); another key than the bound one is `server_key_mismatch`;
4. the release: the version asked, else the newest protected one, published or deprecated and not
   restricted; none is `not_escrowed`.

A release answers `expiresAt` = now + `LICENSE_TOKEN_TTL_SECONDS` (900 s) and the same
`offlineGraceUntil` as verify (`LICENSE_OFFLINE_GRACE_HOURS`, never beyond a cancelled period or a
payment grace). `Cache-Control: no-store`. Limits: 300 per minute per address and 60 per minute per
key or token, answered 429, which a loader treats as "could not answer". Every answer is a row of
`escrow_key_events`: outcome, reason, package, release, licence, deployment, server-key fingerprint
and, for a release, the delivery marker. No row can hold a key.

`POST /v1/me/licenses/:id/deployments/:activationId/reset-server-key` unbinds a deployment for an
honest migration: audited, at most three per deployment per 24 hours (429 `reset_limit`).

### Loaders

- **.NET kit** (`ScriptGo.Host.Escrow`): decrypts in managed memory. The only in-memory loader today.
- **Reference loader** (`scriptgo escrow load`, `packages/cli/src/lib/escrow-loader.ts`): plain Node,
  labelled "reference loader, not a compiled host". It checks every hash of the signed manifest
  before asking for a key, keeps no key on disk (so a cold start always needs the master), stamps
  the delivery marker, can write the copy to disk (`--out`, licence-only grade) and, long-running,
  stops when the offline grace of its last valid answer ends. Exit codes: 0 ran, 1 refused, 3
  stopped at the end of grace, 4 master unreachable at start.
- **OPEN//77 install** (`scriptgo escrow install --target open77`): writes the bundle's signed clear
  files, `escrow.json`, `payload.enc` and one-line stubs; decrypts nothing and generates nothing.

### Traceability

`POST /v1/admin/escrow/marker-lookup { marker, reason }` resolves a delivery marker to its licence,
holder, deployment and delivery times, or a release watermark to its release. Audited. A marker can
be removed from a copy by someone who knows it is there: it is evidence when present, never proof of
absence, and never prevention.

### Proof

`node tools/escrow-e2e.mjs` runs the whole chain against a throwaway database and the mock provider
and prints a numbered table; `--loader dotnet` or `--loader "<command>"` drives a real host with the
same steps. `apps/api/test/escrow-chain.test.ts` and `escrow-file-set.test.ts` cover the master.
