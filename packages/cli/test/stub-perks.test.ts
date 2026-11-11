import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PerkCheckResult, PerkEventsResult } from "@scriptgo/shared";
import { startStubApi, type StubApi } from "../src/lib/stub-api.ts";
import { STUB_PERKS } from "../src/lib/stub-perks.ts";
import { apiChecks } from "../src/commands/verify.ts";

let stub: StubApi;
beforeAll(async () => {
  stub = await startStubApi({ packages: ["sg_probe_perks"] });
});
afterAll(() => stub.close());

const call = async (method: string, path: string, body?: unknown, token = stub.serverToken) => {
  const r = await fetch(stub.url + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};

describe("stub perks API", () => {
  it("refuses an unknown server link token", async () => {
    const r = await call("POST", "/v1/perks/check", { player: STUB_PERKS.holder }, "sg_srv_nope");
    expect(r.status).toBe(401);
    expect(r.json).toMatchObject({ error: { code: "unknown_server_link" } });
  });

  it("answers check in the API's shape: the holder has vip, anybody else nothing", async () => {
    const held = await call("POST", "/v1/perks/check", { player: STUB_PERKS.holder, environment: "standalone", adapterVersion: "0.1.0" });
    expect(held.status).toBe(200);
    expect(PerkCheckResult.parse(held.json).perks.map((p) => p.key)).toEqual(["vip"]);
    const none = await call("POST", "/v1/perks/check", { player: STUB_PERKS.buyer });
    expect(PerkCheckResult.parse(none.json).perks).toEqual([]);
    const bad = await call("POST", "/v1/perks/check", { player: "has space" });
    expect(bad.status).toBe(400);
  });

  it("queues a purchase, acknowledges it, and queues a new one for the next server that starts", async () => {
    const first = PerkEventsResult.parse((await call("GET", "/v1/perks/events?limit=100")).json);
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({ kind: "granted", perk: "vip", player: STUB_PERKS.buyer, reason: "purchase" });
    expect((await call("POST", "/v1/perks/events/ack", { upTo: first.cursor })).json).toEqual({ acked: first.cursor });
    // The same server, with its cursor: nothing new.
    const again = PerkEventsResult.parse((await call("GET", `/v1/perks/events?after=${first.cursor}`)).json);
    expect(again.events).toHaveLength(0);
    // Another run starts without a cursor: it gets its own purchase.
    const next = PerkEventsResult.parse((await call("GET", "/v1/perks/events")).json);
    expect(next.events.map((e) => e.seq)).toEqual([first.cursor + 1]);
  });

  it("answers the catalog and the purchase link refusals of the contract", async () => {
    const catalog = await call("GET", "/v1/perks/catalog");
    expect(catalog.json).toEqual(expect.arrayContaining([expect.objectContaining({ key: "vip", purchasable: true })]));
    expect((await call("POST", "/v1/perks/purchase-link", { player: STUB_PERKS.buyer, perk: "vip" })).status).toBe(201);
    expect((await call("POST", "/v1/perks/purchase-link", { player: STUB_PERKS.holder, perk: "vip" })).json).toMatchObject({ error: { code: "already_held" } });
    expect((await call("POST", "/v1/perks/purchase-link", { player: STUB_PERKS.buyer, perk: "gold" })).json).toMatchObject({ error: { code: "not_purchasable" } });
    expect((await call("POST", "/v1/perks/purchase-link", { player: STUB_PERKS.buyer, perk: "nope" })).json).toMatchObject({ error: { code: "unknown_perk" } });
  });

  it("feeds the report's api:perks_* checks", () => {
    const checks = apiChecks(stub.requests, 0, "standalone", "0.1.0");
    expect(checks.find((c) => c.name === "api:perks_bodies_valid")?.status).toBe("failed"); // the 400 above
    expect(checks.find((c) => c.name === "api:perks_environment")?.status).toBe("failed"); // checks without environment
    const from = stub.requests.length;
    stub.requests.push({ method: "POST", path: "/v1/perks/check", bodyError: null, environment: "standalone", adapterVersion: "0.1.0" });
    expect(apiChecks(stub.requests, from, "standalone", "0.1.0").map((c) => c.status)).toEqual(["passed", "passed"]);
  });
});
