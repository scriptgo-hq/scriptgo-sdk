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

  it("ships the core's perks module in the server shim, only for a resource that asks for perks", () => {
    const core = readFileSync(join(repoRoot, "sdk", "lua", "scriptgo", "perks.lua"), "utf8").replace(/\r\n/g, "\n").trimEnd();
    const res = readResource(join(repoRoot, "examples", "packages", "vip_perks"));
    const r = packForOpen77(res, tmp);
    expect(r.errors).toEqual([]);
    const server = readFileSync(join(r.dest, "scriptgo_shim_server.lua"), "utf8");
    // The one implementation, word for word: nothing about perks is written twice for OPEN//77.
    expect(server).toContain(core);
    expect(server).not.toMatch(/^\s*--\s*@(include|capability|end)\b/m);
    expect(server).toMatch(/O\.caps\.perks = true/);
    expect(readFileSync(join(r.dest, "open77.lua"), "utf8")).toMatch(/"http\.request"/);
    expect(r.warnings.join(" ")).toMatch(/scriptgo_server_token/);
    // Nothing in what was added needs a library the OPEN//77 sandbox does not have.
    expect(scanSource(server, "scriptgo_shim_server.lua", "server")).toEqual([]);
    expect(scanSource(readFileSync(join(r.dest, "scriptgo_shim.lua"), "utf8"), "scriptgo_shim.lua", "shared")).toEqual([]);
    // The client shim and a resource without perks carry none of it.
    expect(readFileSync(join(r.dest, "scriptgo_shim_client.lua"), "utf8")).not.toMatch(/perks/);
    const plain = packForOpen77(readResource(join(repoRoot, "sdk", "packages", "sg_inventory")), tmp);
    expect(readFileSync(join(plain.dest, "scriptgo_shim_server.lua"), "utf8")).not.toMatch(/purchaseLink|scriptgo_server_token/);
  });

  it("ships the presence module and asks for players.identity.sensitive only for a resource that declares presence", () => {
    const core = readFileSync(join(repoRoot, "sdk", "lua", "scriptgo", "presence.lua"), "utf8").replace(/\r\n/g, "\n").trimEnd();
    const res = readResource(join(repoRoot, "sdk", "conformance", "sg_probe_presence"));
    const r = packForOpen77(res, tmp);
    expect(r.errors).toEqual([]);
    const server = readFileSync(join(r.dest, "scriptgo_shim_server.lua"), "utf8");
    expect(server).toContain(core);
    expect(server).toMatch(/O\.caps\.presence = true/);
    expect(scanSource(server, "scriptgo_shim_server.lua", "server")).toEqual([]);
    const manifest = readFileSync(join(r.dest, "open77.lua"), "utf8");
    expect(manifest).toMatch(/"players\.identity\.sensitive"/);
    expect(manifest).toMatch(/"http\.request"/);
    expect(r.warnings.join(" ")).toMatch(/one resource per server/);
    expect(r.warnings.join(" ")).toMatch(/HMAC/);
    // A perks resource reads identifiers, never addresses: no sensitive permission, no presence code.
    const perks = packForOpen77(readResource(join(repoRoot, "examples", "packages", "vip_perks")), tmp);
    expect(readFileSync(join(perks.dest, "open77.lua"), "utf8")).not.toMatch(/identity\.sensitive/);
    expect(readFileSync(join(perks.dest, "scriptgo_shim_server.lua"), "utf8")).not.toMatch(/players\.endpoint|codes\/confirm/);
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
  it("refuses JavaScript and TypeScript scripts: OPEN//77 runs Lua only", () => {
    const dir = mkdtempSync(join(tmpdir(), "scriptgo-ts-"));
    try {
      writeFileSync(join(dir, "scriptgo.lua"), 'resource "tsres"\nversion "1.0.0"\nenvironments { "open77" }\nshared_script "shared.lua"\nserver_script "server.ts"\n');
      writeFileSync(join(dir, "shared.lua"), "return {}\n");
      writeFileSync(join(dir, "server.ts"), "export {};\n");
      const out = packForOpen77(readResource(dir), tmp);
      expect(out.errors.map((e) => e.code)).toEqual(["open77_lua_only"]);
      expect(out.errors[0]?.message).toMatch(/server\.ts/);
      expect(out.dest).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("packs a scriptgo.json resource and names it in the generated header", () => {
    const dir = mkdtempSync(join(tmpdir(), "scriptgo-json-"));
    try {
      writeFileSync(join(dir, "scriptgo.json"), JSON.stringify({ resource: "jsonres", version: "1.0.0", environments: ["open77"], server_script: "server.lua" }));
      writeFileSync(join(dir, "server.lua"), "return {}\n");
      const res = readResource(dir);
      expect(res.manifestFile).toBe("scriptgo.json");
      const out = packForOpen77(res, tmp);
      expect(out.errors).toEqual([]);
      expect(readFileSync(join(out.dest, "open77.lua"), "utf8")).toMatch(/from scriptgo\.json 1\.0\.0/);
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

describe("pack --target scriptgo", () => {
  it("ships README, CHANGELOG, LICENSE and test scripts, like publish", async () => {
    const { scriptgoArchive } = await import("../src/commands/pack.ts");
    const { buildArchive } = await import("../src/commands/publish.ts");
    const { unzipSync } = await import("fflate");
    const dir = join(repoRoot, "sdk", "packages", "sg_inventory");
    const res = readResource(dir);
    if (!res.result.ok) throw new Error("manifest");
    const all = listFiles(res.root);
    const packed = await scriptgoArchive(res.result.manifest, all, res.root, res.manifestFile);
    expect(packed.files).toContain("README.md");
    for (const t of res.result.manifest.testScripts) expect(packed.files.some((f) => f === t || f.startsWith(t.split("*")[0]!))).toBe(true);
    const names = Object.keys(unzipSync(packed.zip));
    expect(names).toContain(`${res.result.manifest.name}/README.md`);
    // The website upload and the CLI publish get byte-identical archives.
    expect(Buffer.from((await buildArchive(dir)).zip).equals(Buffer.from(packed.zip))).toBe(true);
  });
});
