import { z } from "zod";
import { Timestamp } from "./common.ts";
import {
  ActivationStatus,
  AppealStatus,
  CheckoutStatus,
  HistorySource,
  LicenseStatus,
  ModerationActionKind,
  Provider,
  Role,
  StoreStatus,
  VerifyFailureReason,
} from "./enums.ts";
import { Offer, PackageSummary } from "./registry.ts";

// ---------------------------------------------------------------- me

export const MeUser = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  image: z.string().nullable(),
  emailVerified: z.boolean(),
  createdAt: Timestamp,
});
export const MeCreatorProfile = z.object({
  username: z.string(),
  displayName: z.string(),
  bio: z.string(),
  links: z.array(z.string()),
  firstParty: z.boolean(),
  joinedAt: Timestamp,
});
export const Me = z.object({ user: MeUser, creatorProfile: MeCreatorProfile.nullable(), roles: z.array(Role) });
export type Me = z.infer<typeof Me>;

export const CreateTokenBody = z.object({
  name: z.string().trim().min(1).max(80).default("cli"),
  expiresInDays: z.number().int().min(1).max(365).nullable().default(90),
});
export type CreateTokenBody = z.infer<typeof CreateTokenBody>;
export const CreatedToken = z.object({ id: z.string(), token: z.string(), name: z.string(), expiresAt: Timestamp.nullable() });
export type CreatedToken = z.infer<typeof CreatedToken>;
export const TokenSummary = z.object({
  id: z.string(),
  name: z.string(),
  preview: z.string(),
  createdAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
  expiresAt: Timestamp.nullable(),
});
export type TokenSummary = z.infer<typeof TokenSummary>;

// ---------------------------------------------------------------- licenses

export const LicenseSummary = z.object({
  id: z.string(),
  package: PackageSummary,
  offer: Offer,
  status: LicenseStatus,
  currentPeriodEnd: Timestamp.nullable(),
  deploymentsUsed: z.number().int().nonnegative(),
  deploymentsAllowed: z.number().int().nonnegative(),
});
export type LicenseSummary = z.infer<typeof LicenseSummary>;

export const Activation = z.object({
  id: z.string(),
  name: z.string(),
  environment: z.string(),
  adapterVersion: z.string().nullable(),
  lastVerifiedAt: Timestamp.nullable(),
  status: ActivationStatus,
  offlineGraceUntil: Timestamp.nullable(),
});
export type Activation = z.infer<typeof Activation>;

export const LicenseHistoryEntry = z.object({
  at: Timestamp,
  event: z.string(),
  source: HistorySource,
  reference: z.string().nullable(),
});
export type LicenseHistoryEntry = z.infer<typeof LicenseHistoryEntry>;

export const LicenseDetail = LicenseSummary.extend({
  keyPreview: z.string(),
  /** The newly issued key can be shown once with POST /v1/me/licenses/:id/reveal. */
  keyRevealAvailable: z.boolean(),
  environments: z.array(z.string()),
  activations: z.array(Activation),
  history: z.array(LicenseHistoryEntry),
  seller: z.object({ creator: z.string(), provider: Provider.nullable() }),
  revokedReason: z.string().nullable(),
  graceUntil: Timestamp.nullable(),
});
export type LicenseDetail = z.infer<typeof LicenseDetail>;

export const RotatedKey = z.object({ key: z.string() });
export const AddDeploymentBody = z.object({
  name: z.string().trim().min(1).max(64),
  environment: z.string().min(1).max(64),
});
export type AddDeploymentBody = z.infer<typeof AddDeploymentBody>;
export const AddDeploymentResult = z.object({ activation: Activation, deploymentToken: z.string() });
export type AddDeploymentResult = z.infer<typeof AddDeploymentResult>;

// ---------------------------------------------------------------- checkout

export const CheckoutBody = z.object({ offerId: z.string().min(1) });
export const CheckoutCreated = z.object({ checkoutId: z.string(), redirectUrl: z.string() });
export type CheckoutCreated = z.infer<typeof CheckoutCreated>;
export const CheckoutState = z.object({
  checkoutId: z.string(),
  status: CheckoutStatus,
  licenseId: z.string().nullable(),
  offerId: z.string(),
  createdAt: Timestamp,
});
export type CheckoutState = z.infer<typeof CheckoutState>;

// ---------------------------------------------------------------- licensing API (deployments)

export const ActivateBody = z.object({
  licenseKey: z.string().min(8).max(200),
  /** "creator//name" identifier or the manifest resource name. */
  package: z.string().min(1).max(200),
  environment: z.string().min(1).max(64),
  deploymentName: z.string().trim().min(1).max(64),
  adapterVersion: z.string().max(64).nullable().default(null),
});
export type ActivateBody = z.infer<typeof ActivateBody>;
export const ActivateResult = z.object({ activationId: z.string(), deploymentToken: z.string() });

