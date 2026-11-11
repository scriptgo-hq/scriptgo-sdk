// Client-delivered assets (docs/spec/assets.md): what an asset file may be, how each environment
// delivers it, and the inspection every builder runs on a package's assets before it is packed,
// published or sold. One implementation, used by `scriptgo validate`, `scriptgo pack` and the
// registry's upload inspection, so the creator's machine and the platform agree on every verdict.
import { createHash } from "node:crypto";
import { expandGlob } from "./files.ts";
import type { Diagnostic, ParsedManifest } from "./manifest.ts";
import { readZip, readZipEntry, ZipError, type ZipEntry } from "./zip.ts";

/** Default limits. The platform may lower them (docs/spec/assets.md, "Limits": an owner decision). */
export const ASSET_LIMITS = {
  /** One asset file, or one container. */
  maxFileBytes: 256 * 1024 * 1024,
  /** Every asset of a release, all environments together. */
  maxReleaseBytes: 1024 * 1024 * 1024,
  /** Expanded size of one container. */
  maxExpandedBytes: 512 * 1024 * 1024,
  /** Asset files of a release. */
  maxFiles: 16384,
};

/**
 * Extensions of code a host, a game client or an operating system runs. Never accepted as an asset,
 * inside a container either: an asset is data (docs/spec/assets.md, "Data only").
 */
export const CODE_EXTENSIONS = new Set([
  // native code and installers
  "exe", "dll", "so", "dylib", "sys", "drv", "ocx", "cpl", "scr", "com", "msi", "msp", "mst", "appx", "msix", "apk", "dex", "app", "pkg", "deb", "rpm", "node", "wasm",
  // game-mod loaders and native plugins
  "asi", "reds",
  // scripts and bytecode
  "lua", "luac", "ljbc", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "pyc", "pyo", "rb", "pl", "php", "sh", "bash", "zsh", "fish", "ps1", "psm1", "psd1", "bat", "cmd", "vbs", "vbe", "wsf", "wsh", "hta", "jse", "lnk", "reg", "inf",
  "jar", "class", "cs", "csx", "vb", "gd", "gdc", "nut", "ysc", "sqf", "sqs", "sma", "amx", "smx",
  // documents that run macros or script
  "html", "htm", "xhtml", "svg", "swf",
]);

/** Archives: only accepted as an environment's declared container, never inside one. */
export const ARCHIVE_EXTENSIONS = new Set(["zip", "7z", "rar", "tar", "gz", "tgz", "bz2", "xz", "zst", "cab", "rpf", "vpk", "gma", "pak", "iso"]);

/** Lower-case extension after the last dot of the last segment ("" when none). */
export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** Names the executable format `bytes` starts with, or null. */
export function executableMagic(bytes: Uint8Array): string | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 8));
  if (b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a) return "Windows executable (MZ)";
  if (b.length >= 4 && b.readUInt32BE(0) === 0x7f454c46) return "ELF executable";
  if (b.length >= 4 && [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(b.readUInt32BE(0))) return "Mach-O executable";
  if (b.length >= 4 && b.readUInt32BE(0) === 0xcafebabe) return "Java class or Mach-O universal binary";
  if (b.length >= 2 && b[0] === 0x23 && b[1] === 0x21) return "script with a #! line";
  if (b.length >= 4 && b[0] === 0x1b && b[1] === 0x4c && b[2] === 0x75 && b[3] === 0x61) return "Lua bytecode";
  if (b.length >= 3 && b[0] === 0x1b && b[1] === 0x4c && b[2] === 0x4a) return "LuaJIT bytecode";
  if (b.length >= 4 && b[0] === 0x00 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d) return "WebAssembly";
  return null;
}

/** Why a file cannot be an asset (by name and first bytes), or null. Archives are judged by the caller. */
export function notDataReason(path: string, head: Uint8Array): string | null {
  const ext = extensionOf(path);
  if (CODE_EXTENSIONS.has(ext)) return `.${ext} is code, not data`;
  const magic = executableMagic(head);
  if (magic) return `the file is a ${magic}`;
  return null;
}

// --------------------------------------------------------------------------- environments

