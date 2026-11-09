// FiveM target: `pack --target fivem` and the `verify --env fivem` runner. No test here runs FiveM:
// the runner tests use a FAKE FXServer (test/fixtures/fake-fxserver.mjs) that only prints console
// lines, so they check process handling and parsing, never a package. Real evidence comes only from
// `scriptgo verify --env fivem` on a real FXServer.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fivemManifest, luaString, packForFivem } from "../src/lib/fivem-pack.ts";
import { fivemServerCfg, newFxConsole, readFxLine, verifyFivem } from "../src/lib/fivem-verify.ts";
import { findInterpreters, readResource, repoRoot } from "../src/lib/sdk.ts";

const tmp = mkdtempSync(join(tmpdir(), "scriptgo-fivem-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const search = [join(repoRoot, "sdk", "packages"), join(repoRoot, "sdk", "conformance"), join(repoRoot, "examples", "packages")];
const fake = join(repoRoot, "packages", "cli", "test", "fixtures", "fake-fxserver.mjs");

function resource(name: string, files: Record<string, string>): string {
  const dir = join(tmp, "src", name);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  return dir;
}

const manifest = (name: string, extra: string): string =>
  `resource "${name}"\nversion "1.0.0"\nscriptgo_version ">=0.1.0"\nenvironments { "standalone", "fivem" }\n${extra}`;

describe("luaString", () => {
  it("writes valid Lua literals", () => {
    expect(luaString('a "b" \\ c')).toBe('"a \\"b\\" \\\\ c"');
    expect(luaString("x\ny\u0001")).toBe('"x\\ny\\001"');
    expect(luaString("café")).toBe('"café"');
  });
});

describe("packForFivem", () => {
  it("writes an fxmanifest.lua that loads the shim before every script of the resource", () => {
    const r = packForFivem(readResource(join(repoRoot, "sdk", "packages", "sg_inventory")), join(tmp, "out"));
    expect(r.errors).toEqual([]);
    const text = readFileSync(join(r.dest, "fxmanifest.lua"), "utf8");
    expect(text).toMatch(/^fx_version "cerulean"$/m);
    expect(text).toMatch(/^game "gta5"$/m);
    expect(text).toMatch(/^version "1\.0\.2"$/m);
    const scripts = text.split("\n").filter((l) => /_script /.test(l));
    expect(scripts).toEqual([
      'shared_script "scriptgo_shim.lua"',
      'shared_script "shared/inventory.lua"',
      'server_script "server/main.lua"',
      'client_script "client/main.lua"',
    ]);
    expect(text).toMatch(/^scriptgo_permission "network\.events"$/m);
    expect(readFileSync(join(r.dest, "scriptgo_shim.lua"), "utf8")).toMatch(/ADAPTER_VERSION = "fivem-shim-/);
    expect(r.warnings.join(" ")).toMatch(/does not list fivem/);
  });

  it("drops dependency ranges FiveM cannot express, with a warning", () => {
    const r = packForFivem(readResource(join(repoRoot, "sdk", "conformance", "sg_probe")), join(tmp, "out"));
    expect(r.errors).toEqual([]);
    const text = readFileSync(join(r.dest, "fxmanifest.lua"), "utf8");
    expect(text).toMatch(/^dependencies \{ "sg_eventbus", "sg_inventory", "sg_permissions" \}$/m);
    expect(r.warnings.join(" ")).toMatch(/sg_eventbus >=1\.0\.0/);
  });

  it("refuses a licensed package: FiveM is free-only", () => {
    const r = packForFivem(readResource(join(repoRoot, "examples", "packages", "inventory_pro")), join(tmp, "out"));
    expect(r.errors.map((e) => e.code)).toContain("fivem_free_only");
    expect(r.errors[0]!.message).toMatch(/§3\.1\(6\)/);
    expect(r.dest).toBe("");
  });

  it("refuses a required licensing capability and warns about an optional one", () => {
    const req = resource("needs_lic", { "scriptgo.lua": manifest("needs_lic", 'capabilities { "licensing" }\nserver_script "s.lua"\n'), "s.lua": "print(1)\n" });
    expect(packForFivem(readResource(req), join(tmp, "out")).errors.map((e) => e.code)).toEqual(["fivem_free_only"]);
    const opt = resource("opt_lic", { "scriptgo.lua": manifest("opt_lic", 'optional_capabilities { "licensing" }\nserver_script "s.lua"\n'), "s.lua": "print(1)\n" });
    const r = packForFivem(readResource(opt), join(tmp, "out"));
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/capability_unavailable:licensing@fivem/);
  });

  it("refuses `require` and client-side `os`, unless --allow-unportable", () => {
    const dir = resource("unportable", {
      "scriptgo.lua": manifest("unportable", 'shared_script "shared.lua"\nserver_script "server.lua"\nclient_script "client.lua"\n'),
      "shared.lua": "local util = require(\"lib.util\")\n-- require('commented') is fine\nlocal s = 'require(\"in a string\")'\n",
      "server.lua": "local t = os.time()\nScriptGo.capabilities.require(\"http\")\n",
      "client.lua": "local t = os.clock()\n",
    });
    const r = packForFivem(readResource(dir), join(tmp, "out"));
    expect(r.errors.map((e) => e.code).sort()).toEqual(["fivem_client_no_os", "fivem_no_require"]);
    expect(r.errors.find((e) => e.code === "fivem_no_require")!.message).toMatch(/^shared\.lua:1 /);
    const loose = packForFivem(readResource(dir), join(tmp, "out"), { allowUnportable: true });
    expect(loose.errors).toEqual([]);
    expect(loose.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it("puts fivem environment scripts after the side scripts, on both sides", () => {
    const m = readResource(resource("envs", {
      "scriptgo.lua": manifest("envs", 'server_script "s.lua"\nclient_script "c.lua"\nenvironment_script "fivem" "env/fivem.lua"\nenvironment_script "love2d" "env/love.lua"\n'),
      "s.lua": "", "c.lua": "", "env/fivem.lua": "", "env/love.lua": "",
    })).result;
    if (!m.ok) throw new Error("manifest");
    const warnings: string[] = [];
    const text = fivemManifest(m.manifest, warnings);
    expect(text.split("\n").filter((l) => /_script /.test(l))).toEqual([
      'shared_script "scriptgo_shim.lua"', 'server_script "s.lua"', 'server_script "env/fivem.lua"', 'client_script "c.lua"', 'client_script "env/fivem.lua"',
    ]);
    expect(warnings.join(" ")).toMatch(/love2d/);
  });

  it("the generated fxmanifest.lua runs as Lua and declares what FiveM reads", () => {
    const lua = findInterpreters().find((i) => i.name === "lua54");
    if (!lua) return; // tools/build-lua.ps1 not run here
    const r = packForFivem(readResource(join(repoRoot, "sdk", "conformance", "sg_probe")), join(tmp, "out"));
    // FiveM evaluates fxmanifest.lua with a metatable that turns every unknown global into a
    // directive; this stand-in records them the same way.
    const harness = join(tmp, "read-manifest.lua");
    writeFileSync(harness, [
      "local seen = {}",
      "local env = setmetatable({}, { __index = function(_, k) return function(v) seen[#seen + 1] = k .. '=' .. (type(v) == 'table' and table.concat(v, ',') or tostring(v)) end end })",
      "local chunk = assert(loadfile(arg[1], 't', env))",
      "chunk()",
      "print(table.concat(seen, '\\n'))",
    ].join("\n"));
    const out = spawnSync(lua.path, [harness, join(r.dest, "fxmanifest.lua")], { encoding: "utf8" });
    expect(out.status).toBe(0);
    const seen = out.stdout.trim().split(/\r?\n/);
    expect(seen.slice(0, 3)).toEqual(["fx_version=cerulean", "game=gta5", "version=0.1.0"]);
    expect(seen).toContain("shared_script=scriptgo_shim.lua");
    expect(seen).toContain("server_script=server/probe.lua");
    expect(seen).toContain("dependencies=sg_eventbus,sg_inventory,sg_permissions");
  });
});

describe("FXServer console", () => {
  // Lines built from the format strings in the FXServer build 38435 binaries.
  const lines = [
    "[           resources] Started resource sg_eventbus",
    "[           resources] Started resource sg_probe (1 warning)",
    "[ citizen-server-impl] \u001b[33mCouldn't start resource sg_inventory.\u001b[0m",
    "[     script:sg_probe] ^1SCRIPT ERROR: @sg_probe/server/probe.lua:12: attempt to index a nil value^7",
    "[     script:sg_probe] Error loading script server/x.lua in resource sg_probe: syntax error",
    "[     script:other_res] ^1SCRIPT ERROR: @other_res/a.lua:1: not ours^7",
    "[          svadhesive] Server license key authentication succeeded. Welcome!",
  ];
  it("reads starts, failures, script errors and the licence state", () => {
    const s = newFxConsole();
    for (const l of lines) readFxLine(s, l, ["sg_eventbus", "sg_probe", "sg_inventory"]);
    expect([...s.started].sort()).toEqual(["sg_eventbus", "sg_probe"]);
    expect(s.failed.get("sg_inventory")).toMatch(/Couldn't start resource sg_inventory/);
    expect(s.failed.get("sg_probe")).toMatch(/attempt to index a nil value/);
    expect(s.errorLines).toHaveLength(3);
    expect(s.licenseOk).toBe(true);
    expect(s.lines[3]).not.toMatch(/\^1|\u001b/);
  });
  it("sees the missing-key fatal error", () => {
    const s = newFxConsole();
    readFxLine(s, "[          svadhesive] Error: This server does not have a license key specified. Please set the sv_licenseKey console variable", []);
    readFxLine(s, "Fatal Error: This server does not have a license key specified.", []);
    expect(s.licenseError).toMatch(/does not have a license key/);
    expect(s.fatal).toMatch(/license key/);
  });
  it("server.cfg binds loopback only and keeps the server off the list", () => {
    const cfg = fivemServerCfg(30121, ["a", "b"], { "a:api": "http://127.0.0.1:1/" });
    expect(cfg).toMatch(/^endpoint_add_tcp "127\.0\.0\.1:30121"$/m);
    expect(cfg).toMatch(/^endpoint_add_udp "127\.0\.0\.1:30121"$/m);
    expect(cfg).toMatch(/^sv_master1 ""$/m);
    expect(cfg).not.toMatch(/0\.0\.0\.0|sv_licenseKey/);
    expect(cfg).toMatch(/^ensure a\nensure b\n$/m);
  });
});

describe("verifyFivem", () => {
  const probe = readResource(join(repoRoot, "sdk", "conformance", "sg_probe"));
  const m = probe.result.ok ? probe.result.manifest : null!;
  const base = { port: 30121, settleMs: 50, timeoutMs: 20000, workDir: join(tmp, "runs"), example: null };

  it("is skipped, never verified, without a server binary", async () => {
    const r = await verifyFivem(probe, m, search, { ...base, server: join(tmp, "missing", "FXServer.exe"), licenseKey: "k" });
    expect(r.status).toBe("skipped");
    expect(r.checks.find((c) => c.name === "server_run")!.message).toMatch(/no FXServer/);
  });

  it("is skipped, never verified, without a licence key", async () => {
    const r = await verifyFivem(probe, m, search, { ...base, server: process.execPath, licenseKey: "" });
    expect(r.status).toBe("skipped");
    expect(r.checks.find((c) => c.name === "server_run")!.message).toMatch(/SCRIPTGO_FIVEM_LICENSE_KEY/);
  });

  it("drives a (fake) server: ensures every packed resource and reads their verdicts", async () => {
    const r = await verifyFivem(probe, m, search, { ...base, licenseKey: "fake-key-123", launcher: [process.execPath, fake] });
    expect(r.environment).toBe("fivem");
    expect(r.runtimeVersion).toBe("fake FXServer (test)");
    for (const n of ["sg_eventbus", "sg_inventory", "sg_permissions", "sg_probe"]) {
      expect(r.checks.find((c) => c.name === `starts:${n}`)!.status).toBe("passed");
    }
    expect(r.checks.find((c) => c.name === "license_key")!.status).toBe("passed");
    expect(r.checks.find((c) => c.name === "server_run")!.status).toBe("passed");
    expect(r.log).not.toMatch(/fake-key-123/);
  });

  it("reports a script error and failed self-checks as failing", async () => {
    process.env.FAKE_FX_SCRIPT_ERROR = "sg_probe";
    process.env.FAKE_FX_SGCHECK = "sg_probe";
    try {
      const r = await verifyFivem(probe, m, search, { ...base, licenseKey: "k", launcher: [process.execPath, fake] });
      expect(r.status).toBe("failing");
      expect(r.checks.find((c) => c.name === "starts:sg_probe")!.message).toMatch(/boom/);
      expect(r.checks.find((c) => c.name === "no_runtime_errors")!.status).toBe("failed");
      expect(r.checks.find((c) => c.name === "self:runtime.side")!.status).toBe("passed");
      expect(r.checks.find((c) => c.name === "self:storage.roundtrip")!.status).toBe("failed");
    } finally {
      delete process.env.FAKE_FX_SCRIPT_ERROR;
      delete process.env.FAKE_FX_SGCHECK;
    }
  });

  it("refuses to pack a licensed package before any server starts", async () => {
    const pro = readResource(join(repoRoot, "examples", "packages", "inventory_pro"));
    const r = await verifyFivem(pro, pro.result.ok ? pro.result.manifest : null!, search, { ...base, licenseKey: "k", launcher: [process.execPath, fake] });
    expect(r.status).toBe("failing");
    expect(r.checks.find((c) => c.name === "packs:inventory_pro")!.message).toMatch(/fivem_free_only/);
    expect(r.checks.some((c) => c.name === "server_run")).toBe(false);
  });
});
