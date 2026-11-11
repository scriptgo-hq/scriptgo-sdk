import { createHmac, randomBytes } from "node:crypto";
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
 *   - code `MT4-2JF` links whoever confirms it (the stub hands the same code out again, so every run
 *     of one `verify` can use it), `USE-D99` is `410 code_used`, `EXP-R3D` is `410 code_expired`,
 *     anything else well formed is `404 unknown_code`. Codes compare ignoring case, spaces and dashes.
 *
 * Like the API, every request must name its environment (`environment`, or one named before on this
 * link), else `409 environment_unknown`. An entry in address mode (`addr`) is fingerprinted at once
 * with the key, by Node's crypto, and the address is dropped: entries only ever hold fingerprints.
 */
export const STUB_PRESENCE = {
  key: "pk_stub_0123456789abcdef",
  code: "MT4-2JF",
  usedCode: "USE-D99",
  expiredCode: "EXP-R3D",
} as const;

export interface PresenceEntry {
  player: string;
  name: string;
  fp: string[];
  /** How the server sent it: its own fingerprints, or addresses the stub fingerprinted. */
  mode: "fp" | "addr";
  environment: string;
  adapterVersion?: string;
  at: number;
}

/** An address as the SDK normalises it: dotted IPv4, or an IPv6 /64 as `a:b:c:d::/64`. */
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const NORMALISED_ADDRESS = new RegExp(`^(?:${OCTET}\\.){3}${OCTET}$|^(?:[0-9a-f]{1,4}:){4}:/64$`);

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
  linked(): { player: string; name?: string; environment: string; adapterVersion?: string }[];
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
  const links: { player: string; name?: string; environment: string; adapterVersion?: string }[] = [];
  // The environment this link last named, as the API keeps it per server link.
  let environment: string | undefined;
  const seen = (said: string | undefined, error: (status: number, code: string, message: string) => void): string | undefined => {
    if (said) environment = said;
    if (!environment) error(409, "environment_unknown", "This server link has not named its environment yet.");
    return environment;
  };
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
        // Checked before anything is read, and never echoed: the address is not in the message.
        if (p.data.players.some((e) => e.addr?.some((a) => !NORMALISED_ADDRESS.test(a)))) return invalid("an address is not normalised"), true;
        const env = seen(p.data.environment, error);
        if (!env) return true;
        const at = Date.now();
        for (const e of p.data.players) {
          const fp = e.fp ?? e.addr!.map((a) => createHmac("sha256", key).update(a).digest("hex"));
          const kept: PresenceEntry = {
            player: e.player, name: e.name, fp, mode: e.fp ? "fp" : "addr", environment: env,
            ...(p.data.adapterVersion ? { adapterVersion: p.data.adapterVersion } : {}), at,
          };
          live.set(e.player, kept);
          history.push({ ...kept, key });
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
        const env = seen(p.data.environment, error);
        if (!env) return true;
        const typed = squash(p.data.code);
        if (typed === squash(STUB_PRESENCE.code)) {
          links.push({
            player: p.data.player, environment: env,
            ...(p.data.name ? { name: p.data.name } : {}),
            ...(p.data.adapterVersion ? { adapterVersion: p.data.adapterVersion } : {}),
          });
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