/**
 * How assets reach players on one environment. `support`:
 *  - `supported`: `scriptgo pack` emits the platform's own delivery form and the platform's engine
 *    sends the files to every player;
 *  - `partial`: the platform delivers some kinds of assets, or delivery needs an operator step;
 *  - `bundled`: no game client downloads anything (single-process or local hosts); assets are files
 *    of the resource, read through `resource.readFile`;
 *  - `unsupported`: the platform has no way for a server-side package to deliver files.
 */
export type AssetSupport = "supported" | "partial" | "bundled" | "unsupported";

export interface AssetEnvironmentRule {
  support: AssetSupport;
  /** What happens to generic `assets` there, or null when the environment cannot deliver them. */
  generic: string | null;
  /** What `environment_asset "<env>"` holds there, or null when it takes none. */
  native: string | null;
  /** `scriptgo pack --target <x>` writes this environment's delivery form. */
  packTarget: string | null;
  /** Why an environment cannot deliver assets, or a caveat. */
  note?: string;
}

export const ASSET_RULES: Record<string, AssetEnvironmentRule> = {
  open77: {
    support: "supported",
    generic: "resource files: sent to every player's client cache before the resource starts; scripts and the WebUI read them, the game engine does not mount them",
    native: "preload packages: .zip files holding REDengine data under archive/pc/mod/, r6/tweaks/ or engine/config/, declared as preload_mod and mounted by the game at its next boot",
    packTarget: "open77",
  },
  fivem: {
    support: "supported",
    generic: "files under stream/ are streamed to players; other files are listed in files {} and downloaded by players",
    native: "streamed game files under stream/ (.ydr, .yft, .ytd, .ymap, .ytyp ...) and data files listed by data_file",
    packTarget: "fivem",
  },
  redm: {
    support: "partial",
    generic: "as on FiveM (stream/ and files {}); the RedM pack target is not built yet",
    native: "as on FiveM; the RedM pack target is not built yet",
    packTarget: null,
  },
  garrysmod: {
    support: "supported",
    generic: "content of the addon (materials/, models/, sound/, maps/, resource/, particles/), each file added to the download list with resource.AddSingleFile",
    native: "the same content roots, including .bsp maps under maps/",
    packTarget: "garrysmod",
  },
  luanti: {
    support: "supported",
    generic: "mod media (textures/, sounds/, models/, media/, locale/, fonts/) in a generated media mod: the engine sends it to every client at join",
    native: "the same media folders",
    packTarget: "luanti",
  },
  beammp: {
    support: "supported",
    generic: null,
    native: "BeamNG mod .zip files, put in Resources/Client/: every player downloads them at join",
    packTarget: "beammp",
  },
  rust: {
    support: "partial",
    generic: null,
    native: "one custom map (.map), which players download from a URL the operator hosts (server.levelurl); a plugin cannot send files to players",
    packTarget: null,
  },
  hytale: {
    support: "partial",
    generic: null,
    native: "an asset pack (.zip with manifest.json, Common/ and Server/) installed in the server's mods/ folder; the server sends its assets to players. Validated, not packed or run yet",
    packTarget: null,
  },
  standalone: { support: "bundled", generic: "files of the resource (resource.readFile)", native: "files of the resource", packTarget: null },
  love2d: { support: "bundled", generic: "files of the resource (resource.readFile)", native: "files of the resource", packTarget: null },
  godot: { support: "bundled", generic: "files of the resource (resource.readFile)", native: "files of the resource", packTarget: null },
  dotnet: { support: "bundled", generic: "files of the resource (resource.readFile)", native: "files of the resource", packTarget: null },
  neovim: { support: "bundled", generic: "files of the resource (resource.readFile); there are no players to deliver to", native: "files of the resource", packTarget: null },
  cctweaked: { support: "bundled", generic: "files of the resource on the computer; there are no players to deliver to", native: "files of the resource", packTarget: null },
  defold: { support: "bundled", generic: "files of the resource (resource.readFile), inside the game build", native: "files of the resource", packTarget: null },
  openresty: { support: "bundled", generic: "files of the resource (resource.readFile); a web server has no game client to deliver to", native: "files of the resource", packTarget: null },
  roblox: { support: "unsupported", generic: null, native: null, packTarget: null, note: "Roblox content is uploaded to Roblox's own asset system by the experience owner; a package cannot deliver files" },
  zomboid: { support: "unsupported", generic: null, native: null, packTarget: null, note: "Project Zomboid servers send mods as Steam Workshop items the operator lists; a package cannot deliver files itself" },
  dst: { support: "unsupported", generic: null, native: null, packTarget: null, note: "Don't Starve Together servers send mods as Steam Workshop items the operator lists; a package cannot deliver files itself" },
  kcdmp: { support: "unsupported", generic: null, native: null, packTarget: null, note: "asset delivery on KCD multiplayer has not been researched" },
};

