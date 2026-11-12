# HTTP API contract (v1)

This document is the contract between `apps/api` and `apps/web` (and `packages/cli`). The API's
OpenAPI document (`GET /v1/openapi.json`, Swagger UI at `/docs`) is generated from the same zod
schemas exported by `packages/shared`. **When a shape changes, update `packages/shared` and this
file in the same change.**

- Base URL: `https://api.scriptgo.dev` in production, `http://localhost:4100` in dev. Every SDK
  default (CLI, hosts, the .NET kit) is production; `SCRIPTGO_API`, `--api` or the `scriptgo_api`
  setting point a client at another API. The web app proxies `/v1/*` and `/api/auth/*` to the
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
PlatformRules       = "no_restriction" | "restricts_paid" | "unsettled"
                    // what the platform's own rights holder says about paid scripts (ADR-0037): information
                    // for the operator who runs a script there, never a SCRIPT//GO rule; it gates nothing
AdapterState        = "verified" | "written" | "none"   // a real run passed | adapter code, no real run yet | no code yet
IntegrationType     = "cli" | "library" | "addon" | "mod" | "plugin" | "program" | "shim" | "kit"
CapabilitySupport   = "supported" | "partial" | "fallback" | "unavailable"
CompatibilityStatus = "verified" | "failing" | "stale" | "not_tested" | "unsupported"
ReleaseStatus       = "draft" | "validating" | "validation_failed" | "ready" | "published" | "deprecated" | "yanked"
Visibility          = "private" | "unlisted" | "public"
ListingStatus       = "active" | "restricted" | "suspended"
OfferInterval       = "free" | "month" | "year" | "perpetual"
Classification      = "free" | "software_license" | "seller_declared" | "authorized_app_feature"
                    | "undeclared" | "on_hold" | "rejected"   // see "Selling rules" below
LicenseStatus       = "active" | "grace" | "cancelled_active" | "expired" | "revoked" | "refunded"
LicenseSource       = "provider" | "admin" | "creator"   // a payment event | a staff grant | a free grant by the package's creator
GrantRecipientKind  = "account" | "server_key"
PerkInterval        = "month" | "perpetual"            // player perks (ADR-0038, docs/spec/perks.md)
PerkEventKind       = "granted" | "updated" | "removed"
ActivationStatus    = "pending" | "active" | "offline_grace" | "deactivated" | "blocked"
StoreStatus         = "not_connected" | "sandbox" | "checkout_off" | "live" | "needs_attention" | "suspended"
CaseStatus          = "received" | "under_review" | "action_taken" | "no_action" | "escalated" | "appeal_open" | "closed"
Category            = "inventory" | "permissions" | "economy" | "events" | "ui" | "admin" | "framework"
                    | "vehicles" | "housing" | "quests" | "library" | "other"
VerifyFailureReason = "expired" | "revoked" | "refunded" | "environment_not_covered" | "deployment_limit"
                    | "unknown_key" | "deactivated"
KeyReleaseFailureReason = VerifyFailureReason | "unbound" | "server_key_mismatch" | "not_escrowed"
ProtectionTier      = "escrow" | "license" | "none"   // what a server gets in an environment (ADR-0027); "none": the adapter has no licence check
ProtectionState     = "available" | "planned"
```

```ts
// On every Environment (list and detail). The tier follows what the adapter can do, never a selling
// rule: "none" means the adapter has no licence check, so a package runs there without one.
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
  platformRules: PlatformRules,       // the platform's own terms on paid scripts; never blocks or conditions a sale
  platformRulesNote: string,          // one factual sentence with its source; "" when there is nothing to report
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
LicenseSummary = { id, package: PackageSummary,
                   offer: Offer | null,           // null for a license granted by the creator: nothing was sold
                   origin: { source: LicenseSource,
                             grantedBy: string | null,              // creator grants: the creator's username
                             recipient: GrantRecipientKind | null },// creator grants: an account, or a server key
                   status: LicenseStatus,
                   currentPeriodEnd: string | null, deploymentsUsed: number, deploymentsAllowed: number }
