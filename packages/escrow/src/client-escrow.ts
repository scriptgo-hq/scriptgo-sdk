// Client code escrow: the encrypted, bytecode-only container `scriptgo-client-escrow/1`
// (docs/spec/client-escrow.md), its sealer, a reference reader, the key steps around it, the
// creator-side line map and the per-buyer copy's client-escrow entries.
//
// A client script is compiled from its source by the SDK's own Lua 5.4.8 compiler (luac.ts) to
// stripped bytecode, each chunk encrypted with AES-256-GCM under a per-deployment key. The game
// client decrypts a chunk in native memory and hands it to its VM only as bytecode
// (`sg_clink_lua_load`), after the release signature and the chunk's tag verify.
//
// Honest ceiling: the client VM runs the bytecode, so a player who reads their own game memory gets
// the stripped bytecode, and a decompiler turns it back into readable, de-identified Lua (control flow
// and string constants, invented local names, no comments). This raises the bar above source shipped
// in clear or decrypted to source in memory; it is not unbreakable.
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
import { compileLua, LUAC_HEADER_BYTES, luacHeaderOf, LuacError } from "./luac.ts";

export const CLIENT_ESCROW_FORMAT = "scriptgo-client-escrow/1";
export const CLIENT_ESCROW_CIPHER = "AES-256-GCM";
export const CLIENT_ESCROW_KDF = "HKDF-SHA256+X25519";
export const CLIENT_ESCROW_MAGIC = Buffer.from("SGCE", "ascii");
export const CLIENT_ESCROW_VERSION = 1;
export const CLIENT_ESCROW_MAX_HEADER = 4 * 1024 * 1024;
/** The container's name at the root of a resource in a delivered copy. */
export const CLIENT_ESCROW_ENTRY = "clientcode.sgce";
/** Opcode permutation is specified, not built: v1 containers carry generation 0 and readers refuse any other. */
export const CLIENT_ESCROW_PERM_GENERATION = 0;
export const CLIENT_ESCROW_LINES_FORMAT = "scriptgo-client-escrow-lines/1";
const PREAMBLE = 12;

/** What a release's bytecode was compiled for: the client VM's Lua version and its 31-byte LUAC header. */
export interface ClientBytecodeTarget {
  lua: string;
  /** Hex of the dump header: "\x1bLua", version, format, LUAC_DATA, instruction/integer/number sizes, LUAC_INT, LUAC_NUM. */
  luacHeader: string;
}

/**
 * PUC Lua 5.4.8, 64-bit integers and doubles, little-endian: OPEN//77's client VM. The header holds
 * no int or size_t size in 5.4 (5.3 had them); the LUAC_INT (0x5678) and LUAC_NUM (370.5) check
 * values pin the byte order and number formats.
 */
export const LUA_548_TARGET: ClientBytecodeTarget = {
  lua: "5.4.8",
  luacHeader: "1b4c7561540019930d0a1a0a04080878560000000000000000000000287740",
};

export type ClientStrip = "full" | "names";

export interface ClientEscrowChunk {
  /** Resource-relative client-script path (`/`), the manifest's own value. */
  path: string;
  /** Plaintext bytecode length. */
  bytes: number;
  /** SHA-256 of the plaintext bytecode, hex. */
  sha256: string;
  /** 12-byte AES-GCM nonce, base64url. */
  nonce: string;
  offset: number;
  /** bytes + 16 (the tag). */
  length: number;
}

export interface ClientEscrowHeader {
  format: typeof CLIENT_ESCROW_FORMAT;
  cipher: typeof CLIENT_ESCROW_CIPHER;
  kdf: typeof CLIENT_ESCROW_KDF;
  package: string;
  version: string;
  release: string;
  deployment: string;
  target: ClientBytecodeTarget;
  strip: ClientStrip;
  permGeneration: number;
  keyId: string;
  fingerprint: string | null;
  chunks: ClientEscrowChunk[];
  signerPublicKey: string;
  signature: string;
}

const b64 = (b: Buffer): string => b.toString("base64url");
const unb64 = (s: string): Buffer => Buffer.from(s, "base64url");
const sha256 = (b: Uint8Array): Buffer => createHash("sha256").update(b).digest();

// --------------------------------------------------------------------------- keys

