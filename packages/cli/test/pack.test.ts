import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseManifest } from "@scriptgo/manifest";
import { packForOpen77, stripCapabilitySections, toOpen77Constraint } from "../src/commands/pack.ts";
import { selfChecks, toCompatibilityRun } from "../src/commands/verify.ts";
import { open77Portability, scanSource } from "../src/lib/portability.ts";
import { listFiles, readResource, repoRoot } from "../src/lib/sdk.ts";

const tmp = mkdtempSync(join(tmpdir(), "scriptgo-cli-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("toOpen77Constraint", () => {
  it("expands caret and tilde into two comparators", () => {
    expect(toOpen77Constraint("^1.2.0").constraint).toBe(">=1.2.0 <2.0.0");
    expect(toOpen77Constraint("^0.3.1").constraint).toBe(">=0.3.1 <0.4.0");
    expect(toOpen77Constraint("~1.4").constraint).toBe(">=1.4.0 <1.5.0");
    expect(toOpen77Constraint(">=1.0.0").constraint).toBe(">=1.0.0");
  });
  it("drops what OPEN//77 cannot express, with a warning", () => {
    const r = toOpen77Constraint("^1.0.0 || ^2.0.0");
    expect(r.constraint).toBeNull();
    expect(r.warning).toMatch(/\|\|/);
  });
});

describe("stripCapabilitySections", () => {
  const text = ["a", "-- @capability ui", "ui()", "-- @end", "-- @capability players", "players()", "-- @end", "b"].join("\n");
  it("keeps only the sections of requested capabilities", () => {
    expect(stripCapabilitySections(text, new Set(["players"]))).toBe(["a", "players()", "b"].join("\n"));
    expect(stripCapabilitySections(text, new Set())).toBe(["a", "b"].join("\n"));
  });
  it("rejects unbalanced markers", () => {
    expect(() => stripCapabilitySections("-- @capability ui\nx", new Set())).toThrow(/never closed/);
    expect(() => stripCapabilitySections("-- @end", new Set())).toThrow(/without/);
  });
  it("the shipped shims are balanced", () => {
    for (const f of ["shim.lua", "shim_server.lua", "shim_client.lua"]) {
      const shim = readFileSync(join(repoRoot, "sdk", "adapters", "open77", f), "utf8");
      expect(() => stripCapabilitySections(shim, new Set())).not.toThrow();
    }
  });
});

