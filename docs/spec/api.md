# HTTP API contract (v1)

This document is the contract between `apps/api` and `apps/web` (and `packages/cli`). The API's
OpenAPI document (`GET /v1/openapi.json`, Swagger UI at `/docs`) is generated from the same zod
schemas exported by `packages/shared`. **When a shape changes, update `packages/shared` and this
file in the same change.**

- Base URL in dev: `http://localhost:4100`. The web app proxies `/v1/*` and `/api/auth/*` to the
  API with Next.js rewrites so cookies stay first-party.
- JSON everywhere, `camelCase`, timestamps ISO-8601 UTC strings, money as
  `{ "amount": 600, "currency": "EUR" }` in **minor units**.
- Errors: `{ "error": { "code": "snake_case", "message": "Human sentence.", "details"?: {} } }`
  with the matching HTTP status.
- Auth: better-auth session cookie (`/api/auth/*`) for people; `Authorization: Bearer sg_pat_...`
  personal access tokens for the CLI; `Authorization: Bearer sg_adm_...` for the CI ingest token.
- Pagination: `?page=1&pageSize=24` → `{ items, total, page, pageSize }`.

## Enumerations

```ts
EnvironmentStatus   = "available" | "beta" | "experimental" | "planned"
EnvironmentKind     = "runtime" | "mod_platform"   // mod_platform: a layer on top of an existing game
EnvironmentSales    = "allowed" | "free_only" | "review"   // the underlying game's rule on selling mods
AdapterState        = "verified" | "written" | "none"   // a real run passed | adapter code, no real run yet | no code yet
IntegrationType     = "cli" | "library" | "addon" | "mod" | "plugin" | "program" | "shim" | "kit"
CapabilitySupport   = "supported" | "partial" | "fallback" | "unavailable"
CompatibilityStatus = "verified" | "failing" | "stale" | "not_tested" | "unsupported"
ReleaseStatus       = "draft" | "validating" | "validation_failed" | "ready" | "published" | "deprecated" | "yanked"
Visibility          = "private" | "unlisted" | "public"
ListingStatus       = "active" | "restricted" | "suspended"
OfferInterval       = "free" | "month" | "year" | "perpetual"
Classification      = "free" | "software_license" | "authorized_app_feature" | "pending_review" | "rejected"
LicenseStatus       = "active" | "grace" | "cancelled_active" | "expired" | "revoked" | "refunded"
ActivationStatus    = "pending" | "active" | "offline_grace" | "deactivated" | "blocked"
StoreStatus         = "not_connected" | "sandbox" | "checkout_off" | "live" | "needs_attention"
CaseStatus          = "received" | "under_review" | "action_taken" | "no_action" | "escalated" | "appeal_open" | "closed"
Category            = "inventory" | "permissions" | "economy" | "events" | "ui" | "admin" | "framework"
                    | "vehicles" | "housing" | "quests" | "library" | "other"
VerifyFailureReason = "expired" | "revoked" | "refunded" | "environment_not_covered" | "deployment_limit"
                    | "unknown_key" | "deactivated"
KeyReleaseFailureReason = VerifyFailureReason | "unbound" | "server_key_mismatch" | "not_escrowed"
ProtectionTier      = "escrow" | "license" | "none"   // what a buyer's server gets in an environment (ADR-0027)
ProtectionState     = "available" | "planned"
```

```ts
// On every Environment (list and detail). "none" is exactly the free_only environments.
EnvironmentProtection = { tier: ProtectionTier, state: ProtectionState, optIn: boolean, note: string }
// On a published release (Release, PackageVersion). Verify with GET /v1/signing-keys.
ReleaseSignature  = { alg: "ed25519", keyId, payload, signature }
                    // payload: canonical JSON { v: 1, package, version, sha256, size, escrow, publishedAt }
// Public facts of a release's encrypted variant; null when the release is not protected. Never a key.
ReleaseEscrowInfo = { format, cipher, kdf, aad, signerPublicKey, signerKeyId, signerOrigin: "master" | "creator" | null,
                      allowlist: string[], clearFiles: string[], encryptedFiles: string[], watermarked: boolean,
                      builtBy: "cli" | "server", sealedKeyPresent: boolean }
```

