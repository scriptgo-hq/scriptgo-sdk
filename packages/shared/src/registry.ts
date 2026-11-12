import { z } from "zod";
import { Money, PageQuery, Timestamp, PackageName, Username } from "./common.ts";
import { AssetEscrowInfo, AssetRightsCase, ReleaseAssetsInfo } from "./assets.ts";
import {
  AdapterState,
  CapabilitySupport,
  Category,
  CheckStage,
  CheckStatus,
  Classification,
  CompatibilityStatus,
  EnvironmentKind,
  PlatformRules,
  EnvironmentStatus,
  IntegrationType,
  ListingStatus,
  ProtectionState,
  ProtectionTier,
  OfferInterval,
  Provider,
  ReleaseStatus,
  Visibility,
} from "./enums.ts";
import { ParsedManifestSchema } from "./manifest.ts";

// ---------------------------------------------------------------- environments

export const LastRun = z.object({ status: CompatibilityStatus, ranAt: Timestamp, runId: z.string() });

/** What a buyer's server gets in one environment: the tier, whether it works today, one honest sentence. */
export const EnvironmentProtection = z.object({
  tier: ProtectionTier,
  state: ProtectionState,
  /** The tier is a feature the server operator switches on (default off), not a property of every server. */
  optIn: z.boolean().default(false),
  note: z.string(),
});
export type EnvironmentProtection = z.infer<typeof EnvironmentProtection>;

/**
 * How client-delivered assets reach players in one environment (docs/spec/assets.md, ASSET_RULES of
 * @scriptgo/manifest). `generic`/`native`: what `assets` and `environment_asset` become there, null
 * when the environment cannot take them. `escrow`: the client work asset escrow would need there.
 */
export const EnvironmentAssets = z.object({
  support: z.enum(["supported", "partial", "bundled", "unsupported"]),
  generic: z.string().nullable(),
  native: z.string().nullable(),
  packTarget: z.string().nullable(),
  note: z.string(),
  escrow: z.string(),
});
export type EnvironmentAssets = z.infer<typeof EnvironmentAssets>;

export const Environment = z.object({
  slug: z.string(),
  name: z.string(),
  kind: EnvironmentKind,
  status: EnvironmentStatus,
  /**
   * The platform's own terms on paid scripts, for the operator who runs a script there and answers
   * for it (ADR-0037). Information only: it never blocks or conditions a sale on SCRIPT//GO.
   */
  platformRules: PlatformRules,
  /** One factual sentence with its source; "" when there is nothing to report. */
  platformRulesNote: z.string(),
  /** Protection tier (ADR-0027). Never weaker or stronger than what the adapter really does. */
  protection: EnvironmentProtection.default({ tier: "none", state: "available", optIn: false, note: "" }),
  /** Asset delivery (docs/spec/assets.md). Optional until the API serves it. */
  assets: EnvironmentAssets.optional(),
  luaDialects: z.array(z.string()),
  /** Guest languages the environment's host runs ("lua", "ts", "js"). */
  languages: z.array(z.string()).default(["lua"]),
  /** Resource sides the host runs: ["server"], or ["server", "client"]. */
  sides: z.array(z.string()).default([]),
  /** Whether adapter code exists and a real run passed (read from the repository, ADR-0022). */
  adapterState: AdapterState.default("none"),
  /** For a written adapter with no real run yet: what that run waits for. "" otherwise. */
  blockedOn: z.string().default(""),
  runtimeVersions: z.array(z.string()),
  adapterVersion: z.string(),
  summary: z.string(),
  capabilities: z.record(z.string(), CapabilitySupport),
  /** Optional per-capability notes ("ui prints to the log"). */
  capabilityNotes: z.record(z.string(), z.string()).default({}),
  verifiedPackages: z.number().int().nonnegative(),
  lastRun: LastRun.nullable(),
});
export type Environment = z.infer<typeof Environment>;

// ---------------------------------------------------------------- packages

export const CreatorRef = z.object({ username: z.string(), displayName: z.string(), firstParty: z.boolean() });
export type CreatorRef = z.infer<typeof CreatorRef>;

export const Pricing = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("free") }),
  z.object({ kind: z.literal("paid"), from: Money, interval: OfferInterval, checkoutEnabled: z.boolean() }),
]);
export type Pricing = z.infer<typeof Pricing>;