describe("packForOpen77", () => {
  it("writes an OPEN//77 manifest that loads the shim before the resource's scripts", () => {
    const res = readResource(join(repoRoot, "sdk", "packages", "sg_inventory"));
    const r = packForOpen77(res, tmp);
    expect(r.errors).toEqual([]);
    const manifest = readFileSync(join(r.dest, "open77.lua"), "utf8");
    const parsed = parseManifest(manifest, { fileName: "open77.lua" });
    expect(parsed.ok).toBe(true);
    const order = manifest.split("\n").filter((l) => /_script /.test(l));
    expect(order.slice(0, 3)).toEqual([
      'shared_script "scriptgo_shim.lua"',
      'server_script "scriptgo_shim_server.lua"',
      'client_script "scriptgo_shim_client.lua"',
    ]);
    // permissions capability is optional in sg_inventory, so the ACL read is kept and declared.
    expect(manifest).toMatch(/"acl\.read"/);
    expect(readFileSync(join(r.dest, "scriptgo_shim_server.lua"), "utf8")).toMatch(/Open77\.acl\.isAllowed/);
  });

  it("leaves out shim sections, and their permissions, for capabilities not asked for", () => {
    const res = readResource(join(repoRoot, "sdk", "packages", "sg_eventbus"));
    const r = packForOpen77(res, tmp);
    expect(r.errors).toEqual([]);
    expect(readFileSync(join(r.dest, "open77.lua"), "utf8")).not.toMatch(/acl\.read/);
    const server = readFileSync(join(r.dest, "scriptgo_shim_server.lua"), "utf8");
    expect(server).not.toMatch(/acl\.isAllowed|notifications|GetConvar/);
    expect(server).toMatch(/GetPlayers/); // players is optional in sg_eventbus
  });

  it("packs a licensed resource with http.request and tells the operator about the allow-list", () => {
    const res = readResource(join(repoRoot, "examples", "packages", "inventory_pro"));
    const r = packForOpen77(res, tmp);
    expect(r.errors).toEqual([]);
    expect(readFileSync(join(r.dest, "open77.lua"), "utf8")).toMatch(/"http\.request"/);
    expect(r.warnings.join(" ")).toMatch(/http\.allowedHosts/);
    const server = readFileSync(join(r.dest, "scriptgo_shim_server.lua"), "utf8");
    expect(server).toMatch(/O\.caps\.licensing = true/);
    expect(server).toMatch(/Open77\.http\.request/);
    // The client shim never reaches the network.
    expect(readFileSync(join(r.dest, "scriptgo_shim_client.lua"), "utf8")).not.toMatch(/http/);
  });

  it("switches a capability on only where its section was kept", () => {
    const res = readResource(join(repoRoot, "sdk", "conformance", "sg_probe"));
    const r = packForOpen77(res, tmp);
    expect(r.errors).toEqual([]);
    const server = readFileSync(join(r.dest, "scriptgo_shim_server.lua"), "utf8");
    expect(server).not.toMatch(/O\.caps\.(http|licensing|ui) = true/);
    expect(readFileSync(join(r.dest, "open77.lua"), "utf8")).not.toMatch(/http\.request/);
  });

  it("refuses code that cannot run in the OPEN//77 sandbox unless forced", () => {
    const dir = mkdtempSync(join(tmpdir(), "scriptgo-unportable-"));
    try {
      writeFileSync(join(dir, "scriptgo.lua"), 'resource "unportable"\nversion "1.0.0"\nenvironments { "open77" }\nserver_script "server.lua"\n');
      writeFileSync(join(dir, "server.lua"), "print(os.time())\n");
      const res = readResource(dir);
      expect(packForOpen77(res, tmp).errors.map((e) => e.code)).toEqual(["open77_no_os"]);
      const forced = packForOpen77(res, tmp, { allowUnportable: true });
      expect(forced.errors).toEqual([]);
      expect(forced.warnings.join(" ")).toMatch(/server\.lua:1/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("OPEN//77 portability lint", () => {
  it("flags os, io and client metatables, not lookalikes in names, strings or comments", () => {
    const src = [
      "local t = os.time()",
      'local photo = "photos.png"; local my_os = {}; print(my_os.time)',
      "-- os.clock() in a comment",
      "--[[ io.open in a long comment ]]",
      'local s = "io.write in a string"',
      "local mt = setmetatable({}, {})",
      "local f = io.open('x')",
    ].join("\n");
    const client = scanSource(src, "client/main.lua", "client").map((i) => `${i.code}@${i.line}`);
    expect(client).toEqual(["open77_no_os@1", "open77_client_no_metatables@6", "open77_no_io@7"]);
    const server = scanSource(src, "server/main.lua", "server").map((i) => `${i.code}@${i.line}`);
    expect(server).toEqual(["open77_no_os@1", "open77_no_io@7"]);
  });
  it("the official packages and the probe are clean", () => {
    for (const dir of ["sdk/packages/sg_eventbus", "sdk/packages/sg_permissions", "sdk/packages/sg_inventory", "sdk/conformance/sg_probe"]) {
      const res = readResource(join(repoRoot, dir));
      if (!res.result.ok) throw new Error(dir);
      expect(open77Portability(res.root, res.result.manifest, listFiles(res.root))).toEqual([]);
    }
  });
});

describe("toCompatibilityRun", () => {
  it("writes the registry's CompatibilityRun shape", () => {
    const run = toCompatibilityRun({
      package: "sg_probe", version: "0.1.0", environment: "luanti", status: "verified", runtimeVersion: "Luanti 5.18.0",
      adapterVersion: "luanti-0.1.0", luaVersion: "LuaJIT 2.1", durationMs: 1234.4, log: "x",
      checks: [{ name: "starts", status: "passed", message: "" }], evidence: { image: "img@sha256:abc", resources: ["a", "b"], empty: "" },
    }, "luanti", "2026-11-09T05:00:00.000Z");
    expect(run.runId).toBe("sg_probe@0.1.0:luanti:2026-11-09T05:00:00.000Z");
    expect(run.evidence).toEqual([{ kind: "image", path: "img@sha256:abc" }, { kind: "resources", path: "a,b" }]);
    expect(run.durationMs).toBe(1234);
  });
});

describe("selfChecks", () => {
  it("turns SGCHECK lines into checks and requires DONE", () => {
    const log = ["[x] SGCHECK PASS a", "[x] SGCHECK FAIL b got 3", "noise"].join("\n");
    const checks = selfChecks(log);
    expect(checks.map((c) => `${c.name}:${c.status}`)).toEqual(["self:a:passed", "self:b:failed", "self:done:failed"]);
    expect(checks[1]!.message).toBe("got 3");
    expect(selfChecks(log + "\nSGCHECK DONE pass=1 fail=1").length).toBe(2);
    expect(selfChecks("nothing here")).toEqual([]);
  });
});
