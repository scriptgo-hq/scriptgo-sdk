import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readResource, repoRoot } from "../src/lib/sdk.ts";
import { findHytaleServer, hytaleArgs, javaMajor, verifyHytale } from "../src/commands/verify-hytale.ts";

// The Hytale runner's own logic. No Hytale server runs here: these tests never produce a report.

describe("javaMajor", () => {
  it("reads modern and legacy version strings", () => {
    expect(javaMajor('openjdk version "25.0.1" 2025-10-21\nOpenJDK Runtime Environment')).toBe(25);
    expect(javaMajor('java version "21.0.12" 2026-07-15 LTS')).toBe(21);
    expect(javaMajor('java version "1.8.0_412"')).toBe(8);
    expect(javaMajor("nothing here")).toBe(0);
  });
});

describe("hytaleArgs", () => {
  it("binds loopback, runs offline without Sentry and hands the plugin its verify options", () => {
    const argv = hytaleArgs({ server: "/srv/hytale", run: "/srv/hytale/scriptgo-runs/x", resource: "sg_probe", with: "sg_probe_readme", seconds: 5, port: 5521 });
    expect(argv.slice(argv.indexOf("-jar"))).toEqual([
      "-jar", join("/srv/hytale", "HytaleServer.jar"),
      "--assets", join("/srv/hytale", "Assets.zip"),
      "--bind", "127.0.0.1:5521",
      "--auth-mode", "offline",
      "--disable-sentry",
    ]);
    expect(argv).toContain("-Dscriptgo.verify=sg_probe");
    expect(argv).toContain("-Dscriptgo.verify.with=sg_probe_readme");
    expect(argv).toContain(`-Dscriptgo.resources=${join("/srv/hytale/scriptgo-runs/x", "resources")}`);
    expect(argv.indexOf("-Dscriptgo.verify=sg_probe")).toBeLessThan(argv.indexOf("-jar"));
  });
});

describe("verifyHytale without a server", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("finds no server in an empty or half-filled folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "sg-hytale-"));
    dirs.push(dir);
    expect(findHytaleServer(dir)).toBeNull();
    writeFileSync(join(dir, "HytaleServer.jar"), "");
    expect(findHytaleServer(dir)).toBeNull(); // Assets.zip is needed too
    writeFileSync(join(dir, "Assets.zip"), "");
    expect(findHytaleServer(dir)).toBe(dir);
  });

  it("reports skipped, never verified, and says where the server comes from", async () => {
    const empty = mkdtempSync(join(tmpdir(), "sg-hytale-"));
    dirs.push(empty);
    const res = readResource(join(repoRoot, "sdk", "conformance", "sg_probe"));
    if (!res.result.ok) throw new Error("sg_probe manifest");
    const r = await verifyHytale(res, res.result.manifest, [], { "hytale-server": empty });
    expect(r.status).toBe("skipped");
    expect(r.environment).toBe("hytale");
    expect(r.checks).toEqual([expect.objectContaining({ name: "server_run", status: "skipped" })]);
    expect(r.checks[0]!.message).toContain("SETUP.md");
  });
});