/** OPEN//77 preload packages: what OPEN//77's server accepts as inert data (its ModRootPolicy). */
export const OPEN77_PRELOAD = {
  maxPackages: 8,
  maxBytes: 256 * 1024 * 1024,
  roots: [
    { prefix: "archive/pc/mod/", extensions: ["archive", "xl"] },
    { prefix: "r6/tweaks/", extensions: ["yaml", "yml", "tweak"] },
    { prefix: "engine/config/", extensions: ["ini"] },
  ],
  /** First four bytes of a REDengine 4 archive: "RDAR". */
  archiveMagic: Buffer.from("RDAR", "ascii"),
};

/** GTA V streamed formats a FiveM resource's stream/ folder carries. */
export const FIVEM_STREAM_EXTENSIONS = new Set(["ydr", "ydd", "yft", "ytd", "ybn", "ymap", "ytyp", "ynd", "ynv", "ycd", "ypt", "ymt", "yed", "ywr", "yvr", "ymf", "gfx"]);
/** Data files FiveM reads through data_file (metadata, audio data, ...). */
export const FIVEM_DATA_EXTENSIONS = new Set(["meta", "xml", "dat", "rel", "nametable", "awc", "ymt", "ytyp"]);
/** Above this, FiveM warns that a streamed asset is oversized and may not stream reliably. */
export const FIVEM_STREAM_WARN_BYTES = 16 * 1024 * 1024;

export const GARRYSMOD_CONTENT_ROOTS = ["materials/", "models/", "sound/", "maps/", "resource/", "particles/"];
/** GMod's default net_maxfilesize (16 MB, 64 MB at most) caps a direct download from the server. */
export const GARRYSMOD_DIRECT_DOWNLOAD_BYTES = 16 * 1024 * 1024;

export const LUANTI_MEDIA_ROOTS = ["textures/", "sounds/", "models/", "media/", "locale/", "fonts/"];
/** The formats Luanti sends to clients (api.luanti.org/mods); anything else stays on the server. */
export const LUANTI_MEDIA_EXTENSIONS = new Set(["png", "jpg", "tga", "ogg", "x", "b3d", "obj", "gltf", "glb", "ttf", "woff", "tr", "po"]);
/** "Currently the engine is unable to handle files over ~16MB in size." (api.luanti.org/mods) */
export const LUANTI_MAX_MEDIA_BYTES = 16 * 1024 * 1024;

// --------------------------------------------------------------------------- inspection

export interface AssetFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface AssetContainer {
  /** Path of the container in the package. */
  path: string;
  environment: string;
  bytes: number;
  sha256: string;
  entries: number;
  expandedBytes: number;
  /** Top-level folders of the container's files, sorted. */
  roots: string[];
}

export interface AssetEnvironmentReport {
  support: AssetSupport;
  /** Asset files delivered there (generic and native), sorted. */
  files: string[];
  containers: AssetContainer[];
  /** What each player downloads there, in bytes (the files as delivered). */
  downloadBytes: number;
  /** Loaders or settings the operator needs (`archivexl`, `tweakxl`, `levelurl`, `fastdl`). */
  needs: string[];
  gameBuilds: string[];
}

export interface AssetReport {
  errors: Diagnostic[];
  warnings: Diagnostic[];
  /** Every asset file of the package (generic and native, every environment), sorted by path. */
  files: AssetFile[];
  totalBytes: number;
  /** Per environment that receives assets. */
  environments: Record<string, AssetEnvironmentReport>;
  /**
   * Containers that already carry a per-buyer fingerprint (`.scriptgo/fingerprint.json`): normal in
   * a buyer's copy, refused by the platform in an upload (the stamper adds it, once).
   */
  fingerprinted: string[];
}

/** The per-buyer fingerprint entry, at the root of a release and of each container. */
export const FINGERPRINT_ENTRY_PATH = ".scriptgo/fingerprint.json";
/** Suffix of a fingerprint entry put under a fixed root (OPEN//77 preloads). */
export const FINGERPRINT_ENTRY_SUFFIX = ".scriptgo-fingerprint.json";