/** The content key of one deployment's copy: HKDF over the release secret asset escrow keeps sealed, its own salt. */
export function deriveClientContentKey(releaseSecret: Buffer, deployment: string): Buffer {
  if (releaseSecret.length !== 32) throw new Error("the release secret must be 32 bytes");
  return Buffer.from(hkdfSync("sha256", releaseSecret, Buffer.from("scriptgo.client-escrow.cek.v1", "utf8"), Buffer.from(deployment, "utf8"), 32));
}

/** Identifies a client content key without revealing it. */
export function clientKeyId(contentKey: Buffer): string {
  return b64(sha256(Buffer.concat([Buffer.from("scriptgo.client-escrow.keyid.v1", "utf8"), contentKey])).subarray(0, 16));
}

/** A chunk's nonce: deterministic and distinct for every (key, path, plaintext). */
export function clientChunkNonce(contentKey: Buffer, path: string, plaintextSha256: Buffer): Buffer<ArrayBuffer> {
  const info = Buffer.concat([Buffer.from(`${path}\n`, "utf8"), plaintextSha256]);
  return Buffer.from(hkdfSync("sha256", contentKey, Buffer.from("scriptgo.client-escrow.nonce.v1", "utf8"), info, 12));
}

export function clientChunkAad(pkg: string, version: string, path: string): Buffer {
  return Buffer.from(`${CLIENT_ESCROW_FORMAT}\n${pkg}@${version}\n${path}`, "utf8");
}

/** Additional data of the key the API wraps to a licensed server (`kind: "client"`). */
export function clientServerAad(pkg: string, version: string, deployment: string): Buffer {
  return Buffer.from(`${CLIENT_ESCROW_FORMAT}\nserver\n${pkg}@${version}\n${deployment}`, "utf8");
}

/** Additional data of the key a licensed server re-wraps to one game session. */
export function clientSessionAad(pkg: string, version: string, keyId: string): Buffer {
  return Buffer.from(`${CLIENT_ESCROW_FORMAT}\nclient\n${pkg}@${version}\n${keyId}`, "utf8");
}

const SESSION_WRAP_INFO = Buffer.from("scriptgo.client-escrow.client-keywrap.v1", "utf8");

function sessionKek(shared: Buffer, epk: Buffer, sessionPub: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([epk, sessionPub]), SESSION_WRAP_INFO, 32));
}

/** The licensed server hands the client key to one game session (ECIES to the session's X25519 key). */
export function wrapClientKeyForSession(
  contentKey: Buffer, sessionPublic: Buffer, aad: Buffer,
  fixed: { ephemeral?: X25519KeyPair; nonce?: Buffer<ArrayBuffer> } = {},
): WrappedKey {
  const ephemeral = fixed.ephemeral ?? generateX25519KeyPair();
  const kek = sessionKek(x25519Shared(ephemeral.privateKey, sessionPublic), ephemeral.publicKey, sessionPublic);
  const { nonce, ciphertext } = fixed.nonce ? aeadEncrypt(kek, contentKey, aad, fixed.nonce) : aeadEncrypt(kek, contentKey, aad);
  return { epk: b64(ephemeral.publicKey), nonce: b64(nonce), wrapped: b64(ciphertext) };
}

export function unwrapClientKeyInSession(wrapped: WrappedKey, sessionPrivate: Buffer, sessionPublic: Buffer, aad: Buffer): Buffer {
  const epk = unb64(wrapped.epk);
  return aeadDecrypt(sessionKek(x25519Shared(sessionPrivate, epk), epk, sessionPublic), unb64(wrapped.nonce), unb64(wrapped.wrapped), aad);
}

// --------------------------------------------------------------------------- compiling

/** Lua keeps at most LUA_IDSIZE - 1 = 59 bytes of a `=` chunk name in messages. */
const LUA_IDSIZE = 60;

/**
 * The chunk name a client script is compiled under: `=<name>@<version>/<path>` (the package name
 * without its creator, no local file path), and `:pos` after it under full strip, where the line a
 * message shows is a position the creator's line map resolves. A name too long for Lua's 59 bytes
 * keeps its end (the path and the suffix) behind "...".
 */