export const PackageSummary = z.object({
  id: z.string(),
  identifier: z.string(),
  creator: CreatorRef,
  name: z.string(),
  resourceName: z.string(),
  title: z.string(),
  summary: z.string(),
  category: Category,
  latestVersion: z.string().nullable(),
  license: z.string(),
  environments: z.array(z.object({ slug: z.string(), status: CompatibilityStatus })),
  capabilities: z.array(z.string()),
  pricing: Pricing,
  downloads: z.number().int().nonnegative(),
  updatedAt: Timestamp,
  listingStatus: ListingStatus,
  /** Only for the owner's own listings (GET /v1/creator/packages); null in public responses. */
  visibility: Visibility.nullable().default(null),
  /** True for the flagged development demo data (never shown as real activity). */
  isDemo: z.boolean().default(false),
});
export type PackageSummary = z.infer<typeof PackageSummary>;

export const Offer = z.object({
  id: z.string(),
  packageId: z.string(),
  name: z.string(),
  interval: OfferInterval,
  price: Money.nullable(),
  classification: Classification,
  environments: z.array(z.string()),
  deployments: z.number().int().nonnegative(),
  provider: Provider.nullable(),
  checkoutEnabled: z.boolean(),
  checkoutDisabledReason: z.string().nullable(),
});
export type Offer = z.infer<typeof Offer>;

export const ThirdPartyAsset = z.object({
  path: z.string().min(1).max(512),
  source: z.string().min(1).max(1024),
  license: z.string().min(1).max(128),
});
export type ThirdPartyAsset = z.infer<typeof ThirdPartyAsset>;

export const RightsDeclaration = z.object({
  declaredAt: Timestamp,
  ownsCode: z.boolean(),
  targetsProprietaryGame: z.boolean(),
  thirdPartyAssets: z.array(ThirdPartyAsset),
  dependencies: z.array(z.object({ name: z.string(), license: z.string() })),
  /** The seller's statement for a release with assets (AssetRightsCase), null otherwise. */
  assetRights: AssetRightsCase.nullable().default(null),
});
export type RightsDeclaration = z.infer<typeof RightsDeclaration>;

/**
 * The registry's ed25519 signature on a published release (ADR-0028). `payload` is the canonical
 * JSON that was signed: { v, package, version, sha256, size, escrow, publishedAt }. Verify it with a
 * key from GET /v1/signing-keys, then compare payload.sha256 with the bytes you downloaded.
 */
export const ReleaseSignature = z.object({ alg: z.literal("ed25519"), keyId: z.string(), payload: z.string(), signature: z.string() });
export type ReleaseSignature = z.infer<typeof ReleaseSignature>;

/**
 * Public facts about a release's encrypted (escrow) variant. Nothing here is secret: it is what the
 * bundle's clear `escrow.json` says, plus whether the master holds the sealed content key. The key
 * itself is never in any response other than POST /v1/licenses/key, wrapped to one bound server.
 */
export const ReleaseEscrowInfo = z.object({
  format: z.string(),
  cipher: z.string(),
  kdf: z.string(),
  /** Release identity bound into the ciphertext and every wrapped key. */
  aad: z.string(),
  /** ed25519 public key (raw base64url) that signed escrow.json, and its short fingerprint. */
  signerPublicKey: z.string(),
  signerKeyId: z.string(),
  /** master: a per-creator key the master holds sealed; creator: a key the creator holds (CLI). */
  signerOrigin: z.enum(["master", "creator"]).nullable(),
  /** Globs left in clear text (manifest, docs, creator-named config), FiveM `escrow_ignore` style. */
  allowlist: z.array(z.string()),
  clearFiles: z.array(z.string()),
  encryptedFiles: z.array(z.string()),
  /** A release-level watermark is baked into the signed manifest (traceability, not prevention). */
  watermarked: z.boolean(),
  /** Who built the bundle: the creator's CLI, or the master from an uploaded archive. */
  builtBy: z.enum(["cli", "server"]),
  /** The master holds this release's content key, sealed at rest. */
  sealedKeyPresent: z.boolean(),
});
export type ReleaseEscrowInfo = z.infer<typeof ReleaseEscrowInfo>;