LicenseDetail = LicenseSummary & {
  keyPreview: string,                 // "sg_live_…a91c"
  environments: string[],
  activations: { id, name, environment, adapterVersion, lastVerifiedAt, status: ActivationStatus, offlineGraceUntil }[],
  history: { at, event, source: "provider" | "user" | "admin" | "system" | "creator", reference }[],
                                      // "creator": the creator who granted the license (the grant, its revocation)
  keyRevealAvailable: boolean,        // POST .../reveal can still show the issued key
  seller: { creator: string, provider: "tebex" | "mock" | null },
  revokedReason: string | null,
  revokedBy: "creator" | "staff" | "provider" | null,   // the granting creator, staff, or a lost payment dispute
  graceUntil: string | null
}
```

A license granted by a creator (`origin.source = "creator"`, see *Creator grants* below) is an
ordinary license on every route of this section and of *Licensing*: the same key, reveal, rotation,
deployments, binding, key endpoint and offline grace. It has no offer and no payment provider
(`offer: null`, `seller.provider: null`). A grant to a server key is held by the creator who granted
it (`origin.recipient = "server_key"`).

The mock provider's checkout page is served by the API at `/v1/mock-provider/checkout/:checkoutId`
(only when COMMERCE_MOCK_PROVIDER_ENABLED, which the API refuses in production). Its buttons POST to
`/v1/mock-provider/checkout/:checkoutId/:action`, `action` one of `pay`, `pay_then_cancel`,
`cancel`, `refund`, `cancel_subscription`, `renew`; each builds the provider events, signs them
(`X-SG-Signature`) and delivers them to `/v1/webhooks/mock`, then answers 303 to
`${PUBLIC_WEB_URL}/checkout/:checkoutId` (`?cancelled=1` after *Cancel*). A paid license is only ever
issued by a verified webhook, never by the redirect: the web page polls
`GET /v1/checkout/:checkoutId`. The two other ways a license exists involve no payment and are both
audited: a staff grant (`POST /v1/admin/licenses/grant`) and a creator grant
(`POST /v1/creator/packages/:name/grants`).

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
                                                 (publishing puts the package's paid offers on the rights declaration of the new release:
                                                  they can be bought at once, with no review, whatever environments the release lists)
POST /v1/creator/releases/:id/deprecate { reason } → Release
POST /v1/creator/releases/:id/yank { reason }    → Release   (its download then answers 410)
POST /v1/creator/packages/:name/offers { name, interval, price, environments, deployments, providerProductId, provider? }
                                                 → 201 Offer   (provider defaults to the creator's Tebex store, else mock)
                                                 (no environment refuses a paid offer; the offer is `undeclared`, with no purchase path,
                                                  until a published release carries the creator's rights declaration)
DELETE /v1/creator/offers/:id                    → 204   (offer withdrawn; licenses already sold are unaffected)
GET  /v1/creator/stores                          → Store[]
POST /v1/creator/stores { provider: "mock" | "tebex", credentials }  → Store
POST /v1/creator/stores/:id/test-event           → { delivered: boolean, status: number }  (mock store only)
GET  /v1/creator/packages/:name/grants           → GrantList
POST /v1/creator/packages/:name/grants { to | serverKey, environments?, environment?, deploymentName?,
                                         deployments?, expiresInDays?, note? }
                                                 → 201 { grant: GrantRow, deploymentToken: string | null }
       400 (neither or both of to/serverKey; serverKey without environment; a malformed key)
       404 recipient_not_found   409 grant_blocked (details.reason) | package_private | already_granted
       422 grant_to_self | unknown_environment | environment_not_declared | environment_unprotected
       429 grant_limit
POST /v1/creator/grants/:id/revoke { reason }    → GrantRow   (404 for a license that was not granted by you)
GET  /v1/creator/customers                       → { license, customer: { username }, offer: Offer | null, source: LicenseSource }[]
                                                 (a grant to a server key is held by the creator: it is in GrantList, not here)
GET  /v1/creator/analytics?days=30&package=      → { downloads: Series, activations: Series, verifications: Series }
```

```ts
KeyActivity = { days, released, refused, refusalsByReason: Record<KeyReleaseFailureReason, number>,
                deployments,            // distinct deployments that received a key in the window
                lastReleasedAt, lastRefusedAt }
```

