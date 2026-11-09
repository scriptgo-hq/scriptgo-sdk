import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readResource, repoRoot } from "../src/lib/sdk.ts";
import {
  RUST_GAME_PORT, RUST_RCON_PORT, detectRustFramework, findRustServer, rustClosure, rustFrameworkPaths, rustInstallFiles,
  rustServerArgs, rustVerifyConfig, verifyRust,
} from "../src/commands/verify-rust.ts";

const packages = join(repoRoot, "sdk", "packages");
let tmp: string;
let savedEnv: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sg-rust-test-"));
  savedEnv = process.env.SCRIPTGO_RUST_SERVER;
  delete process.env.SCRIPTGO_RUST_SERVER;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.SCRIPTGO_RUST_SERVER;
  else process.env.SCRIPTGO_RUST_SERVER = savedEnv;
});

function fakeServer(frameworks: ("oxide" | "carbon")[]): string {
  const dir = join(tmp, "server");
  mkdirSync(join(dir, "RustDedicated_Data", "Managed"), { recursive: true });
  writeFileSync(join(dir, process.platform === "win32" ? "RustDedicated.exe" : "RustDedicated"), "");
  if (frameworks.includes("oxide")) writeFileSync(join(dir, "RustDedicated_Data", "Managed", "Oxide.Rust.dll"), "");
  if (frameworks.includes("carbon")) {
    mkdirSync(join(dir, "carbon", "managed"), { recursive: true });
    writeFileSync(join(dir, "carbon", "managed", "Carbon.dll"), "");
  }
  return dir;
}

function kit(name: string) {
  const res = readResource(join(packages, name));
  if (!res.result.ok) throw new Error(`${name} manifest invalid`);
  return { res, m: res.result.manifest };
}

