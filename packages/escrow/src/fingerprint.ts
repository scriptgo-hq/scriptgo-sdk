// Per-buyer fingerprinted builds of an asset release (docs/spec/assets.md, "Per-buyer builds").
//
// At download the platform gives each licence its own copy: a signed entry naming the licence is
// added to every delivered archive, so the archive's SHA-256 differs per buyer and a leaked copy
// names where it came from. The algorithm is deterministic: the same release, licence, deployment,
// secret and signing key always give the same bytes, so a build can be cached and re-derived.
//
// Traceability, never prevention: removing the entry (unzip and rezip) or repacking the files
// defeats it. It catches careless re-uploads and lets a hash seen elsewhere be looked up.
import { createHash, createHmac } from "node:crypto";
import { crc32 } from "node:zlib";
import { canonicalJson } from "./canonical.ts";
import { ed25519FromSeed, ed25519Sign, ed25519Verify } from "./crypto.ts";
import { readZip, readZipEntry, ZipError, type ZipEntry } from "./zip.ts";

export const FINGERPRINT_FORMAT = "scriptgo-asset-fingerprint/1";
/** The entry's path inside a container; inside the release archive it is `<resource>/` + this. */
export const FINGERPRINT_ENTRY = ".scriptgo/fingerprint.json";
/**
 * The entry's name suffix where a container format only takes files under fixed roots (an OPEN//77
 * preload: `archive/pc/mod/<stem>.scriptgo-fingerprint.json`). The platform picks the entry path
 * per environment (@scriptgo/manifest `fingerprintEntryPath`).
 */
export const FINGERPRINT_SUFFIX = ".scriptgo-fingerprint.json";

/** True for a fingerprint entry's name, at a container's root, a release's resource root, or a fixed root. */
export function isFingerprintEntryName(name: string): boolean {
  return name === FINGERPRINT_ENTRY || name.endsWith(`/${FINGERPRINT_ENTRY}`) || (name.endsWith(FINGERPRINT_SUFFIX) && name.length > FINGERPRINT_SUFFIX.length);
}
const MARKER_LABEL = "scriptgo.asset-fingerprint.v1";
/** 1980-01-01 00:00:00, the earliest DOS date: every entry this module writes carries it. */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;
const UTF8_FLAG = 0x0800;

export interface FingerprintIdentity {
  /** Registry identifier `creator//name`. */
  package: string;
  version: string;
  /** Release id (the registry's). */
  release: string;
  /** Licence id. */
  licence: string;
  /** Deployment id, or "" when the download is not tied to one server. */
  deployment: string;
}

export interface FingerprintRecord extends FingerprintIdentity {
  format: typeof FINGERPRINT_FORMAT;
  /** Path of the archive this entry is in, inside the release: "" for the release archive itself. */
  container: string;
  /** base64url HMAC-SHA256 over release, licence and deployment: resolvable only by the platform. */
  marker: string;
  /** ed25519 public key (raw, base64url) of the platform's fingerprint signer. */
  signerPublicKey: string;
  /** ed25519 signature (base64url) over the canonical record with this field "". */
  signature: string;
}

/** The marker: base64url(HMAC-SHA256(secret, label \n release \n licence \n deployment)). */
export function fingerprintMarker(identity: FingerprintIdentity, secret: Buffer): string {
  if (secret.length < 32) throw new Error("the fingerprint secret must be at least 32 bytes");
  const material = [MARKER_LABEL, identity.release, identity.licence, identity.deployment].join("\n");
  return createHmac("sha256", secret).update(material, "utf8").digest("base64url");
}

/** The signed record for one archive and its exact bytes (canonical JSON, UTF-8, no trailing newline). */
export function fingerprintEntry(identity: FingerprintIdentity, container: string, secret: Buffer, signerSeed: Buffer): { record: FingerprintRecord; bytes: Buffer } {
  const record: FingerprintRecord = {
    format: FINGERPRINT_FORMAT,
    package: identity.package,
    version: identity.version,
    release: identity.release,
    licence: identity.licence,
    deployment: identity.deployment,
    container,
    marker: fingerprintMarker(identity, secret),
    signerPublicKey: ed25519FromSeed(signerSeed).publicKey.toString("base64url"),
    signature: "",
  };
  record.signature = ed25519Sign(Buffer.from(canonicalJson(record), "utf8"), signerSeed).toString("base64url");
  return { record, bytes: Buffer.from(canonicalJson(record), "utf8") };
}