/**
 * Verify never refuses a well-formed request with a 4xx: an unknown, malformed or foreign key is a
 * definitive refusal answered `200 { valid: false, reason: "unknown_key" }`. Runtimes treat 4xx/5xx
 * as "API unreachable" (offline grace applies), so only a structurally broken body gets a 400.
 */
export const VerifyBody = z
  .object({
    licenseKey: z.string().max(512).optional(),
    deploymentToken: z.string().max(512).optional(),
    package: z.string().min(1).max(200),
    environment: z.string().min(1).max(64),
    adapterVersion: z.string().max(64).nullable().default(null),
  })
  .refine((b) => Boolean(b.licenseKey) !== Boolean(b.deploymentToken), {
    message: "Send exactly one of licenseKey or deploymentToken.",
  });
export type VerifyBody = z.infer<typeof VerifyBody>;

export const VerifyResult = z.object({
  valid: z.boolean(),
  reason: VerifyFailureReason.nullable(),
  status: LicenseStatus.nullable(),
  activationStatus: ActivationStatus.nullable(),
  expiresAt: Timestamp.nullable(),
  offlineGraceUntil: Timestamp.nullable(),
  environments: z.array(z.string()),
  /** ed25519-signed short-lived token (EdDSA compact JWS). Verify with GET /v1/licenses/public-key. */
  token: z.string(),
});
export type VerifyResult = z.infer<typeof VerifyResult>;

export const DeactivateBody = z.object({ licenseKey: z.string().min(8).max(200), activationId: z.string().min(1) });
export const PublicKey = z.object({ alg: z.literal("ed25519"), publicKey: z.string(), kid: z.string() });

// ---------------------------------------------------------------- notices and appeals

export const NoticeAppeal = z.object({
  id: z.string(),
  status: AppealStatus,
  statement: z.string(),
  createdAt: Timestamp,
  decidedAt: Timestamp.nullable(),
  outcome: z.string().nullable(),
});
export const Notice = z.object({
  id: z.string(),
  kind: z.enum(["moderation_decision", "appeal_outcome"]),
  caseId: z.string().nullable(),
  package: z.object({ identifier: z.string(), title: z.string() }).nullable(),
  releaseVersion: z.string().nullable(),
  action: ModerationActionKind.nullable(),
  title: z.string(),
  /** Statement of reasons. */
  body: z.string(),
  scope: z.string(),
  createdAt: Timestamp,
  readAt: Timestamp.nullable(),
  appealable: z.boolean(),
  appealDeadline: Timestamp.nullable(),
  appeal: NoticeAppeal.nullable(),
});
export type Notice = z.infer<typeof Notice>;
export const AppealBody = z.object({ statement: z.string().trim().min(10).max(10_000) });

// ---------------------------------------------------------------- creator commerce

export const Series = z.object({
  points: z.array(z.object({ date: z.string(), value: z.number().int().nonnegative() })),
  total: z.number().int().nonnegative(),
});
export type Series = z.infer<typeof Series>;
export const Analytics = z.object({ downloads: Series, activations: Series, verifications: Series });
export type Analytics = z.infer<typeof Analytics>;

export const Store = z.object({
  id: z.string(),
  provider: Provider,
  status: StoreStatus,
  approved: z.boolean(),
  checkoutEnabled: z.boolean(),
  checkoutDisabledReason: z.string().nullable(),
  /** URL to configure as the provider's webhook endpoint. */
  webhookUrl: z.string(),
  webhook: z.object({
    lastEventAt: Timestamp.nullable(),
    deliveries24h: z.number().int().nonnegative(),
    failures24h: z.number().int().nonnegative(),
  }),
  products: z.array(
    z.object({ providerProductId: z.string(), offerId: z.string(), syncStatus: z.enum(["synced", "unverified", "error"]) }),
  ),
  recentDeliveries: z.array(
    z.object({ eventId: z.string(), type: z.string(), status: z.string(), receivedAt: Timestamp, error: z.string().nullable() }),
  ),
  createdAt: Timestamp,
});
export type Store = z.infer<typeof Store>;

export const ConnectStoreBody = z.object({
  provider: Provider,
  /** mock: {} ; tebex: { webhookSecret, publicToken? } — never returned by the API. */
  credentials: z.record(z.string(), z.string().max(512)).default({}),
});
export type ConnectStoreBody = z.infer<typeof ConnectStoreBody>;

export const CustomerRow = z.object({
  license: z.object({
    id: z.string(),
    status: LicenseStatus,
    currentPeriodEnd: Timestamp.nullable(),
    createdAt: Timestamp,
    deploymentsUsed: z.number().int().nonnegative(),
    deploymentsAllowed: z.number().int().nonnegative(),
  }),
  customer: z.object({ username: z.string() }),
  offer: Offer,
  package: z.object({ identifier: z.string(), title: z.string() }),
});
export type CustomerRow = z.infer<typeof CustomerRow>;
