import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { parseManifest } from "@scriptgo/manifest";
import { openEscrowRelease, readBundle } from "@scriptgo/escrow";
import { defaultEscrowKeyPath, packEscrow } from "../src/lib/escrow-pack.ts";
import { secretFileReason, writeSecretFile } from "../src/lib/secret-files.ts";
import { run as packRun, scriptgoArchive } from "../src/commands/pack.ts";

const tmp = mkdtempSync(join(tmpdir(), "scriptgo-cli-escrow-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// A fixed signing key and a private config folder, so the test never writes to ~/.scriptgo.
beforeAll(() => {
  process.env.RELEASE_SIGNING_KEY = Buffer.alloc(32, 0x4c).toString("base64");
  process.env.SCRIPTGO_CONFIG_DIR = join(tmp, "config");
});

const manifestText = [
  'resource "inv_pro"',
  'version "2.1.0"',
  'author "kestrel"',
  'server_script "server/main.lua"',
  'files { "config.lua" }',
].join("\n");

function archive(): Uint8Array {
  const enc = (s: string) => new TextEncoder().encode(s);
  return zipSync({
    "inv_pro/scriptgo.lua": enc(manifestText),
    "inv_pro/README.md": enc("# inv pro"),
    "inv_pro/config.lua": enc("return { rate = 3 }"),
    "inv_pro/server/main.lua": enc("print('proprietary pricing logic')"),
  }, { level: 9, mtime: new Date("2026-01-01T00:00:00Z") });
}

describe("packEscrow", () => {
  it("encrypts scripts, keeps manifest+docs+named config clear, and self-verifies the round-trip", () => {
    const parsed = parseManifest(manifestText, { fileName: "scriptgo.lua" });
    expect(parsed.ok).toBe(true);
    const out = join(tmp, "out");
    const r = packEscrow({
      archive: archive(), manifest: (parsed as { manifest: any }).manifest, manifestFile: "scriptgo.lua",
      identifier: "kestrel//inv-pro", outDir: out, allowlist: ["config.lua"],
    });
    // The key file is written to the config folder, never next to the bundle.
    expect(r.keyPath).toBe(defaultEscrowKeyPath("inv_pro", "2.1.0"));
    expect(r.keyPath.startsWith(join(tmp, "config"))).toBe(true);
    expect(readdirSync(out)).toEqual(["inv_pro-2.1.0.escrow.zip"]);
    // The docs, the manifest, the named config, and the OPEN//77 files generated for a Lua package.
    expect(r.clearFiles.sort()).toEqual(["README.md", "config.lua", "open77.lua", "scriptgo.lua", "scriptgo_shim.lua", "scriptgo_shim_client.lua", "scriptgo_shim_server.lua"]);
    expect(r.encryptedFiles).toEqual(["server/main.lua"]);

    const bundle = readFileSync(r.bundlePath);
    // No plaintext of an encrypted script leaks into the bundle.
    expect(bundle.includes(Buffer.from("proprietary pricing logic"))).toBe(false);

    // The content key file is a separate secret, not inside the bundle.
    const key = JSON.parse(readFileSync(r.keyPath, "utf8"));
    expect(key.contentKeyBase64).toBeTruthy();
    expect(key.aad).toBe("kestrel//inv-pro@2.1.0");
    expect(bundle.includes(Buffer.from(key.contentKeyBase64, "base64"))).toBe(false);

    // The bundle decrypts with the key file's content key.
    const files = openEscrowRelease({ bundle, contentKey: Buffer.from(key.contentKeyBase64, "base64"), trustedSignerPublicKey: readBundle(bundle).manifest.signerPublicKey });
    expect(files.get("server/main.lua")!.toString()).toBe("print('proprietary pricing logic')");
  });

  it("refuses a key file path inside the output folder", () => {
    const parsed = parseManifest(manifestText, { fileName: "scriptgo.lua" });
    const out = join(tmp, "out-refused");
    expect(() => packEscrow({
      archive: archive(), manifest: (parsed as { manifest: any }).manifest, manifestFile: "scriptgo.lua",
      identifier: "kestrel//inv-pro", outDir: out, allowlist: [], keyPath: join(out, "k.escrow-key.json"),
    })).toThrow(/inside the output folder/);
    expect(existsSync(out)).toBe(false);
  });
});

describe("secret files", () => {
  it("restricts a key file to this user: 0600 on POSIX, a one-user ACL on Windows", () => {
    const w = writeSecretFile(join(tmp, "secret", "k.json"), "{}");
    expect(w.warning).toBeNull();
    if (process.platform === "win32") {
      // icacls prints "<file> <account>:(F)" and nothing else: inheritance removed, one entry.
      const acl = execFileSync("icacls", [w.path], { encoding: "utf8" });
      const entries = acl.split(/\r?\n/).map((l) => l.replace(w.path, "").trim()).filter((l) => /:\(/.test(l));
      expect(entries).toHaveLength(1);
      expect(entries[0]!.toLowerCase()).toContain(userInfo().username.toLowerCase());
      expect(w.protection).toMatch(/ACL limited to this user/);
    } else {
      expect(statSync(w.path).mode & 0o777).toBe(0o600);
      expect(w.protection).toMatch(/0600/);
    }
  });

  it("recognises key files by name and by content", () => {
    expect(secretFileReason("dist/x-1.0.0.escrow-key.json")).toMatch(/named like/);
    expect(secretFileReason("release-signing.key")).toMatch(/named like/);
    expect(secretFileReason("cfg/credentials.json")).toMatch(/named like/);
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(secretFileReason("data/k.json", enc('{ "contentKeyBase64": "AAAA" }'))).toMatch(/content key/);
    expect(secretFileReason("data/id.json", enc('{ "alg": "X25519", "privateKey": "x" }'))).toMatch(/identity/);
    expect(secretFileReason("data/k.pem", enc("-----BEGIN PRIVATE KEY-----\nAAAA"))).toMatch(/PEM/);
    expect(secretFileReason("server/main.lua", enc("print('hello')"))).toBeNull();
  });

  it("pack and publish refuse a resource that would ship a key file", async () => {
    const dir = join(tmp, "res-with-key");
    mkdirSync(join(dir, "server"), { recursive: true });
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "scriptgo.lua"), [...manifestText.split("\n").slice(0, 4), 'files { "config.lua", "data/*.json" }'].join("\n"));
    writeFileSync(join(dir, "config.lua"), "return {}");
    writeFileSync(join(dir, "server", "main.lua"), "print(1)");
    writeFileSync(join(dir, "data", "items.json"), "{}");
    writeFileSync(join(dir, "data", "inv_pro-2.1.0.escrow-key.json"), '{ "contentKeyBase64": "AAAA" }');
    const parsed = parseManifest(readFileSync(join(dir, "scriptgo.lua"), "utf8"), { fileName: "scriptgo.lua" });
    const all = ["scriptgo.lua", "config.lua", "server/main.lua", "data/items.json", "data/inv_pro-2.1.0.escrow-key.json"];
    const r = await scriptgoArchive((parsed as { manifest: any }).manifest, all, dir, "scriptgo.lua");
    expect(r.errors.map((e) => e.code)).toEqual(["secret_file"]);
    expect(r.zip.byteLength).toBe(0);
    const errors: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => { errors.push(a.join(" ")); };
    try {
      expect(await packRun([dir, "--target", "open77", "--out", join(tmp, "pack-out")])).toBe(1);
    } finally {
      console.error = original;
    }
    expect(errors.join("\n")).toMatch(/secret_file: data\/inv_pro-2\.1\.0\.escrow-key\.json/);
    expect(existsSync(join(tmp, "pack-out"))).toBe(false);
  });
});