export function clientChunkName(pkg: string, version: string, path: string, strip: ClientStrip): string {
  const name = pkg.includes("//") ? pkg.slice(pkg.lastIndexOf("//") + 2) : pkg;
  let id = `${name}@${version}/${path}${strip === "full" ? ":pos" : ""}`;
  const max = LUA_IDSIZE - 1;
  if (Buffer.byteLength(id, "utf8") > max) {
    const buf = Buffer.from(id, "utf8");
    let tail = buf.subarray(buf.length - (max - 3));
    while (tail.length > 0 && (tail[0]! & 0xc0) === 0x80) tail = tail.subarray(1);
    id = `...${tail.toString("utf8")}`;
  }
  return `=${id}`;
}

export interface CompiledClientScript {
  path: string;
  bytecode: Buffer;
  /** full strip: the source line of each position; names strip: null (the bytecode keeps lines). */
  lines: number[] | null;
}

/**
 * Compiles one client script from its source for a container. Source only: precompiled bytecode is
 * refused (a crafted chunk could target the client VM), and a syntax error names the path and line.
 */
export function compileClientScript(source: string | Uint8Array, opts: { package: string; version: string; path: string; strip: ClientStrip }): CompiledClientScript {
  if (unsafePath(opts.path)) throw new ClientEscrowError("unsafe_path", `${opts.path}: unsafe path`);
  const chunkName = clientChunkName(opts.package, opts.version, opts.path, opts.strip);
  try {
    if (opts.strip === "full") {
      const r = compileLua(source, { chunkName: `=${opts.path}`, strip: "full", dumpSource: chunkName });
      return { path: opts.path, bytecode: r.bytecode, lines: r.positions };
    }
    const r = compileLua(source, { chunkName, strip: "names" });
    return { path: opts.path, bytecode: r.bytecode, lines: null };
  } catch (e) {
    if (e instanceof LuacError) throw new ClientEscrowError(e.code === "syntax" ? "syntax" : "compile", `${opts.path}: ${e.message}`);
    throw e;
  }
}

// --------------------------------------------------------------------------- the container

/** Path rules of escrow.md ("Path rules"). */
function unsafePath(p: string): boolean {
  return p.length === 0 || p.startsWith("/") || p.includes("\\") || p.includes(":") || /[\u0000-\u001f\u007f]/.test(p) || p.split("/").some((s) => s === "" || s === "." || s === "..");
}

export class ClientEscrowError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Seals compiled client scripts (path → bytecode) into one container, in path order. */
export function sealClientContainer(opts: {
  chunks: Map<string, Buffer>;
  package: string;
  version: string;
  release: string;
  deployment: string;
  contentKey: Buffer;
  signerSeed: Buffer;
  strip: ClientStrip;
  target?: ClientBytecodeTarget;
  fingerprint?: string | null;
  /** Test vectors only: seal what a reader must refuse (a chunk that is not the target's bytecode, another generation). */
  unchecked?: { skipTargetCheck?: boolean; permGeneration?: number };
}): Buffer {
  const target = opts.target ?? LUA_548_TARGET;
  if (opts.contentKey.length !== 32) throw new Error("the content key must be 32 bytes");
  if (opts.chunks.size === 0) throw new Error("a client-escrow container holds at least one chunk");
  const body: Buffer[] = [];
  const chunks: ClientEscrowChunk[] = [];
  let offset = 0;
  for (const path of [...opts.chunks.keys()].sort()) {
    if (unsafePath(path)) throw new ClientEscrowError("unsafe_path", `${path}: unsafe path`);
    const data = opts.chunks.get(path)!;
    if (!opts.unchecked?.skipTargetCheck && (data.length < LUAC_HEADER_BYTES || luacHeaderOf(data) !== target.luacHeader)) throw new ClientEscrowError("target_mismatch", `${path}: not bytecode for the declared target`);
    const digest = sha256(data);
    const nonce = clientChunkNonce(opts.contentKey, path, digest);
    const ct = aeadEncrypt(opts.contentKey, data, clientChunkAad(opts.package, opts.version, path), nonce).ciphertext;
    chunks.push({ path, bytes: data.length, sha256: digest.toString("hex"), nonce: b64(nonce), offset, length: ct.length });
    body.push(ct);
    offset += ct.length;
  }
  const header: ClientEscrowHeader = {
    format: CLIENT_ESCROW_FORMAT,
    cipher: CLIENT_ESCROW_CIPHER,
    kdf: CLIENT_ESCROW_KDF,
    package: opts.package,
    version: opts.version,
    release: opts.release,
    deployment: opts.deployment,
    target: { lua: target.lua, luacHeader: target.luacHeader },
    strip: opts.strip,
    permGeneration: opts.unchecked?.permGeneration ?? CLIENT_ESCROW_PERM_GENERATION,
    keyId: clientKeyId(opts.contentKey),
    fingerprint: opts.fingerprint ?? null,
    chunks,
    signerPublicKey: b64(ed25519FromSeed(opts.signerSeed).publicKey),
    signature: "",
  };
  header.signature = b64(ed25519Sign(Buffer.from(canonicalJson(header), "utf8"), opts.signerSeed));
  const headerBytes = Buffer.from(canonicalJson(header), "utf8");
  if (headerBytes.length > CLIENT_ESCROW_MAX_HEADER) throw new Error("the container header is larger than 4 MiB");
  const pre = Buffer.alloc(PREAMBLE);
  CLIENT_ESCROW_MAGIC.copy(pre, 0);
  pre.writeUInt8(CLIENT_ESCROW_VERSION, 4);
  pre.writeUInt32LE(headerBytes.length, 8);
  return Buffer.concat([pre, headerBytes, ...body]);
}

