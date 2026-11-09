import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { parseManifest } from "@scriptgo/manifest";
import { openEscrowRelease, readBundle } from "@scriptgo/escrow";
import { packEscrow } from "../src/lib/escrow-pack.ts";

const tmp = mkdtempSync(join(tmpdir(), "scriptgo-cli-escrow-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// A fixed signing key so the test never writes to ~/.scriptgo.
beforeAll(() => { process.env.RELEASE_SIGNING_KEY = Buffer.alloc(32, 0x4c).toString("base64"); });

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
    const r = packEscrow({
      archive: archive(), manifest: (parsed as { manifest: any }).manifest, manifestFile: "scriptgo.lua",
      identifier: "kestrel//inv-pro", outDir: tmp, allowlist: ["config.lua"],
    });
    expect(r.clearFiles.sort()).toEqual(["README.md", "config.lua", "scriptgo.lua"]);
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
});