`Release` and `PackageVersion` carry `escrow: ReleaseEscrowInfo | null` and `signature: ReleaseSignature | null`
(null only for a release published before signing; the seed signs those). For a protected release
`sha256` and `size` describe the encrypted bundle: that is what is delivered.

## Public

```
GET  /v1/health                                  → { ok: true, version }
GET  /v1/environments                            → Environment[]   (listed environments only)
GET  /v1/environments/:slug                      → EnvironmentDetail (also for an unlisted one, by direct link)
GET  /v1/packages?q&environment&capability&category&pricing=free|paid&sort=updated|downloads|name&page&pageSize
                                                 → Page<PackageSummary>
GET  /v1/packages/:creator/:name                 → PackageDetail
GET  /v1/packages/:creator/:name/versions/:version/download   → zip stream, header X-Sha256
GET  /v1/creators/:username                      → CreatorProfile
POST /v1/reports  (multipart: fields + evidence[]) → { caseId: "RPT-2026-000123", status: "received" }
GET  /v1/stats                                   → { packages, creators, environmentsVerified }  (real counts only: demo
                                                   data excluded, environmentsVerified counts listed environments)
GET  /v1/compatibility-runs/:runId/evidence/:index → stored evidence file (screenshot or log)
POST /v1/licenses/verify, /v1/licenses/activate, /v1/licenses/key, /v1/licenses/deactivate, GET /v1/licenses/public-key  (see Licensing)
```

