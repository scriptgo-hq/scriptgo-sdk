// Garry's Mod packaging and the runner's pure helpers. No server runs here: the real runs are
// `scriptgo verify --env garrysmod` on a dedicated server (TEST_RESULTS.md).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { engineLines, luaErrors, srcdsArgs, verifyGarrysmod, verifyRequest, type GarrysmodVerifyOptions } from "../src/commands/verify-garrysmod.ts";
import { garrysmodPortability, packForGarrysmod } from "../src/lib/garrysmod.ts";
import { listFiles, readResource, repoRoot } from "../src/lib/sdk.ts";

const tmp = mkdtempSync(join(tmpdir(), "scriptgo-gmod-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function resource(name: string, files: Record<string, string>): string {
  const dir = join(tmp, "src", name);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  return dir;
}

const manifest = (name: string, extra: string): string =>
  `resource "${name}"\nversion "1.0.0"\nscriptgo_version ">=0.1.0"\n${extra}`;

describe("packForGarrysmod", () => {
  it("makes a resource addon with the manifest and its files, plus the runtime addon", () => {
    const res = readResource(join(repoRoot, "sdk", "conformance", "sg_probe"));
    const out = join(tmp, "pack1");
    const r = packForGarrysmod(res, out);
    expect(r.errors).toEqual([]);
    expect(r.dest).toBe(join(out, "scriptgo_sg_probe"));
    const addon = JSON.parse(readFileSync(join(r.dest, "addon.json"), "utf8"));
    expect(addon.type).toBe("servercontent");
    const root = join(r.dest, "lua", "scriptgo", "resources", "sg_probe");
    expect(readFileSync(join(root, "scriptgo.lua"), "utf8")).toBe(readFileSync(join(res.root, "scriptgo.lua"), "utf8"));
    expect(existsSync(join(root, "server", "probe.lua"))).toBe(true);
    // The runtime: autorun entry, host files and the core next to them.
    expect(existsSync(join(out, "scriptgo", "lua", "autorun", "server", "scriptgo.lua"))).toBe(true);
    expect(existsSync(join(out, "scriptgo", "lua", "scriptgo", "adapter.lua"))).toBe(true);
    expect(existsSync(join(out, "scriptgo", "lua", "scriptgo", "core", "init.lua"))).toBe(true);
    expect(r.warnings.join(" ")).not.toMatch(/does not list garrysmod/);
  });

  it("skips the runtime on request and warns about licensing and missing environments", () => {
    const res = readResource(join(repoRoot, "examples", "packages", "inventory_pro"));
    const out = join(tmp, "pack2");
    const r = packForGarrysmod(res, out, { runtime: false });
    expect(r.errors).toEqual([]);
    expect(existsSync(join(out, "scriptgo"))).toBe(false);
    const w = r.warnings.join("\n");
    expect(w).toMatch(/scriptgo_api convar/);
  });

  it("refuses a resource whose manifest references a missing file", () => {
    const dir = resource("gm_broken", { "scriptgo.lua": manifest("gm_broken", 'server_script "nope.lua"\n') });
    const r = packForGarrysmod(readResource(dir), join(tmp, "pack3"), { runtime: false });
    expect(r.errors.length).toBeGreaterThan(0);
    expect(existsSync(join(tmp, "pack3", "scriptgo_gm_broken"))).toBe(false);
  });
});

describe("garrysmodPortability", () => {
  it("flags client scripts, a dialect GLua lacks, `continue` and upper-case paths", () => {
    const dir = resource("gm_port", {
      "scriptgo.lua": manifest("gm_port", 'lua { "5.4" }\nenvironments { "standalone" }\nserver_script "Server/Main.lua"\nclient_script "client.lua"\n'),
      "Server/Main.lua": 'local continue = 1\n-- continue in a comment is fine\nlocal s = "continue"\nprint(t.continue, x:continue())\n',
      "client.lua": "print(1)\n",
    });
    const res = readResource(dir);
    if (!res.result.ok) throw new Error("fixture manifest is invalid");
    const issues = garrysmodPortability(dir, res.result.manifest, listFiles(dir));
    const codes = issues.map((i) => i.code);
    expect(codes).toContain("garrysmod_no_client");
    expect(codes).toContain("garrysmod_dialect");
    expect(codes).toContain("garrysmod_path_case");
    const cont = issues.filter((i) => i.code === "garrysmod_continue_keyword");
    expect(cont.map((i) => i.line)).toEqual([1]);
  });

  it("is quiet for a server-only LuaJIT resource with lower-case paths", () => {
    const dir = resource("gm_clean", {
      "scriptgo.lua": manifest("gm_clean", 'lua { "5.1", "luajit" }\nserver_script "server.lua"\n'),
      "server.lua": "for i = 1, 3 do if i == 2 then goto skip end ::skip:: end\n",
    });
    const res = readResource(dir);
    if (!res.result.ok) throw new Error("fixture manifest is invalid");
    expect(garrysmodPortability(dir, res.result.manifest, listFiles(dir))).toEqual([]);
  });
});

describe("garrysmod runner helpers", () => {
  it("binds srcds to loopback, in LAN mode, never hibernating; local HTTP only when asked", () => {
    const a = srcdsArgs(27115, "gm_construct", false);
    expect(a.join(" ")).toMatch(/-port 27115 \+ip 127\.0\.0\.1/);
    expect(a.join(" ")).toMatch(/\+sv_lan 1 \+sv_hibernate_think 1/);
    expect(a.slice(-2)).toEqual(["+map", "gm_construct"]);
    expect(a).not.toContain("-allowlocalhttp");
    expect(srcdsArgs(27115, "gm_construct", true)).toContain("-allowlocalhttp");
  });

  it("writes the verify request with the stub's licensing config merged under the run's extra config", () => {
    const opts: GarrysmodVerifyOptions = {
      port: 27115, seconds: 4, timeoutMs: 1000,
      stub: { url: "http://127.0.0.1:4999", licenseKey: "SG-TEST", requests: [], label: "stub" },
      example: null,
      extra: { config: { resources: { pkg: { greeting: "hi" } }, permissions: { user: ["a.*"] } }, botChat: ["/x"] },
    };
    const req = verifyRequest("pkg", opts);
    expect(req.resource).toBe("pkg");
    expect(req.with).toBeNull();
    expect(req.botChat).toEqual(["/x"]);
    expect(req.config).toEqual({
      resources: { pkg: { api: "http://127.0.0.1:4999", license_key: "SG-TEST", greeting: "hi" } },
      convars: { scriptgo_api: "http://127.0.0.1:4999" },
      permissions: { user: ["a.*"] },
    });
  });

  it("keeps SCRIPT//GO and error lines from the console log", () => {
    const log = [
      "Network: IP 127.0.0.1, mode MP, dedicated Yes, ports 27115 SV / 27005 CL",
      "[scriptgo] host SCRIPT//GO garrysmod-0.1.0 on 2026.09.17, LuaJIT 2.0.4: 4 resource(s) found",
      "[ERROR] addons/other/lua/autorun/x.lua:3: attempt to index nil",
      "  1. unknown - addons/other/lua/autorun/x.lua:3",
      "Host_Error: something fatal",
    ].join("\r\n");
    expect(engineLines(log)).toHaveLength(4);
    expect(luaErrors(log)).toEqual(["[ERROR] addons/other/lua/autorun/x.lua:3: attempt to index nil"]);
  });

  it("skips (not passes) without a server", async () => {
    const dir = resource("gm_noserver", { "scriptgo.lua": manifest("gm_noserver", 'server_script "s.lua"\n'), "s.lua": "" });
    const res = readResource(dir);
    if (!res.result.ok) throw new Error("fixture manifest is invalid");
    const report = await verifyGarrysmod(res, res.result.manifest, [join(tmp, "src")], {
      server: join(tmp, "no-such-server"), port: 27115, seconds: 1, timeoutMs: 1000,
    });
    expect(report.status).not.toBe("verified");
    expect(report.checks).toEqual([expect.objectContaining({ name: "server_run", status: "skipped" })]);
  });
});
