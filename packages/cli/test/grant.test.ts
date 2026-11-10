import { describe, expect, it } from "vitest";
import { ApiClient } from "../src/commands/_api-client.ts";
import { runGrant, summary, USAGE } from "../src/commands/grant.ts";

/** A fake SCRIPT//GO API: records every request, answers from `routes`. */
function fakeApi(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: { method: string; path: string; body: any; auth: string | null }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    const headers = init?.headers as Record<string, string>;
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null, auth: headers.authorization ?? null });
    const route = routes[`${method} ${path}`];
    if (!route) return new Response(JSON.stringify({ error: { code: "not_found", message: "No such route in the fake." } }), { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const out: string[] = [];
  const err: string[] = [];
  return { calls, out, err, io: { api: new ApiClient("http://api.test", "sg_pat_test", fetchImpl), out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

const KEY = "Zm9yLXRlc3RzLW9ubHktMzItYnl0ZXMtb2Yta2V5LS0tLS0"; // 43 base64url characters
const TOKEN = "sg_dep_handed_over_once_000000000000";
const row = (over: Record<string, unknown> = {}) => ({
  id: "lic_1",
  package: "studio//vip-lounge",
  status: "active",
  createdAt: "2026-11-10T10:00:00.000Z",
  expiresAt: null,
  revokedAt: null,
  revokedReason: null,
  recipient: { kind: "account", name: "Night City RP", serverKeyFingerprint: null },
  environments: ["standalone"],
  deploymentsUsed: 0,
  deploymentsAllowed: 1,
  lastKeyReleaseAt: null,
  note: "",
  ...over,
});

describe("scriptgo grant", () => {
  it("says what it is: free, no payment, protection and not a sale", () => {
    expect(summary).toMatch(/free licenses/);
    expect(summary).toMatch(/no payment/);
    expect(USAGE).toMatch(/nothing is sold and no payment provider is involved/);
    expect(USAGE).toMatch(/it does not sell it/);
    expect(USAGE).not.toMatch(/unbreakable|cannot be copied|secure against/i);
  });

  it("prints usage: exit 0 for --help, 2 for a missing or unknown subcommand", async () => {
    const help = fakeApi({});
    expect(await runGrant(["--help"], help.io)).toBe(0);
    expect(help.out.join("\n")).toContain("scriptgo grant create <package> --to");
    const none = fakeApi({});
    expect(await runGrant([], none.io)).toBe(2);
    expect(await runGrant(["give", "vip-lounge"], none.io)).toBe(2);
    expect(none.err.join("\n")).toContain("scriptgo grant revoke <license id>");
    expect(none.calls).toHaveLength(0);
  });

  it("grants to an account, by package name or creator//name", async () => {
    const f = fakeApi({ "POST /v1/creator/packages/vip-lounge/grants": { status: 201, body: { grant: row({ deploymentsAllowed: 2, expiresAt: "2026-12-10T10:00:00.000Z", note: "partner" }), deploymentToken: null } } });
    const code = await runGrant(["create", "studio//vip-lounge", "--to", "usr_9", "--deployments", "2", "--expires-days", "30", "--environments", "standalone, dotnet", "--note", "partner"], f.io);
    expect(code).toBe(0);
    expect(f.calls).toEqual([
      { method: "POST", path: "/v1/creator/packages/vip-lounge/grants", auth: "Bearer sg_pat_test", body: { to: "usr_9", environments: ["standalone", "dotnet"], deployments: 2, expiresInDays: 30, note: "partner" } },
    ]);
    const text = f.out.join("\n");
    expect(text).toContain("granted a free license for studio//vip-lounge (license lic_1); no payment is involved");
    expect(text).toContain("account Night City RP; 0/2 deployments; standalone; until 2026-12-10; note: partner");
    expect(text).toContain("Dashboard → Licenses");
    expect(text).not.toContain("sg_dep_");
  });

  it("grants to a server key and prints the deployment token once, with what the operator runs", async () => {
    const grant = row({ id: "lic_2", recipient: { kind: "server_key", name: "badlands-1", serverKeyFingerprint: "0123456789abcdef" }, deploymentsUsed: 1 });
    const f = fakeApi({ "POST /v1/creator/packages/vip-lounge/grants": { status: 201, body: { grant, deploymentToken: TOKEN } } });
    expect(await runGrant(["create", "vip-lounge", "--server-key", KEY, "--environment", "standalone", "--name", "badlands-1"], f.io)).toBe(0);
    expect(f.calls[0]!.body).toEqual({ serverKey: KEY, environment: "standalone", deploymentName: "badlands-1", expiresInDays: null });
    const text = f.out.join("\n");
    expect(text).toContain("server key 0123456789abcdef (badlands-1); 1/1 deployments");
    expect(text).toContain("deployment token (shown once");
    expect(f.out.filter((l) => l === TOKEN)).toHaveLength(1);
    expect(text).toContain("scriptgo add studio//vip-lounge --deployment-token <the token>");
    expect(text).toContain("another server is refused (server_key_mismatch)");
  });

  it("refuses bad input before calling the API", async () => {
    const f = fakeApi({});
    const bad = [
      ["create"],
      ["create", "vip-lounge"],
      ["create", "vip-lounge", "--to", "usr_9", "--server-key", KEY, "--environment", "standalone"],
      ["create", "vip-lounge", "--to", "someone@example.test"],
      ["create", "vip-lounge", "--server-key", KEY],
      ["create", "vip-lounge", "--server-key", KEY, "--environment", "standalone", "--deployments", "3"],
      ["create", "vip-lounge", "--to", "usr_9", "--deployments", "0"],
      ["create", "vip-lounge", "--to", "usr_9", "--expires-days", "soon"],
      ["list"],
      ["revoke"],
      ["revoke", "lic_1"],
      ["revoke", "lic_1", "--reason", "x"],
    ];
    for (const args of bad) expect(await runGrant(args, f.io), args.join(" ")).toBe(2);
    expect(f.calls).toHaveLength(0);
    expect(f.err.join("\n")).toContain("not an e-mail address");
  });

  it("lists grants with their status and whether a new one can be issued", async () => {
    const grants = [
      row(),
      row({ id: "lic_2", status: "revoked", revokedAt: "2026-11-09T08:00:00.000Z", recipient: { kind: "server_key", name: "badlands-1", serverKeyFingerprint: "0123456789abcdef" }, deploymentsUsed: 1 }),
    ];
    const f = fakeApi({ "GET /v1/creator/packages/vip-lounge/grants": { body: { grants, canGrant: true, blockedCode: null, blockedReason: null, perDay: 25, grantedToday: 2 } } });
    expect(await runGrant(["list", "vip-lounge"], f.io)).toBe(0);
    expect(f.out).toEqual([
      "lic_1  active   account Night City RP; 0/1 deployments; standalone; no end date",
      "lic_2  revoked  server key 0123456789abcdef (badlands-1); 1/1 deployments; standalone; revoked 2026-11-09",
      "you can grant: 2 of 25 used in the last 24 hours",
    ]);

    const held = fakeApi({ "GET /v1/creator/packages/vip-lounge/grants": { body: { grants: [], canGrant: false, blockedCode: "listing_restricted", blockedReason: "This listing is restricted by a moderation decision: no license can be granted for it.", perDay: 25, grantedToday: 0 } } });
    expect(await runGrant(["list", "vip-lounge"], held.io)).toBe(0);
    expect(held.out).toEqual(["no granted licenses for this package", "granting is closed: This listing is restricted by a moderation decision: no license can be granted for it."]);

    const json = fakeApi({ "GET /v1/creator/packages/vip-lounge/grants": { body: { grants, canGrant: true, blockedCode: null, blockedReason: null, perDay: 25, grantedToday: 2 } } });
    expect(await runGrant(["list", "vip-lounge", "--json"], json.io)).toBe(0);
    expect(JSON.parse(json.out.join("\n")).grants).toHaveLength(2);
  });

  it("revokes with a reason and says what happens next", async () => {
    const f = fakeApi({ "POST /v1/creator/grants/lic_1/revoke": { body: row({ status: "revoked", revokedAt: "2026-11-10T12:00:00.000Z", revokedReason: "the partnership ended" }) } });
    expect(await runGrant(["revoke", "lic_1", "--reason", "the partnership ended"], f.io)).toBe(0);
    expect(f.calls[0]).toMatchObject({ method: "POST", path: "/v1/creator/grants/lic_1/revoke", body: { reason: "the partnership ended" } });
    expect(f.out[0]).toBe("revoked lic_1 (studio//vip-lounge)");
    expect(f.out[1]).toMatch(/refuses it from now on.*offline grace/);
  });

  it("reports the API's refusal with its code and exits 1", async () => {
    const f = fakeApi({
      "POST /v1/creator/packages/vip-lounge/grants": { status: 409, body: { error: { code: "grant_blocked", message: "This listing is restricted by a moderation decision: no license can be granted for it.", details: { reason: "listing_restricted" } } } },
      "POST /v1/creator/grants/lic_9/revoke": { status: 404, body: { error: { code: "not_found", message: "No such granted license in your packages." } } },
    });
    expect(await runGrant(["create", "vip-lounge", "--to", "usr_9"], f.io)).toBe(1);
    expect(f.err[0]).toBe("scriptgo grant create: grant_blocked: This listing is restricted by a moderation decision: no license can be granted for it.");
    expect(await runGrant(["revoke", "lic_9", "--reason", "not mine"], f.io)).toBe(1);
    expect(f.err[1]).toBe("scriptgo grant revoke: not_found: No such granted license in your packages.");
    expect(f.out).toHaveLength(0);
  });
});