`PackageDetail.compatibility` has one entry per environment the latest release declares or was
run on. An environment can be run on several runtimes (standalone on Lua 5.1, 5.4 and LuaJIT): the
newest run of each runtime counts, the entry is `failing` if any of them fails (its `runId` and
`log` are then the failing run's), and `runtimeVersion` lists the runtimes, comma-separated.

```ts
Environment = {
  slug: "standalone" | "love2d" | "godot" | "luanti" | "open77" | string,
  name: string,                       // "LÖVE"
  kind: EnvironmentKind,
  status: EnvironmentStatus,
  sales: EnvironmentSales,
  salesNote: string,                  // one line: the rule and why; "" when allowed without condition
  luaDialects: string[],              // as sdk/environments.json writes them: "5.1", "5.4", "LuaJIT"
  languages: string[],                // guest languages its host runs: ["lua"], or ["lua", "ts", "js"] on dotnet
  sides: string[],                    // ["server"] or ["server", "client"]
  adapterState: AdapterState,         // read from the repository and verification/reports, never declared
  blockedOn: string,                  // adapterState "written": what the first real run waits for; "" otherwise
  runtimeVersions: string[],          // ["11.5"]
  adapterVersion: string,
  summary: string,
  capabilities: Record<Capability, CapabilitySupport>,
  capabilityNotes: Record<Capability, string>,   // only for capabilities with a caveat
  verifiedPackages: number,
  lastRun: { status: CompatibilityStatus, ranAt: string, runId: string } | null
}
EnvironmentDetail = Environment & {
  setupMarkdown: string, limitations: string[], packages: PackageSummary[],
  integration: { type: IntegrationType, runtime: string, summary: string } | null,   // null: no adapter code yet
  proof: {                            // verified runs from verification/reports: newest version of each package, per runtime
    package: string, version: string, runtime: string, lua: string, adapterVersion: string,
    checksPassed: number, checks: number, ranAt: string
  }[]
}

PackageSummary = {
  id: string,
  identifier: string,                 // "kestrel//inventory-pro"
  creator: { username: string, displayName: string, firstParty: boolean },
  name: string,                       // "inventory-pro" (URL segment)
  resourceName: string,               // "inventory_pro" (manifest `resource`)
  title: string, summary: string, category: Category,
  latestVersion: string | null, license: string,
  environments: { slug: string, status: CompatibilityStatus }[],
  capabilities: string[],
  pricing: { kind: "free" } | { kind: "paid", from: Money, interval: OfferInterval, checkoutEnabled: boolean },
  downloads: number, updatedAt: string, listingStatus: ListingStatus
}
PackageDetail = PackageSummary & {
  description: string, readme: string, repository: string | null,
  manifest: ParsedManifest,           // output of packages/manifest
  versions: { version, status: ReleaseStatus, publishedAt, sha256, size, changelog }[],
  compatibility: {
    environment: string, status: CompatibilityStatus, version: string,
    runtimeVersion: string | null, adapterVersion: string | null,
    ranAt: string | null, runId: string | null, log: string | null,
    evidence: { kind: "screenshot" | "log", url: string }[],
    missingCapability: string | null
  }[],
  offers: Offer[],
  rights: { declaredAt, ownsCode: boolean, targetsProprietaryGame: boolean,
            thirdPartyAssets: { path, source, license }[], dependencies: { name, license }[] } | null,
  seller: { creator: string, provider: "tebex" | "mock" | null } 
}
Offer = { id, packageId, name, interval: OfferInterval, price: Money | null,
          classification: Classification, environments: string[], deployments: number,
          provider: "tebex" | "mock" | null, checkoutEnabled: boolean, checkoutDisabledReason: string | null }
CreatorProfile = { username, displayName, bio, links: string[], joinedAt, firstParty, packages: PackageSummary[] }
```

## Account (session or PAT)

```
GET  /v1/me                                      → { user, creatorProfile | null, roles: Role[] }
POST /v1/me/tokens { name, expiresInDays? }     → 201 { id, token: "sg_pat_...", name, expiresAt }
                                                   (shown once; browser session only, a PAT cannot mint PATs)
GET  /v1/me/tokens                               → { id, name, preview, createdAt, lastUsedAt, expiresAt }[]
DELETE /v1/me/tokens/:id                         → 204
GET  /v1/me/library                              → PackageSummary[]
GET  /v1/me/licenses                             → LicenseSummary[]
GET  /v1/me/licenses/:id                         → LicenseDetail
POST /v1/me/licenses/:id/reveal                  → { key }   the key issued with the license, shown once (then 409)
POST /v1/me/licenses/:id/rotate                  → { key }   new key, shown once; the old key stops working
POST /v1/me/licenses/:id/deployments  { name, environment }  → 201 { activation, deploymentToken }
DELETE /v1/me/licenses/:id/deployments/:activationId         → 204
GET  /v1/me/notices                              → Notice[]
POST /v1/me/notices/:id/appeal { statement }     → Notice
POST /v1/checkout { offerId }                    → 201 { checkoutId, redirectUrl }
       409 offer_free | already_licensed | checkout_disabled (message = checkoutDisabledReason), 502 provider_error
GET  /v1/checkout/:checkoutId                    → { checkoutId, status: "pending" | "completed" | "failed" | "expired",
                                                     licenseId | null, offerId, createdAt }
```

```ts
LicenseSummary = { id, package: PackageSummary, offer: Offer, status: LicenseStatus,
                   currentPeriodEnd: string | null, deploymentsUsed: number, deploymentsAllowed: number }
LicenseDetail = LicenseSummary & {
  keyPreview: string,                 // "sg_live_…a91c"
  environments: string[],
  activations: { id, name, environment, adapterVersion, lastVerifiedAt, status: ActivationStatus, offlineGraceUntil }[],
  history: { at, event, source: "provider" | "user" | "admin" | "system", reference }[],
  keyRevealAvailable: boolean,        // POST .../reveal can still show the issued key
  seller: { creator: string, provider: "tebex" | "mock" | null },
  revokedReason: string | null,
  graceUntil: string | null
}
```

The mock provider's checkout page is served by the API at `/v1/mock-provider/checkout/:checkoutId`
(only when COMMERCE_MOCK_PROVIDER_ENABLED, which the API refuses in production). Its buttons POST to
`/v1/mock-provider/checkout/:checkoutId/:action`, `action` one of `pay`, `pay_then_cancel`,
`cancel`, `refund`, `cancel_subscription`, `renew`; each builds the provider events, signs them
(`X-SG-Signature`) and delivers them to `/v1/webhooks/mock`, then answers 303 to
`${PUBLIC_WEB_URL}/checkout/:checkoutId` (`?cancelled=1` after *Cancel*). Licenses are only ever
granted by a verified webhook or an audited admin grant, never by the redirect: the web page polls
`GET /v1/checkout/:checkoutId`.

## Creator (session or PAT; requires a creator profile)

```
POST /v1/creator/profile { username, displayName, bio }       → 201 { username, displayName, ... }
GET  /v1/creator/packages                        → PackageSummary[] (incl. private/draft)
POST /v1/creator/packages { name, title, summary, category, license, visibility, repository }  → 201 CreatorPackageDetail
GET  /v1/creator/packages/:name                  → CreatorPackageDetail
PATCH /v1/creator/packages/:name                 → CreatorPackageDetail
POST /v1/creator/packages/:name/releases  (multipart: archive=zip)  → Release (status "validating")
     + escrow=true [allowlist=<globs, one per line or comma-separated>]   → Release (status "ready" | "validation_failed")
       the master builds the encrypted bundle from the plain archive, signs escrow.json with the creator's
       master-held key, validates in the request (no worker) and keeps no plaintext
     + archive=<escrow bundle> contentKey=<base64, 32 bytes>               → Release (status "ready" | "validation_failed")
       a bundle built by `scriptgo publish --escrow`: the master checks the signature, opens it in memory with
       the key, validates the plaintext, stores the bundle and seals the key
       422 escrow_key_required | escrow_key_invalid | escrow_key_mismatch | escrow_bundle_invalid |
           escrow_signature_invalid | escrow_package_mismatch | escrow_version_mismatch |
           escrow_nothing_to_encrypt | escrow_reserved_file | invalid_allowlist | signer_retired
GET  /v1/creator/packages/:name/key-activity?days=30  → KeyActivity   (counts from the key endpoint's log)
GET  /v1/creator/releases/:id                    → Release with validation report
POST /v1/creator/releases/:id/rights { ownsCode, targetsProprietaryGame, thirdPartyAssets[] }
POST /v1/creator/releases/:id/publish            → Release (409 publish_blocked, details.blockers: string[])
                                                 (a release that declares a free_only environment rejects every paid offer of the package)
POST /v1/creator/releases/:id/deprecate { reason } → Release
POST /v1/creator/releases/:id/yank { reason }    → Release   (its download then answers 410)
POST /v1/creator/packages/:name/offers { name, interval, price, environments, deployments, providerProductId, provider? }
                                                 → 201 Offer   (provider defaults to the creator's Tebex store, else mock)
                                                 (422 environment_free_only: a paid offer whose environments, or whose package's non-yanked releases, include a free_only environment)
DELETE /v1/creator/offers/:id                    → 204   (offer withdrawn; licenses already sold are unaffected)
GET  /v1/creator/stores                          → Store[]
POST /v1/creator/stores { provider: "mock" | "tebex", credentials }  → Store
POST /v1/creator/stores/:id/test-event           → { delivered: boolean, status: number }  (mock store only)
GET  /v1/creator/customers                       → { license, customer: { username }, offer }[]
GET  /v1/creator/analytics?days=30&package=      → { downloads: Series, activations: Series, verifications: Series }
```

```ts
KeyActivity = { days, released, refused, refusalsByReason: Record<KeyReleaseFailureReason, number>,
                deployments,            // distinct deployments that received a key in the window
                lastReleasedAt, lastRefusedAt }
```

The content key of a protected release is sealed at rest, is in no log and no audit record, and is in
no response of this API other than `POST /v1/licenses/key`, wrapped to one bound server. Publishing
signs the release (`signature`) with the registry key. A protected release is immutable like any
other: a new key is a new release.

```ts
Release = { id, packageName, version, status: ReleaseStatus, createdAt, sha256, size,
            checks: { stage: "archive" | "manifest" | "integrity" | "static" | "unit" | "environment" | "rights",
                      name: string, status: "pending" | "running" | "passed" | "failed" | "skipped",
                      required: boolean, durationMs: number | null, message: string | null, log: string | null }[],
            blockers: string[] }
CreatorPackageDetail = PackageSummary & { description, repository, releases: Release[], offers: Offer[] }
Store = { id, provider, status: StoreStatus, approved: boolean,
          checkoutEnabled: boolean, checkoutDisabledReason: string | null,
          webhookUrl: string,                 // where to point the provider's webhooks
          webhook: { lastEventAt, deliveries24h, failures24h },
          products: { providerProductId, offerId, syncStatus: "synced" | "unverified" | "error" }[],
          recentDeliveries: { eventId, type, status, receivedAt, error }[], createdAt }
```

## Licensing (called by deployments)

```
POST /v1/licenses/activate   { licenseKey, package, environment, deploymentName, adapterVersion, serverPublicKey? }
                             → 201 { activationId, deploymentToken }
                               404 unknown_key, 409 deployment_limit | deployment_exists | <license status, e.g. expired>,
                               422 environment_not_covered   (activating the same name again rotates its token)
                               // serverPublicKey: the server's X25519 public key (base64url) for escrow binding
POST /v1/licenses/verify     { licenseKey | deploymentToken, package, environment, adapterVersion }
                             → 200 { valid, reason: VerifyFailureReason | null, status: LicenseStatus | null,
                                     activationStatus: ActivationStatus | null, expiresAt, offlineGraceUntil,
                                     environments: string[], token: string }   // ed25519-signed, short-lived
POST /v1/licenses/key        { licenseKey | deploymentToken, package, version?, environment, adapterVersion, serverPublicKey? }
                             → 200 { valid, reason: KeyReleaseFailureReason | null, wrappedKey: {epk,nonce,wrapped} | null,
                                     aad, signerPublicKey, deliveryWatermark, offlineGraceUntil, expiresAt }
                               // escrow: content key wrapped to the bound server. Gated like verify, plus binding +
                               // escrowed release. Reasons add unbound, server_key_mismatch, not_escrowed.
                               // Cache-Control: no-store. 4xx/5xx → loader offline grace. 300/min per IP and
                               // 60/min per key or token (429). Every answer is logged with its reason.
                               // See docs/spec/escrow.md.
POST /v1/licenses/deactivate { licenseKey, activationId }  → { ok: true }
GET  /v1/licenses/:id        (owner session only)          → LicenseDetail
GET  /v1/licenses/public-key                               → { alg: "ed25519", publicKey, kid }
(activate and deactivate: 30/min per IP)

GET  /v1/signing-keys                                      → { keys: { keyId, alg: "ed25519", publicKey, status: "current" | "retired" }[] }
                                                             // the registry's RELEASE-signing keys (raw public key, base64url);
                                                             // not the license-token key above
GET  /v1/creators/:username/signing-keys                   → { keys: { keyId, alg, publicKey, origin: "master" | "creator", createdAt, retiredAt }[] }
                                                             // the keys that sign this creator's escrow manifests
POST /v1/me/licenses/:id/deployments/:activationId/reset-server-key   (owner; 10/min)
                             → 200 Activation   404 not_found, 409 not_bound, 429 reset_limit (3 per deployment per 24 h)
                               // unbinds the server key; the next key request binds the server that makes it. Audited.
```

`Activation` (in `LicenseDetail.activations`) carries `binding: { bound, serverKeyFingerprint, boundAt,
lastKeyReleaseAt, resets, lastResetAt }`: the server key as a fingerprint (16 hex characters of the
SHA-256 of the raw public key), never the key. Activating the same deployment name again renews its
token but answers 409 `server_key_mismatch` when it names another server key than the bound one.

**Download of a release** (`GET /v1/packages/:creator/:name/versions/:version/download`): the answer
carries `X-Sha256`, `X-ScriptGo-Artifact: plain | escrow` and the release signature in
`X-ScriptGo-Signature`, `X-ScriptGo-Signature-Key`, `X-ScriptGo-Signature-Payload` (base64url of the
signed JSON). A protected release is delivered as its encrypted bundle, and only to a licensed
customer: the session or personal token of the license holder, or `X-ScriptGo-Deployment-Token` /
`X-ScriptGo-License-Key`; anyone else gets 403 `license_required`. `?variant=plain` returns the
plaintext to the package's creator and to staff only, and is audited
(`release.escrow_plain_downloaded`); it answers 403 to a buyer and 409 `not_escrowed` on an
unprotected release.

**Key-release refusal reasons** (stable; a loader switches on them):
`unknown_key` no license matches the key or token for this package · `expired` · `revoked` ·
`refunded` · `deactivated` the deployment was deactivated · `environment_not_covered` ·
`deployment_limit` · `unbound` the request names no server key to wrap to (a license key alone, or a
deployment without a key and none sent) · `server_key_mismatch` another server key than the bound
one (a copy on another machine; an honest move needs the owner's reset) · `not_escrowed` no protected
release for the version asked (or it was yanked or restricted).

`package` is the `creator//name` identifier or the manifest resource name (`inventory_pro`).

`verify` is rate-limited per IP (300/min) and per key (60/min) and never reveals another
customer's data. **A definitive refusal is always HTTP 200** `{ valid: false, reason }` (a
malformed key, or a key for another package, is `unknown_key`). Any 4xx/5xx `{ error: { code } }`,
429 included, means the API could not answer, and a runtime then applies the offline grace of its
last valid answer. Only a structurally broken body (neither or both of `licenseKey` and
`deploymentToken`) gets a 400. `offlineGraceUntil` is an ISO-8601 UTC timestamp.

`token` is a compact JWS (header `{ alg: "EdDSA", typ: "sg-license+jws", kid }`, key from
`GET /v1/licenses/public-key`) whose payload is
`{ iss: "scriptgo", typ: "license-verification", ... }` with the answer above and `iat`/`exp`.

## Webhooks

```
POST /v1/webhooks/tebex            raw body, header X-Signature, platform secret (TEBEX_WEBHOOK_SECRET)
POST /v1/webhooks/tebex/:storeId   same, verified with that store's own webhook secret (Store.webhookUrl)
POST /v1/webhooks/mock             raw body, header X-SG-Signature (HMAC-SHA256 of the raw body, hex)
```

Tebex: `X-Signature = hex HMAC-SHA256(secret, hex SHA-256 of the raw body)`; `validation.webhook`
is answered `200 { id }`. With `TEBEX_ENFORCE_IP_ALLOWLIST` (on by default in production) senders
other than 18.209.80.3 and 54.87.231.232 get 404. A bad or missing signature is
`401 invalid_signature`, recorded in the operational error log, never as a payment event.
Accepted events answer `200 { received: true, duplicate, status }`, `status` one of `processed`,
`deferred` (about something not issued yet; replayed when it is), `ignored`, `failed` (a permanent
mismatch, acknowledged so the provider stops retrying). Events are idempotent on
(provider, event id): a duplicate is a no-op.

## Admin

Moderation routes accept the `moderator` or `admin` role; routes marked *(admin)* need `admin`.

```
GET  /v1/admin/review/offers?status=pending|all        → ReviewOffer[]
POST /v1/admin/review/offers/:id/decision { classification, reason }      → ReviewOffer
GET  /v1/admin/review/releases?status=open|all         → ReviewRelease[]
POST /v1/admin/review/releases/:reviewId/decision { decision: "approve" | "restrict" | "reinstate", reason }
                                                       → ReviewRelease
GET  /v1/admin/reports?status                          → CaseSummary[]
GET  /v1/admin/reports/:id                             → CaseDetail   (:id = report id or case id RPT-YYYY-NNNNNN)
POST /v1/admin/reports/:id/review                      → CaseDetail   (moves it to under_review)
POST /v1/admin/reports/:id/decision    { action: "no_action" | "restrict_release" | "restrict_sales" | "suspend_listing",
                                         reasons: string, escalate: boolean }  → CaseDetail
GET  /v1/admin/reports/:id/evidence/:evidenceId        → file (attachment, nosniff)
POST /v1/admin/appeals/:id/decision { outcome: "upheld" | "reversed", reasons } → CaseDetail
                                       409 same_reviewer when the caller took the decision under appeal
                                       (CaseDetail.appeals[].decisionId → decisions[].decidedBy)
GET  /v1/admin/audit?subject=<type>:<id>&actor&action&limit               → AuditEntry[]
GET  /v1/admin/payment-events?status&provider&limit    (admin) → PaymentEventRow[]
GET  /v1/admin/errors?limit                            (admin) → OperationalError[]
POST /v1/admin/compatibility-runs      (CI ingest token, or admin session) CompatibilityRun
                                       → 201 { id, releaseId, created: true }, 200 on replay of the same runId
POST /v1/admin/licenses/grant          (admin) { userId, offerId, reason } → 201 LicenseDetail (audited grant)
POST /v1/admin/licenses/:id/revoke     (admin) { reason }                  → { ok: true }
GET  /v1/admin/stores                  (admin) → (Store & { creator })[]
POST /v1/admin/stores/:id/approval     (admin) { approved, reason }       → Store & { creator }
POST /v1/admin/ingest-tokens           (admin, browser session) { name }  → 201 { id, token: "sg_adm_..." } (shown once)
GET  /v1/admin/ingest-tokens           (admin) → { id, name, preview, createdAt, lastUsedAt }[]
DELETE /v1/admin/ingest-tokens/:id     (admin) → 204
GET  /v1/admin/users?email             (admin) → { id, email, name, createdAt, roles, creator }[]
POST /v1/admin/roles                   (admin, browser session) { userId, role: "admin" | "moderator", grant, reason }
                                       → { userId, roles }   (409 last_admin)
```

`CompatibilityRun` is the JSON written by `scriptgo verify` into `verification/reports/*.json`:

```ts
CompatibilityRun = { runId, package: "scriptgo//event-bus" | "sg_eventbus", version, environment, status: "verified" | "failing",
                     runtimeVersion, adapterVersion, luaVersion, ranAt, durationMs, log, checks: { name, status, message }[],
                     evidence: { kind, path }[] }
```

`package` may be the `creator//name` identifier or the manifest resource name, as `scriptgo verify`
writes it. A resource name must designate one package; when several creators use it, the single
first-party package wins, otherwise the run is refused with `409 ambiguous_package`. Unknown
packages are `404 unknown_package`. Ingestion is idempotent on `runId`.

## Escrow (staff)

```
GET  /v1/admin/escrow/key-events?limit=&outcome=released|refused&reason=&license=   (staff)
                             → KeyEventRow[]   // every answer of POST /v1/licenses/key, newest first
POST /v1/admin/escrow/marker-lookup { marker, reason }                              (staff; 30/min)
                             → MarkerLookupResult   // audited as escrow.marker_lookup with the reason
```

```ts
KeyEventRow = { id, at, outcome: "released" | "refused", reason: string | null, packageRef, package: string | null,
                version, environment, licenseId, deploymentId, deploymentName, serverKeyFingerprint }
// marker: the bare token, the .scriptgo-escrow file a loader stamps into a decrypted copy, or an escrow.json
MarkerLookupResult = { kind: "delivery" | "release" | "unknown", marker,
                       release: { package, version } | null,
                       license: { id, status, holderUserId, holderName, holderEmail } | null,
                       deployment: { id, name, environment, status, serverKeyFingerprint } | null,
                       deliveries: { count, firstAt, lastAt, recent: Timestamp[] } }
```

A delivery marker names one license and one deployment; a release watermark names the release only.
The log and the lookup never hold or return a content key. Traceability, not prevention.

`deliveries.count`, `firstAt` and `lastAt` are computed over every release of the marker still in the
log; `recent` lists the 20 latest. The worker trims the log (ADR-0034): unmatched refusals after
`ESCROW_KEY_LOG_UNMATCHED_RETENTION_DAYS` (30), other refusals and repeated releases after
`ESCROW_KEY_LOG_RETENTION_DAYS` (400). The first and last release of a marker are never trimmed, so
`firstAt` and `lastAt` stay true while `count` covers what remains.

## Commerce readiness (Tebex)

What is configured and what is missing before a Tebex store can sell. Both routes compute their
answer from real state on each call: the server's settings, whether a sealed credential exists (never
its value), the offers, and the webhook deliveries the server recorded. Nothing is stored as "ready",
no secret is returned, and a `GET` changes nothing: checkout still opens only with
`COMMERCE_CHECKOUT_ENABLED=true` and an approved store (ADR-0007). The owner's checklist is
`docs/ops/TEBEX-GO-LIVE.md`. Schemas: `packages/shared/src/readiness.ts`.

