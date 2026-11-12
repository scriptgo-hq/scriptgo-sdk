// Asset escrow: the encrypted container format `scriptgo-asset-escrow/1` (docs/spec/assets.md,
// "Asset escrow"), its sealer, a reference decryptor and the key steps around it.
//
// Files are encrypted at rest and in transit with AES-256-GCM, cut into chunks so a reader can
// serve any byte range without decrypting the whole file (an engine reads an archive by offset).
// Each chunk's nonce is a per-file prefix and the chunk index; the additional data binds the chunk
// to the release, the file path, its index and whether it is the last one, so chunks cannot be
// reordered, moved between files or truncated without the tag failing. This is the STREAM
// construction over a vetted AEAD; no primitive is written here (Node crypto, OpenSSL).
//
// Honest ceiling: a game client that renders an asset holds it in clear in its memory, and in GPU
// memory. Whoever controls that machine can copy it there. The container raises the cost of
// copying (no clear file on disk, in a CDN, in a leaked server folder) and binds delivery to a
// licensed server; it does not make copying impossible.
import { createHash, hkdfSync } from "node:crypto";
import { canonicalJson } from "./canonical.ts";
import {
  aeadDecrypt,
  aeadEncrypt,
  AES_TAG_BYTES,
  ed25519FromSeed,
  ed25519Sign,
  ed25519Verify,
  generateX25519KeyPair,
  x25519Shared,
  type WrappedKey,
  type X25519KeyPair,
} from "./crypto.ts";
import { appendStoredEntry, FINGERPRINT_SUFFIX, fingerprintMarker, isFingerprintEntryName, type FingerprintIdentity } from "./fingerprint.ts";
import { readZip, readZipEntry } from "./zip.ts";

export const ASSET_ESCROW_FORMAT = "scriptgo-asset-escrow/1";
export const ASSET_ESCROW_CIPHER = "AES-256-GCM-STREAM";
export const ASSET_ESCROW_KDF = "HKDF-SHA256+X25519";
export const ASSET_ESCROW_MAGIC = Buffer.from("SGAE", "ascii");
export const ASSET_ESCROW_VERSION = 1;
export const ASSET_ESCROW_DEFAULT_CHUNK = 1024 * 1024;
export const ASSET_ESCROW_MIN_CHUNK = 4096;
export const ASSET_ESCROW_MAX_CHUNK = 16 * 1024 * 1024;
/** The header is read before anything else: keep it bounded. */
export const ASSET_ESCROW_MAX_HEADER = 4 * 1024 * 1024;
const PREAMBLE = 12; // magic (4) | version (1) | reserved (3) | header length (u32 LE)

export interface AssetEscrowFile {
  /** Path the platform hook serves the file under (resource-relative, `/`). */
  path: string;
  /** Plaintext size in bytes. */
  bytes: number;
  /** Number of chunks (at least 1; an empty file is one empty final chunk). */
  chunks: number;
  /** Offset of the file's first chunk from the start of the body. */
  offset: number;
  /** Ciphertext length: every chunk with its 16-byte tag. */
  length: number;
  /** 8-byte nonce prefix, base64url. */
  noncePrefix: string;
  /** SHA-256 of the file's ciphertext range: integrity checked before any key is asked for. */
  sha256: string;
}

export interface AssetEscrowHeader {
  format: typeof ASSET_ESCROW_FORMAT;
  cipher: typeof ASSET_ESCROW_CIPHER;
  kdf: typeof ASSET_ESCROW_KDF;
  /** Registry identifier `creator//name`. */
  package: string;
  version: string;
  release: string;
  /** The deployment whose content key encrypts this copy ("" for a copy bound to no server). */
  deployment: string;
  chunkBytes: number;
  /** base64url of the first 16 bytes of SHA-256("scriptgo.asset-escrow.keyid.v1" ‖ contentKey). */
  keyId: string;
  /** The per-buyer fingerprint marker of this copy, or null. */
  fingerprint: string | null;
  files: AssetEscrowFile[];
  signerPublicKey: string;
  signature: string;
}

const b64 = (b: Buffer): string => b.toString("base64url");
const unb64 = (s: string): Buffer => Buffer.from(s, "base64url");
const sha256 = (b: Uint8Array): Buffer => createHash("sha256").update(b).digest();