/** True for a fingerprint entry's name (same rule as @scriptgo/escrow `isFingerprintEntryName`). */
export function isFingerprintEntryName(name: string): boolean {
  return name === FINGERPRINT_ENTRY_PATH || name.endsWith(`/${FINGERPRINT_ENTRY_PATH}`) || (name.endsWith(FINGERPRINT_ENTRY_SUFFIX) && name.length > FINGERPRINT_ENTRY_SUFFIX.length);
}

/**
 * Where the per-buyer fingerprint goes inside one container of `environment`. OPEN//77 takes a
 * preload's files under its mod roots only (a file anywhere else refuses the whole package), so
 * there it is `archive/pc/mod/<stem>.scriptgo-fingerprint.json`: an inert file the game does not
 * load (it mounts .archive files; ArchiveXL reads .xl files). Elsewhere `.scriptgo/fingerprint.json`.
 */
export function fingerprintEntryPath(environment: string, containerPath: string): string {
  if (environment !== "open77") return FINGERPRINT_ENTRY_PATH;
  const base = containerPath.slice(containerPath.lastIndexOf("/") + 1).replace(/\.zip$/i, "");
  return `archive/pc/mod/${base.replace(/[^A-Za-z0-9_.-]/g, "_") || "package"}${FINGERPRINT_ENTRY_SUFFIX}`;
}

/** Generic asset files: `assets` globs expanded against the listing. */
export function genericAssetFiles(m: ParsedManifest, files: string[]): string[] {
  const out = new Set<string>();
  for (const p of m.assets) for (const f of expandGlob(p, files)) out.add(f);
  return [...out].sort();
}

/** One environment's native asset files: `environment_asset "<env>"` globs expanded. */
export function environmentAssetFiles(m: ParsedManifest, env: string, files: string[]): string[] {
  const out = new Set<string>();
  for (const p of m.environmentAssets[env] ?? []) for (const f of expandGlob(p, files)) out.add(f);
  return [...out].sort();
}

/** Every asset file of the package, all environments, sorted. */
export function allAssetFiles(m: ParsedManifest, files: string[]): string[] {
  const out = new Set(genericAssetFiles(m, files));
  for (const env of Object.keys(m.environmentAssets)) for (const f of environmentAssetFiles(m, env, files)) out.add(f);
  return [...out].sort();
}

export function hasAssets(m: ParsedManifest): boolean {
  return m.assets.length > 0 || Object.keys(m.environmentAssets).length > 0;
}

/**
 * The environments an asset inspection judges: every environment with native assets, and, when the
 * package has generic assets, every environment it lists (or none, for an unrestricted package).
 */
export function assetEnvironments(m: ParsedManifest): string[] {
  const out = new Set(Object.keys(m.environmentAssets));
  if (m.assets.length > 0) for (const e of m.environments) out.add(e);
  return [...out].sort();
}

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const rootOf = (p: string): string => (p.includes("/") ? p.slice(0, p.indexOf("/") + 1) : p);

interface Ctx {
  errors: Diagnostic[];
  warnings: Diagnostic[];
  fingerprinted: string[];
}
const err = (c: Ctx, code: string, message: string): void => void c.errors.push({ code, message });
const warn = (c: Ctx, code: string, message: string): void => void c.warnings.push({ code, message });

