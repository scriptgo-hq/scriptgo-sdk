import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  PerkAckBody,
  PerkAckResult,
  PerkCatalogEntry,
  PerkCheckBody,
  PerkCheckResult,
  PerkEventsQuery,
  PerkEventsResult,
  PerkPurchaseLink,
  PerkPurchaseLinkBody,
} from "@scriptgo/shared";
import type { StubRequest } from "./stub-api.ts";

/**
 * The perks routes of the loopback stub API (`scriptgo verify --stub-api`), for the server side of
 * docs/spec/perks.md: check, events + ack, catalog, purchase link. Every request is parsed with the
 * API's own schemas (@scriptgo/shared) and every answer is checked against its result schema before
 * it is sent, like the licensing routes. It is not the API: one server link, fixed data, no store.
 *
 * Fixed data, which sdk/conformance/sg_probe_perks checks:
 *   - `sgprobe:holder` holds `vip` (monthly, 30 days left);
 *   - the event queue holds one `granted` event: `vip` for `sgprobe:buyer`, reason `purchase`. A
 *     server that starts pulling (no `after`) once everything was acknowledged gets a new one, so
 *     the runs of one `verify` (one per interpreter, all on this stub) each see a purchase;
 *   - the catalog sells `vip` and lists `gold` as not purchasable.
 */
export const STUB_PERKS = {
  holder: "sgprobe:holder",
  buyer: "sgprobe:buyer",
  heldKey: "vip",
  unsoldKey: "gold",
} as const;

export interface StubPerks {
  /** The one server link token the stub knows (`sg_srv_…`); any other is `401 unknown_server_link`. */
  serverToken: string;
  /** The highest sequence number a server acknowledged, or null. */
  acked(): number | null;
  /** Handles a /v1/perks/* request; false when the path is not one of these routes. */
  handle(
    req: IncomingMessage, path: string, raw: string, entry: StubRequest,
    send: (status: number, body: unknown) => void, error: (status: number, code: string, message: string) => void,
  ): boolean;
}

const MONTH_MS = 30 * 24 * 3600 * 1000;
const GRACE_MS = 72 * 3600 * 1000;

export function createStubPerks(): StubPerks {
  const serverToken = "sg_srv_stub_" + randomBytes(12).toString("hex");
  const started = Date.now();
  const expiresAt = new Date(started + MONTH_MS).toISOString();
  const graceUntil = () => new Date(Math.min(Date.now() + GRACE_MS, started + MONTH_MS)).toISOString();
  const purchase = (seq: number) =>
    ({ seq, kind: "granted" as const, perk: STUB_PERKS.heldKey, player: STUB_PERKS.buyer, reason: "purchase", status: "active" as const, at: new Date().toISOString() });
  const events = [purchase(1)];
  let acked: number | null = null;
  const held = (player: string) => (player === STUB_PERKS.holder ? [STUB_PERKS.heldKey] : []);

  return {
    serverToken,
    acked: () => acked,
    handle(req, path, raw, entry, send, error) {
      if (!path.startsWith("/v1/perks/")) return false;
      if (req.headers.authorization !== `Bearer ${serverToken}`) {
        error(401, "unknown_server_link", "Unknown, malformed or revoked server link token.");
        return true;
      }
      const body = (): unknown => {
        try {
          return JSON.parse(raw);
        } catch {
          return undefined;
        }
      };
      const invalid = (issue: string | undefined) => {
        entry.bodyError = issue ?? "invalid";
        error(400, "validation_failed", "The request does not match the schema.");
      };
      const now = new Date().toISOString();

      if (req.method === "POST" && path === "/v1/perks/check") {
        const p = PerkCheckBody.safeParse(body());
        if (!p.success) return invalid(p.error.issues[0]?.message), true;
        Object.assign(entry, { environment: p.data.environment, adapterVersion: p.data.adapterVersion ?? null });
        send(200, PerkCheckResult.parse({
          player: p.data.player,
          perks: held(p.data.player).map((key) => ({ key, status: "active", expiresAt, offlineGraceUntil: graceUntil() })),
          serverTime: now,
        }));
        return true;
      }
      if (req.method === "GET" && path === "/v1/perks/events") {
        const q = PerkEventsQuery.safeParse(Object.fromEntries(new URL(req.url ?? "/", "http://stub").searchParams));
        if (!q.success) return invalid(q.error.issues[0]?.message), true;
        if (q.data.after === undefined && acked !== null && acked >= events[events.length - 1]!.seq) events.push(purchase(acked + 1));
        const after = q.data.after ?? acked ?? 0;
        const list = events.filter((e) => e.seq > after).slice(0, q.data.limit)
          .map((e) => ({ ...e, expiresAt, offlineGraceUntil: graceUntil() }));
        const cursor = list.length > 0 ? list[list.length - 1]!.seq : after;
        send(200, PerkEventsResult.parse({ events: list, cursor, more: false, serverTime: now }));
        return true;
      }
      if (req.method === "POST" && path === "/v1/perks/events/ack") {
        const p = PerkAckBody.safeParse(body());
        if (!p.success) return invalid(p.error.issues[0]?.message), true;
        const top = events[events.length - 1]!.seq;
        acked = Math.max(acked ?? 0, Math.min(p.data.upTo, top));
        send(200, PerkAckResult.parse({ acked }));
        return true;
      }
      if (req.method === "GET" && path === "/v1/perks/catalog") {
        send(200, PerkCatalogEntry.array().parse([
          { key: STUB_PERKS.heldKey, name: "VIP", description: "", interval: "month", price: { amount: 500, currency: "EUR" }, purchasable: true },
          { key: STUB_PERKS.unsoldKey, name: "Gold", description: "", interval: "perpetual", price: { amount: 1500, currency: "EUR" }, purchasable: false },
        ]));
        return true;
      }
      if (req.method === "POST" && path === "/v1/perks/purchase-link") {
        const p = PerkPurchaseLinkBody.safeParse(body());
        if (!p.success) return invalid(p.error.issues[0]?.message), true;
        if (p.data.perk !== STUB_PERKS.heldKey && p.data.perk !== STUB_PERKS.unsoldKey) {
          error(404, "unknown_perk", "This operator sells no such perk.");
        } else if (p.data.perk === STUB_PERKS.unsoldKey) {
          error(409, "not_purchasable", "Not on sale.");
        } else if (held(p.data.player).includes(p.data.perk)) {
          error(409, "already_held", "The player already holds this perk.");
        } else {
          send(201, PerkPurchaseLink.parse({
            url: `http://stub.invalid/perk/${randomBytes(16).toString("hex")}`,
            expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
          }));
        }
        return true;
      }
      error(404, "not_found", "No such perks route on the stub.");
      return true;
    },
  };
}
