import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acceptMinecraftEula, ccTweakedBlocker, minecraftServerProperties, verifyCcTweaked } from "../src/lib/cctweaked.ts";
// @ts-expect-error plain ESM script without type declarations
import { eulaState } from "../../../sdk/adapters/cctweaked/runtime.mjs";
// @ts-expect-error plain ESM script without type declarations
import { manifestInfo } from "../../../sdk/adapters/cctweaked/harness/run.mjs";

const roots: string[] = [];
const fakeRoot = (): string => {
  const r = mkdtempSync(join(tmpdir(), "scriptgo-cct-test-"));
  roots.push(r);
  return r;
};
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("cctweaked verify", () => {
  it("binds the server to loopback only, with no other listener and nobody allowed in", () => {
    const p = minecraftServerProperties(25999);
    expect(p).toContain("server-ip=127.0.0.1\n");
    expect(p).toContain("server-port=25999\n");
    for (const off of ["enable-rcon=false", "enable-query=false", "enable-status=false", "white-list=true", "enforce-whitelist=true"]) expect(p).toContain(off + "\n");
    expect(p).not.toMatch(/^eula/m);
  });

  it("reads the owner's EULA answer and never takes a missing or false one for acceptance", () => {
    const root = fakeRoot();
    expect(eulaState(root).accepted).toBe(false);
    mkdirSync(join(root, "tools", "runtimes", "minecraft", "server"), { recursive: true });
    const file = join(root, "tools", "runtimes", "minecraft", "server", "eula.txt");
    writeFileSync(file, "#By changing the setting below to TRUE you are indicating your agreement to our EULA\neula=false\n");
    expect(eulaState(root).accepted).toBe(false);
    writeFileSync(file, "eula=true\n");
    expect(eulaState(root).accepted).toBe(true);
  });

  it("writes eula=true only through the operator's explicit acceptance, into the runtime folder", () => {
    const root = fakeRoot();
    const file = acceptMinecraftEula(root, new Date("2026-11-09T12:00:00Z"));
    expect(file).toBe(join(root, "tools", "runtimes", "minecraft", "server", "eula.txt"));
    expect(readFileSync(file, "utf8")).toBe("# Accepted by the operator with scriptgo verify --accept-minecraft-eula on 2026-11-09T12:00:00.000Z\n# https://www.minecraft.net/en-us/eula\neula=true\n");
    expect(eulaState(root).accepted).toBe(true);
  });

  it("is skipped, and writes nothing, when the runtime or the EULA acceptance is missing", async () => {
    const root = fakeRoot();
    expect(ccTweakedBlocker(root)).toMatch(/^runtime incomplete/);
    const report = await verifyCcTweaked({
      root, pkg: { name: "sg_probe", version: "0.1.0" }, resources: [], resource: "sg_probe", withResource: null,
      seconds: 1, readyTimeoutMs: 1000, reportTimeoutMs: 1000,
    });
    expect(report.status).toBe("skipped");
    expect(report.checks).toEqual([{ name: "server_run", status: "skipped", message: expect.stringMatching(/^runtime incomplete/) }]);
    expect(existsSync(join(root, "tools", "runtimes", "minecraft", "server", "eula.txt"))).toBe(false);
    expect(existsSync(join(root, "tools", "runtimes", "minecraft", "server", "server.properties"))).toBe(false);
  });
});

describe("cc-core harness runner", () => {
  it("reads a resource's name and dependencies from its manifest", () => {
    const info = manifestInfo('resource "sg_probe"\nversion "0.1.0"\ndependency "sg_eventbus >=1.0.0"\ndependencies { "sg_inventory", "sg_permissions >=1.0.0" }\n');
    expect(info).toEqual({ name: "sg_probe", deps: ["sg_eventbus", "sg_inventory", "sg_permissions"] });
  });
});