/** Identifies a content key without revealing it. */
export function assetKeyId(contentKey: Buffer): string {
  return b64(sha256(Buffer.concat([Buffer.from("scriptgo.asset-escrow.keyid.v1", "utf8"), contentKey])).subarray(0, 16));
}

/**
 * The content key of one deployment's copy of a release: HKDF-SHA256 over the release's asset
 * secret (32 random bytes the platform keeps sealed), so each licensed server's copy has its own key
 * and a leaked key opens one server's copy only.
 */
export function deriveAssetContentKey(releaseSecret: Buffer, deployment: string): Buffer {
  if (releaseSecret.length !== 32) throw new Error("the release asset secret must be 32 bytes");
  return Buffer.from(hkdfSync("sha256", releaseSecret, Buffer.from("scriptgo.asset-escrow.cek.v1", "utf8"), Buffer.from(deployment, "utf8"), 32));
}

/**
 * A file's 8-byte nonce prefix: HKDF over the content key, the path and the plaintext's SHA-256.
 * Deterministic (the same copy seals to the same bytes) and distinct for every (key, path,
 * plaintext), so no two different plaintexts are ever encrypted under one key and nonce.
 */
export function assetNoncePrefix(contentKey: Buffer, path: string, plaintextSha256: Buffer): Buffer {
  const info = Buffer.concat([Buffer.from(`${path}\n`, "utf8"), plaintextSha256]);
  return Buffer.from(hkdfSync("sha256", contentKey, Buffer.from("scriptgo.asset-escrow.nonce.v1", "utf8"), info, 8));
}

function chunkNonce(prefix: Buffer, index: number): Buffer<ArrayBuffer> {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeUInt32BE(index, 8);
  return n;
}

/** Additional data of one chunk: format, release, path, index (u32 BE), final flag (u8). */
export function assetChunkAad(pkg: string, version: string, path: string, index: number, final: boolean): Buffer {
  const tail = Buffer.alloc(5);
  tail.writeUInt32BE(index, 0);
  tail.writeUInt8(final ? 1 : 0, 4);
  return Buffer.concat([Buffer.from(`${ASSET_ESCROW_FORMAT}\n${pkg}@${version}\n${path}\n`, "utf8"), tail]);
}

/** Path rules of escrow.md ("Path rules"). */
function unsafePath(p: string): boolean {
  return p.length === 0 || p.startsWith("/") || p.includes("\\") || p.includes(":") || /[\u0000-\u001f\u007f]/.test(p) || p.split("/").some((s) => s === "" || s === "." || s === "..");
}

/** Seals files into one container. Files are sealed in path order. */
export function sealAssetContainer(opts: {
  files: Map<string, Buffer>;
  package: string;
  version: string;
  release: string;
  deployment: string;
  contentKey: Buffer;
  signerSeed: Buffer;
  fingerprint?: string | null;
  chunkBytes?: number;
}): Buffer {
  const chunkBytes = opts.chunkBytes ?? ASSET_ESCROW_DEFAULT_CHUNK;
  if (!Number.isInteger(chunkBytes) || chunkBytes < ASSET_ESCROW_MIN_CHUNK || chunkBytes > ASSET_ESCROW_MAX_CHUNK) throw new Error(`chunkBytes must be between ${ASSET_ESCROW_MIN_CHUNK} and ${ASSET_ESCROW_MAX_CHUNK}`);
  if (opts.contentKey.length !== 32) throw new Error("the content key must be 32 bytes");
  const body: Buffer[] = [];
  const files: AssetEscrowFile[] = [];
  let offset = 0;
  for (const path of [...opts.files.keys()].sort()) {
    if (unsafePath(path)) throw new Error(`${path}: unsafe path`);
    const data = opts.files.get(path)!;
    const prefix = assetNoncePrefix(opts.contentKey, path, sha256(data));
    const chunks = Math.max(1, Math.ceil(data.length / chunkBytes));
    if (chunks > 0xffffffff) throw new Error(`${path}: too many chunks`);
    const parts: Buffer[] = [];
    for (let i = 0; i < chunks; i++) {
      const plain = Buffer.from(data.subarray(i * chunkBytes, Math.min(data.length, (i + 1) * chunkBytes)));
      const final = i === chunks - 1;
      parts.push(aeadEncrypt(opts.contentKey, plain, assetChunkAad(opts.package, opts.version, path, i, final), chunkNonce(prefix, i)).ciphertext);
    }
    const cipher = Buffer.concat(parts);
    files.push({ path, bytes: data.length, chunks, offset, length: cipher.length, noncePrefix: b64(prefix), sha256: sha256(cipher).toString("hex") });
    body.push(cipher);
    offset += cipher.length;
  }
  const header: AssetEscrowHeader = {
    format: ASSET_ESCROW_FORMAT,
    cipher: ASSET_ESCROW_CIPHER,
    kdf: ASSET_ESCROW_KDF,
    package: opts.package,
    version: opts.version,
    release: opts.release,
    deployment: opts.deployment,
    chunkBytes,
    keyId: assetKeyId(opts.contentKey),
    fingerprint: opts.fingerprint ?? null,
    files,
    signerPublicKey: b64(ed25519FromSeed(opts.signerSeed).publicKey),
    signature: "",
  };
  header.signature = b64(ed25519Sign(Buffer.from(canonicalJson(header), "utf8"), opts.signerSeed));
  const headerBytes = Buffer.from(canonicalJson(header), "utf8");
  const pre = Buffer.alloc(PREAMBLE);
  ASSET_ESCROW_MAGIC.copy(pre, 0);
  pre.writeUInt8(ASSET_ESCROW_VERSION, 4);
  pre.writeUInt32LE(headerBytes.length, 8);
  return Buffer.concat([pre, headerBytes, ...body]);
}