### Creator grants: protect without selling (ADR-0036)

A creator can issue a **free license** for one of their own packages. Nothing is sold: no offer, no
checkout, no store and no payment event exist behind it, and no payment provider is involved. It is
for a creator who wants a protected release to run on servers they chose (their own, a partner's, a
tester's) with the same binding, logging and revocation a sold license has.

```ts
// POST body. Exactly one of `to` and `serverKey`.
{ to?: string,             // the recipient's account id (GET /v1/me → user.id; shown in Dashboard → Settings and by
                           // `scriptgo login`), or a creator username. Never an e-mail address.
  serverKey?: string,      // the server's X25519 public key, base64url, 43 characters (`scriptgo escrow identity`)
  environments?: string[], // account grants: environments covered; default: what the latest release declares
  environment?: string,    // server-key grants: the environment of that server (required)
  deploymentName?: string, // server-key grants: default "server"
  deployments?: number,    // account grants: 1..100, default 1. A server-key grant is always 1
  expiresInDays?: number | null,   // 1..3650; null (default) = until revoked
  note?: string }          // the creator's own note, up to 200 characters; not shown to the holder

GrantRow  = { id,                      // the license id
              package: "creator//name", status: LicenseStatus, createdAt, expiresAt, revokedAt, revokedReason,
              recipient: { kind: GrantRecipientKind,
                           name,                       // account: the holder's display name; server_key: the deployment's name
                           serverKeyFingerprint },     // server_key: fingerprint of the bound key, else null
              environments: string[], deploymentsUsed, deploymentsAllowed, lastKeyReleaseAt, note }
GrantList = { grants: GrantRow[], canGrant: boolean, blockedCode: string | null, blockedReason: string | null,
              perDay: number, grantedToday: number }
```

- **To an account** (`to`). The account holds the license as a buyer would: it appears in
  `GET /v1/me/licenses`, the key is revealed once, deployments are added and bound on first use. The
  holder is told by e-mail (the message carries no key). An e-mail address is not accepted as `to`:
  the answer, or the list of grants, would tell the creator whether that address has an account. An
  account id is random and a creator username is public, so `404 recipient_not_found` reveals nothing.
- **To a server key** (`serverKey`). For an operator who has no account, or wants none. They run
  their loader's identity command on the server and send the creator the public key it prints. The
  license is then **held by the creator**; its single deployment is created by the grant, already
  bound to that key, and its **deployment token is returned once** in this answer (stored hashed,
  never listed again) for the creator to hand over. The operator downloads the bundle with
  `X-ScriptGo-Deployment-Token` and the loader asks `POST /v1/licenses/key` with it. The key endpoint
  is unchanged: the content key is wrapped to the bound key only, and a request that presents any
  other key is `server_key_mismatch`, so the token is useless on another machine. Moving the server
  takes the holder's audited reset (`POST /v1/me/licenses/:id/deployments/:activationId/reset-server-key`,
  by the creator here) like any deployment. A lost token is renewed by re-activating the same
  deployment name with the license key, which never swaps the bound key.
- **Who.** The package's own creator only (`404` for anyone else's package). Staff keep their own
  grant (`POST /v1/admin/licenses/grant`, which needs an offer) and can revoke any license.
- **Holds.** A grant needs no offer and depends on none. It is refused with `409 grant_blocked` and
  `details.reason` while staff action holds the package or nothing can be delivered:
  `listing_suspended`, `listing_restricted`, `sales_restricted`, `no_release` (no published release
  that is neither yanked nor restricted). Also `409 package_private` (nobody but the creator could
  download it). A license granted earlier follows the same staff action afterwards: the key endpoint
  does not release the key of a restricted or yanked release, and the download refuses a restricted
  listing. An environment's `platformRules` block nothing, a grant included; a server-key grant for
  an environment whose protection tier is `none` (its adapter has no licence check) is
  `422 environment_unprotected`.