describe("rust verify runner", () => {
  it("is skipped, never verified, without a server", async () => {
    expect(findRustServer()).toBeNull();
    const { res, m } = kit("sg_eventbus");
    const r = await verifyRust(res, m, [packages], { seconds: 5, timeoutMs: 1000 });
    expect(r.status).toBe("skipped");
    expect(r.environment).toBe("rust");
    expect(r.checks).toEqual([expect.objectContaining({ name: "server_run", status: "skipped" })]);
    expect(r.checks[0]!.message).toContain("--rust-server");
  });

  it("finds the server from the flag or SCRIPTGO_RUST_SERVER", () => {
    const dir = fakeServer(["oxide"]);
    expect(findRustServer(dir)).toBe(dir);
    process.env.SCRIPTGO_RUST_SERVER = dir;
    expect(findRustServer()).toBe(dir);
    expect(findRustServer(join(tmp, "nothing-here"))).toBeNull();
  });

  it("detects Oxide, Carbon, both or neither", () => {
    expect(detectRustFramework(fakeServer([]))).toBeNull();
    rmSync(join(tmp, "server"), { recursive: true });
    expect(detectRustFramework(fakeServer(["oxide"]))).toBe("oxide");
    rmSync(join(tmp, "server"), { recursive: true });
    expect(detectRustFramework(fakeServer(["carbon"]))).toBe("carbon");
    rmSync(join(tmp, "server"), { recursive: true });
    expect(detectRustFramework(fakeServer(["oxide", "carbon"]))).toBe("both");
  });

  it("skips a server without a framework, or with both", async () => {
    const { res, m } = kit("sg_eventbus");
    const none = await verifyRust(res, m, [packages], { server: fakeServer([]), seconds: 5, timeoutMs: 1000 });
    expect(none.status).toBe("skipped");
    expect(none.checks[0]!.message).toContain("neither Oxide nor Carbon");
    rmSync(join(tmp, "server"), { recursive: true });
    const both = await verifyRust(res, m, [packages], { server: fakeServer(["oxide", "carbon"]), seconds: 5, timeoutMs: 1000 });
    expect(both.status).toBe("skipped");
  });

  it("knows where each framework keeps plugins, config and data", () => {
    const o = rustFrameworkPaths("S", "oxide");
    expect(o.plugins).toBe(join("S", "oxide", "plugins"));
    expect(o.config).toBe(join("S", "oxide", "config", "ScriptGo.json"));
    const c = rustFrameworkPaths("S", "carbon");
    expect(c.config).toBe(join("S", "carbon", "configs", "ScriptGo.json"));
    expect(c.data).toBe(join("S", "carbon", "data"));
  });

  it("installs the bridge, KeraLua, this OS's lua54 and the framework's plugin file", () => {
    const files = rustInstallFiles("carbon").map(([, to]) => to);
    expect(files).toContain("RustDedicated_Data/Managed/ScriptGo.Bridge.dll");
    expect(files).toContain("RustDedicated_Data/Managed/KeraLua.dll");
    expect(files).toContain(process.platform === "win32" ? "RustDedicated_Data/Plugins/x86_64/lua54.dll" : "RustDedicated_Data/Plugins/x86_64/liblua54.so");
    expect(files).toContain("carbon/plugins/ScriptGo.cs");
    expect(files.some((f) => f.startsWith("oxide/"))).toBe(false);
  });

  it("binds the server to loopback on the lane's ports, with Rust+ off", () => {
    const args = rustServerArgs("log.txt", "pw");
    const value = (k: string): string | undefined => args[args.indexOf(k) + 1];
    expect(value("+server.ip")).toBe("127.0.0.1");
    expect(value("+rcon.ip")).toBe("127.0.0.1");
    expect(value("+server.port")).toBe(String(RUST_GAME_PORT));
    expect(value("+rcon.port")).toBe(String(RUST_RCON_PORT));
    expect(value("+app.port")).toBe("-1");
    expect(args.join(" ")).not.toContain("0.0.0.0");
  });

  it("writes a verify config the plugin reads, convars and API host only with an API", () => {
    const plain = rustVerifyConfig({ resource: "sg_probe", reportPath: "r.json", resourceFolder: "res", seconds: 12 });
    expect(plain.verify).toEqual({ resource: "sg_probe", with: null, reportPath: "r.json", runSeconds: 12, quit: true });
    expect(plain.httpAllowedHosts).toEqual([]);
    expect(plain.convars).toEqual({});
    const withApi = rustVerifyConfig({ resource: "sg_probe", with: "sg_probe_readme", reportPath: "r.json", resourceFolder: "res", seconds: 12, api: { url: "http://127.0.0.1:4555", licenseKey: "k" } });
    expect(withApi.httpAllowedHosts).toEqual(["127.0.0.1"]);
    expect(withApi.convars).toEqual({ scriptgo_api: "http://127.0.0.1:4555" });
    expect(withApi.resources).toEqual({ sg_probe: { api: "http://127.0.0.1:4555", license_key: "k" } });

    // Every key the runner writes is one the plugin declares (plugin/ScriptGo.cs [JsonProperty]).
    const plugin = readFileSync(join(repoRoot, "sdk", "adapters", "rust", "plugin", "ScriptGo.cs"), "utf8");
    const declared = new Set([...plugin.matchAll(/\[JsonProperty\("([^"]+)"\)\]/g)].map((x) => x[1]));
    for (const key of [...Object.keys(withApi), ...Object.keys(withApi.verify as object)]) expect(declared).toContain(key);
  });

  it("resolves a package's dependencies before it", () => {
    const res = readResource(join(repoRoot, "sdk", "conformance", "sg_probe"));
    const { order, missing } = rustClosure(res, [packages]);
    expect(missing).toEqual([]);
    expect(order.length).toBeGreaterThan(1);
    expect(order[order.length - 1]!.root).toBe(res.root);
    const { missing: none } = rustClosure(res, [join(tmp, "empty")]);
    expect(none.length).toBeGreaterThan(0);
  });
});
