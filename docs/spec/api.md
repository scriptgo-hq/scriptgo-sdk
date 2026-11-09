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
```

## Public

```
GET  /v1/health                                  → { ok: true, version }
GET  /v1/environments                            → Environment[]
GET  /v1/environments/:slug                      → EnvironmentDetail
GET  /v1/packages?q&environment&capability&category&pricing=free|paid&sort=updated|downloads|name&page&pageSize
                                                 → Page<PackageSummary>
GET  /v1/packages/:creator/:name                 → PackageDetail
GET  /v1/packages/:creator/:name/versions/:version/download   → zip stream, header X-Sha256
GET  /v1/creators/:username                      → CreatorProfile
POST /v1/reports  (multipart: fields + evidence[]) → { caseId: "RPT-2026-000123", status: "received" }
GET  /v1/stats                                   → { packages, creators, environmentsVerified }  (real counts only)
```

```ts
Environment = {
  slug: "standalone" | "love2d" | "godot" | "luanti" | "open77" | string,
  name: string,                       // "LÖVE"
  status: EnvironmentStatus,
  luaDialects: ("5.1" | "5.4" | "luajit")[],
  runtimeVersions: string[],          // ["11.5"]
  adapterVersion: string,
  summary: string,
  capabilities: Record<Capability, CapabilitySupport>,
  verifiedPackages: number,
  lastRun: { status: CompatibilityStatus, ranAt: string, runId: string } | null
}
EnvironmentDetail = Environment & { setupMarkdown: string, limitations: string[], packages: PackageSummary[] }

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
POST /v1/me/tokens                               → { token: "sg_pat_..." } (shown once)
GET  /v1/me/library                              → PackageSummary[]
GET  /v1/me/licenses                             → LicenseSummary[]
GET  /v1/me/licenses/:id                         → LicenseDetail
POST /v1/me/licenses/:id/rotate                  → { key }                (shown once)
POST /v1/me/licenses/:id/deployments  { name, environment }  → { activation, deploymentToken }
DELETE /v1/me/licenses/:id/deployments/:activationId
GET  /v1/me/notices                              → Notice[]
POST /v1/me/notices/:id/appeal { statement }     → Notice
POST /v1/checkout { offerId }                    → { checkoutId, redirectUrl }
GET  /v1/checkout/:checkoutId                    → { status: "pending" | "completed" | "failed" | "expired", licenseId | null }
```

```ts
LicenseSummary = { id, package: PackageSummary, offer: Offer, status: LicenseStatus,
                   currentPeriodEnd: string | null, deploymentsUsed: number, deploymentsAllowed: number }
LicenseDetail = LicenseSummary & {
  keyPreview: string,                 // "sg_live_…a91c"
  environments: string[],
  activations: { id, name, environment, adapterVersion, lastVerifiedAt, status: ActivationStatus, offlineGraceUntil }[],
  history: { at, event, source: "provider" | "user" | "admin" | "system", reference }[]
}
```

The mock provider's checkout page is served by the API at `/v1/mock-provider/checkout/:checkoutId`
with *Pay* and *Cancel* buttons that deliver **signed webhooks** to `/v1/webhooks/mock`. Licenses
are only ever granted by a verified webhook or an audited admin grant, never by the redirect.

## Creator (session or PAT; requires a creator profile)

```
POST /v1/creator/profile { username, displayName, bio }
GET  /v1/creator/packages                        → PackageSummary[] (incl. private/draft)
POST /v1/creator/packages { name, title, summary, category, license, visibility, repository }
PATCH /v1/creator/packages/:name
POST /v1/creator/packages/:name/releases  (multipart: archive=zip)  → Release (status "validating")
GET  /v1/creator/releases/:id                    → Release with validation report
POST /v1/creator/releases/:id/rights { ownsCode, targetsProprietaryGame, thirdPartyAssets[] }
POST /v1/creator/releases/:id/publish            → Release (409 if blocked, with reasons)
POST /v1/creator/packages/:name/offers { name, interval, price, environments, deployments, providerProductId }
GET  /v1/creator/stores                          → Store[]
POST /v1/creator/stores { provider: "mock" | "tebex", credentials }  → Store
POST /v1/creator/stores/:id/test-event           → { delivered: boolean }  (sandbox only)
GET  /v1/creator/customers                       → { license, customer: { username }, offer }[]
GET  /v1/creator/analytics                       → { downloads: Series, activations: Series, verifications: Series }
```

```ts
Release = { id, packageName, version, status: ReleaseStatus, createdAt, sha256, size,
            checks: { stage: "archive" | "manifest" | "integrity" | "static" | "unit" | "environment" | "rights",
                      name: string, status: "pending" | "running" | "passed" | "failed" | "skipped",
                      required: boolean, durationMs: number | null, message: string | null, log: string | null }[],
            blockers: string[] }
Store = { id, provider, status: StoreStatus, checkoutEnabled: boolean, checkoutDisabledReason: string | null,
          webhook: { lastEventAt, deliveries24h, failures24h }, products: { providerProductId, offerId, syncStatus }[] }
```

## Licensing (called by deployments)

```
POST /v1/licenses/activate   { licenseKey, package, environment, deploymentName, adapterVersion }
                             → { activationId, deploymentToken }
POST /v1/licenses/verify     { licenseKey | deploymentToken, package, environment, adapterVersion }
                             → { valid, status: LicenseStatus, activationStatus, expiresAt, offlineGraceUntil,
                                 environments: string[], token: string }   // ed25519-signed, short-lived
POST /v1/licenses/deactivate { licenseKey, activationId }  → { ok: true }
GET  /v1/licenses/:id        (owner session only)          → LicenseDetail
GET  /v1/licenses/public-key                               → { alg: "ed25519", publicKey }
```

`verify` is rate-limited per key and per IP, never reveals another customer's data, and answers
`valid: false` with a `reason` (`expired`, `revoked`, `environment_not_covered`,
`deployment_limit`, `unknown_key`).

## Webhooks

```
POST /v1/webhooks/tebex   raw body, header X-Signature (verified per Tebex docs), idempotent on event id
POST /v1/webhooks/mock    raw body, header X-SG-Signature (HMAC-SHA256), idempotent on event id
```

## Admin (role `admin` or `moderator`)

```
GET  /v1/admin/review/offers           POST /v1/admin/review/offers/:id/decision { classification, reason }
GET  /v1/admin/review/releases         POST /v1/admin/review/releases/:id/decision
GET  /v1/admin/reports                 GET /v1/admin/reports/:id
POST /v1/admin/reports/:id/decision    { action: "no_action" | "restrict_release" | "restrict_sales" | "suspend_listing",
                                         reasons: string, escalate: boolean }
GET  /v1/admin/audit?subject&actor     GET /v1/admin/payment-events      GET /v1/admin/errors
POST /v1/admin/compatibility-runs      (CI ingest token) CompatibilityRun
POST /v1/admin/licenses/grant          { userId, offerId, reason }   (audited administrative grant)
```

`CompatibilityRun` is the JSON written by `scriptgo verify` into `verification/reports/*.json`:

```ts
CompatibilityRun = { runId, package: "scriptgo//event-bus", version, environment, status: "verified" | "failing",
                     runtimeVersion, adapterVersion, luaVersion, ranAt, durationMs, log, checks: { name, status, message }[],
                     evidence: { kind, path }[] }
```