export interface ClientContainerView {
  header: ClientEscrowHeader;
  bodyOffset: number;
}

/**
 * Reads and checks a container before any key is involved (client-escrow.md, "Reading"): preamble,
 * canonical header, format, cipher, kdf, strip, permutation generation, target shape, pinned signer and
 * signature, chunk table (safe unique paths, `length = bytes + 16`, contiguous offsets, nonce size),
 * body length. Each chunk's plaintext hash is checked after decryption, by the reader.
 */
export function readClientContainer(container: Uint8Array, opts: { trustedSigner?: string } = {}): ClientContainerView {
  const buf = Buffer.from(container.buffer, container.byteOffset, container.byteLength);
  const fail = (code: string, message: string): never => {
    throw new ClientEscrowError(code, message);
  };
  if (buf.length < PREAMBLE || !buf.subarray(0, 4).equals(CLIENT_ESCROW_MAGIC)) fail("not_a_container", "no SGCE preamble");
  if (buf.readUInt8(4) !== CLIENT_ESCROW_VERSION) fail("unsupported_version", `container version ${buf.readUInt8(4)}`);
  if (buf.readUInt8(5) !== 0 || buf.readUInt8(6) !== 0 || buf.readUInt8(7) !== 0) fail("invalid_header", "reserved bytes are not zero");
  const headerLength = buf.readUInt32LE(8);
  if (headerLength > CLIENT_ESCROW_MAX_HEADER || PREAMBLE + headerLength > buf.length) fail("invalid_header", "header length out of range");
  const headerText = buf.subarray(PREAMBLE, PREAMBLE + headerLength).toString("utf8");
  let header: ClientEscrowHeader;
  try {
    header = JSON.parse(headerText) as ClientEscrowHeader;
  } catch {
    return fail("invalid_header", "header is not JSON");
  }
  if (header === null || typeof header !== "object" || canonicalJson(header) !== headerText) fail("invalid_header", "header is not in canonical form");
  if (header.format !== CLIENT_ESCROW_FORMAT || header.cipher !== CLIENT_ESCROW_CIPHER || header.kdf !== CLIENT_ESCROW_KDF) fail("invalid_header", "unknown format, cipher or kdf");
  for (const k of ["package", "version", "release", "deployment", "keyId", "signerPublicKey", "signature"] as const) {
    if (typeof header[k] !== "string") fail("invalid_header", `${k} missing`);
  }
  if (header.strip !== "full" && header.strip !== "names") fail("invalid_header", "strip must be full or names");
  if (header.permGeneration !== CLIENT_ESCROW_PERM_GENERATION) fail("unsupported_generation", `opcode permutation generation ${String(header.permGeneration)} is not supported`);
  if (header.fingerprint !== null && typeof header.fingerprint !== "string") fail("invalid_header", "fingerprint must be a string or null");
  const t = header.target;
  if (!t || typeof t !== "object" || typeof t.lua !== "string" || typeof t.luacHeader !== "string" || !/^[0-9a-f]{62}$/.test(t.luacHeader)) fail("invalid_header", "target missing or malformed");
  if (opts.trustedSigner && header.signerPublicKey !== opts.trustedSigner) fail("untrusted_signer", "signed by another key than the pinned one");
  const ok = ed25519Verify(Buffer.from(canonicalJson({ ...header, signature: "" }), "utf8"), unb64(header.signature), unb64(header.signerPublicKey));
  if (!ok) fail("signature", "the header signature does not verify");
  if (!Array.isArray(header.chunks) || header.chunks.length === 0) fail("invalid_header", "chunks missing");
  const bodyOffset = PREAMBLE + headerLength;
  const seen = new Set<string>();
  let expected = 0;
  for (const c of header.chunks) {
    if (typeof c.path !== "string" || unsafePath(c.path)) fail("unsafe_path", `unsafe path ${String(c.path)}`);
    if (seen.has(c.path)) fail("invalid_header", `${c.path} listed twice`);
    seen.add(c.path);
    if (!Number.isInteger(c.bytes) || c.bytes < LUAC_HEADER_BYTES || c.offset !== expected || c.length !== c.bytes + AES_TAG_BYTES) fail("invalid_header", `${c.path}: inconsistent size or range`);
    if (typeof c.nonce !== "string" || unb64(c.nonce).length !== 12) fail("invalid_header", `${c.path}: nonce must be 12 bytes`);
    if (typeof c.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(c.sha256)) fail("invalid_header", `${c.path}: sha256 malformed`);
    expected += c.length;
  }
  if (bodyOffset + expected !== buf.length) fail("tampered", "the body length does not match the chunk table");
  return { header, bodyOffset };
}