/** Reads a container and checks every entry is data (and not an archive). Null when unreadable. */
function inspectContainer(
  c: Ctx, path: string, env: string, data: Buffer,
  entryCheck: (name: string, entry: ZipEntry, bytes: Buffer) => void,
): AssetContainer | null {
  let zip;
  try {
    zip = readZip(data);
  } catch (e) {
    err(c, "asset_container_invalid", `${path}: ${e instanceof ZipError ? e.message : String(e)}`);
    return null;
  }
  let expanded = 0;
  const roots = new Set<string>();
  for (const entry of zip.entries) {
    if (entry.isDirectory) continue;
    expanded += entry.size;
    if (expanded > ASSET_LIMITS.maxExpandedBytes) {
      err(c, "asset_container_too_large", `${path}: expands to more than ${ASSET_LIMITS.maxExpandedBytes} bytes`);
      return null;
    }
    if (isFingerprintEntryName(entry.name)) {
      // A buyer's copy: the stamper's entry is not an asset. Its record is checked by
      // `scriptgo assets fingerprint`; an upload that carries one is refused by the platform.
      c.fingerprinted.push(path);
      continue;
    }
    if (entry.name.startsWith(".scriptgo/")) {
      err(c, "reserved_path", `${path}: ${entry.name}: .scriptgo/ is reserved for the per-buyer fingerprint`);
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = readZipEntry(data, entry);
    } catch (e) {
      err(c, "asset_container_invalid", `${path}: ${e instanceof ZipError ? e.message : String(e)}`);
      continue;
    }
    const ext = extensionOf(entry.name);
    if (ARCHIVE_EXTENSIONS.has(ext)) err(c, "asset_nested_archive", `${path}: ${entry.name}: an archive inside a container is refused`);
    const why = notDataReason(entry.name, bytes);
    if (why) err(c, "asset_not_data", `${path}: ${entry.name}: ${why}`);
    roots.add(rootOf(entry.name));
    entryCheck(entry.name, entry, bytes);
  }
  return { path, environment: env, bytes: data.length, sha256: sha256(data), entries: zip.entries.filter((e) => !e.isDirectory).length, expandedBytes: expanded, roots: [...roots].sort() };
}

/**
 * Inspects a package's assets: data only, sizes, and each environment's delivery rules. `read`
 * returns a file's bytes (the folder on a creator's machine, the uploaded archive on the platform).
 * Diagnostics are errors when a declared asset could not be delivered as declared: nothing is ever
 * dropped silently.
 */
export function inspectAssets(opts: {
  manifest: ParsedManifest;
  files: string[];
  read: (path: string) => Buffer;
  /** Environments to judge besides the declared ones (the target of `scriptgo pack`). */
  targets?: string[];
}): AssetReport {
  const m = opts.manifest;
  const listing = opts.files.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, ""));
  const c: Ctx = { errors: [], warnings: [], fingerprinted: [] };
  const report: AssetReport = { errors: c.errors, warnings: c.warnings, files: [], totalBytes: 0, environments: {}, fingerprinted: c.fingerprinted };
  if (!hasAssets(m)) return report;

  for (const p of m.assets) if (expandGlob(p, listing).length === 0) err(c, "pattern_empty", `assets pattern '${p}' matches no file.`);
  for (const [env, paths] of Object.entries(m.environmentAssets)) {
    for (const p of paths) if (expandGlob(p, listing).length === 0) err(c, "pattern_empty", `environment_asset "${env}" pattern '${p}' matches no file.`);
  }

  // Every asset file once: data only, size.
  const generic = genericAssetFiles(m, listing);
  const containerPaths = new Set<string>();
  for (const env of ["open77", "beammp", "hytale"]) for (const f of environmentAssetFiles(m, env, listing)) if (extensionOf(f) === "zip") containerPaths.add(f);
  const cache = new Map<string, Buffer>();
  const bytesOf = (p: string): Buffer => {
    let b = cache.get(p);
    if (!b) {
      b = opts.read(p);
      cache.set(p, b);
    }
    return b;
  };
  const all = allAssetFiles(m, listing);
  if (all.length > ASSET_LIMITS.maxFiles) err(c, "asset_too_many_files", `${all.length} asset files: at most ${ASSET_LIMITS.maxFiles}.`);
  for (const f of all) {
    const data = bytesOf(f);
    report.files.push({ path: f, bytes: data.length, sha256: sha256(data) });
    report.totalBytes += data.length;
    if (data.length > ASSET_LIMITS.maxFileBytes) err(c, "asset_too_large", `${f}: ${data.length} bytes, over ${ASSET_LIMITS.maxFileBytes} per file.`);
    if (data.length === 0) err(c, "asset_empty", `${f}: an asset cannot be empty.`);
    const ext = extensionOf(f);
    if (ARCHIVE_EXTENSIONS.has(ext) && !containerPaths.has(f)) {
      err(c, "asset_archive", `${f}: an archive is an asset only as an environment's container (environment_asset "open77", "beammp" or "hytale"); unpack it or declare it there.`);
      continue;
    }
    const why = notDataReason(f, data);
    if (why) err(c, "asset_not_data", `${f}: ${why}. Assets are data only: code belongs in scripts.`);
  }
  if (report.totalBytes > ASSET_LIMITS.maxReleaseBytes) err(c, "asset_release_too_large", `assets total ${report.totalBytes} bytes, over ${ASSET_LIMITS.maxReleaseBytes} per release.`);

  for (const env of [...new Set([...assetEnvironments(m), ...(opts.targets ?? [])])].sort()) {
    const rule = ASSET_RULES[env];
    const native = environmentAssetFiles(m, env, listing);
    const envReport: AssetEnvironmentReport = { support: rule?.support ?? "unsupported", files: [], containers: [], downloadBytes: 0, needs: [], gameBuilds: m.gameBuilds[env] ?? [] };
    report.environments[env] = envReport;
    if (!rule) {
      err(c, "assets_unsupported", `${env}: SCRIPT//GO has no asset delivery for this environment yet.`);
      continue;
    }
    if (native.length > 0 && rule.native === null) err(c, "assets_unsupported", `environment_asset "${env}": ${env} takes no native assets${rule.note ? ` (${rule.note})` : ""}.`);
    if (generic.length > 0 && rule.generic === null) {
      err(c, "assets_unsupported", rule.native
        ? `${env} cannot deliver generic assets (it takes ${rule.native}). Declare them with environment_asset "${env}" in its own form, or remove ${env} from environments.`
        : `${env} cannot deliver assets${rule.note ? ` (${rule.note})` : ""}. Remove ${env} from environments, or sell the assets without it.`);
    }
    const delivered = [...new Set([...(rule.generic ? generic : []), ...native])].sort();
    envReport.files = delivered;
    envReport.downloadBytes = delivered.reduce((n, f) => n + bytesOf(f).length, 0);
    ENV_CHECKS[env]?.({ c, m, env, generic: rule.generic ? generic : [], native, listing, bytesOf, report: envReport });
    if (envReport.support === "bundled") envReport.downloadBytes = 0;
  }
  return report;
}

