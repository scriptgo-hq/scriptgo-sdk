import { z } from "zod";

/** Enumerations from docs/spec/api.md ("Enumerations"). Keep both in sync. */

export const EnvironmentStatus = z.enum(["available", "beta", "experimental", "planned"]);
export type EnvironmentStatus = z.infer<typeof EnvironmentStatus>;
/** runtime: an engine or runtime that hosts Lua itself. mod_platform: a layer on top of an existing game. */
export const EnvironmentKind = z.enum(["runtime", "mod_platform"]);
export type EnvironmentKind = z.infer<typeof EnvironmentKind>;
/**
 * What the platform's own rights holder says about paid scripts (ADR-0037). Information for the
 * operator who runs a script there and answers for it; never a SCRIPT//GO rule, and it gates nothing.
 * no_restriction: none known, or the terms allow it. restricts_paid: the terms restrict or forbid
 * paid scripts. unsettled: no published rule, or it depends on the script.
 */
export const PlatformRules = z.enum(["no_restriction", "restricts_paid", "unsettled"]);
export type PlatformRules = z.infer<typeof PlatformRules>;
/** verified: a real run passed; written: adapter code exists, no real run yet; none: no adapter code yet. */
export const AdapterState = z.enum(["verified", "written", "none"]);
export type AdapterState = z.infer<typeof AdapterState>;
/** How an environment runs packages: a CLI host, a library, an addon, a mod, a plugin, a computer program, a shim, or an embedded host kit. */
export const IntegrationType = z.enum(["cli", "library", "addon", "mod", "plugin", "program", "shim", "kit"]);
export type IntegrationType = z.infer<typeof IntegrationType>;

/**
 * What a buyer's server gets in an environment (ADR-0027). escrow: the host runs compiled code and
 * can hold a key, so an encrypted release is decrypted in memory. license: licence check and signed
 * releases only (a pure-script host; no code-secrecy claim). none: the adapter has no licence check,
 * so a package runs there without one (ADR-0037: a technical fact, never a selling rule).
 */
export const ProtectionTier = z.enum(["escrow", "license", "none"]);
export type ProtectionTier = z.infer<typeof ProtectionTier>;
/** Whether that tier works in the environment today. */
export const ProtectionState = z.enum(["available", "planned"]);
export type ProtectionState = z.infer<typeof ProtectionState>;

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

/**
 * How an offer stands (ADR-0037). The seller decides and answers for what they sell: nothing waits
 * for a reviewer.
 *   free                    no payment
 *   software_license        declared by the seller as their own, independent software
 *   seller_declared         sold on the seller's declaration that they own the code, which targets a
 *                           third-party game platform; not reviewed by SCRIPT//GO before sale
 *   authorized_app_feature  set by staff: a feature of an application its rights holder authorized
 *   undeclared              no rights declaration on a published release yet: no purchase path until
 *                           the seller declares (the seller's action, no reviewer)
 *   on_hold                 put on hold by staff after a report: no purchase path; notified, appealable
 *   rejected                withdrawn by staff after a report: no purchase path; notified, appealable
 */
export const Classification = z.enum([
  "free",
  "software_license",
  "seller_declared",
  "authorized_app_feature",
  "undeclared",
  "on_hold",
  "rejected",
]);
export type Classification = z.infer<typeof Classification>;

export const LicenseStatus = z.enum(["active", "grace", "cancelled_active", "expired", "revoked", "refunded"]);
export type LicenseStatus = z.infer<typeof LicenseStatus>;

export const ActivationStatus = z.enum(["pending", "active", "offline_grace", "deactivated", "blocked"]);
export type ActivationStatus = z.infer<typeof ActivationStatus>;

/** suspended: staff suspended the store after a report; nothing can be bought through it. */
export const StoreStatus = z.enum(["not_connected", "sandbox", "checkout_off", "live", "needs_attention", "suspended"]);
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
  "perks",
  "presence",
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

/**
 * What a moderation decision does. The first five are decisions on a report; hold_offer and
 * reject_offer act on one offer (POST /v1/admin/review/offers/:id/decision). Every one except
 * no_action sends the creator a notice they can appeal.
 */
export const ModerationActionKind = z.enum(["no_action", "restrict_release", "restrict_sales", "suspend_listing", "suspend_store", "hold_offer", "reject_offer"]);
export type ModerationActionKind = z.infer<typeof ModerationActionKind>;
/** The decisions a moderator can take on a report. */
export const ReportActionKind = z.enum(["no_action", "restrict_release", "restrict_sales", "suspend_listing", "suspend_store"]);
export type ReportActionKind = z.infer<typeof ReportActionKind>;

export const AppealStatus = z.enum(["open", "upheld", "reversed"]);
export type AppealStatus = z.infer<typeof AppealStatus>;

/** `creator`: the creator who granted the license (a grant, or its revocation). */
export const HistorySource = z.enum(["provider", "user", "admin", "system", "creator"]);
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
  /** The request carries a server public key other than the one bound to the deployment (a copy on
   * another machine, or an honest re-install: the owner resets the server key in the dashboard). */
  "server_key_mismatch",
  /** The package/release has no encrypted variant (nothing to release a key for). */
  "not_escrowed",
]);
export type KeyReleaseFailureReason = z.infer<typeof KeyReleaseFailureReason>;