/**
 * The reference reader: what a client loader does before it hands a chunk to its VM, in TypeScript,
 * for tests and tooling. It returns bytecode as bytes, which the native loader deliberately never
 * does (`sg_clink_lua_load` only compiles into a state).
 */
export class ClientContainerReader {
  private readonly buf: Buffer;
  private key: Buffer | null;
  readonly header: ClientEscrowHeader;
  private readonly bodyOffset: number;

  constructor(container: Uint8Array, contentKey: Buffer, opts: { trustedSigner?: string; target?: ClientBytecodeTarget } = {}) {
    const view = readClientContainer(container, opts);
    const target = opts.target ?? LUA_548_TARGET;
    if (view.header.target.luacHeader !== target.luacHeader) throw new ClientEscrowError("target_mismatch", "compiled for another Lua VM");
    if (contentKey.length !== 32 || clientKeyId(contentKey) !== view.header.keyId) throw new ClientEscrowError("wrong_key", "the key is not this container's key");
    this.buf = Buffer.from(container.buffer, container.byteOffset, container.byteLength);
    this.header = view.header;
    this.bodyOffset = view.bodyOffset;
    this.key = Buffer.from(contentKey);
  }

  paths(): string[] {
    return this.header.chunks.map((c) => c.path);
  }

  /** Decrypts and checks one chunk: tag, plaintext hash, LUAC header. */
  bytecode(path: string): Buffer {
    if (!this.key) throw new ClientEscrowError("closed", "the reader was closed");
    const c = this.header.chunks.find((x) => x.path === path);
    if (!c) throw new ClientEscrowError("not_found", `${path}: not in the container`);
    const ct = this.buf.subarray(this.bodyOffset + c.offset, this.bodyOffset + c.offset + c.length);
    let plain: Buffer;
    try {
      plain = aeadDecrypt(this.key, unb64(c.nonce), ct, clientChunkAad(this.header.package, this.header.version, c.path));
    } catch {
      throw new ClientEscrowError("tampered", `${path}: the chunk does not authenticate`);
    }
    if (sha256(plain).toString("hex") !== c.sha256) throw new ClientEscrowError("tampered", `${path}: bytecode hash mismatch`);
    if (luacHeaderOf(plain) !== this.header.target.luacHeader) throw new ClientEscrowError("target_mismatch", `${path}: bytecode header differs from the target`);
    return plain;
  }

  close(): void {
    this.key?.fill(0);
    this.key = null;
  }
}

// --------------------------------------------------------------------------- the creator's line map

export interface ClientLineMap {
  format: typeof CLIENT_ESCROW_LINES_FORMAT;
  package: string;
  version: string;
  strip: ClientStrip;
  /** Per full-stripped chunk: the bytecode's SHA-256 and the source line of each position. */
  chunks: Record<string, { sha256: string; lines: number[] }>;
}

