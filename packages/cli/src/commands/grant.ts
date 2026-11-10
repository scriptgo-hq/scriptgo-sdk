// scriptgo grant create <package> --to <account id | creator username> [--environments a,b] [--deployments <n>]
// scriptgo grant create <package> --server-key <public key> --environment <env> [--name <deployment>]
//                                 [--expires-days <n>] [--note "<who it is for>"] [--json]
// scriptgo grant list   <package> [--json]
// scriptgo grant revoke <license id> --reason "<why>"
//
// "Protect without selling": a creator issues a free license for one of their own packages, so a
// protected (escrow) release runs on a server the creator chose. Nothing is sold and no payment
// provider is involved. A granted license is an ordinary license: same key endpoint, same binding
// to one server, same revocation.
//
// --to names another account: its account id (shown by `scriptgo login` and in Dashboard →
// Settings) or a creator username. An e-mail address is not accepted. --server-key is for an
// operator without an account: they run `scriptgo escrow identity --identity <file>` on their
// server and send you the public key it prints. The license is then held by you, bound to that
// server, and the deployment token is printed ONCE for you to hand over.
import { parseIdentifier } from "@scriptgo/shared";
import { parseArgs } from "../lib/args.ts";
import { ApiClient, describeError } from "./_api-client.ts";

export const summary = "Grant, list or revoke free licenses for your own packages (no payment involved)";

export const USAGE = `scriptgo grant create <package> --to <account id | creator username> [--environments <a,b>] [--deployments <n>]
    [--expires-days <n>] [--note "<who it is for>"] [--json]
scriptgo grant create <package> --server-key <server public key> --environment <env> [--name <deployment>]
    [--expires-days <n>] [--note "<who it is for>"] [--json]
scriptgo grant list <package> [--json]
scriptgo grant revoke <license id> --reason "<why>"

A granted license is free: nothing is sold and no payment provider is involved. It protects a
release (delivery to chosen servers, traceability, revocation); it does not sell it.
--to           the recipient's account id (they see it with 'scriptgo login' or in Dashboard → Settings),
               or a creator username. E-mail addresses are not accepted.
--server-key   the public key the operator's server prints with 'scriptgo escrow identity'. You hold
               the license; its one deployment is bound to that key, and the deployment token is
               printed once for you to hand to the operator.
<package> is one of your own packages: its name, or creator//name.`;

interface GrantRow {
  id: string;
  package: string;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  recipient: { kind: "account" | "server_key"; name: string; serverKeyFingerprint: string | null };
  environments: string[];
  deploymentsUsed: number;
  deploymentsAllowed: number;
  lastKeyReleaseAt: string | null;
  note: string;
}
interface GrantList {
  grants: GrantRow[];
  canGrant: boolean;
  blockedReason: string | null;
  perDay: number;
  grantedToday: number;
}

