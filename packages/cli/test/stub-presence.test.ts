import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PresenceResult } from "@scriptgo/shared";
import { startStubApi, type StubApi } from "../src/lib/stub-api.ts";
import { STUB_PRESENCE } from "../src/lib/stub-presence.ts";
import { apiChecks, serverTokenConvar } from "../src/commands/verify.ts";

let stub: StubApi;
beforeAll(async () => {
  stub = await startStubApi({ packages: ["sg_probe_presence"] });
});
afterAll(() => stub.close());

const call = async (method: string, path: string, body?: unknown, token = stub.serverToken) => {
  const r = await fetch(stub.url + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};
const fp = (key: string, address: string) => createHmac("sha256", key).update(address).digest("hex");

describe("stub player match API", () => {
  it("refuses an unknown server link token", async () => {
    expect((await call("POST", "/v1/presence", { players: [] }, "sg_srv_nope")).status).toBe(401);
    expect((await call("POST", "/v1/identity/codes/confirm", { code: "K7-4QX", player: "a:b" }, "sg_srv_nope")).status).toBe(401);
  });

  it("hands out the key on an empty report, then keeps fingerprints only", async () => {
    const first = await call("POST", "/v1/presence", '{"players":[]}');
    expect(first.status).toBe(200);
    const { presenceKey } = PresenceResult.parse(first.json);
    expect(presenceKey).toBe(STUB_PRESENCE.key);
    const entry = { player: "standalone:2", name: "Bob", fp: [fp(presenceKey, "203.0.113.7")] };
    const r = await call("POST", "/v1/presence", { players: [entry] });
    expect(r.json).toMatchObject({ accepted: 1, presenceKey });
    expect(stub.presence.entries().get("standalone:2")).toMatchObject({ name: "Bob", fp: entry.fp });
  });

  it("refuses a raw address where a fingerprint belongs", async () => {
    const r = await call("POST", "/v1/presence", { players: [{ player: "standalone:3", name: "Eve", fp: ["203.0.113.7"] }] });
    expect(r.status).toBe(400);
    expect(stub.presence.entries().has("standalone:3")).toBe(false);
  });

  it("removes an entry by its percent-encoded identifier", async () => {
    await call("POST", "/v1/presence", { players: [{ player: "rust:steam:7", name: "R", fp: [fp(STUB_PRESENCE.key, "198.51.100.23")] }] });
    expect((await call("DELETE", `/v1/presence/${encodeURIComponent("rust:steam:7")}`)).json).toEqual({ removed: true });
    expect((await call("DELETE", `/v1/presence/${encodeURIComponent("rust:steam:7")}`)).json).toEqual({ removed: false });
  });

  it("rotates the key", async () => {
    const next = stub.presence.rotate();
    const r = PresenceResult.parse((await call("POST", "/v1/presence", { players: [] })).json);
    expect(r.presenceKey).toBe(next);
    expect(next).not.toBe(STUB_PRESENCE.key);
  });

  it("confirms codes ignoring case, spaces and dashes, with the contract's refusals", async () => {
    expect((await call("POST", "/v1/identity/codes/confirm", { code: "k74qx", player: "standalone:2", name: "Bob" })).json).toEqual({ linked: true });
    expect(stub.presence.linked().at(-1)).toEqual({ player: "standalone:2", name: "Bob" });
    const used = await call("POST", "/v1/identity/codes/confirm", { code: "US-ED00", player: "standalone:2" });
    expect([used.status, used.json]).toEqual([410, { error: { code: "code_used", message: expect.any(String) } }]);
    expect((await call("POST", "/v1/identity/codes/confirm", { code: "EX-P1RE", player: "standalone:2" })).json).toMatchObject({ error: { code: "code_expired" } });
    expect((await call("POST", "/v1/identity/codes/confirm", { code: "ZZ-ZZZZ", player: "standalone:2" })).status).toBe(404);
    expect((await call("POST", "/v1/identity/codes/confirm", { code: "no!", player: "standalone:2" })).status).toBe(400);
  });

  it("feeds the report's api:presence_bodies_valid check", () => {
    const checks = apiChecks(stub.requests, 0, "standalone", "0.1.0");
    expect(checks.find((c) => c.name === "api:presence_bodies_valid")?.status).toBe("failed"); // the raw address above
    const from = stub.requests.length;
    stub.requests.push({ method: "POST", path: "/v1/presence", bodyError: null });
    expect(apiChecks(stub.requests, from, "standalone", "0.1.0").map((c) => c.status)).toEqual(["passed"]);
  });

  it("turns presence on only for a package that declares it", () => {
    expect(serverTokenConvar({ serverToken: "t" }, { capabilities: ["perks"] })).toEqual({ scriptgo_server_token: "t" });
    expect(serverTokenConvar({ serverToken: "t" }, { capabilities: ["presence"] })).toEqual({ scriptgo_server_token: "t", scriptgo_presence: "true" });
    expect(serverTokenConvar(undefined, { capabilities: ["presence"] })).toEqual({});
  });
});

describe("api:presence_fingerprint", () => {
  it("passes when every report is HMAC-SHA256(key, address), fails otherwise", async () => {
    const { fingerprintCheck, VERIFIER_ADDRESS } = await import("../src/commands/verify.ts");
    const key = "pk_test_20261111";
    const good = { key, fp: [fp(key, VERIFIER_ADDRESS)] };
    expect(fingerprintCheck([good], VERIFIER_ADDRESS).status).toBe("passed");
    expect(fingerprintCheck([good, { key, fp: [fp(key, "203.0.113.11")] }], VERIFIER_ADDRESS).status).toBe("failed");
    expect(fingerprintCheck([], VERIFIER_ADDRESS).status).toBe("failed");
  });
});
