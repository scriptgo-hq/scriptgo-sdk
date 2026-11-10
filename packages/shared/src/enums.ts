import { z } from "zod";

/** Enumerations from docs/spec/api.md ("Enumerations"). Keep both in sync. */

export const EnvironmentStatus = z.enum(["available", "beta", "experimental", "planned"]);
export type EnvironmentStatus = z.infer<typeof EnvironmentStatus>;
/** runtime: an engine or runtime that hosts Lua itself. mod_platform: a layer on top of an existing game. */
export const EnvironmentKind = z.enum(["runtime", "mod_platform"]);
export type EnvironmentKind = z.infer<typeof EnvironmentKind>;
/** Whether paid packages are possible there: allowed, free_only (the rights holder forbids selling), review. */
export const EnvironmentSales = z.enum(["allowed", "free_only", "review"]);
export type EnvironmentSales = z.infer<typeof EnvironmentSales>;
/** verified: a real run passed; written: adapter code exists, no real run yet; none: no adapter code yet. */
export const AdapterState = z.enum(["verified", "written", "none"]);
export type AdapterState = z.infer<typeof AdapterState>;
/** How an environment runs packages: a CLI host, a library, an addon, a mod, a plugin, a computer program, a shim, or an embedded host kit. */
export const IntegrationType = z.enum(["cli", "library", "addon", "mod", "plugin", "program", "shim", "kit"]);
export type IntegrationType = z.infer<typeof IntegrationType>;

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

/** Why an escrow key release was refused: the verify reasons plus escrow-specific ones. */
export const KeyReleaseFailureReason = z.enum([
  "expired",
  "revoked",
  "refunded",
  "environment_not_covered",
  "deployment_limit",
  "unknown_key",
  "deactivated",
  /** The deployment registered no server public key (not bound); a key cannot be wrapped to it. */
  "unbound",
  /** The package/release has no encrypted variant (nothing to release a key for). */
  "not_escrowed",
]);
export type KeyReleaseFailureReason = z.infer<typeof KeyReleaseFailureReason>;