- **Limits.** One live grant per account and package, and per server key and package
  (`409 already_granted`). `LICENSE_CREATOR_GRANTS_PER_PACKAGE_PER_DAY` (25) grants per package per
  rolling 24 hours, revoked ones included (`429 grant_limit`; 0 lifts the cap). The routes are
  rate-limited per IP like the other creator routes.
- **Revocation.** `POST /v1/creator/grants/:id/revoke` works on licenses this creator granted, never
  on one that was paid for. It is what a staff revoke is: `POST /v1/licenses/key` and
  `/v1/licenses/verify` answer `revoked` from the next request, the bundle is no longer delivered,
  and a running server stops when the offline grace of its last valid answer ends. Not reversible:
  grant again.
- **Audit.** `license.issued` with `source: "creator"`, the recipient kind, the holder and
  `payment: "none"`; `license.deployment_added` and `license.deployment_server_key_bound` for a
  server-key grant; `license.revoked` with `by: "creator"` and the reason. The deployment token and
  the license key are in no audit record.

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
Store = { id, provider, status: StoreStatus,
          suspended: boolean, suspendedReason: string | null,   // suspended by staff after a report (ADR-0037); no staff approval exists
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
POST /v1/licenses/key        { licenseKey | deploymentToken, package, version?, environment, adapterVersion, serverPublicKey?,
                               kind?: "code" | "assets" }
                             → 200 { valid, reason: KeyReleaseFailureReason | null, final: boolean,
                                     wrappedKey: {epk,nonce,wrapped} | null,
                                     aad, signerPublicKey, deliveryWatermark, offlineGraceUntil, expiresAt,
                                     keyId?, version? }
                               // kind "assets" (default "code"): the asset content key of an asset-escrowed
                               // release, for the token's deployment, wrapped with the server aad of
                               // docs/spec/assets.md "Asset escrow"; keyId names it. Same checks and order;
                               // not_escrowed when the release has no asset escrow. Logged with kind assets.
                               // final: true on revoked | refunded | expired | deactivated (the right to run is
                               // over: a loader stops at once); false otherwise (the offline grace applies).
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

Since ADR-0038 a provider event is about a license **or about a player's perk**: a checkout is for
an offer (an account buys a license) or for a perk (a player buys it, with no account), and the same
verification, deduplication, money check and state rules apply to both. A payment event row names
the one it touched (`licenseId` or `playerPerkId`).

## Player perks (ADR-0038)

An operator sells a perk to the players of their own servers, from their own store; a linked game
server asks SCRIPT//GO who has it. The protocol, with every request and answer, the purchase link
and the script API are in `docs/spec/perks.md`. The routes:

```
# The operator (session or PAT; requires a creator profile)
GET    /v1/creator/perks                       → Perk[]
POST   /v1/creator/perks                       CreatePerkBody → 201 Perk
POST   /v1/creator/perks/:id/declare           PerkRights → Perk
DELETE /v1/creator/perks/:id                   → 204 (no longer sold; holders keep it)
GET    /v1/creator/perk-holders[?perk=key]     → PerkHolder[]
GET    /v1/creator/server-links                → ServerLink[]
POST   /v1/creator/server-links                { name } → 201 { link: ServerLink, token }   (token shown once)
POST   /v1/creator/server-links/:id/revoke     → ServerLink

# The game server (Authorization: Bearer sg_srv_…; 401 unknown_server_link without a valid link)
POST   /v1/perks/check                         { player, environment?, adapterVersion? } → { player, perks: HeldPerk[], serverTime }
GET    /v1/perks/events[?after=seq][&limit=n]  → { events: PerkEvent[], cursor, more, serverTime }
POST   /v1/perks/events/ack                    { upTo } → { acked }
GET    /v1/perks/catalog                       → PerkCatalogEntry[]
POST   /v1/perks/purchase-link                 { player, perk } → 201 { url, expiresAt }

# The player who follows a purchase link (no account; the signed link is the authorisation)
GET    /v1/perks/purchase?token=…              → PerkPurchaseInfo        404 invalid_link, 410 link_expired
POST   /v1/perks/purchase/checkout             { token } → 201 { checkoutId, redirectUrl }   409 checkout_disabled
GET    /v1/perks/checkouts/:id                 → { checkoutId, status, perk, operator, player }

# Staff, after a report
GET    /v1/admin/perks[?operator=username]     → StaffPerk[]   (on hold or withdrawn; with operator: all of theirs)
POST   /v1/admin/perks/:id/decision            { decision: "on_hold" | "rejected" | "lift", reason, caseId? } → StaffPerk
```

```ts
Perk        = { id, key, name, description, interval: PerkInterval, price: Money, provider, providerProductId,
                classification: Classification, classificationReason, declared, active,
                purchasable, notPurchasableReason, holders, createdAt }
CreatePerkBody = { key, name, description?, interval, price: Money, provider?, providerProductId?,
                   rights?: { ownsCode, targetsProprietaryGame } }
ServerLink  = { id, name, tokenPreview, environment, adapterVersion, lastSeenAt, pendingEvents, revoked, createdAt }
PerkHolder  = { id, perkKey, perkName, player, status: LicenseStatus, has, currentPeriodEnd, cancelledAt, refundedAt,
                revokedReason, disputed, provider, paymentRef, subscriptionRef, serverLinkName, createdAt }
HeldPerk    = { key, status: LicenseStatus, expiresAt: Timestamp | null, offlineGraceUntil: Timestamp }
PerkEvent   = { seq, kind: PerkEventKind, perk, player, reason, status: LicenseStatus,
                expiresAt: Timestamp | null, offlineGraceUntil: Timestamp | null, at: Timestamp }
```

- **Keys and identifiers.** A perk key is `^[a-z0-9][a-z0-9_.-]{0,63}$`, unique per operator. A
  player is the identifier string of the host's `ScriptGo.players.identifier`: 1 to 128 printable
  ASCII characters, no spaces, opaque to SCRIPT//GO.
- **Selling rules.** A perk is purchasable when `offerCheckoutState` says so, exactly as an offer:
  the seller's declaration (`rights`, or `/declare`), no reviewer, no environment, no store
  approval; a hold by staff (`on_hold`, `rejected`) or a suspended store closes the purchase path
  (`409 not_purchasable` for a server asking for a link, `409 checkout_disabled` at checkout), with
  a notice and an appeal. Holders keep what they hold.
- **The server link token** is a secret like a deployment token: `sg_srv_…`, stored as a SHA-256
  hash, returned once at creation, revocable (not reversible). Limits: 600 requests a minute per
  token (60 for purchase links) on top of the per-address limits; `PERK_SERVER_LINKS_PER_OPERATOR`
  (50) live links per account.
- **Isolation.** Every server-facing answer is selected by the operator of the link the token
  designates; no route takes an operator as a parameter.
- **The purchase link** is a compact JWS (header `{ alg: "EdDSA", typ: "sg-perk-purchase-link+jws", kid }`)
  whose payload is `{ iss, typ: "perk-purchase", v: 1, op, perk, player, link, iat, exp }`. Its key is
  an ed25519 key of its own, derived from the server secret with HKDF-SHA256 for this purpose; the
  license-token key and the release key sign nothing else. `PERK_PURCHASE_LINK_TTL_SECONDS` (900).

## Selling rules (ADR-0037)

- **The seller decides.** SCRIPT//GO does not review an offer before sale. An offer's
  `classification` follows the creator's rights declaration for the newest published release:
  none yet → `undeclared` (no purchase path; `checkoutDisabledReason` tells the seller to declare,
  and no reviewer is involved); declared as their own, independent software → `software_license`;
  declared as their own code that targets a third-party game platform → `seller_declared` (sold on
  the seller's declaration). Both declared classes can be bought at once. Publishing a release
  computes it again. The seller answers for what they sell.
- **Staff act on reports.** Nothing enters a review queue by itself. After a report, staff can
  restrict a release, restrict a package's sales, suspend its listing or suspend the seller's store
  (decisions on the report), or put one offer on hold or withdraw it (`on_hold`, `rejected`). Each
  is audited, sends the creator a notice and can be appealed; a reversal on appeal undoes it.
  `GET /v1/admin/review/offers` lists the offers on hold; nothing enters it by itself
  (`?package=` shows one package's offers, so that staff can put one on hold).
- **No environment gates a sale.** A script is sold as a SCRIPT//GO script. The environments a
  package lists are places where it runs; `platformRules` reports each platform's own terms, for
  the operator who runs it there and answers to that platform's rights holder.
- **No store approval.** A store sells once its own configuration is complete.
  `COMMERCE_CHECKOUT_ENABLED` is the payment provider's switch for the whole platform, not a
  judgement on a seller. A suspended store (`Store.suspended`) has no purchase path, on any provider.
- **A hold closes the purchase path, not the licences already sold.** Restricted sales, a suspended
  listing or store, and an offer on hold stop new purchases (`POST /v1/checkout` answers
  `409 checkout_disabled` with the reason). They do not revoke a licence, and the key endpoint
  keeps releasing keys to existing holders, so a paying customer's server keeps running. What the
  key endpoint does refuse is a release that is restricted or yanked; a restricted listing also
  refuses downloads. Revoking a licence is a separate, explicit act.

## Admin

Moderation routes accept the `moderator` or `admin` role; routes marked *(admin)* need `admin`.

```
GET  /v1/admin/review/offers?status=on_hold|all&package=creator//name  → ReviewOffer[]
                                       (on_hold, the default: the offers staff put on hold after a report; nothing
                                        enters this list by itself. package: the offers of one package, any state)
POST /v1/admin/review/offers/:id/decision { classification: "on_hold" | "rejected" | "software_license" | "seller_declared"
                                            | "authorized_app_feature" | "free", reason, caseId? }      → ReviewOffer
                                       (on_hold, rejected: no purchase path; the creator gets a notice and can appeal;
                                        caseId names the report, 422 unknown_case. software_license, seller_declared:
                                        lift a hold, back on the seller's declaration. Audited)
GET  /v1/admin/review/releases?status=open|all         → ReviewRelease[]
POST /v1/admin/review/releases/:reviewId/decision { decision: "approve" | "restrict" | "reinstate", reason }
                                                       → ReviewRelease
GET  /v1/admin/reports?status                          → CaseSummary[]
GET  /v1/admin/reports/:id                             → CaseDetail   (:id = report id or case id RPT-YYYY-NNNNNN)
POST /v1/admin/reports/:id/review                      → CaseDetail   (moves it to under_review)
POST /v1/admin/reports/:id/decision    { action: "no_action" | "restrict_release" | "restrict_sales" | "suspend_listing"
                                                 | "suspend_store",
                                         reasons: string, escalate: boolean }  → CaseDetail
                                       (suspend_store: every store of the reported package's creator; 422 no_store when
                                        there is none to suspend. Like every decision but no_action: a notice, an appeal
                                        window, and a reversal on appeal undoes it)
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
POST /v1/admin/stores/:id/reinstate    (admin) { reason }                  → Store & { creator }
                                       (lifts a suspension without an appeal; audited, the seller is told;
                                        409 not_suspended. No route suspends or approves a store: a
                                        suspension is the `suspend_store` decision on a report)
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

## Assets (docs/spec/assets.md)

A release may carry client-delivered assets (maps, models, textures, sounds). Licensed,
fingerprinted, traceable: every download of a release with assets is a copy built for its licence
(and deployment), and nothing in these routes is a key. Schemas: `packages/shared/src/assets.ts`.

```
POST /v1/creator/packages/:name/releases   (multipart, unchanged) — a release whose manifest declares assets is
                                       streamed to storage (413 archive_too_large above the platform's cap, read from
                                       Content-Length first), inspected entry by entry (data only, sizes, delivery rules)
                                       and refused with every inspection error in its checks; a buyer's fingerprinted
                                       copy is refused (asset_fingerprinted). Release.assets carries the report.
POST /v1/creator/releases/:id/rights { ownsCode, targetsProprietaryGame, thirdPartyAssets, assetRights }
                                       assetRights: "original" | "game_edits" | "game_extracted"; publishing a release
                                       with assets needs it (a blocker, not a review).
GET  /v1/packages/:creator/:name/versions/:version/download
                                       for a release with assets: the caller's own copy. Licence holder (session or
                                       token), X-ScriptGo-Deployment-Token or X-ScriptGo-License-Key, otherwise 403
                                       license_required. The creator and staff get a copy fingerprinted to their own
                                       account; staff may ask ?variant=original (audited). Headers: X-Sha256 (the copy),
                                       X-ScriptGo-Artifact: plain, X-ScriptGo-Fingerprint: <marker>, the copy's signature
                                       (payload adds release: { sha256 } and fingerprint), Cache-Control: private, no-store.
POST /v1/creator/assets/lookup  { sha256 } | { record }   → AssetLookupResult   (own packages; account = null)
POST /v1/assets/reports         CreateAssetReportBody     → 201 AssetReportRow  (signed in; goodFaith and accuracy
                                       statements required; opens a compliance case)
GET  /v1/admin/assets/reports?status=open|actioned|rejected|all  (staff) → AssetReportRow[]
GET  /v1/admin/assets/reports/:id                         (staff) → AssetReportRow
POST /v1/admin/assets/lookup    { sha256 } | { record }   (staff) → AssetLookupResult   (audited)
POST /v1/admin/assets/reports/:id/resolve { deliveryId }  (staff) → AssetReportRow
POST /v1/admin/assets/reports/:id/action  AssetReportActionBody (staff) → AssetReportRow
                                       revoke_license / deactivate_deployment need a resolved copy (422 not_resolved);
                                       restrict_release decides the linked case (notice and appeal); takedown_notice
                                       records a notice a person sent to a third-party host; reject closes it.
```

Lookup by SHA-256 matches a whole copy or any container in it. Lookup by record checks its
signature against the platform's fingerprint signers and recomputes its marker; a record whose
signature or marker fails is reported as such and matches nothing. Every lookup and action is
audited.

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
no secret is returned, and a `GET` changes nothing: checkout through Tebex still opens only with
`COMMERCE_CHECKOUT_ENABLED=true` (ADR-0007). A store needs no staff approval (ADR-0037): every
check is one the server verifies by itself. The owner's checklist is
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
StoreReadiness    = { storeId, provider: "tebex", creator: string, webhookUrl: string, suspended: boolean,
                      checks: ReadinessCheck[], summary: ReadinessSummary, generatedAt: Timestamp }
CommerceReadiness = { platform: { checks: ReadinessCheck[], summary: ReadinessSummary },
                      stores: StoreReadiness[], generatedAt: Timestamp }
```

`status`: `ok` configured or proven by a recorded event; `missing` the operator or the creator still
has to supply something; `warning` worth a look, does not block; `blocked` waits for a decision
outside configuration (the payment provider's written approval, or a moderation decision that
holds an offer or the store). `summary.ready` is true when no check is `missing` or `blocked`;
`summary.remaining` has one line per such check, in order. With every Tebex value in place it is
exactly `["Written approval from Tebex, then COMMERCE_CHECKOUT_ENABLED=true"]`, then empty.

Store checks, in order (`id`): `store_connected`, `webhook_secret` (saved yes/no), `public_token`
(saved yes/no; needed to open a checkout basket), `webhook_url` (the URL to paste in Tebex; `missing`
when `PUBLIC_API_URL` is not a public https address), `webhook_delivery` (the last delivery recorded
for this store: accepted → `ok`, refused → `missing` with the reason; none recorded → `warning`,
because the validation webhook is answered but not recorded), `webhook_failures` (last 24 hours),
`product_mapping` (every active paid Tebex offer carries a provider product id; unmapped offers are
named), then, only when the store has paid offers, `rights_declared` (offers that are `undeclared`:
the seller's own step), `offer_holds` (offers staff put on hold or withdrew after a report) and
`published_release`; `store_suspended` (present only while staff have suspended the store);
`checkout_flag`.

Platform checks, in order: `public_api_url`, `ip_allowlist` (`TEBEX_ENFORCE_IP_ALLOWLIST`),
`trust_proxy` (a warning when the sender check is on and `TRUST_PROXY` is false), `mock_provider`,
`platform_webhook_secret` (`TEBEX_WEBHOOK_SECRET`, optional), `checkout_flag`
(`COMMERCE_CHECKOUT_ENABLED`; `blocked` until the written approval).