/** Checks a record's shape and signature (and the signer, when one is pinned). */
export function verifyFingerprintRecord(record: unknown, trustedSigner?: string): { ok: true; record: FingerprintRecord } | { ok: false; reason: string } {
  if (!record || typeof record !== "object") return { ok: false, reason: "not an object" };
  const r = record as Record<string, unknown>;
  for (const k of ["format", "package", "version", "release", "licence", "deployment", "container", "marker", "signerPublicKey", "signature"]) {
    if (typeof r[k] !== "string") return { ok: false, reason: `field ${k} missing` };
  }
  if (r.format !== FINGERPRINT_FORMAT) return { ok: false, reason: `unknown format ${String(r.format)}` };
  if (trustedSigner && r.signerPublicKey !== trustedSigner) return { ok: false, reason: "signed by another key than the pinned one" };
  const unsigned = { ...r, signature: "" };
  const ok = ed25519Verify(Buffer.from(canonicalJson(unsigned), "utf8"), Buffer.from(r.signature as string, "base64url"), Buffer.from(r.signerPublicKey as string, "base64url"));
  return ok ? { ok: true, record: r as unknown as FingerprintRecord } : { ok: false, reason: "bad signature" };
}

// --------------------------------------------------------------------------- zip writing

function localHeader(name: Buffer, crc: number, size: number, flags: number, time: number, date: number): Buffer {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4); // version needed: 2.0
  h.writeUInt16LE(flags, 6);
  h.writeUInt16LE(0, 8); // stored
  h.writeUInt16LE(time, 10);
  h.writeUInt16LE(date, 12);
  h.writeUInt32LE(crc >>> 0, 14);
  h.writeUInt32LE(size, 18);
  h.writeUInt32LE(size, 22);
  h.writeUInt16LE(name.length, 26);
  h.writeUInt16LE(0, 28);
  return Buffer.concat([h, name]);
}

function centralRecord(name: Buffer, crc: number, size: number, flags: number, time: number, date: number, offset: number, madeBy: number, external: number): Buffer {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(madeBy, 4);
  h.writeUInt16LE(20, 6);
  h.writeUInt16LE(flags, 8);
  h.writeUInt16LE(0, 10);
  h.writeUInt16LE(time, 12);
  h.writeUInt16LE(date, 14);
  h.writeUInt32LE(crc >>> 0, 16);
  h.writeUInt32LE(size, 20);
  h.writeUInt32LE(size, 24);
  h.writeUInt16LE(name.length, 28);
  // extra 0, comment 0, disk 0, internal attributes 0
  h.writeUInt32LE(external >>> 0, 38);
  h.writeUInt32LE(offset, 42);
  return Buffer.concat([h, name]);
}

function endRecord(count: number, cdSize: number, cdOffset: number, comment: Buffer): Buffer {
  const h = Buffer.alloc(22);
  h.writeUInt32LE(0x06054b50, 0);
  h.writeUInt16LE(count, 8);
  h.writeUInt16LE(count, 10);
  h.writeUInt32LE(cdSize, 12);
  h.writeUInt32LE(cdOffset, 16);
  h.writeUInt16LE(comment.length, 20);
  return Buffer.concat([h, comment]);
}

const check32 = (n: number, what: string): void => {
  if (n >= 0xffffffff) throw new ZipError("zip64", `${what} would need zip64`);
};

/**
 * Appends one stored entry to a zip without touching any existing entry's bytes: the new local
 * header and data go after the last entry's data, the original central directory is copied as is,
 * then comes the new central record and an end record with the count, size and offset updated.
 * Refuses an archive that already holds a `.scriptgo/` entry at the same level.
 */
