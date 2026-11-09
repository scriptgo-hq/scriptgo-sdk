import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";

/**
 * Vetted primitives only, through Node's `crypto` (OpenSSL): AES-256-GCM (AEAD), X25519 key
 * agreement and ed25519 signatures. No primitive is hand-rolled. The byte layouts below are the
 * cross-language contract: the .NET loader (ScriptGo.Host.Escrow) mirrors them exactly, with
 * System.Security.Cryptography AES-GCM and NSec (libsodium) X25519/ed25519. Any change here is a
 * change to docs/spec/escrow.md and to the .NET side, together.
 *
 * Honest ceiling (CREATOR-PROTECTION.md §1): encryption raises the cost of copying a resource off a
 * server and makes a leaked file useless on an unbound one. It does not stop the operator of a host
 * that must decrypt and run the code from recovering it on their own machine. These routines are the
 * "real crypto where a host can hold a secret" layer, never a secrecy claim on a pure-Lua host.
 */

// DER prefixes that wrap a raw 32-byte Curve25519 key (RFC 8410). Node exports/imports only DER;
// the raw bytes are what NSec and libsodium use, so we strip and re-add the prefix here.
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex"); // 12 bytes + 32-byte public
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex"); // 16 bytes + 32-byte seed
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export const CONTENT_KEY_BYTES = 32;
export const AES_NONCE_BYTES = 12;
export const AES_TAG_BYTES = 16;
export const X25519_KEY_BYTES = 32;

// --------------------------------------------------------------------------- AES-256-GCM (AEAD)

export interface Aead {
  /** 12-byte nonce. Unique per (key, message); callers pass a fresh random one. */
  nonce: Buffer;
  /** Ciphertext with the 16-byte GCM tag appended (the layout AesGcm uses on the .NET side). */
  ciphertext: Buffer;
}

/** AES-256-GCM encrypt. `aad` is authenticated but not encrypted; it binds the blob to a release. */
export function aeadEncrypt(key: Buffer, plaintext: Buffer, aad: Buffer, nonce = randomBytes(AES_NONCE_BYTES)): Aead {
  if (key.length !== 32) throw new Error("AES-256-GCM needs a 32-byte key.");
  if (nonce.length !== AES_NONCE_BYTES) throw new Error("AES-GCM nonce must be 12 bytes.");
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ciphertext: Buffer.concat([body, cipher.getAuthTag()]) };
}

/** AES-256-GCM decrypt. Throws if the tag or the AAD does not verify (tamper-evident). */
export function aeadDecrypt(key: Buffer, nonce: Buffer, ciphertextWithTag: Buffer, aad: Buffer): Buffer {
  if (key.length !== 32) throw new Error("AES-256-GCM needs a 32-byte key.");
  if (ciphertextWithTag.length < AES_TAG_BYTES) throw new Error("ciphertext is shorter than the GCM tag.");
  const tag = ciphertextWithTag.subarray(ciphertextWithTag.length - AES_TAG_BYTES);
  const body = ciphertextWithTag.subarray(0, ciphertextWithTag.length - AES_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export function randomContentKey(): Buffer {
  return randomBytes(CONTENT_KEY_BYTES);
}

// --------------------------------------------------------------------------- X25519 (key wrapping)

export interface X25519KeyPair {
  /** Raw 32-byte public key (what the server registers with its deployment). */
  publicKey: Buffer;
  /** Raw 32-byte private seed (never leaves the server). */
  privateKey: Buffer;
}

export function generateX25519KeyPair(): X25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return { publicKey: rawFromPublic(publicKey, X25519_SPKI_PREFIX), privateKey: rawFromPrivate(privateKey, X25519_PKCS8_PREFIX) };
}

function rawFromPublic(key: KeyObject, prefix: Buffer): Buffer {
  const der = key.export({ type: "spki", format: "der" });
  return Buffer.from(der.subarray(prefix.length));
}

function rawFromPrivate(key: KeyObject, prefix: Buffer): Buffer {
  const der = key.export({ type: "pkcs8", format: "der" });
  return Buffer.from(der.subarray(prefix.length));
}

function x25519PublicFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== X25519_KEY_BYTES) throw new Error("X25519 public key must be 32 bytes.");
  return createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

