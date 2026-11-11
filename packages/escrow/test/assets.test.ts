import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  appendStoredEntry,
  AssetContainerReader,
  assetClientAad,
  assetKeyId,
  buildFingerprinted,
  canonicalJson,
  deriveAssetContentKey,
  ed25519Sign,
  findFingerprints,
  fingerprintEntry,
  FINGERPRINT_ENTRY,
  generateX25519KeyPair,
  readAssetContainer,
  readZip,
  replaceEntries,
  sealAssetContainer,
  unwrapAssetKeyOnClient,
  verifyFingerprintRecord,
  wrapAssetKeyForClient,
} from "../src/index.ts";
import { assetVectors, MATERIAL, releaseArchive } from "./vectors/build.ts";

const here = dirname(fileURLToPath(import.meta.url));
const identity = { package: "kestrel//night-market", version: "2.0.0", release: "rel_01", licence: "lic_42", deployment: "dep_7" };

describe("the zip reader is the same file in both packages", () => {
  it("packages/escrow/src/zip.ts equals packages/manifest/src/zip.ts", () => {
    const a = readFileSync(join(here, "..", "src", "zip.ts"), "utf8").replace(/\r\n/g, "\n");
    const b = readFileSync(join(here, "..", "..", "manifest", "src", "zip.ts"), "utf8").replace(/\r\n/g, "\n");
    expect(a).toBe(b);
  });
});

describe("per-buyer fingerprinted builds", () => {
  const { zip, preload } = releaseArchive();
  const build = (licence: string) =>
    buildFingerprinted({
      zip, root: "night_market/", containers: ["night_market/dist/night_market.zip"],
      identity: { ...identity, licence }, secret: MATERIAL.fingerprintSecret, signerSeed: MATERIAL.fingerprintSignerSeed,
    });

  it("is deterministic and differs per buyer, outer and inner", () => {
    const a1 = build("lic_42");
    const a2 = build("lic_42");
    const b = build("lic_43");
    expect(a1.zip.equals(a2.zip)).toBe(true);
    expect(a1.sha256).not.toBe(b.sha256);
    expect(a1.containers[0]!.sha256).not.toBe(b.containers[0]!.sha256);
    expect(a1.marker).not.toBe(b.marker);
  });

  it("keeps every original entry's bytes and adds one signed entry per archive", () => {
    const out = build("lic_42");
    const files = unzipSync(out.zip);
    expect(Object.keys(files).sort()).toEqual(["night_market/.scriptgo/fingerprint.json", "night_market/dist/night_market.zip", "night_market/media/night_market_sign.png", "night_market/scriptgo.lua"]);
    const original = unzipSync(zip);
    expect(Buffer.from(files["night_market/scriptgo.lua"]!).equals(Buffer.from(original["night_market/scriptgo.lua"]!))).toBe(true);
    const inner = unzipSync(files["night_market/dist/night_market.zip"]!);
    const innerOriginal = unzipSync(preload);
    for (const [k, v] of Object.entries(innerOriginal)) expect(Buffer.from(inner[k]!).equals(Buffer.from(v))).toBe(true);
    expect(Object.keys(inner)).toContain(FINGERPRINT_ENTRY);
    const found = findFingerprints(out.zip);
    expect(found.map((f) => [f.where, f.ok, f.record?.container])).toEqual([
      ["night_market/dist/night_market.zip!.scriptgo/fingerprint.json", true, "night_market/dist/night_market.zip"],
      ["night_market/.scriptgo/fingerprint.json", true, ""],
    ]);
    expect(found[1]!.record!.licence).toBe("lic_42");
  });

  it("the stamped archives pass the strict reader (offsets, CRC, no hidden bytes)", () => {
    const out = build("lic_42");
    expect(() => readZip(out.zip)).not.toThrow();
    const entry = readZip(out.zip).entries.find((e) => e.name.endsWith("night_market.zip"))!;
    expect(() => readZip(out.zip.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize))).not.toThrow();
  });

  it("refuses an archive that already carries a fingerprint, and a forged record", () => {
    const once = appendStoredEntry(preload, FINGERPRINT_ENTRY, Buffer.from("{}"));
    expect(() => appendStoredEntry(once, FINGERPRINT_ENTRY, Buffer.from("{}"))).toThrow(/already holds/);
    const { record } = fingerprintEntry(identity, "", MATERIAL.fingerprintSecret, MATERIAL.fingerprintSignerSeed);
    expect(verifyFingerprintRecord(record).ok).toBe(true);
    expect(verifyFingerprintRecord({ ...record, licence: "lic_other" }).ok).toBe(false);
    expect(verifyFingerprintRecord(record, "another-key").ok).toBe(false);
  });

  it("replaceEntries keeps unchanged entries byte for byte", () => {
    const z = Buffer.from(zipSync({ "a.txt": Buffer.from("aaaa"), "b.txt": Buffer.from("bbbb") }, { level: 9 }));
    const out = replaceEntries(z, new Map([["a.txt", Buffer.from("AAAAAAAA")]]));
    const files = unzipSync(out);
    expect(Buffer.from(files["a.txt"]!).toString()).toBe("AAAAAAAA");
    expect(Buffer.from(files["b.txt"]!).toString()).toBe("bbbb");
    const before = readZip(z).entries.find((e) => e.name === "b.txt")!;
    const after = readZip(out).entries.find((e) => e.name === "b.txt")!;
    expect(out.subarray(after.localOffset, after.endOffset).equals(z.subarray(before.localOffset, before.endOffset))).toBe(true);
  });
});

