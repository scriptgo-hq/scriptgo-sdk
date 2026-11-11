// A strict, read-only zip reader for asset containers (docs/spec/assets.md, "Containers").
//
// It reads the central directory, never trusts a local header on its own, and refuses what the
// escrow loaders refuse (docs/spec/escrow.md, "Archive rules"): zip64, multi-disk archives,
// encrypted entries, methods other than stored (0) and deflate (8), duplicate paths, unsafe paths,
// symbolic links, a local header that names another file than its central record, bytes before the
// first entry or after the end record, and a CRC-32 mismatch. The same rules apply wherever a
// container is read: `scriptgo validate`, `scriptgo pack`, the registry's inspection and the
// fingerprint stamper (packages/escrow).
import { crc32, inflateRawSync } from "node:zlib";

export interface ZipEntry {
  /** Entry name as stored (resource-relative, `/` separators). Directories end with `/`. */
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  /** Offset of the local file header. */
  localOffset: number;
  /** Offset of the entry's data (after the local header, name and extra field). */
  dataOffset: number;
  /** Offset just past the entry's data and its data descriptor, if any. */
  endOffset: number;
  /** Offset and length of the central directory record. */
  centralOffset: number;
  centralLength: number;
  isDirectory: boolean;
  dosTime: number;
  dosDate: number;
}

export interface ZipArchive {
  entries: ZipEntry[];
  /** Offset and size of the central directory. */
  cdOffset: number;
  cdSize: number;
  /** Offset of the end of central directory record. */
  eocdOffset: number;
  comment: Buffer;
}

export class ZipError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const DESCRIPTOR_SIG = 0x08074b50;

/** Limits for one container (docs/spec/assets.md): entries and path length as in the escrow loaders. */
export const ZIP_LIMITS = { maxEntries: 16384, maxPathBytes: 1024 };

/** Why an entry path is unsafe (escrow path rules), or null. */
export function unsafeEntryPath(name: string): string | null {
  if (name.length === 0) return "empty path";
  if (Buffer.byteLength(name, "utf8") > ZIP_LIMITS.maxPathBytes) return "path longer than 1024 bytes";
  if (name.startsWith("/")) return "absolute path";
  if (name.includes("\\")) return "backslash in path";
  if (name.includes(":")) return "colon in path";
  if (/[\u0000-\u001f\u007f]/.test(name)) return "control character in path";
  const segments = name.endsWith("/") ? name.slice(0, -1).split("/") : name.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return "empty, '.' or '..' segment";
  return null;
}

/** Parses the central directory of `data`. Throws ZipError on anything the rules refuse. */
export function readZip(data: Uint8Array): ZipArchive {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buf.length < 22) throw new ZipError("not_a_zip", "too short to be a zip archive");
  // The end record is in the last 22 + 65535 bytes; take the last signature whose comment fits exactly.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG && i + 22 + buf.readUInt16LE(i + 20) === buf.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not_a_zip", "no end of central directory record (or bytes after it)");
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIG) throw new ZipError("zip64", "zip64 archives are refused");
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const countDisk = buf.readUInt16LE(eocd + 8);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || countDisk !== count) throw new ZipError("multi_disk", "multi-disk archives are refused");
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError("zip64", "zip64 archives are refused");
  if (cdOffset + cdSize !== eocd) throw new ZipError("bad_layout", "the central directory does not end at the end record");
  if (count > ZIP_LIMITS.maxEntries) throw new ZipError("too_many_entries", `more than ${ZIP_LIMITS.maxEntries} entries`);

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== CEN_SIG) throw new ZipError("bad_layout", "truncated or corrupt central directory");
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const dosTime = buf.readUInt16LE(p + 12);
    const dosDate = buf.readUInt16LE(p + 14);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const diskStart = buf.readUInt16LE(p + 34);
    const external = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const centralLength = 46 + nameLen + extraLen + commentLen;
    if (p + centralLength > eocd) throw new ZipError("bad_layout", "truncated central directory record");
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    if (diskStart !== 0) throw new ZipError("multi_disk", "multi-disk archives are refused");
    if (flags & 0x1) throw new ZipError("encrypted", `${name}: encrypted entries are refused`);
    if (method !== 0 && method !== 8) throw new ZipError("bad_method", `${name}: compression method ${method} is refused (stored or deflate only)`);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ZipError("zip64", `${name}: zip64 entries are refused`);
    const why = unsafeEntryPath(name);
    if (why) throw new ZipError("unsafe_path", `${name}: ${why}`);
    // Unix mode in the high 16 bits when made on Unix (3) or macOS (19): refuse symbolic links.
    const host = madeBy >> 8;
    if ((host === 3 || host === 19) && ((external >>> 16) & 0o170000) === 0o120000) throw new ZipError("symlink", `${name}: symbolic links are refused`);
    if (seen.has(name)) throw new ZipError("duplicate_path", `${name}: the path appears twice`);
    seen.add(name);

    if (localOffset + 30 > cdOffset || buf.readUInt32LE(localOffset) !== LOC_SIG) throw new ZipError("bad_layout", `${name}: no local header at its offset`);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const lName = buf.subarray(localOffset + 30, localOffset + 30 + lNameLen).toString("utf8");
    if (lName !== name) throw new ZipError("header_mismatch", `${name}: the local header names '${lName}'`);
    const dataOffset = localOffset + 30 + lNameLen + lExtraLen;
    let endOffset = dataOffset + compressedSize;
    if (flags & 0x8) {
      // Data descriptor: optional signature, CRC, compressed size, size.
      endOffset += endOffset + 4 <= cdOffset && buf.readUInt32LE(endOffset) === DESCRIPTOR_SIG ? 16 : 12;
    }
    if (endOffset > cdOffset) throw new ZipError("bad_layout", `${name}: data runs into the central directory`);
    entries.push({
      name, method, flags, crc, compressedSize, size, localOffset, dataOffset, endOffset,
      centralOffset: p, centralLength, isDirectory: name.endsWith("/"), dosTime, dosDate,
    });
    p += centralLength;
  }
  if (p !== eocd) throw new ZipError("bad_layout", "bytes between the central directory and the end record");
  // Entries must tile the area before the central directory, starting at 0: no hidden bytes.
  const sorted = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  let cursor = 0;
  for (const e of sorted) {
    if (e.localOffset !== cursor) throw new ZipError("bad_layout", `${e.name}: unexpected bytes before this entry`);
    cursor = e.endOffset;
  }
  if (cursor !== cdOffset) throw new ZipError("bad_layout", "unexpected bytes before the central directory");
  return { entries, cdOffset, cdSize, eocdOffset: eocd, comment: Buffer.from(buf.subarray(eocd + 22)) };
}

/** The decompressed bytes of one entry, CRC-32 checked. `maxBytes` guards against zip bombs. */
export function readZipEntry(data: Uint8Array, entry: ZipEntry, maxBytes = 512 * 1024 * 1024): Buffer {
  if (entry.size > maxBytes) throw new ZipError("too_large", `${entry.name}: ${entry.size} bytes is over the limit`);
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const raw = buf.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  const out = entry.method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(entry.size, 1) });
  if (out.length !== entry.size) throw new ZipError("bad_size", `${entry.name}: size differs from the central directory`);
  if ((crc32(out) >>> 0) !== entry.crc) throw new ZipError("bad_crc", `${entry.name}: CRC-32 mismatch`);
  return out;
}