export interface GrantIo {
  api: ApiClient;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** "vip-lounge" or "studio//vip-lounge" → the package name the creator routes use. */
function packageName(ref: string): string {
  return parseIdentifier(ref)?.name ?? ref;
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

function describe(g: GrantRow): string {
  const who = g.recipient.kind === "server_key" ? `server key ${g.recipient.serverKeyFingerprint ?? "(reset)"} (${g.recipient.name})` : `account ${g.recipient.name}`;
  const until = g.status === "revoked" ? `revoked ${day(g.revokedAt)}` : g.expiresAt ? `until ${day(g.expiresAt)}` : "no end date";
  return `${g.id}  ${g.status.padEnd(8)} ${who}; ${g.deploymentsUsed}/${g.deploymentsAllowed} deployments; ${g.environments.join(", ") || "all environments"}; ${until}${g.note ? `; note: ${g.note}` : ""}`;
}

export async function runGrant(args: string[], io: GrantIo): Promise<number> {
  const [sub, ...rest] = args;
  const a = parseArgs(rest, { booleans: ["help", "json"] });
  const wantsHelp = sub === "--help" || a.bools.has("help");
  if (!sub || wantsHelp || !["create", "list", "revoke"].includes(sub)) {
    (wantsHelp ? io.out : io.err)(USAGE);
    return wantsHelp ? 0 : 2;
  }
  const usage = (message: string): number => {
    io.err(`scriptgo grant ${sub}: ${message}\n${USAGE}`);
    return 2;
  };
  const target = a.positional[0];

  try {
    if (sub === "list") {
      if (!target) return usage("name the package");
      const r = await io.api.get<GrantList>(`/v1/creator/packages/${encodeURIComponent(packageName(target))}/grants`);
      if (a.bools.has("json")) {
        io.out(JSON.stringify(r.data, null, 2));
        return 0;
      }
      if (r.data.grants.length === 0) io.out("no granted licenses for this package");
      for (const g of r.data.grants) io.out(describe(g));
      io.out(r.data.canGrant ? `you can grant: ${r.data.grantedToday} of ${r.data.perDay || "unlimited"} used in the last 24 hours` : `granting is closed: ${r.data.blockedReason}`);
      return 0;
    }

    if (sub === "revoke") {
      if (!target) return usage("give the license id (see 'scriptgo grant list <package>')");
      const reason = (a.flags.reason ?? "").trim();
      if (reason.length < 3) return usage("--reason is required: it is recorded and shown to the license holder");
      const r = await io.api.post<GrantRow>(`/v1/creator/grants/${encodeURIComponent(target)}/revoke`, { reason });
      io.out(`revoked ${r.data.id} (${r.data.package})`);
      io.out("the key endpoint refuses it from now on; a server that is running stops when the offline grace of its last answer ends");
      return 0;
    }

    // create
    if (!target) return usage("name the package");
    const to = a.flags.to;
    const serverKey = a.flags["server-key"];
    if (Boolean(to) === Boolean(serverKey)) return usage("give either --to <account> or --server-key <public key>");
    if (to && to.includes("@")) return usage("--to takes an account id or a creator username, not an e-mail address");
    if (serverKey && !a.flags.environment) return usage("--server-key needs --environment <env>, the environment of that server");
    const int = (flag: string): number | undefined | null => {
      const v = a.flags[flag];
      if (v === undefined) return undefined;
      return /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : null;
    };
    const deployments = int("deployments");
    const expiresInDays = int("expires-days");
    if (deployments === null) return usage("--deployments is a whole number above zero");
    if (expiresInDays === null) return usage("--expires-days is a whole number above zero");
    if (serverKey && deployments !== undefined && deployments !== 1) return usage("a server-key grant is for one server: leave --deployments out");

    const body: Record<string, unknown> = {
      ...(to ? { to } : { serverKey, environment: a.flags.environment, ...(a.flags.name ? { deploymentName: a.flags.name } : {}) }),
      ...(to && a.flags.environments ? { environments: a.flags.environments.split(",").map((e) => e.trim()).filter(Boolean) } : {}),
      ...(to && deployments ? { deployments } : {}),
      expiresInDays: expiresInDays ?? null,
      ...(a.flags.note ? { note: a.flags.note } : {}),
    };
    const r = await io.api.post<{ grant: GrantRow; deploymentToken: string | null }>(`/v1/creator/packages/${encodeURIComponent(packageName(target))}/grants`, body);
    if (a.bools.has("json")) {
      io.out(JSON.stringify(r.data, null, 2));
      return 0;
    }
    const g = r.data.grant;
    io.out(`granted a free license for ${g.package} (license ${g.id}); no payment is involved`);
    io.out(describe(g));
    if (r.data.deploymentToken) {
      io.out("deployment token (shown once; hand it to the operator of that server, over a private channel):");
      io.out(r.data.deploymentToken);
      io.out("on that server:");
      io.out(`  scriptgo add ${g.package} --deployment-token <the token>`);
      io.out(`  scriptgo escrow load --bundle <the downloaded .escrow.zip> --package ${g.package} --environment ${g.environments[0] ?? "<env>"} --deployment-token <the token> --identity <the same identity file>`);
      io.out("the token only works with the server key you granted to: another server is refused (server_key_mismatch)");
    } else {
      io.out("the recipient finds it under Dashboard → Licenses, reveals the key once and adds a deployment, as with any license");
    }
    return 0;
  } catch (e) {
    io.err(`scriptgo grant ${sub}: ${describeError(e)}`);
    return 1;
  }
}

export async function run(args: string[]): Promise<number> {
  const first = args[0];
  // Help and usage errors need no token.
  if (!first || first === "--help" || args.includes("--help") || !["create", "list", "revoke"].includes(first)) {
    return runGrant(args, { api: new ApiClient("", null), out: (l) => console.log(l), err: (l) => console.error(l) });
  }
  return runGrant(args, { api: ApiClient.fromEnvironment({ requireToken: true }), out: (l) => console.log(l), err: (l) => console.error(l) });
}
