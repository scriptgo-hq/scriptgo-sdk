import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  IdentityCodeConfirmBody,
  IdentityCodeConfirmResult,
  PlayerId,
  PresenceBody,
  PresenceResult,
} from "@scriptgo/shared";
import type { StubRequest } from "./stub-api.ts";

/**
 * The player match routes of the loopback stub API (`scriptgo verify --stub-api`), for the game
 * server side of docs/spec/player-match.md: presence reports, presence removal and code
 * confirmation. Bodies are parsed with the API's own schemas (@scriptgo/shared) and answers are
 * checked against the result schemas before they are sent, like the perks routes. It is not the API:
 * one server link, one key, entries in memory, no sign-in page.
 *
 * Fixed data, which sdk/conformance/sg_probe_presence checks:
 *   - the presence key is `STUB_PRESENCE.key` until `rotate()` is called;
 *   - code `K7-4QX` links whoever confirms it (the stub hands the same code out again, so every run
 *     of one `verify` can use it), `US-ED00` is `410 code_used`, `EX-P1RE` is `410 code_expired`,
 *     anything else well formed is `404 unknown_code`. Codes compare ignoring case, spaces and dashes.
 */
export const STUB_PRESENCE = {
  key: "pk_stub_0123456789abcdef",
  code: "K7-4QX",
  usedCode: "US-ED00",
  expiredCode: "EX-P1RE",
} as const;

export interface PresenceEntry {
  player: string;
  name: string;
  fp: string[];
  at: number;
}

export interface StubPresence {
  /** The key the stub hands out now. */
  key(): string;
  /** Hands out a new key from now on, as the daily rotation does. */
  rotate(): string;
  /** Live entries, by identifier. Raw addresses never reach the stub: only fingerprints. */
  entries(): Map<string, PresenceEntry>;
  /** Every entry ever reported, with the key it was hashed with: what a run can compare. */
  reports(): (PresenceEntry & { key: string })[];
  /** Every confirmed code, in order. */
  linked(): { player: string; name?: string }[];
  /** Handles a presence or code request; false when the path is not one of these routes. */
  handle(
    req: IncomingMessage, path: string, raw: string, entry: StubRequest,
    send: (status: number, body: unknown) => void, error: (status: number, code: string, message: string) => void,
  ): boolean;
}

const DAY_MS = 24 * 3600 * 1000;
const squash = (code: string) => code.replace(/[\s-]/g, "").toUpperCase();

export function createStubPresence(serverToken: string): StubPresence {
  let key: string = STUB_PRESENCE.key;
  let rotatesAt = new Date(Date.now() + DAY_MS).toISOString();
  const live = new Map<string, PresenceEntry>();
  const links: { player: string; name?: string }[] = [];
  const history: (PresenceEntry & { key: string })[] = [];

  return {
    key: () => key,
    rotate() {
      key = "pk_stub_" + randomBytes(12).toString("hex");
      rotatesAt = new Date(Date.now() + DAY_MS).toISOString();
      return key;
    },
    entries: () => live,
    linked: () => links,
    reports: () => history,
    handle(req, path, raw, entry, send, error) {
      if (path !== "/v1/presence" && !path.startsWith("/v1/presence/") && path !== "/v1/identity/codes/confirm") return false;
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

      if (req.method === "POST" && path === "/v1/presence") {
        const p = PresenceBody.safeParse(body());
        if (!p.success) return invalid(p.error.issues[0]?.message), true;
        const at = Date.now();
        for (const e of p.data.players) {
          live.set(e.player, { ...e, at });
          history.push({ ...e, at, key });
        }
        send(200, PresenceResult.parse({ accepted: p.data.players.length, presenceKey: key, rotatesAt }));
        return true;
      }
      if (req.method === "DELETE" && path.startsWith("/v1/presence/")) {
        let id: string;
        try {
          id = decodeURIComponent(path.slice("/v1/presence/".length));
        } catch {
          return invalid("identifier is not percent-encoded"), true;
        }
        const p = PlayerId.safeParse(id);
        if (!p.success) return invalid(p.error.issues[0]?.message), true;
        send(200, { removed: live.delete(p.data) });
        return true;
      }
      if (req.method === "POST" && path === "/v1/identity/codes/confirm") {
        const p = IdentityCodeConfirmBody.safeParse(body());
        if (!p.success) return invalid(p.error.issues[0]?.message), true;
        const typed = squash(p.data.code);
        if (typed === squash(STUB_PRESENCE.code)) {
          links.push({ player: p.data.player, ...(p.data.name ? { name: p.data.name } : {}) });
          send(200, IdentityCodeConfirmResult.parse({ linked: true }));
        } else if (typed === squash(STUB_PRESENCE.usedCode)) {
          error(410, "code_used", "This code was already used.");
        } else if (typed === squash(STUB_PRESENCE.expiredCode)) {
          error(410, "code_expired", "This code is older than 10 minutes.");
        } else {
          error(404, "unknown_code", "No such code.");
        }
        return true;
      }
      error(404, "not_found", "No such presence route on the stub.");
      return true;
    },
  };
}
