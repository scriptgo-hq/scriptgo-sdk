// Client code escrow on the creator's side: which scripts are escrowed, the local compile and line
// map of `publish --client-escrow`, `escrow lines`, and `pack --target open77` over a buyer's copy.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { CLIENT_ESCROW_ENTRY, clientEscrowStub, resolveClientMessage } from "@scriptgo/escrow";
import { parseManifest } from "@scriptgo/manifest";
import { packForOpen77 } from "../src/commands/pack.ts";
import { run as escrowRun } from "../src/commands/escrow.ts";
import { run as publishRun } from "../src/commands/publish.ts";
import { buildClientLineMap, clientEscrowErrors, clientEscrowScripts } from "../src/lib/client-escrow.ts";
import { listFiles, readResource } from "../src/lib/sdk.ts";

const tmp = mkdtempSync(join(tmpdir(), "scriptgo-client-escrow-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const MANIFEST = (environments: string) => [
  'resource "night_market"',
  'version "2.0.0"',
  'author "kestrel"',
  'license "MIT"',
  'category "economy"',
  'lua { "5.4" }',
  `environments { ${environments} }`,
  'shared_script "shared/config.lua"',
  'server_script "server/main.lua"',
  'client_scripts { "client/hud.lua", "client/menu.lua" }',
  "",
].join("\n");

const HUD = ["local function draw(state)", "  return state.cash.amount", "end", 'local label = "night-market-hud-constant"', "return { draw = draw, label = label }", ""].join("\n");

function resource(name: string, environments = '"open77"', extra: Record<string, string> = {}): string {
  const dir = join(tmp, name);
  const files: Record<string, string> = {
    "scriptgo.lua": MANIFEST(environments),
    "shared/config.lua": "return { price = 3 }\n",
    "server/main.lua": "print('server')\n",
    "client/hud.lua": HUD,
    "client/menu.lua": "return 1\n",
    ...extra,
  };
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  return dir;
}

function manifestOf(dir: string) {
  const res = readResource(dir);
  if (!res.result.ok) throw new Error(JSON.stringify(res.result.errors));
  return { res, m: res.result.manifest, files: listFiles(res.root) };
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [], err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  const error = vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (out.push(String(chunk)), true));
  try {
    return { code: await fn(), out: out.join("\n"), err: err.join("\n") };
  } finally {
    log.mockRestore();
    error.mockRestore();
    write.mockRestore();
  }
}

describe("which scripts client escrow covers", () => {
  it("is the expanded client_scripts, never the shared or server scripts", () => {
    const { m, files } = manifestOf(resource("scope"));
    expect(clientEscrowScripts(m, files)).toEqual(["client/hud.lua", "client/menu.lua"]);
    expect(clientEscrowErrors(m, files)).toEqual([]);
  });
  it("refuses a release that also targets another host, or names none", () => {
    const both = manifestOf(resource("both", '"open77", "fivem"'));
    expect(clientEscrowErrors(both.m, both.files).map((e) => e.code)).toEqual(["client_escrow_open77_only"]);
    const none = manifestOf(resource("none", ""));
    expect(clientEscrowErrors(none.m, none.files)[0]!.message).toMatch(/lists no environment/);
  });
});

describe("the local compile and the line map", () => {
  it("compiles like the platform and maps every position of a fully stripped chunk to its line", () => {
    const { res, m, files } = manifestOf(resource("lines"));
    const built = buildClientLineMap(res.root, m, files, { package: "kestrel//night-market", strip: "full" });
    expect(built.errors).toEqual([]);
    expect(built.lines.package).toBe("kestrel//night-market");
    expect(Object.keys(built.lines.chunks)).toEqual(["client/hud.lua", "client/menu.lua"]);
    // The map never holds source: line numbers only.
    expect(JSON.stringify(built.lines)).not.toContain("night-market-hud-constant");
    expect(new Set(built.lines.chunks["client/hud.lua"]!.lines)).toEqual(new Set([1, 2, 3, 4, 5]));
    // The field access of line 2 fails at run time with a position; the map turns it into the line.
    const lines = built.lines.chunks["client/hud.lua"]!.lines;
    const pos = lines.indexOf(2) + 1;
    expect(resolveClientMessage(built.lines, `night-market@2.0.0/client/hud.lua:pos:${pos}: attempt to index a nil value`)).toBe("client/hud.lua:2: attempt to index a nil value");
  });
  it("names a syntax error by path and line before anything is uploaded", () => {
    const { res, m, files } = manifestOf(resource("syntax", '"open77"', { "client/menu.lua": "return (1\n" }));
    const built = buildClientLineMap(res.root, m, files, { package: "kestrel//night-market", strip: "full" });
    expect(built.errors.map((e) => e.code)).toEqual(["client_escrow_syntax"]);
    expect(built.errors[0]!.message).toMatch(/client\/menu\.lua/);
  });
  it("keeps no position table under a names strip (the bytecode keeps its lines)", () => {
    const { res, m, files } = manifestOf(resource("names"));
    const built = buildClientLineMap(res.root, m, files, { package: "kestrel//night-market", strip: "names" });
    expect(built.errors).toEqual([]);
    expect(built.lines.chunks).toEqual({});
  });
});

