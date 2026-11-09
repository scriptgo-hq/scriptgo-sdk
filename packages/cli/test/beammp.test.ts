// The BeamMP target without a BeamMP server: packing, the verify runner's skip paths, and the
// plugin itself on a MOCK of BeamMP's Lua API (sdk/adapters/beammp/test). None of this is a
// verification: only `scriptgo verify --env beammp` against the real BeamMP-Server writes reports.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM build script without type declarations
import { buildPlugin } from "../../../sdk/adapters/beammp/build.mjs";
import { beammpClosure, beammpServerConfig, beammpWarnings, packForBeamMP, verifyBeamMP } from "../src/lib/beammp.ts";
import { defaultSearchPaths, readResource, repoRoot } from "../src/lib/sdk.ts";
import { startStubApi } from "../src/lib/stub-api.ts";

const tmp = mkdtempSync(join(tmpdir(), "scriptgo-beammp-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const search = [join(repoRoot, "sdk", "conformance"), ...defaultSearchPaths()];
const probe = readResource(join(repoRoot, "sdk", "conformance", "sg_probe"));
const exe = process.platform === "win32" ? ".exe" : "";
// Lua 5.3 first: it is the Lua of BeamMP-Server.
const interpreters = ["lua53", "lua54", "lua51", "luajit"]
  .map((name) => ({ name, path: join(repoRoot, "tools", "runtimes", "bin", name + exe) }))
  .filter((i) => existsSync(i.path));
const pluginTest = join(repoRoot, "sdk", "adapters", "beammp", "test", "plugin_test.lua");
const hasCurl = spawnSync("curl", ["--version"], { encoding: "utf8" }).status === 0;

function run(cmd: string, args: string[]): Promise<{ status: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => { out += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => { out += c.toString("utf8"); });
    child.on("close", (status) => done({ status, out }));
  });
}

describe("BeamMP ServerConfig.toml", () => {
  const toml = beammpServerConfig(30814);
  it("binds loopback, stays private and unlisted, and holds no key", () => {
    expect(toml).toContain("Port = 30814");
    expect(toml).toContain('IP = "127.0.0.1"');
    expect(toml).toContain("Private = true");
    expect(toml).toContain("InformationPacket = false");
    expect(toml).toContain("AllowGuests = false");
    expect(toml).toMatch(/^AuthKey = ""$/m);
  });
});