export class AssetEscrowError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface AssetContainerView {
  header: AssetEscrowHeader;
  /** Byte offset of the body in the container. */
  bodyOffset: number;
}

/**
 * Reads and checks a container before any key is involved (the order every implementation follows,
 * docs/spec/assets.md, "Reader behaviour"): preamble, header shape, format, cipher, kdf, chunk size,
 * pinned signer and ed25519 signature over the canonical header, file table (safe unique paths,
 * contiguous ranges, chunk counts that match the sizes), body length, then each file's ciphertext
 * SHA-256.
 *
 * Without `trustedSigner` this is INSPECTION: the signature is checked under the key the header
 * names, which proves integrity, not origin. Never decrypt on that basis: `AssetContainerReader`
 * requires a pinned signer (the native `sg_asset_container_open` too; `sg_asset_container_inspect`
 * is the integrity-only door).
 */
export function readAssetContainer(container: Uint8Array, opts: { trustedSigner?: string } = {}): AssetContainerView {
  const buf = Buffer.from(container.buffer, container.byteOffset, container.byteLength);
  const fail = (code: string, message: string): never => {
    throw new AssetEscrowError(code, message);
  };
  if (buf.length < PREAMBLE || !buf.subarray(0, 4).equals(ASSET_ESCROW_MAGIC)) fail("not_a_container", "no SGAE preamble");
  if (buf.readUInt8(4) !== ASSET_ESCROW_VERSION) fail("unsupported_version", `container version ${buf.readUInt8(4)}`);
  if (buf.readUInt8(5) !== 0 || buf.readUInt8(6) !== 0 || buf.readUInt8(7) !== 0) fail("invalid_header", "reserved bytes are not zero");
  const headerLength = buf.readUInt32LE(8);
  if (headerLength > ASSET_ESCROW_MAX_HEADER || PREAMBLE + headerLength > buf.length) fail("invalid_header", "header length out of range");
  const headerText = buf.subarray(PREAMBLE, PREAMBLE + headerLength).toString("utf8");
  let header: AssetEscrowHeader;
  try {
    header = JSON.parse(headerText) as AssetEscrowHeader;
  } catch {
    return fail("invalid_header", "header is not JSON");
  }
  if (canonicalJson(header) !== headerText) fail("invalid_header", "header is not in canonical form");
  if (header.format !== ASSET_ESCROW_FORMAT || header.cipher !== ASSET_ESCROW_CIPHER || header.kdf !== ASSET_ESCROW_KDF) fail("invalid_header", "unknown format, cipher or kdf");
  for (const k of ["package", "version", "release", "deployment", "keyId", "signerPublicKey", "signature"] as const) {
    if (typeof header[k] !== "string") fail("invalid_header", `${k} missing`);
  }
  if (header.fingerprint !== null && typeof header.fingerprint !== "string") fail("invalid_header", "fingerprint must be a string or null");
  if (!Number.isInteger(header.chunkBytes) || header.chunkBytes < ASSET_ESCROW_MIN_CHUNK || header.chunkBytes > ASSET_ESCROW_MAX_CHUNK) fail("invalid_header", "chunkBytes out of range");
  if (opts.trustedSigner && header.signerPublicKey !== opts.trustedSigner) fail("untrusted_signer", "signed by another key than the pinned one");
  const ok = ed25519Verify(Buffer.from(canonicalJson({ ...header, signature: "" }), "utf8"), unb64(header.signature), unb64(header.signerPublicKey));
  if (!ok) fail("signature", "the header signature does not verify");
  if (!Array.isArray(header.files)) fail("invalid_header", "files missing");
  const bodyOffset = PREAMBLE + headerLength;
  const seen = new Set<string>();
  let expected = 0;
  for (const f of header.files) {
    if (typeof f.path !== "string" || unsafePath(f.path)) fail("unsafe_path", `unsafe path ${String(f.path)}`);
    if (seen.has(f.path)) fail("invalid_header", `${f.path} listed twice`);
    seen.add(f.path);
    const chunks = Math.max(1, Math.ceil(f.bytes / header.chunkBytes));
    if (!Number.isInteger(f.bytes) || f.bytes < 0 || f.chunks !== chunks || f.offset !== expected || f.length !== f.bytes + chunks * AES_TAG_BYTES) fail("invalid_header", `${f.path}: inconsistent size, chunks or range`);
    if (unb64(f.noncePrefix).length !== 8) fail("invalid_header", `${f.path}: nonce prefix must be 8 bytes`);
    expected += f.length;
  }
  if (bodyOffset + expected !== buf.length) fail("tampered", "the body length does not match the file table");
  for (const f of header.files) {
    const range = buf.subarray(bodyOffset + f.offset, bodyOffset + f.offset + f.length);
    if (sha256(range).toString("hex") !== f.sha256) fail("tampered", `${f.path}: ciphertext hash mismatch`);
  }
  return { header, bodyOffset };
}