/**
 * Client code escrow of a release (client-escrow.md; ADR-0046 in scriptgo-api): its OPEN//77 client
 * scripts ship in each copy as stripped Lua bytecode, sealed per deployment, never as source. Public
 * metadata: never a key, never the line map. Bytecode can still be decompiled to working logic
 * (local names and comments are lost): deterrence and traceability, not secrecy.
 */
export const ReleaseClientEscrowInfo = z.object({
  format: z.literal("scriptgo-client-escrow/1"),
  environment: z.literal("open77"),
  /** full: no local names and no line numbers; names: no local names, real line numbers kept. */
  strip: z.enum(["full", "names"]),
  /** Client scripts each copy carries as bytecode (resource-relative paths). */
  scripts: z.array(z.string()),
  /**
   * Where the source line numbers are. creator_only (strip full): in the line map the platform
   * keeps and serves to the creator only (GET /v1/creator/releases/:id/client-lines), never in a
   * copy. in_bytecode (strip names): left in the bytecode.
   */
  lineNumbers: z.enum(["creator_only", "in_bytecode"]),
});
export type ReleaseClientEscrowInfo = z.infer<typeof ReleaseClientEscrowInfo>;

/**
 * What a release protects, in one place (SDK 0.1.12; additive). Each kind is independent:
 * serverCode is code escrow (escrow.md; details in `escrow`), clientCode is client code escrow,
 * assets is asset escrow (the same value as `assets.escrow`). perBuyerCopies: every download is a
 * copy built and fingerprinted for one licence (a release with assets or with client code escrow).
 * A response from an older API has no `protection`: read it as `escrow !== null` for serverCode and
 * `assets?.escrow ?? null` for assets.
 */
export const ReleaseProtection = z.object({
  serverCode: z.boolean(),
  clientCode: ReleaseClientEscrowInfo.nullable(),
  assets: AssetEscrowInfo.nullable(),
  perBuyerCopies: z.boolean(),
});
export type ReleaseProtection = z.infer<typeof ReleaseProtection>;

const NO_PROTECTION: ReleaseProtection = { serverCode: false, clientCode: null, assets: null, perBuyerCopies: false };