export function appendStoredEntry(zip: Uint8Array, path: string, data: Buffer): Buffer {
  const src = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  const archive = readZip(src);
  const dir = path.slice(0, path.lastIndexOf(".scriptgo/"));
  if (archive.entries.some((e) => e.name.startsWith(`${dir}.scriptgo/`))) throw new ZipError("reserved_path", `the archive already holds ${dir}.scriptgo/`);
  if (archive.entries.length + 1 >= 0xffff) throw new ZipError("too_many_entries", "too many entries to add one");
  const name = Buffer.from(path, "utf8");
  const crc = crc32(data);
  const local = localHeader(name, crc, data.length, UTF8_FLAG, DOS_TIME, DOS_DATE);
  const central = centralRecord(name, crc, data.length, UTF8_FLAG, DOS_TIME, DOS_DATE, archive.cdOffset, 20, 0);
  const cdOffset = archive.cdOffset + local.length + data.length;
  const cdSize = archive.cdSize + central.length;
  check32(cdOffset + cdSize, "the archive");
  return Buffer.concat([
    src.subarray(0, archive.cdOffset),
    local,
    data,
    src.subarray(archive.cdOffset, archive.cdOffset + archive.cdSize),
    central,
    endRecord(archive.entries.length + 1, cdSize, cdOffset, archive.comment),
  ]);
}

/**
 * Rewrites a zip with some entries' contents replaced, every other byte kept: entries stay in
 * their local order and central-directory order; an unchanged entry's local header, data, data
 * descriptor and central record are copied verbatim (only its offset moves); a replaced entry is
 * written stored, with flags reduced to the UTF-8 bit, no extra field and no comment, keeping its
 * name, DOS time and date, "version made by" and external attributes.
 */
export function replaceEntries(zip: Uint8Array, replacements: Map<string, Buffer>): Buffer {
  const src = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  const archive = readZip(src);
  for (const name of replacements.keys()) if (!archive.entries.some((e) => e.name === name)) throw new ZipError("missing_entry", `${name}: not in the archive`);
  const parts: Buffer[] = [];
  const newOffset = new Map<ZipEntry, number>();
  const newCentral = new Map<ZipEntry, Buffer>();
  let offset = 0;
  for (const e of [...archive.entries].sort((a, b) => a.localOffset - b.localOffset)) {
    newOffset.set(e, offset);
    const replacement = replacements.get(e.name);
    if (replacement) {
      const name = Buffer.from(e.name, "utf8");
      const crc = crc32(replacement);
      const flags = e.flags & UTF8_FLAG;
      const local = localHeader(name, crc, replacement.length, flags, e.dosTime, e.dosDate);
      parts.push(local, replacement);
      const madeBy = src.readUInt16LE(e.centralOffset + 4);
      const external = src.readUInt32LE(e.centralOffset + 38);
      newCentral.set(e, centralRecord(name, crc, replacement.length, flags, e.dosTime, e.dosDate, offset, madeBy, external));
      offset += local.length + replacement.length;
    } else {
      parts.push(src.subarray(e.localOffset, e.endOffset));
      const central = Buffer.from(src.subarray(e.centralOffset, e.centralOffset + e.centralLength));
      central.writeUInt32LE(offset, 42);
      newCentral.set(e, central);
      offset += e.endOffset - e.localOffset;
    }
    check32(offset, "an entry offset");
  }
  const cd = Buffer.concat(archive.entries.map((e) => newCentral.get(e)!));
  check32(offset + cd.length, "the archive");
  return Buffer.concat([...parts, cd, endRecord(archive.entries.length, cd.length, offset, archive.comment)]);
}

// --------------------------------------------------------------------------- the per-buyer build

export interface FingerprintedBuild {
  /** The release archive as delivered to this buyer. */
  zip: Buffer;
  sha256: string;
  marker: string;
  /** Every stamped container, with the SHA-256 it has in this build (what players' copies carry). */
  containers: Array<{ path: string; sha256: string; bytes: number }>;
}

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/**
 * Builds one buyer's copy of a release archive (docs/spec/assets.md, "The algorithm"):
 *  1. stamp each container (the release's environment-asset .zip files, by their path in the
 *     archive) with a fingerprint entry (container = its path): `.scriptgo/fingerprint.json`, or
 *     the entry path given for that container (`{ path, entry }`, from `fingerprintEntryPath`);
 *  2. put the stamped containers back with `replaceEntries`;
 *  3. stamp the release archive itself with `<root>.scriptgo/fingerprint.json` (container = "").
 * `root` is the resource folder every entry of the release archive sits in (`<resource>/`).
 */