interface EnvCheck {
  c: Ctx;
  m: ParsedManifest;
  env: string;
  generic: string[];
  native: string[];
  listing: string[];
  bytesOf: (p: string) => Buffer;
  report: AssetEnvironmentReport;
}

const ENV_CHECKS: Record<string, (x: EnvCheck) => void> = {
  open77: ({ c, native, bytesOf, report }) => {
    const zips = native.filter((f) => extensionOf(f) === "zip");
    for (const f of native) if (extensionOf(f) !== "zip") err(c, "open77_preload_not_zip", `environment_asset "open77" ${f}: OPEN//77 preloads REDengine data from .zip packages only.`);
    if (zips.length > OPEN77_PRELOAD.maxPackages) err(c, "open77_too_many_preloads", `${zips.length} preload packages: OPEN//77 takes at most ${OPEN77_PRELOAD.maxPackages} per resource.`);
    let xl = false;
    let tweaks = false;
    for (const f of zips) {
      const data = bytesOf(f);
      if (data.length > OPEN77_PRELOAD.maxBytes) err(c, "open77_preload_too_large", `${f}: OPEN//77 takes a preload of at most ${OPEN77_PRELOAD.maxBytes} bytes.`);
      const box = inspectContainer(c, f, "open77", data, (name, _entry, bytes) => {
        const root = OPEN77_PRELOAD.roots.find((r) => name.startsWith(r.prefix));
        const ext = extensionOf(name);
        if (!root) {
          err(c, "open77_preload_root", `${f}: ${name}: outside the inert roots OPEN//77 accepts (${OPEN77_PRELOAD.roots.map((r) => r.prefix).join(", ")}).`);
          return;
        }
        if (!root.extensions.includes(ext)) {
          err(c, "open77_preload_type", `${f}: ${name}: .${ext} is not accepted under ${root.prefix} (${root.extensions.map((e) => `.${e}`).join(", ")}).`);
          return;
        }
        if (ext === "archive" && !bytes.subarray(0, 4).equals(OPEN77_PRELOAD.archiveMagic)) err(c, "open77_archive_magic", `${f}: ${name}: not a REDengine archive (it does not start with "RDAR").`);
        if (ext === "xl") xl = true;
        if (root.prefix === "r6/tweaks/") tweaks = true;
      });
      if (box) report.containers.push(box);
    }
    if (xl) report.needs.push("archivexl");
    if (tweaks) report.needs.push("tweakxl");
    if (zips.length > 0 && report.gameBuilds.length === 0) warn(c, "asset_game_build_missing", `Declare game_build "open77" "<build>": REDengine archives are made for one game build and can break on the next.`);
  },

  fivem: (x) => fivemCheck(x),
  redm: (x) => fivemCheck(x),

  garrysmod: ({ c, generic, native, bytesOf, report }) => {
    let fastdl = false;
    for (const f of [...new Set([...generic, ...native])]) {
      if (!GARRYSMOD_CONTENT_ROOTS.some((r) => f.startsWith(r))) {
        err(c, "garrysmod_content_root", `${f}: Garry's Mod sends content from ${GARRYSMOD_CONTENT_ROOTS.join(", ")} only; move the file under one of them.`);
        continue;
      }
      if (extensionOf(f) === "bsp" && !f.startsWith("maps/")) err(c, "garrysmod_map_path", `${f}: a .bsp map belongs in maps/.`);
      if (f !== f.toLowerCase()) warn(c, "garrysmod_path_case", `${f}: upper-case path; GMod lower-cases paths on Linux servers and in .gma archives.`);
      if (bytesOf(f).length > GARRYSMOD_DIRECT_DOWNLOAD_BYTES) fastdl = true;
    }
    if (fastdl) {
      report.needs.push("fastdl");
      warn(c, "garrysmod_large_download", `a file is over 16 MB, GMod's default net_maxfilesize for a download from the server: the operator raises net_maxfilesize (64 MB at most) or serves files over FastDL (sv_downloadurl).`);
    }
  },

  luanti: ({ c, generic, native, bytesOf, m }) => {
    for (const f of [...new Set([...generic, ...native])]) {
      const root = LUANTI_MEDIA_ROOTS.find((r) => f.startsWith(r));
      const base = f.slice(f.lastIndexOf("/") + 1);
      if (!root) {
        err(c, "luanti_media_root", `${f}: Luanti sends media from ${LUANTI_MEDIA_ROOTS.join(", ")} only.`);
        continue;
      }
      if (!LUANTI_MEDIA_EXTENSIONS.has(extensionOf(f))) err(c, "luanti_media_type", `${f}: Luanti does not send .${extensionOf(f)} to clients (it sends ${[...LUANTI_MEDIA_EXTENSIONS].map((e) => `.${e}`).join(", ")}).`);
      if (!/^[A-Za-z0-9_.-]+$/.test(base)) err(c, "luanti_media_name", `${f}: Luanti media names use a-z A-Z 0-9 _ . - only.`);
      if (f.split("/").slice(1, -1).some((s) => s.startsWith("_") || s.startsWith("."))) err(c, "luanti_media_hidden", `${f}: Luanti ignores media folders whose name starts with _ or .`);
      if (bytesOf(f).length > LUANTI_MAX_MEDIA_BYTES) err(c, "luanti_media_too_large", `${f}: Luanti cannot handle media files over about 16 MB.`);
      if (!base.startsWith(`${m.name}_`) && !base.startsWith(`${m.name}.`)) warn(c, "luanti_media_prefix", `${f}: Luanti's media names are one namespace for every mod; prefix the file name with "${m.name}_" to avoid a clash.`);
    }
  },

  beammp: ({ c, native, bytesOf, report }) => {
    for (const f of native) {
      if (extensionOf(f) !== "zip") {
        err(c, "beammp_client_not_zip", `environment_asset "beammp" ${f}: BeamMP sends .zip mods from Resources/Client only.`);
        continue;
      }
      const box = inspectContainer(c, f, "beammp", bytesOf(f), () => undefined);
      if (box) report.containers.push(box);
    }
  },

  rust: ({ c, native, report }) => {
    const maps = native.filter((f) => extensionOf(f) === "map");
    for (const f of native) if (extensionOf(f) !== "map") err(c, "rust_asset_type", `environment_asset "rust" ${f}: on Rust a package can only carry a custom map (.map); a plugin cannot send other files to players.`);
    if (maps.length > 1) err(c, "rust_one_map", `${maps.length} maps: a Rust server runs one map at a time.`);
    if (maps.length > 0) report.needs.push("levelurl");
  },

  hytale: ({ c, native, bytesOf, report }) => {
    for (const f of native) {
      if (extensionOf(f) !== "zip") {
        err(c, "hytale_pack_not_zip", `environment_asset "hytale" ${f}: a Hytale asset pack is declared as a .zip.`);
        continue;
      }
      let manifest: Buffer | null = null;
      const box = inspectContainer(c, f, "hytale", bytesOf(f), (name, _e, bytes) => {
        if (name === "manifest.json") manifest = bytes;
        else if (!name.startsWith("Common/") && !name.startsWith("Server/")) err(c, "hytale_pack_root", `${f}: ${name}: an asset pack holds manifest.json, Common/ and Server/ only.`);
      });
      if (box) report.containers.push(box);
      if (!manifest) err(c, "hytale_pack_manifest", `${f}: no manifest.json at the root of the asset pack.`);
      else {
        try {
          const parsed = JSON.parse((manifest as Buffer).toString("utf8")) as Record<string, unknown>;
          if (parsed["IncludesAssetPack"] !== true) err(c, "hytale_pack_manifest", `${f}: manifest.json must set "IncludesAssetPack": true.`);
          if ("Main" in parsed) err(c, "hytale_pack_code", `${f}: manifest.json names a Main class: an asset pack is data only.`);
        } catch {
          err(c, "hytale_pack_manifest", `${f}: manifest.json is not valid JSON.`);
        }
      }
    }
  },
};

