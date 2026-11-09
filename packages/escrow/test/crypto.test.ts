import { describe, expect, it } from "vitest";
import {
  aeadDecrypt,
  aeadEncrypt,
  ed25519FromSeed,
  ed25519Sign,
  ed25519Verify,
  generateX25519KeyPair,
  randomContentKey,
  unwrapContentKey,
  wrapContentKey,
  x25519Shared,
} from "../src/crypto.ts";

const aad = Buffer.from("pkg@1.0.0");

describe("AES-256-GCM", () => {
  it("round-trips and is tamper-evident on ciphertext, tag and aad", () => {
    const key = randomContentKey();
    const pt = Buffer.from("secret script body");
    const { nonce, ciphertext } = aeadEncrypt(key, pt, aad);
    expect(aeadDecrypt(key, nonce, ciphertext, aad).equals(pt)).toBe(true);

    const flipped = Buffer.from(ciphertext);
    flipped[0]! ^= 1;
    expect(() => aeadDecrypt(key, nonce, flipped, aad)).toThrow();
    expect(() => aeadDecrypt(key, nonce, ciphertext, Buffer.from("other@1.0.0"))).toThrow();
    expect(() => aeadDecrypt(randomContentKey(), nonce, ciphertext, aad)).toThrow();
  });
});

describe("X25519 key wrapping", () => {
  it("agrees on a shared secret both ways", () => {
    const a = generateX25519KeyPair();
    const b = generateX25519KeyPair();
    expect(x25519Shared(a.privateKey, b.publicKey).equals(x25519Shared(b.privateKey, a.publicKey))).toBe(true);
  });

  it("wraps a content key only the bound server can unwrap", () => {
    const server = generateX25519KeyPair();
    const other = generateX25519KeyPair();
    const contentKey = randomContentKey();
    const wrapped = wrapContentKey(contentKey, server.publicKey, aad);
    expect(unwrapContentKey(wrapped, server.privateKey, server.publicKey, aad).equals(contentKey)).toBe(true);
    // A copied folder on another box (another keypair) cannot unwrap it.
    expect(() => unwrapContentKey(wrapped, other.privateKey, other.publicKey, aad)).toThrow();
    // A different release (different aad) is refused too.
    expect(() => unwrapContentKey(wrapped, server.privateKey, server.publicKey, Buffer.from("pkg@2.0.0"))).toThrow();
  });
});

describe("ed25519", () => {
  it("signs and verifies, and rejects a tampered message or a wrong key", () => {
    const seed = Buffer.alloc(32, 7);
    const { publicKey } = ed25519FromSeed(seed);
    const msg = Buffer.from("escrow manifest bytes");
    const sig = ed25519Sign(msg, seed);
    expect(ed25519Verify(msg, sig, publicKey)).toBe(true);
    expect(ed25519Verify(Buffer.from("tampered"), sig, publicKey)).toBe(false);
    expect(ed25519Verify(msg, sig, ed25519FromSeed(Buffer.alloc(32, 8)).publicKey)).toBe(false);
  });
});