/**
 * The reference decryptor: random-access reads of one container with its content key. A platform
 * hook implements the same steps in native code (docs/spec/assets.md, "The client hook").
 */
export class AssetContainerReader {
  private readonly buf: Buffer;
  private key: Buffer | null;
  readonly header: AssetEscrowHeader;
  private readonly bodyOffset: number;

  /** `trustedSigner` is required: the signer you trust, from a source the party that handed you the
   * container does not control (docs/spec/assets.md, "The signer"). */
  constructor(container: Uint8Array, contentKey: Buffer, opts: { trustedSigner: string }) {
    if (typeof opts?.trustedSigner !== "string" || opts.trustedSigner.length === 0) {
      throw new AssetEscrowError("untrusted_signer", "a pinned signer is required to decrypt a container (the key its header names proves integrity, not origin)");
    }
    const view = readAssetContainer(container, opts);
    this.buf = Buffer.from(container.buffer, container.byteOffset, container.byteLength);
    this.header = view.header;
    this.bodyOffset = view.bodyOffset;
    if (contentKey.length !== 32 || assetKeyId(contentKey) !== view.header.keyId) throw new AssetEscrowError("wrong_key", "the key is not this container's key");
    this.key = Buffer.from(contentKey);
  }

  paths(): string[] {
    return this.header.files.map((f) => f.path);
  }

  size(path: string): number {
    return this.file(path).bytes;
  }

  private file(path: string): AssetEscrowFile {
    const f = this.header.files.find((x) => x.path === path);
    if (!f) throw new AssetEscrowError("not_found", `${path}: not in the container`);
    return f;
  }

  private chunk(f: AssetEscrowFile, index: number): Buffer {
    if (!this.key) throw new AssetEscrowError("closed", "the reader was closed");
    const cb = this.header.chunkBytes;
    const plainLen = index === f.chunks - 1 ? f.bytes - index * cb : cb;
    const start = this.bodyOffset + f.offset + index * (cb + AES_TAG_BYTES);
    const ct = this.buf.subarray(start, start + plainLen + AES_TAG_BYTES);
    try {
      return aeadDecrypt(this.key, chunkNonce(unb64(f.noncePrefix), index), ct, assetChunkAad(this.header.package, this.header.version, f.path, index, index === f.chunks - 1));
    } catch {
      throw new AssetEscrowError("tampered", `${f.path}: chunk ${index} does not authenticate`);
    }
  }

