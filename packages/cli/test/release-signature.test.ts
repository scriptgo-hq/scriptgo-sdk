import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, ed25519FromSeed, ed25519Sign } from "@scriptgo/escrow";
import { keyIdOf, signatureFromHeaders, trustedKeysFor, trustFile, verifyRelease, type ReleaseSignature } from "../src/lib/release-signature.ts";

const dir = mkdtempSync(join(tmpdir(), "scriptgo-cli-trust-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  process.env.SCRIPTGO_CONFIG_DIR = mkdtempSync(join(dir, "cfg-"));
  delete process.env.SCRIPTGO_RELEASE_KEYS;
});

const SEED = Buffer.alloc(32, 0x31);
const OTHER = Buffer.alloc(32, 0x32);
const pub = (seed: Buffer) => ed25519FromSeed(seed).publicKey.toString("base64url");
const bytes = Buffer.from("the archive the registry published");
const sha = createHash("sha256").update(bytes).digest("hex");

function sign(seed: Buffer, over: Record<string, unknown> = {}): ReleaseSignature {
  const payload = canonicalJson({ v: 1, package: "kestrel//inv-pro", version: "2.1.0", sha256: sha, size: bytes.length, escrow: false, publishedAt: "2026-11-10T00:00:00.000Z", ...over });
  return { alg: "ed25519", keyId: keyIdOf(pub(seed)), payload, signature: ed25519Sign(Buffer.from(payload, "utf8"), seed).toString("base64url") };
}
const key = (seed: Buffer) => ({ keyId: keyIdOf(pub(seed)), publicKey: pub(seed) });
const expected = { package: "kestrel//inv-pro", version: "2.1.0", sha256: sha };

describe("release signature check (scriptgo add)", () => {
  it("accepts the registry's signature over exactly these bytes", () => {
    expect(verifyRelease(sign(SEED), [key(SEED)], expected)).toEqual({ ok: true });
  });

  it("refuses a tampered archive, another release, a forged payload, an untrusted key and no signature", () => {
    const tampered = createHash("sha256").update(Buffer.concat([bytes, Buffer.from("!")])).digest("hex");
    expect(verifyRelease(sign(SEED), [key(SEED)], { ...expected, sha256: tampered })).toMatchObject({ ok: false, reason: expect.stringMatching(/tampered or corrupted/) });
    expect(verifyRelease(sign(SEED), [key(SEED)], { ...expected, version: "2.1.1" })).toMatchObject({ ok: false });
    expect(verifyRelease(sign(SEED), [key(SEED)], { ...expected, package: "mallory//inv-pro" })).toMatchObject({ ok: false });
    // The attacker rewrites the signed hash to match their bytes: the signature no longer verifies.
    const forged = { ...sign(SEED), payload: sign(SEED).payload.replace(sha, tampered) };
    expect(verifyRelease(forged, [key(SEED)], { ...expected, sha256: tampered })).toMatchObject({ ok: false, reason: expect.stringMatching(/does not verify/) });
    // The attacker signs with their own key: it is not a trusted release key.
    expect(verifyRelease(sign(OTHER, { sha256: tampered }), [key(SEED)], { ...expected, sha256: tampered })).toMatchObject({ ok: false, reason: expect.stringMatching(/does not trust/) });
    expect(verifyRelease(null, [key(SEED)], expected)).toMatchObject({ ok: false });
    expect(verifyRelease({ ...sign(SEED), alg: "rsa" }, [key(SEED)], expected)).toMatchObject({ ok: false });
  });

  it("reads the signature from the download headers", () => {
    const s = sign(SEED);
    const h = new Headers({ "x-scriptgo-signature": s.signature, "x-scriptgo-signature-key": s.keyId, "x-scriptgo-signature-payload": Buffer.from(s.payload).toString("base64url") });
    expect(signatureFromHeaders(h)).toEqual(s);
    expect(signatureFromHeaders(new Headers({ "x-scriptgo-signature": s.signature }))).toBeNull();
  });
});

describe("trusted release keys", () => {
  const api = "https://registry.example";

  it("pins the registry's keys on first use and keeps them", () => {
    const first = trustedKeysFor(api, [{ ...key(SEED) }]);
    expect(first.keys).toEqual([key(SEED)]);
    expect(first.notes[0]).toMatch(/first use/);
    expect(JSON.parse(readFileSync(trustFile(), "utf8"))[api]).toEqual([key(SEED)]);
    expect(trustedKeysFor(api, [key(SEED)]).notes).toEqual([]);
  });

  it("does not trust a key the registry starts serving later, until the operator accepts it", () => {
    trustedKeysFor(api, [key(SEED)]);
    // A hijacked registry (or a rotation) serves another key.
    const later = trustedKeysFor(api, [key(OTHER)]);
    expect(later.keys).toEqual([key(SEED)]);
    expect(verifyRelease(sign(OTHER), later.keys, expected)).toMatchObject({ ok: false, reason: expect.stringMatching(/--trust-new-key/) });
    const accepted = trustedKeysFor(api, [key(OTHER)], { trustNew: true });
    expect(accepted.keys).toEqual([key(SEED), key(OTHER)]);
    expect(verifyRelease(sign(OTHER), accepted.keys, expected)).toEqual({ ok: true });
    // Pins are per registry.
    expect(trustedKeysFor("https://other.example", [key(OTHER)]).keys).toEqual([key(OTHER)]);
  });

  it("uses keys pinned out of band when SCRIPTGO_RELEASE_KEYS is set", () => {
    process.env.SCRIPTGO_RELEASE_KEYS = pub(SEED);
    const t = trustedKeysFor(api, [key(OTHER)]);
    expect(t.keys).toEqual([key(SEED)]);
    expect(verifyRelease(sign(OTHER), t.keys, expected).ok).toBe(false);
  });
});