export const PackageVersion = z.object({
  version: z.string(),
  status: ReleaseStatus,
  publishedAt: Timestamp.nullable(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
  changelog: z.string().nullable(),
  /** Moderation overlay: the release is visible with a notice but not downloadable. */
  restricted: z.boolean().default(false),
  /** Set when the release is delivered as an encrypted bundle (sha256/size then describe the bundle). */
  escrow: ReleaseEscrowInfo.nullable().default(null),
  /** The registry's signature on this release; null only for releases published before signing. */
  signature: ReleaseSignature.nullable().default(null),
  /** Client-delivered assets of the release (docs/spec/assets.md); null when it carries none. */
  assets: ReleaseAssetsInfo.nullable().default(null),
  /** What the release protects: server code, client code, assets (ReleaseProtection). */
  protection: ReleaseProtection.default(NO_PROTECTION),
});
export type PackageVersion = z.infer<typeof PackageVersion>;

export const CompatibilityEntry = z.object({
  environment: z.string(),
  status: CompatibilityStatus,
  version: z.string(),
  runtimeVersion: z.string().nullable(),
  adapterVersion: z.string().nullable(),
  ranAt: Timestamp.nullable(),
  runId: z.string().nullable(),
  log: z.string().nullable(),
  evidence: z.array(z.object({ kind: z.enum(["screenshot", "log"]), url: z.string() })),
  missingCapability: z.string().nullable(),
});
export type CompatibilityEntry = z.infer<typeof CompatibilityEntry>;

export const PackageDetail = PackageSummary.extend({
  description: z.string(),
  readme: z.string(),
  repository: z.string().nullable(),
  manifest: ParsedManifestSchema.nullable(),
  versions: z.array(PackageVersion),
  compatibility: z.array(CompatibilityEntry),
  offers: z.array(Offer),
  rights: RightsDeclaration.nullable(),
  seller: z.object({ creator: z.string(), provider: Provider.nullable() }),
  /** Release the detail describes (latest published unless ?version= was given). */
  viewingVersion: z.string().nullable(),
});
export type PackageDetail = z.infer<typeof PackageDetail>;

export const PackageSearchQuery = PageQuery.extend({
  q: z.string().max(200).optional(),
  environment: z.string().max(64).optional(),
  capability: z.string().max(64).optional(),
  category: Category.optional(),
  pricing: z.enum(["free", "paid"]).optional(),
  sort: z.enum(["updated", "downloads", "name"]).default("updated"),
  verifiedOnly: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});
export type PackageSearchQuery = z.infer<typeof PackageSearchQuery>;

/** How an environment runs packages (ADR-0022). */
export const EnvironmentIntegration = z.object({
  type: IntegrationType,
  /** The host and its Lua: "BeamMP-Server 3.9.3 (Lua 5.3)". */
  runtime: z.string(),
  summary: z.string(),
});
export type EnvironmentIntegration = z.infer<typeof EnvironmentIntegration>;

/** One verified run from verification/reports: the newest version of a package, per runtime. */
export const ProofRun = z.object({
  package: z.string(),
  version: z.string(),
  runtime: z.string(),
  lua: z.string(),
  adapterVersion: z.string(),
  checksPassed: z.number().int().nonnegative(),
  checks: z.number().int().nonnegative(),
  ranAt: Timestamp,
});
export type ProofRun = z.infer<typeof ProofRun>;

export const EnvironmentDetail = Environment.extend({
  setupMarkdown: z.string(),
  limitations: z.array(z.string()),
  /** null for a planned environment with no adapter code yet. */
  integration: EnvironmentIntegration.nullable(),
  /** What real runs proved here; empty until one passes. */
  proof: z.array(ProofRun),
  packages: z.array(PackageSummary),
});
export type EnvironmentDetail = z.infer<typeof EnvironmentDetail>;

export const CreatorProfile = z.object({
  username: z.string(),
  displayName: z.string(),
  bio: z.string(),
  links: z.array(z.string()),
  joinedAt: Timestamp,
  firstParty: z.boolean(),
  packages: z.array(PackageSummary),
});
export type CreatorProfile = z.infer<typeof CreatorProfile>;

export const Stats = z.object({
  packages: z.number().int().nonnegative(),
  creators: z.number().int().nonnegative(),
  environmentsVerified: z.number().int().nonnegative(),
});
export type Stats = z.infer<typeof Stats>;

export const Health = z.object({
  ok: z.literal(true),
  version: z.string(),
  /** Whether the platform delivers e-mail (SMTP configured). The site words its promises on it. */
  mail: z.boolean(),
});

// ---------------------------------------------------------------- creator: packages and releases

export const ReleaseCheck = z.object({
  stage: CheckStage,
  name: z.string(),
  status: CheckStatus,
  required: z.boolean(),
  durationMs: z.number().int().nonnegative().nullable(),
  message: z.string().nullable(),
  log: z.string().nullable(),
});
export type ReleaseCheck = z.infer<typeof ReleaseCheck>;

export const Release = z.object({
  id: z.string(),
  packageName: z.string(),
  version: z.string(),
  status: ReleaseStatus,
  createdAt: Timestamp,
  publishedAt: Timestamp.nullable(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
  checks: z.array(ReleaseCheck),
  blockers: z.array(z.string()),
  manifest: ParsedManifestSchema.nullable(),
  files: z.array(z.object({ path: z.string(), sha256: z.string(), size: z.number().int().nonnegative() })),
  rights: RightsDeclaration.nullable(),
  restricted: z.boolean(),
  escrow: ReleaseEscrowInfo.nullable().default(null),
  signature: ReleaseSignature.nullable().default(null),
  /** Client-delivered assets of the release (docs/spec/assets.md); null when it carries none. */
  assets: ReleaseAssetsInfo.nullable().default(null),
  /** What the release protects: server code, client code, assets (ReleaseProtection). */
  protection: ReleaseProtection.default(NO_PROTECTION),
});
export type Release = z.infer<typeof Release>;

/** Public signing keys. Release signing is a different key from the licence-token signer. */
export const SigningKey = z.object({ keyId: z.string(), alg: z.literal("ed25519"), publicKey: z.string(), status: z.enum(["current", "retired"]) });
export type SigningKey = z.infer<typeof SigningKey>;
export const SigningKeys = z.object({ keys: z.array(SigningKey) });
export type SigningKeys = z.infer<typeof SigningKeys>;

/** A creator's escrow-manifest signing keys (public halves only). */
export const CreatorSigningKey = z.object({
  keyId: z.string(),
  alg: z.literal("ed25519"),
  publicKey: z.string(),
  origin: z.enum(["master", "creator"]),
  createdAt: Timestamp,
  retiredAt: Timestamp.nullable(),
});
export type CreatorSigningKey = z.infer<typeof CreatorSigningKey>;
export const CreatorSigningKeys = z.object({ keys: z.array(CreatorSigningKey) });
export type CreatorSigningKeys = z.infer<typeof CreatorSigningKeys>;

/** Key-release activity of one package: real counts from the key endpoint's log, nothing estimated. */
export const KeyActivity = z.object({
  days: z.number().int().positive(),
  released: z.number().int().nonnegative(),
  refused: z.number().int().nonnegative(),
  refusalsByReason: z.record(z.string(), z.number().int().nonnegative()),
  /** Distinct deployments that received a key in the window. */
  deployments: z.number().int().nonnegative(),
  lastReleasedAt: Timestamp.nullable(),
  lastRefusedAt: Timestamp.nullable(),
});
export type KeyActivity = z.infer<typeof KeyActivity>;

export const CreateCreatorProfileBody = z.object({
  username: Username,
  displayName: z.string().trim().min(1).max(80),
  bio: z.string().max(2000).default(""),
  links: z.array(z.string().url().max(500)).max(8).default([]),
});
export type CreateCreatorProfileBody = z.infer<typeof CreateCreatorProfileBody>;

export const CreatePackageBody = z.object({
  name: PackageName,
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().max(300).default(""),
  category: Category.default("other"),
  license: z.string().trim().min(1).max(128),
  visibility: Visibility.default("public"),
  repository: z.string().url().max(500).nullable().default(null),
});
export type CreatePackageBody = z.infer<typeof CreatePackageBody>;

export const UpdatePackageBody = CreatePackageBody.omit({ name: true }).partial();
export type UpdatePackageBody = z.infer<typeof UpdatePackageBody>;

export const CreatorPackageDetail = PackageSummary.extend({
  description: z.string(),
  repository: z.string().nullable(),
  releases: z.array(Release),
  offers: z.array(Offer),
});
export type CreatorPackageDetail = z.infer<typeof CreatorPackageDetail>;

export const RightsBody = z.object({
  ownsCode: z.boolean(),
  targetsProprietaryGame: z.boolean(),
  thirdPartyAssets: z.array(ThirdPartyAsset).max(500).default([]),
  /** For a release with assets: which case applies (required to publish one; ignored otherwise). */
  assetRights: AssetRightsCase.nullable().default(null),
});
export type RightsBody = z.infer<typeof RightsBody>;

export const CreateOfferBody = z.object({
  name: z.string().trim().min(1).max(80),
  interval: OfferInterval,
  price: Money.nullable().default(null),
  environments: z.array(z.string().min(1).max(64)).max(32).default([]),
  deployments: z.number().int().min(0).max(10_000).default(1),
  providerProductId: z.string().trim().min(1).max(128).nullable().default(null),
});
export type CreateOfferBody = z.infer<typeof CreateOfferBody>;

export const CompatibilityRunSchema = z.object({
  runId: z.string().min(1).max(128),
  package: z.string().min(3).max(200),
  version: z.string().min(1).max(64),
  environment: z.string().min(1).max(64),
  status: z.enum(["verified", "failing"]),
  runtimeVersion: z.string().max(128).nullable().optional(),
  adapterVersion: z.string().max(128).nullable().optional(),
  luaVersion: z.string().max(128).nullable().optional(),
  ranAt: Timestamp,
  durationMs: z.number().int().nonnegative().nullable().optional(),
  log: z.string().max(2_000_000).nullable().optional(),
  checks: z.array(z.object({ name: z.string(), status: z.string(), message: z.string().nullable().optional() })).default([]),
  evidence: z.array(z.object({ kind: z.string(), path: z.string() })).default([]),
});
export type CompatibilityRun = z.infer<typeof CompatibilityRunSchema>;
