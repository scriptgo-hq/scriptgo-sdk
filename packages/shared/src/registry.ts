import { z } from "zod";
import { Money, PageQuery, Timestamp, PackageName, Username } from "./common.ts";
import {
  CapabilitySupport,
  Category,
  CheckStage,
  CheckStatus,
  Classification,
  CompatibilityStatus,
  EnvironmentKind,
  EnvironmentSales,
  EnvironmentStatus,
  ListingStatus,
  OfferInterval,
  Provider,
  ReleaseStatus,
  Visibility,
} from "./enums.ts";
import { ParsedManifestSchema } from "./manifest.ts";

// ---------------------------------------------------------------- environments

export const LastRun = z.object({ status: CompatibilityStatus, ranAt: Timestamp, runId: z.string() });

export const Environment = z.object({
  slug: z.string(),
  name: z.string(),
  kind: EnvironmentKind,
  status: EnvironmentStatus,
  /** Whether the rights holder of the underlying game allows paid packages there. */
  sales: EnvironmentSales,
  salesNote: z.string(),
  luaDialects: z.array(z.string()),
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
});
export type RightsDeclaration = z.infer<typeof RightsDeclaration>;

export const PackageVersion = z.object({
  version: z.string(),
  status: ReleaseStatus,
  publishedAt: Timestamp.nullable(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
  changelog: z.string().nullable(),
  /** Moderation overlay: the release is visible with a notice but not downloadable. */
  restricted: z.boolean().default(false),
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

export const EnvironmentDetail = Environment.extend({
  setupMarkdown: z.string(),
  limitations: z.array(z.string()),
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
});
export type Release = z.infer<typeof Release>;

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