describe("pack --target beammp", () => {
  it("writes one plugin with the resource and its dependencies; main.lua is the only top-level script", () => {
    const r = packForBeamMP(probe, join(tmp, "pack"), search);
    expect(r.errors).toEqual([]);
    expect(r.resources).toEqual(["sg_eventbus", "sg_inventory", "sg_permissions", "sg_probe"]);
    // BeamMP runs every top-level .lua file of a plugin folder: only main.lua may be there.
    expect(readdirSync(r.dest).filter((f) => f.endsWith(".lua"))).toEqual(["main.lua"]);
    expect(existsSync(join(r.dest, "lib", "adapter.lua"))).toBe(true);
    expect(existsSync(join(r.dest, "core", "init.lua"))).toBe(true);
    expect(readdirSync(join(r.dest, "resources")).sort()).toEqual(r.resources);
    expect(existsSync(join(r.dest, "resources", "sg_probe", "tests"))).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it("adds to an existing plugin instead of replacing it", () => {
    const net = readResource(join(repoRoot, "sdk", "conformance", "sg_probe_net"));
    const r = packForBeamMP(net, join(tmp, "pack"), search);
    expect(r.errors).toEqual([]);
    const names = readdirSync(join(r.dest, "resources")).sort();
    expect(names).toContain("sg_probe");
    expect(names).toContain("sg_probe_net");
    expect(r.warnings.some((w) => /curl/.test(w))).toBe(true);
  });

  it("warns about what BeamMP does not run", () => {
    const inv = readResource(join(repoRoot, "sdk", "packages", "sg_inventory"));
    if (!inv.result.ok) throw new Error("sg_inventory manifest");
    const w = beammpWarnings(inv.result.manifest).join("\n");
    expect(w).toMatch(/client_script files are shipped but never run/);
    expect(w).toMatch(/does not list beammp/);
    expect(w).toMatch(/does not include 5\.3/);
  });

  it("refuses a missing dependency", () => {
    const { missing } = beammpClosure(probe, []);
    expect(missing.length).toBeGreaterThan(0);
    const r = packForBeamMP(probe, join(tmp, "pack-missing"), []);
    expect(r.errors[0]?.code).toBe("dependency_missing");
  });
});

describe("verify --env beammp without a runnable server", () => {
  if (!probe.result.ok) throw new Error("sg_probe manifest");
  const m = probe.result.manifest;
  it("is skipped, never verified, without a server binary", async () => {
    const r = await verifyBeamMP(probe, m, search, { server: null });
    expect(r.status).toBe("skipped");
    expect(r.checks.find((c) => c.name === "server_run")?.message).toMatch(/no BeamMP-Server binary/);
  });
  it("is skipped without an AuthKey, and says where the owner gets one", async () => {
    const fake = join(tmp, "BeamMP-Server" + exe);
    const r = await verifyBeamMP(probe, m, search, { server: fake, authKey: "" });
    expect(r.status).toBe("skipped");
    expect(r.checks.find((c) => c.name === "server_run")?.message).toMatch(/keymaster\.beammp\.com.*BEAMMP_AUTH_KEY/);
  });
});

describe.skipIf(interpreters.length === 0)("BeamMP plugin on the mock BeamMP API", () => {
  for (const lua of interpreters) {
    it(`runs sg_probe in verify mode, then players, commands, storage and reload (${lua.name})`, async () => {
      const dir = buildPlugin(join(tmp, `plugin-${lua.name}`), beammpClosure(probe, search).order.map((r) => r.root)) as string;
      const r = await run(lua.path, [pluginTest, dir, "basic"]);
      const fails = r.out.split(/\r?\n/).filter((l) => l.startsWith("FAIL"));
      expect(fails).toEqual([]);
      expect(r.out).toMatch(/(\d+)\/\1 checks passed/);
      expect(r.status).toBe(0);
    }, 60000);
  }

  // The runner end to end on a FAKE server process (the plugin on the mock API, no sockets): the
  // folder, the key handling, the report, the console `exit`, the cleanup.
  it("drives a server process: report, console exit, key kept out of the log, folder removed", async () => {
    if (!probe.result.ok) throw new Error("sg_probe manifest");
    const lua = interpreters[0]!;
    const fake = join(repoRoot, "sdk", "adapters", "beammp", "test", "fake_server.lua");
    const key = "00000000-test-key-not-real-000000000000";
    const before = new Set(readdirSync(tmpdir()).filter((f) => f.startsWith("scriptgo-beammp-")));
    process.env.BEAMMP_PORT = "1"; // must not reach the server: BeamMP lets it override the file
    try {
      const r = await verifyBeamMP(probe, probe.result.manifest, search, {
        server: lua.path, authKey: key, port: 30899, seconds: 2, launch: { command: lua.path, args: (dir) => [fake, dir] },
      });
      const byName = new Map(r.checks.map((c) => [c.name, c]));
      expect(byName.get("server_run")?.status).toBe("passed");
      expect(byName.get("server_run")?.message).toMatch(/all systems started/);
      expect(byName.get("starts")?.status).toBe("passed");
      expect(byName.get("environment_declared")?.status).toBe("passed");
      expect(r.checks.filter((c) => c.name.startsWith("self:") && c.status === "passed").length).toBe(25);
      expect(byName.get("no_plugin_errors")?.status).toBe("passed");
      // Nothing listens in the fake: the socket check says so instead of passing.
      expect(byName.get("listens_on_loopback_only")?.status).toMatch(/failed|skipped/);
      expect(r.evidence.stoppedBy).toBe("console exit");
      expect(r.log).not.toContain(key);
      expect(r.log).toContain(`key length ${key.length}, port override nil`);
      expect(r.runtimeVersion).toBe("BeamMP-Server 0.0.0"); // from the banner the server printed
      const after = readdirSync(tmpdir()).filter((f) => f.startsWith("scriptgo-beammp-") && !before.has(f));
      expect(after).toEqual([]);
    } finally {
      delete process.env.BEAMMP_PORT;
    }
  }, 90000);

  // Real curl, real stub API (schema-checked), mock BeamMP API, clock in real time.
  it.skipIf(!hasCurl)("ScriptGo.http and licensing through background curl, against the stub API", async () => {
    const lua = interpreters[0]!;
    const net = readResource(join(repoRoot, "sdk", "conformance", "sg_probe_net"));
    const stub = await startStubApi({ packages: ["sg_probe_net"] });
    try {
      const dir = buildPlugin(join(tmp, "plugin-net"), [net.root], {
        verify: { resource: "sg_probe_net", seconds: 8, report: "net-report.json" },
        resources: { sg_probe_net: { api: stub.url, license_key: stub.licenseKey } },
        convars: { scriptgo_api: stub.url },
        httpAllowedHosts: [new URL(stub.url).hostname],
      }) as string;
      const r = await run(lua.path, [pluginTest, dir, "realtime"]);
      const fails = r.out.split(/\r?\n/).filter((l) => l.startsWith("FAIL"));
      expect(fails).toEqual([]);
      expect(r.status).toBe(0);
      const report = JSON.parse(readFileSync(join(dir, "net-report.json"), "utf8")) as { checks: { name: string; status: string }[] };
      expect(report.checks.filter((c) => c.name.startsWith("self:")).length).toBeGreaterThanOrEqual(6);
      const licensing = stub.requests.filter((q) => q.path.startsWith("/v1/licenses/"));
      expect(licensing.length).toBeGreaterThan(0);
      expect(licensing.every((q) => q.bodyError === null && q.environment === "beammp" && q.adapterVersion === "beammp-0.1.0")).toBe(true);
    } finally {
      await stub.close();
    }
  }, 90000);
});