```
GET /v1/creator/stores/:id/readiness   (creator, own store) → StoreReadiness
                                       404 not_found (not your store), 409 sandbox_store (a mock store)
GET /v1/admin/commerce/readiness       (admin) → CommerceReadiness
```

```ts
ReadinessCheck    = { id: string, label: string, status: "ok" | "missing" | "warning" | "blocked",
                      detail: string, fix: string | null }
ReadinessSummary  = { ready: boolean, remaining: string[] }
StoreReadiness    = { storeId, provider: "tebex", creator: string, webhookUrl: string, approved: boolean,
                      checks: ReadinessCheck[], summary: ReadinessSummary, generatedAt: Timestamp }
CommerceReadiness = { platform: { checks: ReadinessCheck[], summary: ReadinessSummary },
                      stores: StoreReadiness[], generatedAt: Timestamp }
```

`status`: `ok` configured or proven by a recorded event; `missing` the operator or the creator still
has to supply something; `warning` worth a look, does not block; `blocked` waits for a decision
outside configuration (the written approval, a review). `summary.ready` is true when no check is
`missing` or `blocked`; `summary.remaining` has one line per such check, in order. With every Tebex
value in place it is exactly `["Approval of this store by SCRIPT//GO staff", "Written approval from
Tebex, then COMMERCE_CHECKOUT_ENABLED=true"]`, then only the second line, then empty.

Store checks, in order (`id`): `store_connected`, `webhook_secret` (saved yes/no), `public_token`
(saved yes/no; needed to open a checkout basket), `webhook_url` (the URL to paste in Tebex; `missing`
when `PUBLIC_API_URL` is not a public https address), `webhook_delivery` (the last delivery recorded
for this store: accepted → `ok`, refused → `missing` with the reason; none recorded → `warning`,
because the validation webhook is answered but not recorded), `webhook_failures` (last 24 hours),
`product_mapping` (every active paid Tebex offer carries a provider product id; unmapped offers are
named), `offer_review` and `published_release` (only when the store has paid offers),
`store_approval`, `checkout_flag`.

Platform checks, in order: `public_api_url`, `ip_allowlist` (`TEBEX_ENFORCE_IP_ALLOWLIST`),
`trust_proxy` (a warning when the sender check is on and `TRUST_PROXY` is false), `mock_provider`,
`platform_webhook_secret` (`TEBEX_WEBHOOK_SECRET`, optional), `checkout_flag`
(`COMMERCE_CHECKOUT_ENABLED`; `blocked` until the written approval).
