import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VerifyResult } from "@scriptgo/shared";
import { startStubApi, type StubApi } from "../src/lib/stub-api.ts";
import { apiChecks } from "../src/commands/verify.ts";

let stub: StubApi;
beforeAll(async () => {
  stub = await startStubApi({ packages: ["sg_probe_net", "scriptgo//sg-probe-net"], environments: ["standalone", "open77"] });
});
afterAll(() => stub.close());

const post = async (path: string, body: unknown) => {
  const r = await fetch(stub.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};
const base = { package: "sg_probe_net", environment: "open77", adapterVersion: "open77-shim-0.3.0" };

describe("stub licensing API", () => {
  it("answers verify in the API's VerifyResult shape", async () => {
    const ok = await post("/v1/licenses/verify", { ...base, licenseKey: stub.licenseKey });
    expect(ok.status).toBe(200);
    expect(VerifyResult.parse(ok.json).valid).toBe(true);
    const unknown = await post("/v1/licenses/verify", { ...base, licenseKey: "sg_live_nope_nope" });
    expect(unknown.json).toMatchObject({ valid: false, reason: "unknown_key" });
    const otherEnv = await post("/v1/licenses/verify", { ...base, environment: "godot", licenseKey: stub.licenseKey });
    expect(otherEnv.json).toMatchObject({ valid: false, reason: "environment_not_covered" });
  });

  it("activates, then verifies the deployment token, bound to its environment", async () => {
    const act = await post("/v1/licenses/activate", { ...base, licenseKey: stub.licenseKey, deploymentName: "lab" });
    expect(act.status).toBe(201);
    const token = act.json.deploymentToken as string;
    expect(token).toMatch(/^sg_dep_/);
    expect((await post("/v1/licenses/verify", { ...base, deploymentToken: token })).json).toMatchObject({ valid: true, activationStatus: "active" });
    expect((await post("/v1/licenses/verify", { ...base, environment: "standalone", deploymentToken: token })).json).toMatchObject({
      valid: false,
      reason: "environment_not_covered",
    });
    const refused = await post("/v1/licenses/activate", { ...base, licenseKey: "sg_live_nope_nope", deploymentName: "lab" });
    expect(refused.status).toBe(404);
    expect(refused.json).toMatchObject({ error: { code: "unknown_key" } });
  });

  it("rejects a body the real API would reject, and records why", async () => {
    const from = stub.requests.length;
    const both = await post("/v1/licenses/verify", { ...base, licenseKey: stub.licenseKey, deploymentToken: "sg_dep_x" });
    expect(both.status).toBe(400);
    const checks = apiChecks(stub.requests, from, "open77", "open77-shim-0.3.0");
    expect(checks.find((c) => c.name === "api:bodies_valid")?.status).toBe("failed");
  });

  it("flags a request sent for the wrong environment or adapter", async () => {
    const from = stub.requests.length;
    await post("/v1/licenses/verify", { ...base, licenseKey: stub.licenseKey });
    const checks = apiChecks(stub.requests, from, "standalone", "0.1.0");
    expect(checks.map((c) => `${c.name}:${c.status}`)).toEqual(["api:bodies_valid:passed", "api:environment:failed", "api:adapter_version:failed"]);
    expect(apiChecks(stub.requests, stub.requests.length, "open77", "x")).toEqual([]);
  });
});