describe("publish --client-escrow --dry-run and escrow lines", () => {
  it("compiles locally, writes the line map and uploads nothing", async () => {
    const dir = resource("publish");
    const map = join(tmp, "night-market-2.0.0.client-lines.json");
    const r = await capture(() => publishRun([dir, "--client-escrow", "--dry-run", "--package", "night-market", "--client-lines", map]));
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/2 client script\(s\) compiled/);
    const written = JSON.parse(readFileSync(map, "utf8"));
    expect(written.format).toBe("scriptgo-client-escrow-lines/1");

    const pos = (written.chunks["client/hud.lua"].lines as number[]).indexOf(2) + 1;
    const resolved = await capture(() => escrowRun(["lines", map, `[string] night-market@2.0.0/client/hud.lua:pos:${pos}: boom`]));
    expect(resolved.code).toBe(0);
    expect(resolved.out).toContain("client/hud.lua:2: boom");
    const summary = await capture(() => escrowRun(["lines", map]));
    expect(summary.out).toMatch(/client\/hud\.lua: \d+ positions, lines 1-5/);
  });
  it("refuses a combination v1 does not deliver", async () => {
    const dir = resource("refuse");
    expect((await capture(() => publishRun([dir, "--client-escrow", "--escrow", "--dry-run"]))).code).toBe(2);
    expect((await capture(() => publishRun([dir, "--client-strip", "names", "--dry-run"]))).code).toBe(2);
    expect((await capture(() => publishRun([dir, "--client-escrow", "--client-strip", "none", "--dry-run"]))).code).toBe(2);
    const fivem = resource("refuse-fivem", '"open77", "fivem"');
    const r = await capture(() => publishRun([fivem, "--client-escrow", "--dry-run"]));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/client_escrow_open77_only/);
  });
});

describe("pack --target open77 over a buyer's copy", () => {
  it("copies the container and declares it in files, with the stubs at the scripts' paths", () => {
    const dir = resource("copy", '"open77"', {
      "client/hud.lua": clientEscrowStub("client/hud.lua").toString("utf8"),
      "client/menu.lua": clientEscrowStub("client/menu.lua").toString("utf8"),
      [CLIENT_ESCROW_ENTRY]: "SGCE-not-a-real-container",
    });
    const out = join(tmp, "packed");
    const r = packForOpen77(readResource(dir), out);
    expect(r.errors).toEqual([]);
    const manifest = readFileSync(join(r.dest, "open77.lua"), "utf8");
    const parsed = parseManifest(manifest, { fileName: "open77.lua" });
    if (!parsed.ok) throw new Error("bad manifest");
    expect(parsed.manifest.files).toContain(CLIENT_ESCROW_ENTRY);
    // The shim client file stays clear: it is the SDK's, not the creator's.
    expect(parsed.manifest.clientScripts).toEqual(["scriptgo_shim_client.lua", "client/hud.lua", "client/menu.lua"]);
    expect(readFileSync(join(r.dest, CLIENT_ESCROW_ENTRY), "utf8")).toBe("SGCE-not-a-real-container");
    expect(readFileSync(join(r.dest, "client", "hud.lua"), "utf8")).not.toContain("night-market-hud-constant");
  });
  it("leaves a resource without client escrow as it was", () => {
    const r = packForOpen77(readResource(resource("plain")), join(tmp, "packed-plain"));
    expect(r.errors).toEqual([]);
    expect(readFileSync(join(r.dest, "open77.lua"), "utf8")).not.toContain(CLIENT_ESCROW_ENTRY);
  });
});
