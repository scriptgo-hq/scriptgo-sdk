import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unzipSync, zipSync } from "fflate";
import { OPEN77_GENERATED_FILES, open77Capable, open77Manifest, open77ShimFiles, parseManifest } from "@scriptgo/manifest";
import { readBundle } from "@scriptgo/escrow";
import { buildEscrow, packEscrow } from "../src/lib/escrow-pack.ts";
import { Open77EscrowError, escrowStub, installEscrowForOpen77 } from "../src/lib/open77-escrow.ts";

const tmp = mkdtempSync(join(tmpdir(), "scriptgo-open77-escrow-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeAll(() => { process.env.RELEASE_SIGNING_KEY = Buffer.alloc(32, 0x4c).toString("base64"); });

const SECRET = "print('proprietary pricing logic')";
const manifestText = [
  'resource "inv_pro"',
  'version "2.1.0"',
  'author "kestrel"',
  'capability "events"',
  'shared_script "shared/items.lua"',
  'server_script "server/main.lua"',
  'client_script "client/hud.lua"',
  'files { "config.lua" }',
].join("\n");

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function pack(out: string, extraAllow: string[] = []): { bundle: Buffer; signer: string } {
  const parsed = parseManifest(manifestText, { fileName: "scriptgo.lua" });
  if (!parsed.ok) throw new Error(parsed.errors.map((e) => e.message).join("; "));
  const archive = zipSync({
    "inv_pro/scriptgo.lua": enc(manifestText),
    "inv_pro/README.md": enc("# inv pro"),
    "inv_pro/config.lua": enc("return { rate = 3 }"),
    "inv_pro/shared/items.lua": enc("Items = {}"),
    "inv_pro/client/hud.lua": enc("-- hud"),
    "inv_pro/server/main.lua": enc(SECRET),
  }, { level: 9, mtime: new Date("2026-01-01T00:00:00Z") });
  const r = packEscrow({ archive, manifest: parsed.manifest, manifestFile: "scriptgo.lua", identifier: "kestrel//inv-pro", outDir: out, allowlist: extraAllow });
  const bundle = readFileSync(r.bundlePath);
  return { bundle, signer: readBundle(bundle).manifest.signerPublicKey };
}

describe("escrow packer", () => {
  it("keeps client-facing files clear and encrypts only server code", () => {
    const { bundle } = pack(join(tmp, "p1"));
    const { manifest } = readBundle(bundle);
    expect(manifest.encryptedFiles).toEqual(["server/main.lua"]);
    expect(manifest.clearFiles.map((f) => f.path).sort()).toEqual(["README.md", "client/hud.lua", "config.lua", "open77.lua", "scriptgo.lua", "scriptgo_shim.lua", "scriptgo_shim_client.lua", "scriptgo_shim_server.lua", "shared/items.lua"]);
  });

  it("puts the generated OPEN//77 files in the bundle as clear files the signature covers", () => {
    const { bundle } = pack(join(tmp, "p1b"));
    const { manifest, clear } = readBundle(bundle);
    const sha = (d: Uint8Array) => createHash("sha256").update(d).digest("hex");
    for (const f of OPEN77_GENERATED_FILES) {
      const entry = manifest.clearFiles.find((c) => c.path === f);
      expect(entry, f).toBeTruthy();
      expect(sha(clear.get(f)!)).toBe(entry!.sha256);
    }
    // Exactly what `pack --target open77` writes: the manifest lists the shim first, then the scripts.
    const parsed = parseManifest(manifestText, { fileName: "scriptgo.lua" }) as { ok: true; manifest: any };
    expect(clear.get("open77.lua")!.toString("utf8")).toBe(open77Manifest(parsed.manifest, [], "scriptgo.lua"));
    for (const [to, data] of open77ShimFiles(parsed.manifest)) expect(clear.get(to)!.equals(data)).toBe(true);
    // A changed open77.lua breaks the signed manifest: the installer refuses it.
    const entries = unzipSync(bundle);
    const forged = zipSync({ ...entries, "open77.lua": enc(clear.get("open77.lua")!.toString("utf8") + 'server_script "backdoor.lua"\n') });
    expect(() => installEscrowForOpen77({ bundle: forged, resourcesRoot: join(tmp, "resources-forged") })).toThrow(/open77\.lua/);
  });

  it("generates nothing for a package that cannot run on OPEN//77", () => {
    // TypeScript scripts: OPEN//77 runs Lua only.
    const tsManifest = ['resource "ts_only"', 'version "1.0.0"', 'server_script "server/main.ts"'].join("\n");
    const ts = parseManifest(tsManifest, { fileName: "scriptgo.lua" }) as { ok: true; manifest: any };
    expect(open77Capable(ts.manifest)).toBe(false);
    const archive = zipSync({ "ts_only/scriptgo.lua": enc(tsManifest), "ts_only/server/main.ts": enc("export {};"), "ts_only/server/main.ts.js": enc("// compiled") });
    const built = buildEscrow({ archive, manifest: ts.manifest, manifestFile: "scriptgo.lua", identifier: "kestrel//ts-only", allowlist: [] });
    expect(built.clearFiles).toEqual(["scriptgo.lua"]);
    expect(built.encryptedFiles.sort()).toEqual(["server/main.ts", "server/main.ts.js"]);
    // Its bundle has no signed open77.lua, so it is not installable there, and nothing unsigned is written.
    const root = join(tmp, "resources-ts");
    expect(() => installEscrowForOpen77({ bundle: built.bundle, resourcesRoot: root })).toThrow(/not packed for OPEN\/\/77/);
    expect(existsSync(join(root, "ts_only"))).toBe(false);

    // A Lua package that lists other environments only is not packed for OPEN//77 either.
    const elsewhere = parseManifest(manifestText + '\nenvironments { "standalone" }', { fileName: "scriptgo.lua" }) as { ok: true; manifest: any };
    expect(open77Capable(elsewhere.manifest)).toBe(false);
    const listed = parseManifest(manifestText + '\nenvironments { "standalone", "open77" }', { fileName: "scriptgo.lua" }) as { ok: true; manifest: any };
    expect(open77Capable(listed.manifest)).toBe(true);
  });

  it("refuses a resource that already has a file with a generated name", () => {
    const parsed = parseManifest(manifestText, { fileName: "scriptgo.lua" }) as { ok: true; manifest: any };
    const archive = zipSync({ "inv_pro/scriptgo.lua": enc(manifestText), "inv_pro/scriptgo_shim.lua": enc("-- mine"), "inv_pro/server/main.lua": enc(SECRET), "inv_pro/shared/items.lua": enc("Items = {}"), "inv_pro/client/hud.lua": enc("-- hud"), "inv_pro/config.lua": enc("return {}") });
    expect(() => buildEscrow({ archive, manifest: parsed.manifest, manifestFile: "scriptgo.lua", identifier: "kestrel//inv-pro", allowlist: [] })).toThrow(/scriptgo_shim\.lua/);
  });
});

describe("installEscrowForOpen77 with target rust", () => {
  it("uses the portable manifest and stubs every encrypted Lua file", () => {
    const { bundle, signer } = pack(join(tmp, "p-rust"));
    const r = installEscrowForOpen77({ bundle, resourcesRoot: join(tmp, "resources-rust"), trustedSignerPublicKey: signer, target: "rust" });
    expect(r.stubs).toEqual(["server/main.lua"]);
    expect(readFileSync(join(r.dest, "server/main.lua"), "utf8")).not.toContain("proprietary");
    for (const f of ["scriptgo.lua", "escrow.json", "payload.enc"]) expect(existsSync(join(r.dest, f))).toBe(true);
  });
});

describe("installEscrowForOpen77", () => {
  it("writes an OPEN//77 folder whose server scripts stay encrypted on disk", () => {
    const { bundle, signer } = pack(join(tmp, "p2"));
    const root = join(tmp, "resources-a");
    const r = installEscrowForOpen77({ bundle, resourcesRoot: root, trustedSignerPublicKey: signer });
    expect(r.name).toBe("inv_pro");
    expect(r.stubs).toEqual(["server/main.lua"]);
    expect(r.warnings.filter((w) => w.includes("trusted-signer"))).toEqual([]);

    const dest = join(root, "inv_pro");
    const { manifest } = readBundle(bundle);
    // The stub is at the script's path and carries no source.
    const stub = readFileSync(join(dest, "server/main.lua"), "utf8");
    expect(stub).toBe(escrowStub(manifest, "server/main.lua"));
    expect(stub).not.toContain("proprietary");
    // Nothing in the folder holds the plaintext.
    for (const f of ["escrow.json", "payload.enc", "open77.lua", "scriptgo_shim.lua"]) expect(existsSync(join(dest, f))).toBe(true);
    expect(readFileSync(join(dest, "payload.enc")).includes(Buffer.from(SECRET))).toBe(false);
    // escrow.json and payload.enc are byte for byte the bundle's.
    const raw = unzipSync(bundle);
    expect(readFileSync(join(dest, "escrow.json")).equals(Buffer.from(raw["escrow.json"]!))).toBe(true);
    expect(readFileSync(join(dest, "payload.enc")).equals(Buffer.from(raw["payload.enc"]!))).toBe(true);
    // Clear files are real, and the generated manifest lists the shim before the scripts.
    expect(readFileSync(join(dest, "shared/items.lua"), "utf8")).toBe("Items = {}");
    const open77 = readFileSync(join(dest, "open77.lua"), "utf8");
    expect(open77).toContain('server_script "server/main.lua"');
    expect(open77.indexOf("scriptgo_shim.lua")).toBeLessThan(open77.indexOf("shared/items.lua"));

    // No unsigned script: every file on disk is a signed clear file of the bundle, byte for byte,
    // the bundle's own escrow.json / payload.enc, or a one-line stub. The installer generated nothing.
    const sha = (d: Uint8Array) => createHash("sha256").update(d).digest("hex");
    const walk = (dir: string, prefix = ""): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name), `${prefix}${d.name}/`) : [`${prefix}${d.name}`]));
    const onDisk = walk(dest);
    expect(onDisk.length).toBe(manifest.clearFiles.length + 2 + r.stubs.length);
    for (const f of onDisk) {
      if (f === "escrow.json" || f === "payload.enc") continue;
      const signed = manifest.clearFiles.find((c) => c.path === f);
      if (signed) expect(sha(readFileSync(join(dest, f))), f).toBe(signed.sha256);
      else expect(readFileSync(join(dest, f), "utf8"), f).toBe(escrowStub(manifest, f));
    }
    expect(readFileSync(join(dest, "open77.lua")).equals(Buffer.from(raw["open77.lua"]!))).toBe(true);
  });

  it("warns when the signer is not pinned, and refuses another signer", () => {
    const { bundle } = pack(join(tmp, "p3"));
    const r = installEscrowForOpen77({ bundle, resourcesRoot: join(tmp, "resources-b") });
    expect(r.warnings.some((w) => w.includes("trusted-signer"))).toBe(true);
    const other = Buffer.alloc(32, 7).toString("base64url");
    expect(() => installEscrowForOpen77({ bundle, resourcesRoot: join(tmp, "resources-c"), trustedSignerPublicKey: other })).toThrowError(Open77EscrowError);
  });

  it("refuses a tampered payload and a tampered clear file", () => {
    const { bundle } = pack(join(tmp, "p4"));
    const entries = unzipSync(bundle);
    const flipped = new Uint8Array(entries["payload.enc"]!);
    flipped[0] = flipped[0]! ^ 0xff;
    const badPayload = zipSync({ ...entries, "payload.enc": flipped });
    expect(() => installEscrowForOpen77({ bundle: badPayload, resourcesRoot: join(tmp, "resources-d") })).toThrow(/payload\.enc/);
    const badClear = zipSync({ ...entries, "config.lua": enc("return { rate = 999 }") });
    expect(() => installEscrowForOpen77({ bundle: badClear, resourcesRoot: join(tmp, "resources-e") })).toThrow(/config\.lua/);
  });

  it("does not replace a folder that is not an escrow install unless forced", () => {
    const { bundle } = pack(join(tmp, "p5"));
    const root = join(tmp, "resources-f");
    mkdirSync(join(root, "inv_pro"), { recursive: true });
    writeFileSync(join(root, "inv_pro", "notes.txt"), "mine");
    expect(() => installEscrowForOpen77({ bundle, resourcesRoot: root })).toThrow(/not an escrow install/);
    const r = installEscrowForOpen77({ bundle, resourcesRoot: root, force: true });
    expect(existsSync(join(r.dest, "notes.txt"))).toBe(false);
    // A second install over an escrow install needs no force.
    expect(() => installEscrowForOpen77({ bundle, resourcesRoot: root })).not.toThrow();
  });
});