function fivemCheck({ c, m, env, generic, native, listing, bytesOf, report }: EnvCheck): void {
  const assetSet = new Set([...generic, ...native]);
  const dataTargets = new Set<string>();
  for (const [type, paths] of Object.entries(m.dataFiles)) {
    for (const p of paths) {
      // A data_file names a file, or a folder (audio wave packs) that holds asset files.
      const hits = expandGlob(p, listing).filter((f) => assetSet.has(f));
      const under = [...assetSet].filter((f) => f.startsWith(p.endsWith("/") ? p : `${p}/`));
      if (hits.length === 0 && under.length === 0) err(c, "fivem_data_file_missing", `data_file "${type}" "${p}": not an asset of this package for ${env}.`);
      for (const f of [...hits, ...under]) dataTargets.add(f);
    }
  }
  let map = false;
  for (const f of native) {
    const ext = extensionOf(f);
    if (f.startsWith("stream/")) {
      if (!FIVEM_STREAM_EXTENSIONS.has(ext)) err(c, "fivem_stream_type", `${f}: .${ext} is not a streamed game format (${[...FIVEM_STREAM_EXTENSIONS].map((e) => `.${e}`).join(", ")}).`);
      if (bytesOf(f).length > FIVEM_STREAM_WARN_BYTES) warn(c, "fivem_oversized_asset", `${f}: over 16 MiB; ${env} warns about oversized streamed assets, which may not load reliably.`);
      if (ext === "ymap") map = true;
    } else if (!dataTargets.has(f)) {
      err(c, "fivem_asset_unused", `${f}: outside stream/ and named by no data_file, so ${env} would never load it. Move it under stream/ or add a data_file line.`);
    }
  }
  for (const f of generic) if (f.startsWith("stream/") && extensionOf(f) === "ymap") map = true;
  if (map) report.needs.push("this_is_a_map");
  if (native.length > 0 && report.gameBuilds.length === 0) warn(c, "asset_game_build_missing", `Declare game_build "${env}" "<build>": streamed assets can depend on the game build.`);
}

/** One line per environment for a terminal: support, download size, needs. */
export function describeAssetReport(r: AssetReport): string[] {
  const mb = (n: number): string => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / (1024 * 1024)).toFixed(1)} MiB`);
  const out = [`assets: ${r.files.length} files, ${mb(r.totalBytes)}`];
  for (const [env, e] of Object.entries(r.environments)) {
    const dl = e.support === "bundled" ? "bundled with the resource, no player download" : `each player downloads ${mb(e.downloadBytes)}`;
    out.push(`  ${env}: ${e.support}, ${e.files.length} files, ${dl}${e.needs.length ? `; needs ${e.needs.join(", ")}` : ""}${e.gameBuilds.length ? `; game build ${e.gameBuilds.join(", ")}` : ""}`);
  }
  return out;
}