function x25519PrivateFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== X25519_KEY_BYTES) throw new Error("X25519 private key must be 32 bytes.");
  return createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
}

/** Raw 32-byte X25519 shared secret (same bytes NSec's X25519 agreement yields). */
export function x25519Shared(privateRaw: Buffer, publicRaw: Buffer): Buffer {
  return diffieHellman({ privateKey: x25519PrivateFromRaw(privateRaw), publicKey: x25519PublicFromRaw(publicRaw) });
}

/**
 * Wraps a content key to a server's X25519 public key (an ECIES: ephemeral X25519 + HKDF-SHA256 +
 * AES-256-GCM). A copied encrypted folder on another box has no matching private key and cannot
 * unwrap the key — the FiveM "lack entitlement" outcome without hardware fingerprinting.
 * Layout, base64url in JSON: { epk, nonce, wrapped } where wrapped = ciphertext||tag.
 */
export interface WrappedKey {
  /** Ephemeral public key, raw 32 bytes (base64url in transit). */
  epk: string;
  nonce: string;
  wrapped: string;
}

const WRAP_INFO = Buffer.from("scriptgo.escrow.keywrap.v1", "utf8");

function wrapKeyEncryptionKey(shared: Buffer, epk: Buffer, serverPub: Buffer): Buffer {
  // Binding the salt to both public keys defends against key-reuse / unknown-key-share surprises.
  const salt = Buffer.concat([epk, serverPub]);
  return Buffer.from(hkdfSync("sha256", shared, salt, WRAP_INFO, 32));
}

export function wrapContentKey(contentKey: Buffer, serverPublicRaw: Buffer, aad: Buffer): WrappedKey {
  const eph = generateX25519KeyPair();
  const shared = x25519Shared(eph.privateKey, serverPublicRaw);
  const kek = wrapKeyEncryptionKey(shared, eph.publicKey, serverPublicRaw);
  const { nonce, ciphertext } = aeadEncrypt(kek, contentKey, aad);
  return { epk: eph.publicKey.toString("base64url"), nonce: nonce.toString("base64url"), wrapped: ciphertext.toString("base64url") };
}

export function unwrapContentKey(wrapped: WrappedKey, serverPrivateRaw: Buffer, serverPublicRaw: Buffer, aad: Buffer): Buffer {
  const epk = Buffer.from(wrapped.epk, "base64url");
  const shared = x25519Shared(serverPrivateRaw, epk);
  const kek = wrapKeyEncryptionKey(shared, epk, serverPublicRaw);
  return aeadDecrypt(kek, Buffer.from(wrapped.nonce, "base64url"), Buffer.from(wrapped.wrapped, "base64url"), aad);
}

// --------------------------------------------------------------------------- ed25519 (signing)

export interface Ed25519KeyPair {
  publicKey: Buffer;
  privateKey: Buffer;
}

/** A deterministic ed25519 key pair from a 32-byte seed (the release signing key). */
export function ed25519FromSeed(seed: Buffer): Ed25519KeyPair {
  if (seed.length !== 32) throw new Error("ed25519 seed must be 32 bytes.");
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  return { publicKey: rawFromPublic(publicKey, ED25519_SPKI_PREFIX), privateKey: seed };
}

export function ed25519Sign(message: Buffer, seed: Buffer): Buffer {
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  return edSign(null, message, privateKey);
}

export function ed25519Verify(message: Buffer, signature: Buffer, publicRaw: Buffer): boolean {
  if (publicRaw.length !== 32) return false;
  const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, publicRaw]), format: "der", type: "spki" });
  return edVerify(null, message, publicKey, signature);
}