  /** `length` bytes from `offset` (clamped to the file), decrypting only the chunks they span. */
  read(path: string, offset: number, length: number): Buffer {
    if (!this.key) throw new AssetEscrowError("closed", "the reader was closed");
    const f = this.file(path);
    if (offset < 0 || length < 0) throw new AssetEscrowError("range", "negative offset or length");
    const end = Math.min(f.bytes, offset + length);
    if (offset >= end) return Buffer.alloc(0);
    const cb = this.header.chunkBytes;
    const parts: Buffer[] = [];
    for (let i = Math.floor(offset / cb); i <= Math.floor((end - 1) / cb); i++) {
      const plain = this.chunk(f, i);
      parts.push(plain.subarray(Math.max(0, offset - i * cb), Math.min(plain.length, end - i * cb)));
    }
    return Buffer.concat(parts);
  }

  readAll(path: string): Buffer {
    return this.read(path, 0, this.size(path));
  }

  /** Wipes the key. Reads after this fail. */
  close(): void {
    this.key?.fill(0);
    this.key = null;
  }
}

// --------------------------------------------------------------------------- key flow

/** Additional data of the server's wrapped key: one release, one deployment's copy. */
export function assetServerAad(pkg: string, version: string, deployment: string): Buffer {
  return Buffer.from(`${ASSET_ESCROW_FORMAT}\nserver\n${pkg}@${version}\n${deployment}`, "utf8");
}

/** Additional data of a key handed to one game client's session. */
export function assetClientAad(pkg: string, version: string, keyId: string): Buffer {
  return Buffer.from(`${ASSET_ESCROW_FORMAT}\nclient\n${pkg}@${version}\n${keyId}`, "utf8");
}

const CLIENT_WRAP_INFO = Buffer.from("scriptgo.asset-escrow.client-keywrap.v1", "utf8");

function clientKek(shared: Buffer, epk: Buffer, clientPub: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([epk, clientPub]), CLIENT_WRAP_INFO, 32));
}

/**
 * The licensed server hands the content key to one game client: an ECIES to the client session's
 * X25519 public key (ephemeral X25519, HKDF-SHA256 with its own label, AES-256-GCM), the same
 * shape as the server wrap of escrow.md with a different label so a wrap to a server and a wrap
 * to a client can never be swapped.
 */
export function wrapAssetKeyForClient(
  contentKey: Buffer, clientPublic: Buffer, aad: Buffer,
  /** Fixed only in test vectors: by default a fresh ephemeral key and a random nonce per wrap. */
  fixed: { ephemeral?: X25519KeyPair; nonce?: Buffer<ArrayBuffer> } = {},
): WrappedKey {
  const ephemeral = fixed.ephemeral ?? generateX25519KeyPair();
  const shared = x25519Shared(ephemeral.privateKey, clientPublic);
  const { nonce, ciphertext } = fixed.nonce
    ? aeadEncrypt(clientKek(shared, ephemeral.publicKey, clientPublic), contentKey, aad, fixed.nonce)
    : aeadEncrypt(clientKek(shared, ephemeral.publicKey, clientPublic), contentKey, aad);
  return { epk: b64(ephemeral.publicKey), nonce: b64(nonce), wrapped: b64(ciphertext) };
}

export function unwrapAssetKeyOnClient(wrapped: WrappedKey, clientPrivate: Buffer, clientPublic: Buffer, aad: Buffer): Buffer {
  const epk = unb64(wrapped.epk);
  const shared = x25519Shared(clientPrivate, epk);
  return aeadDecrypt(clientKek(shared, epk, clientPublic), unb64(wrapped.nonce), unb64(wrapped.wrapped), aad);
}

// --------------------------------------------------------------------------- OPEN//77 escrowed preloads

/** Extension of an asset-escrow container file. */
export const ASSET_ESCROW_EXTENSION = ".sgae";

/**
 * Where an escrowed OPEN//77 preload holds its container: next to the fingerprint record, under
 * `archive/pc/mod/` (an inert file for OPEN//77's mod-root policy and its launcher; the game mounts
 * `.archive` files only). Derived from the container's fingerprint entry path, so both name the same
 * stem: `archive/pc/mod/<stem>.scriptgo-fingerprint.json` -> `archive/pc/mod/<stem>.sgae`.
 */
