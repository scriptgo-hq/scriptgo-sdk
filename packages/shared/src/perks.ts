import { z } from "zod";
import { Money, Timestamp } from "./common.ts";
import { Classification, LicenseStatus, Provider } from "./enums.ts";

/**
 * Player perks (ADR-0038, docs/spec/perks.md). An operator sells a perk to the players of their own
 * servers from their own store; the game server learns it from SCRIPT//GO; the operator's own script
 * applies it.
 */

/** What the script asks for: `ScriptGo.perks.has(player, "vip")`. */
export const PERK_KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const PerkKey = z.string().regex(PERK_KEY_RE, "lowercase letters, digits, '_', '.' and '-', up to 64 characters");

/**
 * A player identifier: the string the adapter's `players.identifier` gives. Opaque to SCRIPT//GO,
 * and only as trustworthy as the platform's own authentication of players. Printable, no spaces.
 */
export const PLAYER_ID_RE = /^[\x21-\x7e]{1,128}$/;
export const PlayerId = z.string().regex(PLAYER_ID_RE, "1 to 128 printable ASCII characters, no spaces");

export const PerkInterval = z.enum(["month", "perpetual"]);
export type PerkInterval = z.infer<typeof PerkInterval>;

/** The seller's own declaration for a perk offer; no reviewer reads it before sale (ADR-0037). */
export const PerkRights = z.object({
  /** "This perk is a feature of my own script, and I have the right to sell it." */
  ownsCode: z.boolean(),
  /** "My script runs on a third-party game platform." */
  targetsProprietaryGame: z.boolean(),
});
export type PerkRights = z.infer<typeof PerkRights>;

export const CreatePerkBody = z.object({
  key: PerkKey,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(""),
  interval: PerkInterval,
  price: Money,
  provider: Provider.optional(),
  /** The product of the operator's own store this perk maps to. */
  providerProductId: z.string().trim().min(1).max(128).nullable().default(null),
  rights: PerkRights.optional(),
});
export type CreatePerkBody = z.infer<typeof CreatePerkBody>;

export const Perk = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string(),
  interval: PerkInterval,
  price: Money,
  provider: Provider.nullable(),
  providerProductId: z.string().nullable(),
  classification: Classification,
  classificationReason: z.string().nullable(),
  declared: z.boolean(),
  active: z.boolean(),
  /** Whether a purchase link for it can be issued now, and the reason when not. */
  purchasable: z.boolean(),
  notPurchasableReason: z.string().nullable(),
  /** Players who hold it now. */
  holders: z.number().int().nonnegative(),
  createdAt: Timestamp,
});
export type Perk = z.infer<typeof Perk>;

export const PerkHolder = z.object({
  id: z.string(),
  perkKey: z.string(),
  perkName: z.string(),
  player: z.string(),
  status: LicenseStatus,
  /** Whether a server asking now is told the player has the perk. */
  has: z.boolean(),
  currentPeriodEnd: Timestamp.nullable(),
  cancelledAt: Timestamp.nullable(),
  refundedAt: Timestamp.nullable(),
  revokedReason: z.string().nullable(),
  disputed: z.boolean(),
  provider: Provider.nullable(),
  paymentRef: z.string().nullable(),
  subscriptionRef: z.string().nullable(),
  serverLinkName: z.string().nullable(),
  createdAt: Timestamp,
});
export type PerkHolder = z.infer<typeof PerkHolder>;

export const CreateServerLinkBody = z.object({
  name: z.string().trim().min(1).max(64),
});
export type CreateServerLinkBody = z.infer<typeof CreateServerLinkBody>;

export const ServerLink = z.object({
  id: z.string(),
  name: z.string(),
  /** "sg_srv_…a91c": the token itself is shown once, at creation. */
  tokenPreview: z.string(),
  environment: z.string().nullable(),
  adapterVersion: z.string().nullable(),
  lastSeenAt: Timestamp.nullable(),
  /** Events queued for this server that it has not acknowledged yet. */
  pendingEvents: z.number().int().nonnegative(),
  revoked: z.boolean(),
  createdAt: Timestamp,
});
export type ServerLink = z.infer<typeof ServerLink>;

export const ServerLinkCreated = z.object({ link: ServerLink, token: z.string() });
export type ServerLinkCreated = z.infer<typeof ServerLinkCreated>;

// ---------------------------------------------------------------------------- server-facing

/** One perk a player holds, as a linked server is told. */
export const HeldPerk = z.object({
  key: z.string(),
  status: LicenseStatus,
  /** The end of what is paid for (or of the payment grace). null = no end. Never trust the perk after it without asking again. */
  expiresAt: Timestamp.nullable(),
  /** How long a server that cannot reach the API may keep this answer; never later than `expiresAt`. */
  offlineGraceUntil: Timestamp,
});
export type HeldPerk = z.infer<typeof HeldPerk>;