/** The creator-side line map of a set of compiled scripts. Never shipped to a game client. */
export function clientLineMap(pkg: string, version: string, strip: ClientStrip, compiled: CompiledClientScript[]): ClientLineMap {
  const chunks: ClientLineMap["chunks"] = {};
  for (const c of [...compiled].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (c.lines) chunks[c.path] = { sha256: sha256(c.bytecode).toString("hex"), lines: c.lines };
  }
  return { format: CLIENT_ESCROW_LINES_FORMAT, package: pkg, version, strip, chunks };
}

/** The source line of one position of a chunk, or null when the map does not know it. */
export function resolveClientPosition(map: ClientLineMap, path: string, position: number): number | null {
  const c = map.chunks[path];
  if (!c || !Number.isInteger(position) || position < 1 || position > c.lines.length) return null;
  return c.lines[position - 1] ?? null;
}

/**
 * Rewrites the `<name>@<version>/<path>:pos:<n>:` positions in an error message or traceback to
 * `<path>:<line>:` with the line map. A position the map does not know is left as it was.
 */
export function resolveClientMessage(map: ClientLineMap, message: string): string {
  const name = map.package.includes("//") ? map.package.slice(map.package.lastIndexOf("//") + 2) : map.package;
  const prefix = `${name}@${map.version}/`;
  const paths = Object.keys(map.chunks);
  return message.replace(/([^\s'"<>()]+):pos:(\d+)/g, (whole, id: string, n: string) => {
    const path = id.startsWith(prefix) ? id.slice(prefix.length) : id.startsWith("...") ? paths.find((p) => `${prefix}${p}`.endsWith(id.slice(3))) : undefined;
    if (!path) return whole;
    const line = resolveClientPosition(map, path, Number(n));
    return line === null ? whole : `${path}:${line}`;
  });
}

// --------------------------------------------------------------------------- the per-buyer copy

/** What stands at an escrowed client script's path in a delivered copy: never compiled by a loader that knows the container. */
export function clientEscrowStub(path: string): Buffer {
  return Buffer.from(`-- SCRIPT//GO client code escrow: ${path} ships encrypted in ${CLIENT_ESCROW_ENTRY}.\nerror("${path.replace(/["\\]/g, "")} is an escrowed client script: it loads only through the SCRIPT//GO client loader", 0)\n`, "utf8");
}

export interface ClientEscrowCopy {
  /** Entry name → stub, for `replaceEntries`. */
  stubs: Map<string, Buffer>;
  /** The container's entry name (`<root>clientcode.sgce`) and bytes. */
  entry: { path: string; data: Buffer };
  /** The creator-side line map of this copy (identical for every copy of a release). */
  lines: ClientLineMap;
}

/**
 * The client-escrow part of one copy: each escrowed client script compiled from the release's own
 * source (never from creator bytecode), sealed under this deployment's key, and a stub at its path.
 * Deterministic: the same release, deployment, key and fingerprint give the same bytes.
 */
export function clientEscrowCopy(opts: {
  /** Reads one entry of the release archive by its full name. */
  read: (entry: string) => Buffer;
  root: string;
  /** Resource-relative client-script paths to escrow. */
  scripts: string[];
  package: string;
  version: string;
  release: string;
  deployment: string;
  contentKey: Buffer;
  signerSeed: Buffer;
  strip: ClientStrip;
  fingerprint: string | null;
}): ClientEscrowCopy {
  const scripts = [...new Set(opts.scripts)].sort();
  if (scripts.length === 0) throw new ClientEscrowError("no_scripts", "client escrow needs at least one client script");
  const compiled = scripts.map((path) => compileClientScript(opts.read(`${opts.root}${path}`), { package: opts.package, version: opts.version, path, strip: opts.strip }));
  const container = sealClientContainer({
    chunks: new Map(compiled.map((c) => [c.path, c.bytecode])),
    package: opts.package,
    version: opts.version,
    release: opts.release,
    deployment: opts.deployment,
    contentKey: opts.contentKey,
    signerSeed: opts.signerSeed,
    strip: opts.strip,
    fingerprint: opts.fingerprint,
  });
  return {
    stubs: new Map(scripts.map((p) => [`${opts.root}${p}`, clientEscrowStub(p)])),
    entry: { path: `${opts.root}${CLIENT_ESCROW_ENTRY}`, data: container },
    lines: clientLineMap(opts.package, opts.version, opts.strip, compiled),
  };
}
