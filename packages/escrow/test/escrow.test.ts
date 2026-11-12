import { describe, expect, it } from "vitest";
import {
  buildEscrowRelease,
  defaultAllowlist,
  ed25519FromSeed,
  generateX25519KeyPair,
  matchesAllowlist,
  openEscrowRelease,
  readBundle,
  releaseAad,
  stampDelivery,
  unwrapContentKey,
  verifyManifest,
  watermarkMatches,
  wrapContentKey,
} from "../src/index.ts";
import { DELIVERY_MARKER } from "../src/format.ts";
import { canonicalJson } from "../src/canonical.ts";
import { ed25519Sign } from "../src/crypto.ts";
import { unzipSync, zipSync } from "fflate";

const SEED = Buffer.alloc(32, 3);

function resource(): Map<string, Buffer> {
  return new Map<string, Buffer>([
    ["scriptgo.lua", Buffer.from('resource "demo"\nversion "1.0.0"\nserver_script "server/main.lua"\n')],
    ["README.md", Buffer.from("# demo")],
    ["config.lua", Buffer.from("return { rate = 5 }")],
    ["server/main.lua", Buffer.from("print('secret logic')")],
    ["server/secret.lua", Buffer.from("return 42")],
  ]);
}

describe("allowlist", () => {
  it("globs within and across segments", () => {
    expect(matchesAllowlist("config.lua", ["config.lua"])).toBe(true);
    expect(matchesAllowlist("stream/a.yft", ["stream/*.yft"])).toBe(true);
    expect(matchesAllowlist("stream/sub/a.yft", ["stream/*.yft"])).toBe(false);
    expect(matchesAllowlist("stream/sub/a.yft", ["stream/**/*.yft"])).toBe(true);
    expect(matchesAllowlist("server/main.lua", ["config.lua"])).toBe(false);
  });
});

describe("buildEscrowRelease", () => {
  it("keeps manifest+docs+named config clear and encrypts the rest", () => {
    const built = buildEscrowRelease({
      files: resource(), package: "kestrel//demo", version: "1.0.0", manifestFile: "scriptgo.lua",
      allowlist: ["config.lua"], signingSeed: SEED,
    });
    expect(built.clearFiles.sort()).toEqual(["README.md", "config.lua", "scriptgo.lua"]);
    expect(built.encryptedFiles.sort()).toEqual(["server/main.lua", "server/secret.lua"]);

    // The bundle must NOT contain the plaintext of an encrypted file anywhere.
    expect(built.bundle.includes(Buffer.from("secret logic"))).toBe(false);
    // The content key is never inside the bundle.
    expect(built.bundle.includes(built.contentKey)).toBe(false);
  });

  it("round-trips through the reference decryptor with the content key", () => {
    const built = buildEscrowRelease({ files: resource(), package: "kestrel//demo", version: "1.0.0", manifestFile: "scriptgo.lua", signingSeed: SEED });
    const files = openEscrowRelease({ bundle: built.bundle, contentKey: built.contentKey, trustedSignerPublicKey: built.manifest.signerPublicKey });
    expect(files.get("server/main.lua")!.toString()).toBe("print('secret logic')");
    expect(files.get("server/secret.lua")!.toString()).toBe("return 42");
    expect(files.get("scriptgo.lua")!.toString()).toContain("resource");
  });

  it("refuses a wrong content key, a tampered payload and an untrusted signer", () => {
    const built = buildEscrowRelease({ files: resource(), package: "kestrel//demo", version: "1.0.0", manifestFile: "scriptgo.lua", signingSeed: SEED });
    expect(() => openEscrowRelease({ bundle: built.bundle, contentKey: Buffer.alloc(32, 9) })).toThrow();

    const { manifest } = readBundle(built.bundle);
    expect(verifyManifest(manifest).ok).toBe(true);
    expect(verifyManifest(manifest, { trustedSignerPublicKey: ed25519FromSeed(Buffer.alloc(32, 1)).publicKey.toString("base64url") }).ok).toBe(false);

    const tampered = { ...manifest, package: "evil//demo" };
    expect(verifyManifest(tampered).ok).toBe(false);
  });

  it("refuses a file added next to a validly signed manifest, and a path listed clear and encrypted", () => {
    const built = buildEscrowRelease({ files: resource(), package: "kestrel//demo", version: "1.0.0", manifestFile: "scriptgo.lua", signingSeed: SEED });
    const pinned = built.manifest.signerPublicKey;
    const entries = unzipSync(built.bundle);
    entries["server/evil.lua"] = Buffer.from("os.execute('calc')");
    const added = Buffer.from(zipSync(entries));
    expect(() => openEscrowRelease({ bundle: added, contentKey: built.contentKey, trustedSignerPublicKey: pinned })).toThrow(/server\/evil\.lua is in the bundle but not in escrow\.json/);

    // Signed by the creator, but a path both clear and encrypted is ambiguous: refused.
    const manifest = { ...built.manifest, clearFiles: [...built.manifest.clearFiles, { path: "server/main.lua", bytes: 5, sha256: "0".repeat(64) }], signature: "" };
    manifest.signature = ed25519Sign(Buffer.from(canonicalJson(manifest), "utf8"), SEED).toString("base64url");
    const both = unzipSync(built.bundle);
    both["escrow.json"] = Buffer.from(JSON.stringify(manifest), "utf8");
    both["server/main.lua"] = Buffer.from("print('x')");
    expect(() => openEscrowRelease({ bundle: Buffer.from(zipSync(both)), contentKey: built.contentKey, trustedSignerPublicKey: pinned })).toThrow(/listed both clear and encrypted/);
  });
});

describe("end-to-end escrow chain (build → wrap → unwrap → decrypt)", () => {
  it("delivers the content key wrapped to a bound server and runs only there", () => {
    const built = buildEscrowRelease({ files: resource(), package: "kestrel//demo", version: "1.0.0", manifestFile: "scriptgo.lua", signingSeed: SEED, watermarkSecret: "watermark-secret-0123456789" });
    const aad = releaseAad("kestrel//demo", "1.0.0");

    // The master wraps the stored content key to the server's registered public key.
    const server = generateX25519KeyPair();
    const wrapped = wrapContentKey(built.contentKey, server.publicKey, aad);

    // The licensed, bound server unwraps it and decrypts in memory.
    const key = unwrapContentKey(wrapped, server.privateKey, server.publicKey, aad);
    const files = openEscrowRelease({ bundle: built.bundle, contentKey: key, trustedSignerPublicKey: built.manifest.signerPublicKey });
    expect(files.get("server/main.lua")!.toString()).toBe("print('secret logic')");

    // A different (unbound) server cannot get the key.
    const unbound = generateX25519KeyPair();
    expect(() => unwrapContentKey(wrapped, unbound.privateKey, unbound.publicKey, aad)).toThrow();

    // The release watermark is present and attributable.
    expect(built.manifest.watermark).not.toBeNull();
    expect(watermarkMatches(built.manifest.watermark!, { releaseId: "kestrel//demo@1.0.0" }, "watermark-secret-0123456789")).toBe(true);

    // The loader stamps a per-delivery marker for traceability.
    stampDelivery(files, { releaseId: "kestrel//demo@1.0.0", licenseId: "lic_1", deploymentId: "dep_1" }, "watermark-secret-0123456789");
    expect(files.has(DELIVERY_MARKER)).toBe(true);
  });
});

describe("defaultAllowlist", () => {
  it("is the manifest and docs", () => {
    expect(defaultAllowlist("open77.lua")).toContain("open77.lua");
    expect(defaultAllowlist("scriptgo.lua")).toContain("README.md");
  });
});
