import { z } from "zod";
import { Timestamp } from "./common.ts";

/**
 * Commerce readiness (docs/ops/TEBEX-GO-LIVE.md). A readiness answer is computed from what is really
 * configured and recorded: environment settings, the sealed store credentials (presence only), the
 * offers, the webhook deliveries. It is never asserted by hand, it never contains a secret, and
 * reading it changes nothing.
 *
 *   ok       configured, or proven by a recorded event
 *   missing  something the operator or the creator still has to supply
 *   warning  worth a look, does not block selling
 *   blocked  waits for a decision outside configuration: the written approval, a review
 */
export const ReadinessStatus = z.enum(["ok", "missing", "warning", "blocked"]);
export type ReadinessStatus = z.infer<typeof ReadinessStatus>;

export const ReadinessCheck = z.object({
  /** Stable identifier ("webhook_secret", "checkout_flag", ...): see docs/spec/api.md. */
  id: z.string(),
  label: z.string(),
  status: ReadinessStatus,
  /** What was found, in one or two sentences. Names settings, never their secret values. */
  detail: z.string(),
  /** What to do when the status is not ok; null when there is nothing to do. */
  fix: z.string().nullable(),
});
export type ReadinessCheck = z.infer<typeof ReadinessCheck>;

export const ReadinessSummary = z.object({
  /** True when no check is missing or blocked. */
  ready: z.boolean(),
  /** One line per missing or blocked check, in order: exactly what still stands between now and selling. */
  remaining: z.array(z.string()),
});
export type ReadinessSummary = z.infer<typeof ReadinessSummary>;

/** Readiness of one connected Tebex store, for its creator and for staff. */
export const StoreReadiness = z.object({
  storeId: z.string(),
  provider: z.literal("tebex"),
  /** The creator's username. */
  creator: z.string(),
  /** The endpoint to paste in Tebex > Developers > Webhooks. */
  webhookUrl: z.string(),
  approved: z.boolean(),
  checks: z.array(ReadinessCheck),
  summary: ReadinessSummary,
  generatedAt: Timestamp,
});
export type StoreReadiness = z.infer<typeof StoreReadiness>;

/** Platform-wide readiness for staff: the server's own settings, then every connected Tebex store. */
export const CommerceReadiness = z.object({
  platform: z.object({ checks: z.array(ReadinessCheck), summary: ReadinessSummary }),
  stores: z.array(StoreReadiness),
  generatedAt: Timestamp,
});
export type CommerceReadiness = z.infer<typeof CommerceReadiness>;