export const PerkCheckBody = z.object({
  player: PlayerId,
  environment: z.string().max(64).optional(),
  adapterVersion: z.string().max(128).optional(),
});
export type PerkCheckBody = z.infer<typeof PerkCheckBody>;

export const PerkCheckResult = z.object({
  player: z.string(),
  /** Every perk of this operator the player holds now. A key that is absent is not held. */
  perks: z.array(HeldPerk),
  serverTime: Timestamp,
});
export type PerkCheckResult = z.infer<typeof PerkCheckResult>;

export const PerkEvent = z.object({
  seq: z.number().int().positive(),
  kind: z.enum(["granted", "updated", "removed"]),
  perk: z.string(),
  player: z.string(),
  reason: z.string(),
  status: LicenseStatus,
  /** granted, updated: the end of what is paid for (null = no end). removed: null. */
  expiresAt: Timestamp.nullable(),
  /** granted, updated: how long a server that cannot reach the API may keep it, counted from this answer; never later than `expiresAt`. removed: null. */
  offlineGraceUntil: Timestamp.nullable(),
  at: Timestamp,
});
export type PerkEvent = z.infer<typeof PerkEvent>;

export const PerkEventsQuery = z.object({
  /** Events after this sequence number. Omitted: after the last acknowledged one. */
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type PerkEventsQuery = z.infer<typeof PerkEventsQuery>;

export const PerkEventsResult = z.object({
  events: z.array(PerkEvent),
  /** The sequence to acknowledge and to pass as `after` next time. */
  cursor: z.number().int().min(0),
  more: z.boolean(),
  serverTime: Timestamp,
});
export type PerkEventsResult = z.infer<typeof PerkEventsResult>;

export const PerkAckBody = z.object({ upTo: z.number().int().min(0) });
export type PerkAckBody = z.infer<typeof PerkAckBody>;

export const PerkAckResult = z.object({ acked: z.number().int().min(0) });
export type PerkAckResult = z.infer<typeof PerkAckResult>;

export const PerkCatalogEntry = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  interval: PerkInterval,
  price: Money,
  purchasable: z.boolean(),
});
export type PerkCatalogEntry = z.infer<typeof PerkCatalogEntry>;

export const PerkPurchaseLinkBody = z.object({ player: PlayerId, perk: PerkKey });
export type PerkPurchaseLinkBody = z.infer<typeof PerkPurchaseLinkBody>;

export const PerkPurchaseLink = z.object({ url: z.string(), expiresAt: Timestamp });
export type PerkPurchaseLink = z.infer<typeof PerkPurchaseLink>;

// ---------------------------------------------------------------------------- buyer-facing

/** What the page behind a purchase link shows before the player goes to the operator's store. */
export const PerkPurchaseInfo = z.object({
  perk: z.object({ key: z.string(), name: z.string(), description: z.string(), interval: PerkInterval, price: Money }),
  operator: z.object({ username: z.string(), displayName: z.string() }),
  player: z.string(),
  provider: Provider.nullable(),
  purchasable: z.boolean(),
  notPurchasableReason: z.string().nullable(),
  expiresAt: Timestamp,
});
export type PerkPurchaseInfo = z.infer<typeof PerkPurchaseInfo>;

export const PerkCheckoutCreated = z.object({ checkoutId: z.string(), redirectUrl: z.string() });
export type PerkCheckoutCreated = z.infer<typeof PerkCheckoutCreated>;

export const PerkCheckoutState = z.object({
  checkoutId: z.string(),
  status: z.enum(["pending", "completed", "failed", "expired"]),
  perk: z.object({ key: z.string(), name: z.string() }),
  operator: z.object({ username: z.string(), displayName: z.string() }),
  player: z.string(),
});
export type PerkCheckoutState = z.infer<typeof PerkCheckoutState>;

/**
 * Staff, after a report (ADR-0037): put one perk offer on hold or withdraw it (no purchase path; the
 * operator is notified and can appeal), or lift that, which puts it back on the seller's declaration.
 */
export const PerkDecisionBody = z.object({
  decision: z.enum(["on_hold", "rejected", "lift"]),
  reason: z.string().trim().min(3).max(5000),
  /** The report this decision follows (RPT-YYYY-NNNNNN), when there is one. */
  caseId: z.string().trim().max(32).optional(),
});
export type PerkDecisionBody = z.infer<typeof PerkDecisionBody>;

export const StaffPerk = Perk.extend({ operator: z.string() });
export type StaffPerk = z.infer<typeof StaffPerk>;
