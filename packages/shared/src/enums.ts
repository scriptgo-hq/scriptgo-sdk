import { z } from "zod";

/** Enumerations from docs/spec/api.md ("Enumerations"). Keep both in sync. */

export const EnvironmentStatus = z.enum(["available", "beta", "experimental", "planned"]);
export type EnvironmentStatus = z.infer<typeof EnvironmentStatus>;

export const CapabilitySupport = z.enum(["supported", "partial", "fallback", "unavailable"]);
export type CapabilitySupport = z.infer<typeof CapabilitySupport>;

export const CompatibilityStatus = z.enum(["verified", "failing", "stale", "not_tested", "unsupported"]);
export type CompatibilityStatus = z.infer<typeof CompatibilityStatus>;

export const ReleaseStatus = z.enum([
  "draft",
  "validating",
  "validation_failed",
  "ready",
  "published",
  "deprecated",
  "yanked",
]);
export type ReleaseStatus = z.infer<typeof ReleaseStatus>;

export const Visibility = z.enum(["private", "unlisted", "public"]);
export type Visibility = z.infer<typeof Visibility>;

export const ListingStatus = z.enum(["active", "restricted", "suspended"]);
export type ListingStatus = z.infer<typeof ListingStatus>;

export const OfferInterval = z.enum(["free", "month", "year", "perpetual"]);
export type OfferInterval = z.infer<typeof OfferInterval>;

export const Classification = z.enum([
  "free",
  "software_license",
  "authorized_app_feature",
  "pending_review",
  "rejected",
]);
export type Classification = z.infer<typeof Classification>;

export const LicenseStatus = z.enum(["active", "grace", "cancelled_active", "expired", "revoked", "refunded"]);
export type LicenseStatus = z.infer<typeof LicenseStatus>;

export const ActivationStatus = z.enum(["pending", "active", "offline_grace", "deactivated", "blocked"]);
export type ActivationStatus = z.infer<typeof ActivationStatus>;

export const StoreStatus = z.enum(["not_connected", "sandbox", "checkout_off", "live", "needs_attention"]);
export type StoreStatus = z.infer<typeof StoreStatus>;

export const CaseStatus = z.enum([
  "received",
  "under_review",
  "action_taken",
  "no_action",
  "escalated",
  "appeal_open",
  "closed",
]);
export type CaseStatus = z.infer<typeof CaseStatus>;

export const Category = z.enum([
  "inventory",
  "permissions",
  "economy",
  "events",
  "ui",
  "admin",
  "framework",
  "vehicles",
  "housing",
  "quests",
  "library",
  "other",
]);
export type Category = z.infer<typeof Category>;

/** Capabilities from docs/spec/runtime.md. The environment matrix may list more; treat as open. */
export const KNOWN_CAPABILITIES = [
  "events",
  "logging",
  "storage",
  "players",
  "permissions",
  "commands",
  "config",
  "ui",
  "http",
  "licensing",
] as const;
export const Capability = z.string().min(1).max(64);
export type Capability = z.infer<typeof Capability>;

export const Role = z.enum(["customer", "creator", "admin", "moderator"]);
export type Role = z.infer<typeof Role>;

export const Provider = z.enum(["tebex", "mock"]);
export type Provider = z.infer<typeof Provider>;

export const CheckoutStatus = z.enum(["pending", "completed", "failed", "expired"]);
export type CheckoutStatus = z.infer<typeof CheckoutStatus>;

export const CheckStage = z.enum(["archive", "manifest", "integrity", "static", "unit", "environment", "rights"]);
export type CheckStage = z.infer<typeof CheckStage>;

export const CheckStatus = z.enum(["pending", "running", "passed", "failed", "skipped"]);
export type CheckStatus = z.infer<typeof CheckStatus>;

export const ModerationActionKind = z.enum(["no_action", "restrict_release", "restrict_sales", "suspend_listing"]);
export type ModerationActionKind = z.infer<typeof ModerationActionKind>;

export const AppealStatus = z.enum(["open", "upheld", "reversed"]);
export type AppealStatus = z.infer<typeof AppealStatus>;

export const HistorySource = z.enum(["provider", "user", "admin", "system"]);
export type HistorySource = z.infer<typeof HistorySource>;

export const VerifyFailureReason = z.enum([
  "expired",
  "revoked",
  "refunded",
  "environment_not_covered",
  "deployment_limit",
  "unknown_key",
  "deactivated",
]);
export type VerifyFailureReason = z.infer<typeof VerifyFailureReason>;