describe("asset escrow containers", () => {
  const key = deriveAssetContentKey(MATERIAL.releaseSecret, "dep_7");
  const big = Buffer.alloc(10_000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
  const files = new Map([["archive/pc/mod/a.archive", big], ["empty.bin", Buffer.alloc(0)]]);
  const seal = () => sealAssetContainer({ files, package: identity.package, version: identity.version, release: "rel_01", deployment: "dep_7", contentKey: key, signerSeed: MATERIAL.assetSignerSeed, chunkBytes: 4096 });

  it("derives one key per deployment", () => {
    expect(deriveAssetContentKey(MATERIAL.releaseSecret, "dep_8").equals(key)).toBe(false);
  });

  it("round-trips random-access reads across chunk boundaries", () => {
    const r = new AssetContainerReader(seal(), key);
    expect(r.readAll("archive/pc/mod/a.archive").equals(big)).toBe(true);
    for (const [o, l] of [[0, 1], [4095, 2], [4096, 4096], [8000, 5000], [9999, 1], [10_000, 5]] as const) {
      expect(r.read("archive/pc/mod/a.archive", o, l).equals(big.subarray(o, Math.min(big.length, o + l)))).toBe(true);
    }
    expect(r.readAll("empty.bin").length).toBe(0);
    r.close();
    expect(() => r.read("empty.bin", 0, 1)).toThrow(/closed/);
  });

  it("is deterministic for one copy", () => {
    expect(seal().equals(seal())).toBe(true);
  });

  it("refuses a wrong key, a tampered chunk, a swapped chunk, a truncated body and an untrusted signer", () => {
    const c = seal();
    expect(() => new AssetContainerReader(c, deriveAssetContentKey(MATERIAL.releaseSecret, "dep_8"))).toThrow(/key/);
    const view = readAssetContainer(c);
    const f = view.header.files.find((x) => x.path === "archive/pc/mod/a.archive")!;
    const flipped = Buffer.from(c);
    flipped[view.bodyOffset + f.offset + 5]! ^= 1;
    expect(() => readAssetContainer(flipped)).toThrow(/hash mismatch/);
    expect(() => readAssetContainer(c.subarray(0, c.length - 1))).toThrow(/body length/);
    expect(() => readAssetContainer(c, { trustedSigner: "x" })).toThrow(/pinned/);
    // A header edited after signing.
    const headerText = c.subarray(12, 12 + c.readUInt32LE(8)).toString("utf8").replace('"rel_01"', '"rel_02"');
    const edited = Buffer.concat([c.subarray(0, 12), Buffer.from(headerText), c.subarray(12 + c.readUInt32LE(8))]);
    expect(() => readAssetContainer(edited)).toThrow(/signature/);
  });

  it("detects chunks moved within a file even when the file hash is recomputed by an attacker with the signer", () => {
    // Swap chunk 0 and 1 of the archive, then re-sign with the signer (a stronger attacker than a
    // player): the per-chunk additional data and nonce still refuse the reordering.
    const c = seal();
    const view = readAssetContainer(c);
    const f = view.header.files.find((x) => x.path === "archive/pc/mod/a.archive")!;
    const start = view.bodyOffset + f.offset;
    const step = 4096 + 16;
    const body = Buffer.from(c.subarray(view.bodyOffset));
    const off = f.offset;
    c.copy(body, off, start + step, start + 2 * step);
    c.copy(body, off + step, start, start + step);
    const header = { ...view.header, files: view.header.files.map((x) => (x.path === f.path ? { ...x, sha256: createHash("sha256").update(body.subarray(off, off + f.length)).digest("hex") } : x)), signature: "" };
    header.signature = ed25519Sign(Buffer.from(canonicalJson(header), "utf8"), MATERIAL.assetSignerSeed).toString("base64url");
    const headerBytes = Buffer.from(canonicalJson(header), "utf8");
    const pre = Buffer.from(c.subarray(0, 12));
    pre.writeUInt32LE(headerBytes.length, 8);
    const resigned = Buffer.concat([pre, headerBytes, body]);
    const r = new AssetContainerReader(resigned, key);
    expect(() => r.read(f.path, 0, 10)).toThrow(/does not authenticate/);
    expect(() => r.read(f.path, 4096, 10)).toThrow(/does not authenticate/);
  });

  it("hands the key to a client session and only that session", () => {
    const client = generateX25519KeyPair();
    const other = generateX25519KeyPair();
    const aad = assetClientAad(identity.package, identity.version, assetKeyId(key));
    const wrapped = wrapAssetKeyForClient(key, client.publicKey, aad);
    expect(unwrapAssetKeyOnClient(wrapped, client.privateKey, client.publicKey, aad).equals(key)).toBe(true);
    expect(() => unwrapAssetKeyOnClient(wrapped, other.privateKey, other.publicKey, aad)).toThrow();
    expect(() => unwrapAssetKeyOnClient(wrapped, client.privateKey, client.publicKey, Buffer.from("other"))).toThrow();
  });
});

describe("committed asset vectors", () => {
  it("are reproduced exactly (regenerate with node packages/escrow/tools/gen-asset-vectors.ts)", () => {
    const committed = JSON.parse(readFileSync(join(here, "vectors", "asset-vectors.json"), "utf8")) as unknown;
    expect(JSON.parse(JSON.stringify(assetVectors()))).toEqual(committed);
  });

  it("open with the published key material", () => {
    const v = JSON.parse(readFileSync(join(here, "vectors", "asset-vectors.json"), "utf8")) as {
      assetEscrow: { containerBase64: string; contentKey: string; signerPublicKey: string; files: { path: string; sha256: string }[]; client: { privateKey: string; publicKey: string; aad: string; wrapped: { epk: string; nonce: string; wrapped: string } } };
    };
    const a = v.assetEscrow;
    const key = unwrapAssetKeyOnClient(a.client.wrapped, Buffer.from(a.client.privateKey, "base64url"), Buffer.from(a.client.publicKey, "base64url"), Buffer.from(a.client.aad, "utf8"));
    expect(key.equals(Buffer.from(a.contentKey, "base64"))).toBe(true);
    const r = new AssetContainerReader(Buffer.from(a.containerBase64, "base64"), key, { trustedSigner: a.signerPublicKey });
    for (const f of a.files) expect(createHash("sha256").update(r.readAll(f.path)).digest("hex")).toBe(f.sha256);
  });
});