export function escrowedPreloadEntry(fingerprintEntry: string): string {
  if (!fingerprintEntry.endsWith(FINGERPRINT_SUFFIX) || fingerprintEntry.includes("/.scriptgo/")) throw new Error(`${fingerprintEntry}: not an OPEN//77 preload fingerprint entry`);
  return fingerprintEntry.slice(0, -FINGERPRINT_SUFFIX.length) + ASSET_ESCROW_EXTENSION;
}

/** An empty zip: the end-of-central-directory record alone. */
function emptyZip(): Buffer {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  return end;
}

/**
 * The escrowed form of one OPEN//77 preload package (docs/spec/assets.md, "OPEN//77"): a zip with a
 * single stored entry, `entry` (from `escrowedPreloadEntry`), holding every file of the preload in
 * one `scriptgo-asset-escrow/1` container, at the paths they have in the preload. The preload's path
 * in the release does not change, so the resource manifest (`preload_mod`) does not either.
 *
 * Deterministic: the same preload, identity, key and signer give the same bytes.
 */
export function escrowPreload(opts: {
  preload: Uint8Array;
  entry: string;
  package: string;
  version: string;
  release: string;
  deployment: string;
  contentKey: Buffer;
  signerSeed: Buffer;
  fingerprint: string | null;
  chunkBytes?: number;
}): Buffer {
  const src = Buffer.from(opts.preload.buffer, opts.preload.byteOffset, opts.preload.byteLength);
  const archive = readZip(src);
  const files = new Map<string, Buffer>();
  for (const e of archive.entries) {
    if (e.isDirectory) continue;
    if (isFingerprintEntryName(e.name) || e.name.toLowerCase().endsWith(ASSET_ESCROW_EXTENSION)) throw new AssetEscrowError("already_escrowed", `${e.name}: the preload is already fingerprinted or escrowed`);
    files.set(e.name, readZipEntry(src, e));
  }
  if (files.size === 0) throw new AssetEscrowError("empty", "the preload holds no file");
  const container = sealAssetContainer({
    files,
    package: opts.package,
    version: opts.version,
    release: opts.release,
    deployment: opts.deployment,
    contentKey: opts.contentKey,
    signerSeed: opts.signerSeed,
    fingerprint: opts.fingerprint,
    chunkBytes: opts.chunkBytes,
  });
  return appendStoredEntry(emptyZip(), opts.entry, container);
}

/**
 * The `transform` of `buildFingerprinted` for a release whose OPEN//77 preloads are escrowed: each
 * container in `escrowed` (path in the release archive) becomes its escrowed form, sealed with the
 * content key of the copy's deployment and carrying the copy's fingerprint marker in its header.
 * The platform signs the containers with its fingerprint signer.
 */
export function escrowedPreloadTransform(opts: {
  identity: FingerprintIdentity;
  releaseSecret: Buffer;
  fingerprintSecret: Buffer;
  signerSeed: Buffer;
  escrowed: Iterable<string>;
  chunkBytes?: number;
}): (container: { path: string; entry: string; data: Buffer }) => Buffer {
  const escrowed = new Set(opts.escrowed);
  const marker = fingerprintMarker(opts.identity, opts.fingerprintSecret);
  return ({ path, entry, data }) => {
    if (!escrowed.has(path)) return data;
    const contentKey = deriveAssetContentKey(opts.releaseSecret, opts.identity.deployment);
    try {
      return escrowPreload({
        preload: data,
        entry: escrowedPreloadEntry(entry),
        package: opts.identity.package,
        version: opts.identity.version,
        release: opts.identity.release,
        deployment: opts.identity.deployment,
        contentKey,
        signerSeed: opts.signerSeed,
        fingerprint: marker,
        chunkBytes: opts.chunkBytes,
      });
    } finally {
      contentKey.fill(0);
    }
  };
}

/** The container inside an escrowed preload, or null when the zip is not one. */
export function escrowedPreloadContainer(preload: Uint8Array): { entry: string; container: Buffer } | null {
  const src = Buffer.from(preload.buffer, preload.byteOffset, preload.byteLength);
  const found = readZip(src).entries.filter((e) => !e.isDirectory && e.name.toLowerCase().endsWith(ASSET_ESCROW_EXTENSION));
  if (found.length !== 1) return null;
  return { entry: found[0]!.name, container: readZipEntry(src, found[0]!) };
}
