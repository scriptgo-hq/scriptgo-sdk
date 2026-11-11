import { z } from "zod";
import { Timestamp } from "./common.ts";
import { PlayerId } from "./perks.ts";

/**
 * Player match (docs/spec/player-match.md): what a linked game server sends to tie a buyer on a shop
 * to a player. Server-facing routes, authorised by the server link token (`Bearer sg_srv_…`), like
 * the perks routes. The SDK's side is sdk/lua/scriptgo/presence.lua.
 */

/** HMAC-SHA256(presenceKey, normalised address), lowercase hex. Never the address itself. */
export const PRESENCE_FINGERPRINT_RE = /^[0-9a-f]{64}$/;
export const PresenceFingerprint = z.string().regex(PRESENCE_FINGERPRINT_RE, "64 lowercase hex characters");

/** The day's key. A plain token, so a host may hand it to its crypto tool safely; used as the UTF-8 bytes of the string. */
export const PRESENCE_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
export const PresenceKey = z.string().regex(PRESENCE_KEY_RE, "16 to 128 characters of A-Z, a-z, 0-9, '_' and '-'");

export const PresencePlayer = z.object({
  player: PlayerId,
  /** The name the game shows; the sign-in page shows it to the one browser that matched. */
  name: z.string().min(1).max(64),
  fp: z.array(PresenceFingerprint).min(1).max(4),
});
export type PresencePlayer = z.infer<typeof PresencePlayer>;

/** POST /v1/presence. An empty list is valid: it is how a server first learns the key. */
export const PresenceBody = z.object({ players: z.array(PresencePlayer).max(1000) });
export type PresenceBody = z.infer<typeof PresenceBody>;

/** The answer to POST /v1/presence (and the key a server hashes with until `rotatesAt`). */
export const PresenceResult = z.object({
  accepted: z.number().int().min(0).optional(),
  presenceKey: PresenceKey,
  rotatesAt: Timestamp,
});
export type PresenceResult = z.infer<typeof PresenceResult>;

/** What a player types after /link: letters and digits, with or without the dash, any case. The API compares ignoring case, spaces and dashes. */
export const IdentityCodeText = z.string().regex(/^[A-Za-z0-9-]{4,16}$/, "4 to 16 letters, digits or '-'");

/** POST /v1/identity/codes/confirm, from a game server: the player who typed the code. */
export const IdentityCodeConfirmBody = z.object({
  code: IdentityCodeText,
  player: PlayerId,
  /** Optional: the name the game shows, so the page can say "Continue as <name>". */
  name: z.string().min(1).max(64).optional(),
});
export type IdentityCodeConfirmBody = z.infer<typeof IdentityCodeConfirmBody>;

/**
 * 200 on success. Refusals (`{ error: { code } }`): 404 `unknown_code`, 410 `code_expired` or
 * `code_used`, 429 `rate_limited`, 401 `unknown_server_link`.
 */
export const IdentityCodeConfirmResult = z.object({ linked: z.literal(true) });
export type IdentityCodeConfirmResult = z.infer<typeof IdentityCodeConfirmResult>;