export function buildFingerprinted(opts: {
  zip: Uint8Array;
  root: string;
  containers: Array<string | { path: string; entry: string }>;
  identity: FingerprintIdentity;
  secret: Buffer;
  signerSeed: Buffer;
  /**
   * Replaces a container's bytes before it is stamped (asset escrow: `escrowPreload` turns an
   * OPEN//77 preload into its escrowed form). Returns the bytes to stamp; called in path order.
   */
  transform?: (container: { path: string; entry: string; data: Buffer }) => Buffer;
}): FingerprintedBuild {
  const src = Buffer.from(opts.zip.buffer, opts.zip.byteOffset, opts.zip.byteLength);
  const archive = readZip(src);
  const replacements = new Map<string, Buffer>();
  const containers: FingerprintedBuild["containers"] = [];
  const wanted = new Map<string, string>();
  for (const c of opts.containers) {
    const [path, name] = typeof c === "string" ? [c, FINGERPRINT_ENTRY] : [c.path, c.entry];
    if (!isFingerprintEntryName(name)) throw new ZipError("bad_entry", `${name}: not a fingerprint entry name`);
    wanted.set(path, name);
  }
  for (const path of [...wanted.keys()].sort()) {
    const entry = archive.entries.find((e) => e.name === path);
    if (!entry) throw new ZipError("missing_entry", `${path}: not in the release archive`);
    const inner = entry.method === 0 ? Buffer.from(src.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize)) : readEntry(src, entry);
    if (readZip(inner).entries.some((e) => isFingerprintEntryName(e.name))) throw new ZipError("already_stamped", `${path}: already holds a fingerprint entry`);
    const data = opts.transform ? opts.transform({ path, entry: wanted.get(path)!, data: inner }) : inner;
    const stamped = appendStoredEntry(data, wanted.get(path)!, fingerprintEntry(opts.identity, path, opts.secret, opts.signerSeed).bytes);
    replacements.set(path, stamped);
    containers.push({ path, sha256: sha256(stamped), bytes: stamped.length });
  }
  const withContainers = replacements.size > 0 ? replaceEntries(src, replacements) : src;
  const zip = appendStoredEntry(withContainers, `${opts.root}${FINGERPRINT_ENTRY}`, fingerprintEntry(opts.identity, "", opts.secret, opts.signerSeed).bytes);
  return { zip, sha256: sha256(zip), marker: fingerprintMarker(opts.identity, opts.secret), containers };
}

function readEntry(src: Buffer, entry: ZipEntry): Buffer {
  return readZipEntry(src, entry);
}

/** Every fingerprint entry found in an archive (and in the archives it holds), each verified. */
export function findFingerprints(zip: Uint8Array, trustedSigner?: string): Array<{ where: string; ok: boolean; reason?: string; record?: FingerprintRecord }> {
  const out: Array<{ where: string; ok: boolean; reason?: string; record?: FingerprintRecord }> = [];
  const walk = (data: Buffer, where: string, depth: number): void => {
    let archive;
    try {
      archive = readZip(data);
    } catch {
      return;
    }
    for (const e of archive.entries) {
      if (e.isDirectory) continue;
      const bytes = () => (e.method === 0 ? Buffer.from(data.subarray(e.dataOffset, e.dataOffset + e.compressedSize)) : readEntry(data, e));
      if (isFingerprintEntryName(e.name)) {
        try {
          const v = verifyFingerprintRecord(JSON.parse(bytes().toString("utf8")), trustedSigner);
          out.push(v.ok ? { where: `${where}${e.name}`, ok: true, record: v.record } : { where: `${where}${e.name}`, ok: false, reason: v.reason });
        } catch {
          out.push({ where: `${where}${e.name}`, ok: false, reason: "not JSON" });
        }
      } else if (depth === 0 && e.name.toLowerCase().endsWith(".zip")) {
        walk(bytes(), `${where}${e.name}!`, depth + 1);
      }
    }
  };
  walk(Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength), "", 0);
  return out;
}
