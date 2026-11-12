// `scriptgo pack --target fivem|redm [--cfx-escrow]`: a SCRIPT//GO resource as a Cfx.re resource
// folder, for FiveM (GTA V, `game "gta5"`) or RedM (Red Dead Redemption 2, `game "rdr3"`).
//
// FXServer already runs this resource shape (CreateThread, Wait, events, exports, RegisterCommand),
// so the pack is a generated fxmanifest.lua plus one shim file (sdk/adapters/fivem/shim.lua)
// listed as the first shared_script: FXServer loads every shared_script before the side scripts
// (citizenfx/fivem, citizen-scripting-core ResourceScriptingComponent.cpp), so `ScriptGo` exists
// before any script of the resource runs, on both sides. RedM is the same FXServer (`gamename
// rdr3`) and the same Lua runtime; the shim uses only CitizenFX natives common to both games, and
// reports the environment it was packed for.
//
// RedM refuses a resource whose fxmanifest.lua lacks `rdr3_warning` with the exact acknowledgement
// below: "Resource %s does not contain the RedM pre-release warning in fxmanifest.lua." (read from
// the FXServer binary, build 38435, citizen-server-impl.dll).
//
// The shim has no licence check (ADR-0020 wrote it without one, after the Rockstar Games Creator
// Platform License Agreement of 2026-09-10, §3.1(6)). So a package that needs one, `licensed true`
// or a required `licensing` capability, is refused here: the shim could not enforce it and the
// package would run unchecked. That is a technical limit of this adapter, not a selling rule: no
// environment blocks a paid offer on SCRIPT//GO (ADR-0037), and what the platform's terms say about
// paid server content is the platform's own rule, which the operator who runs a script there
// answers for.
//
// `--cfx-escrow` writes the build a creator uploads to Cfx.re's own asset escrow (portal.cfx.re,
// "Created Assets"; docs.fivem.net/docs/server-manual/asset-escrow, read 2026-11-12). Cfx.re
// encrypts it on the creator's Cfx.re account and only servers whose Cfx.re key holds the
// entitlement start it. SCRIPT//GO encrypts nothing there. The build adds `lua54 "yes"` (escrowed
// Lua must be Lua 5.4) and `escrow_ignore` for the files the manifest's `cfx_escrow_ignore` leaves
// readable, and says which files Cfx.re does not encrypt (it encrypts Lua, .ydr, .ydd and .yft).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
import { cfxDataFileTargets, expandGlob, expandIncludes, stripCapabilitySections, validateResourceFiles, type ParsedManifest } from "@scriptgo/manifest";
import { copyFiles, copyFingerprint, describePlan, FINGERPRINT_FILE, hasScripts, planAssets, type AssetPlan } from "./assets.ts";
import { scanSource, type PortabilityIssue } from "./portability.ts";
import { listFiles, sdkRoot, type LoadedResource } from "./sdk.ts";

export const FIVEM_SHIM_FILE = "scriptgo_shim.lua";
export const NO_LICENCE_CHECK =
  "The FiveM shim (which RedM runs too) has no licence check, so it could not enforce one: this is a technical limit of the adapter, not a selling rule. What the Rockstar Games Creator Platform License Agreement (2026-09-10, §3.1(6)) says about paid server content is the platform's own rule, which the operator who runs a script there answers for";

/** The two Cfx.re games: same FXServer, same resource shape, not each other's game files. */
export type CfxGame = "fivem" | "redm";
export const CFX_GAMES: Record<CfxGame, { name: string; game: "gta5" | "rdr3"; escrowServerBuild: number }> = {
  // Server builds from Cfx.re's announcements: "server version 5181 or above" (FiveM, 2021-11),
  // "server version 12735 or above to run resources using this feature on RedM" (2025-02-03).
  fivem: { name: "FiveM", game: "gta5", escrowServerBuild: 5181 },
  redm: { name: "RedM", game: "rdr3", escrowServerBuild: 12735 },
};
export const isCfxGame = (t: string): t is CfxGame => t === "fivem" || t === "redm";

/** The acknowledgement RedM requires in every fxmanifest.lua, word for word (FXServer build 38435). */
export const RDR3_WARNING = "I acknowledge that this is a prerelease build of RedM, and I am aware my resources *will* become incompatible once RedM ships.";

/** What Cfx.re's asset escrow does, from its documentation (read 2026-11-12). */
export const CFX_ESCROW = {
  /** "Currently Lua, YFT, YDD, and YDR files are supported." Everything else stays as uploaded. */
  encrypts: new Set(["lua", "ydr", "ydd", "yft"]),
  /** "The maximum file size for escrowed assets is 1GB." Read as 10^9 bytes, the stricter value. */
  maxUploadBytes: 1_000_000_000,
};

export interface FivemIssue {
  code: string;
  message: string;
}

/** The adapter version the shim reports at runtime. */
export function fivemShimVersion(): string {
  const text = readFileSync(join(sdkRoot, "adapters", "fivem", "shim.lua"), "utf8");
  return /ADAPTER_VERSION = "([^"]+)"/.exec(text)?.[1] ?? "fivem-shim-0.0.0";
}

/** A Lua string literal (fxmanifest.lua is executed as Lua, not parsed like scriptgo.lua). */
export function luaString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 32 || code === 127) out += `\\${String(code).padStart(3, "0")}`;
    else out += ch;
  }
  return out + '"';
}

const luaList = (items: string[]): string => `{ ${items.map(luaString).join(", ")} }`;
const extensionOf = (f: string): string => (f.includes(".") ? f.slice(f.lastIndexOf(".") + 1).toLowerCase() : "");

/**
 * What FiveM's Lua runtime lacks, from its source (citizenfx/fivem citizen-scripting-lua
 * LuaScriptRuntime.cpp): `require` resolves only the runtime's built-in modules, so a resource's
 * own modules are "not found"; `os` and `io` exist only on the server. RedM runs the same runtime.
 */
const FIVEM_RULES = [
  {
    code: "fivem_no_require",
    pattern: /(?<![\w.:])require\s*[("'[]/,
    sides: ["shared", "server", "client"] as ("shared" | "server" | "client")[],
    message: "FiveM's and RedM's `require` finds no resource module: list the module as a shared/server/client script and share it through a global or an export",
  },
  {
    code: "fivem_client_no_os",
    pattern: /(?<![\w.:])os\s*\.\s*[A-Za-z_]+/,
    sides: ["shared", "client"] as ("shared" | "server" | "client")[],
    message: "`os` is nil in FiveM's and RedM's client Lua: use ScriptGo.time.monotonic() (ScriptGo.time.now() is nil on the client)",
  },
];

/** Portability issues for every script of a resource that declares (or does not restrict) the game. */
export function fivemPortability(root: string, m: ParsedManifest, files: string[], game: CfxGame = "fivem"): PortabilityIssue[] {
  if (m.environments.length > 0 && !m.environments.includes(game)) return [];
  const bySide: ["shared" | "server" | "client", string[]][] = [
    ["shared", m.sharedScripts],
    ["server", m.serverScripts],
    ["client", m.clientScripts],
    // Environment scripts run on both sides, after the side scripts.
    ["shared", m.environmentScripts[game] ?? []],
  ];
  const issues: PortabilityIssue[] = [];
  const seen = new Set<string>();
  for (const [side, patterns] of bySide) {
    for (const pattern of patterns) {
      for (const file of expandGlob(pattern, files)) {
        const key = `${side}:${file}`;
        if (seen.has(key)) continue;
        seen.add(key);
        issues.push(...scanSource(readFileSync(join(root, file), "utf8"), file, side, FIVEM_RULES));
      }
    }
  }
  return issues;
}

/**
 * Refusals that follow from the shim having no licence check; optional licensing is only a warning.
 * A package that is sold but does not ask for a licence check packs like any other.
 */
export function fivemLicensingUnavailable(m: ParsedManifest, warnings: string[], game: CfxGame = "fivem"): FivemIssue[] {
  const errors: FivemIssue[] = [];
  const name = CFX_GAMES[game].name;
  if (m.licensed) errors.push({ code: "fivem_licensing_unavailable", message: `${m.name} is licensed (licensed true). ${NO_LICENCE_CHECK}` });
  if (m.capabilities.includes("licensing")) {
    errors.push({ code: "fivem_licensing_unavailable", message: `${m.name} requires the licensing capability, which the shim does not provide on ${name}. ${NO_LICENCE_CHECK}` });
  }
  if (!m.licensed && m.optionalCapabilities.includes("licensing")) {
    warnings.push(`licensing is unavailable on ${name} (the shim has no licence check): ScriptGo.licensing raises capability_unavailable:licensing@${game} there`);
  }
  return errors;
}

/** What fxmanifest.lua needs to know about a package's assets (lib/assets.ts). */
export interface FivemAssets {
  /** Asset files the resource carries, resource-relative. */
  files: string[];
  /** `data_file` lines: game data type and path (a file, or a folder of asset files). */
  dataFiles: { type: string; path: string }[];
  /** True when a .ymap is streamed: the resource is a map (`this_is_a_map`). */
  map: boolean;
}

/**
 * The asset part of fxmanifest from an asset plan: every carried file and the data_file lines that
 * name one of them. data_file lines are not keyed by game, so a line naming only the other game's
 * files stays out of this build (the inspection skips it the same way).
 */
export function fivemAssets(m: ParsedManifest, plan: AssetPlan, game: CfxGame = "fivem", listing: string[] = plan.delivered): FivemAssets {
  const dataFiles: { type: string; path: string }[] = [];
  for (const [type, paths] of Object.entries(m.dataFiles)) {
    for (const path of paths) if (cfxDataFileTargets(path, plan.delivered, listing).length > 0) dataFiles.push({ type, path });
  }
  return { files: plan.delivered, dataFiles, map: (plan.report.environments[game]?.needs ?? []).includes("this_is_a_map") };
}

export interface FivemManifestOptions {
  game?: CfxGame;
  /** For `--cfx-escrow`: the files left readable (`escrow_ignore`); also adds `lua54 "yes"`. */
  escrowIgnore?: string[];
}

/**
 * The generated fxmanifest.lua, for FiveM (`game "gta5"`) or RedM (`game "rdr3"` and its
 * `rdr3_warning`). Assets: files under stream/ are streamed by FXServer on its own; every other
 * asset file is listed in `files`, so players download it, and `data_file` lines name the ones the
 * game loads as data. An asset-only package has no shim and no scripts.
 */
export function fivemManifest(m: ParsedManifest, warnings: string[], assets?: FivemAssets, opts: FivemManifestOptions = {}): string {
  const game = opts.game ?? "fivem";
  const g = CFX_GAMES[game];
  const escrow = opts.escrowIgnore !== undefined;
  const lines: string[] = [
    `-- Generated by \`scriptgo pack --target ${game}${escrow ? " --cfx-escrow" : ""}\` from scriptgo.lua ${m.version}. Edit scriptgo.lua, not this file.`,
    `fx_version "cerulean"`,
    `game ${luaString(g.game)}`,
  ];
  if (game === "redm") lines.push(`rdr3_warning ${luaString(RDR3_WARNING)}`);
  // Cfx.re's escrow requires Lua 5.4 for the scripts it encrypts. Cfx.re's manifest reference now
  // calls the directive deprecated and not needed; it is kept for the older servers that read it.
  if (escrow) lines.push(`lua54 "yes"`);
  lines.push("", `version ${luaString(m.version)}`);
  if (m.author) lines.push(`author ${luaString(m.author)}`);
  if (m.description ?? m.title) lines.push(`description ${luaString((m.description ?? m.title)!)}`);
  if (m.repository) lines.push(`repository ${luaString(m.repository)}`);
  // Read back by ScriptGo.resource.hasPermission (FXServer keeps unknown keys as metadata).
  for (const p of m.permissions) lines.push(`scriptgo_permission ${luaString(p)}`);
  if (m.dependencies.length > 0) {
    // FXServer's `dependency` only names a resource that must load first; version ranges are dropped.
    const ranged = m.dependencies.filter((d) => d.range && d.range !== "*");
    if (ranged.length > 0) {
      warnings.push(`${g.name} dependencies carry no version: ${ranged.map((d) => `${d.name} ${d.range}`).join(", ")} became plain resource names`);
    }
    lines.push(`dependencies ${luaList(m.dependencies.map((d) => d.name))}`);
  }
  if (assets?.map) lines.push(`this_is_a_map "yes"`);
  const scripts = hasScripts(m);
  if (scripts) {
    lines.push("", `shared_script ${luaString(FIVEM_SHIM_FILE)}`);
    for (const p of m.sharedScripts) lines.push(`shared_script ${luaString(p)}`);
  }
  const envScripts = m.environmentScripts[game] ?? [];
  for (const p of [...m.serverScripts, ...envScripts]) lines.push(`server_script ${luaString(p)}`);
  for (const p of [...m.clientScripts, ...envScripts]) lines.push(`client_script ${luaString(p)}`);
  const assetFiles = (assets?.files ?? []).filter((f) => !f.startsWith("stream/"));
  const files = [...new Set([...m.files, ...m.webFiles, ...(m.webUiPage ? [m.webUiPage] : []), ...assetFiles])];
  if (files.length > 0) lines.push(`files ${luaList(files)}`);
  for (const d of assets?.dataFiles ?? []) lines.push(`data_file ${luaString(d.type)} ${luaString(d.path)}`);
  if (m.webUiPage) lines.push(`ui_page ${luaString(m.webUiPage)}`);
  // Declarative exports: a global function of that name, exported by FXServer itself.
  for (const e of m.exports) lines.push(`export ${luaString(e)}`);
  for (const e of m.serverExports) lines.push(`server_export ${luaString(e)}`);
  if (escrow && opts.escrowIgnore!.length > 0) lines.push("", `escrow_ignore ${luaList(opts.escrowIgnore!)}`);
  for (const env of Object.keys(m.environmentScripts)) {
    if (env !== game) warnings.push(`environment_script "${env}" is not shipped to ${g.name}`);
  }
  if (m.environments.length > 0 && !m.environments.includes(game)) {
    warnings.push(`the manifest does not list ${game} in environments; the package is untested there`);
  }
  return lines.join("\n") + "\n";
}

/** What a `--cfx-escrow` build leaves to Cfx.re, and what Cfx.re will not encrypt. */
export interface CfxEscrowBuild {
  /** The zip to upload at portal.cfx.re: `<name>/...`, deterministic. */
  zip: string;
  bytes: number;
  /** Files Cfx.re's escrow encrypts on upload (Lua, .ydr, .ydd, .yft not left open). */
  encrypted: string[];
  /** Files left readable on purpose: `cfx_escrow_ignore` and the SCRIPT//GO shim. */
  ignored: string[];
  /** Files Cfx.re's escrow does not encrypt (other types), besides fxmanifest.lua. */
  notEncrypted: string[];
  serverBuild: number;
}

export interface CfxPackOptions {
  game?: CfxGame;
  allowUnportable?: boolean;
  withoutAssets?: boolean;
  /** Write the build for Cfx.re's asset escrow (a folder and its upload zip). */
  cfxEscrow?: boolean;
}

/**
 * The escrow part of a `--cfx-escrow` build: which packed files Cfx.re encrypts, which stay
 * readable, and the warnings for what its escrow cannot encrypt.
 */
export function cfxEscrowPlan(m: ParsedManifest, packed: string[], warnings: string[]): { encrypted: string[]; ignored: string[]; notEncrypted: string[] } {
  const ignored = new Set<string>();
  for (const pattern of m.cfxEscrowIgnore) {
    const hits = expandGlob(pattern, packed);
    if (hits.length === 0) warnings.push(`cfx_escrow_ignore '${pattern}' matches no file of this build`);
    for (const f of hits) ignored.add(f);
  }
  // The shim is SCRIPT//GO's MIT code: it stays readable, so an operator can audit what talks to
  // SCRIPT//GO. Nothing secret is in it.
  if (packed.includes(FIVEM_SHIM_FILE)) ignored.add(FIVEM_SHIM_FILE);
  const encrypted: string[] = [];
  const notEncrypted: string[] = [];
  for (const f of packed) {
    if (f === "fxmanifest.lua" || ignored.has(f)) continue;
    (CFX_ESCROW.encrypts.has(extensionOf(f)) ? encrypted : notEncrypted).push(f);
  }
  const web = new Set([...m.webFiles.flatMap((p) => expandGlob(p, packed)), ...(m.webUiPage ? [m.webUiPage] : [])]);
  const js = notEncrypted.filter((f) => extensionOf(f) === "js" && !web.has(f));
  const nui = notEncrypted.filter((f) => web.has(f));
  const streamed = notEncrypted.filter((f) => f.startsWith("stream/"));
  if (js.length > 0) warnings.push(`Cfx.re's escrow does not encrypt JavaScript: ${js.join(", ")} stay readable`);
  if (nui.length > 0) warnings.push(`NUI files are sent to each player's browser and Cfx.re's escrow does not cover them: ${nui.join(", ")} stay readable`);
  if (streamed.length > 0) {
    const types = [...new Set(streamed.map((f) => `.${extensionOf(f)}`))].sort().join(", ");
    warnings.push(`Cfx.re's escrow encrypts .ydr, .ydd and .yft models only: ${streamed.length} other streamed files (${types}) stay readable`);
  }
  if (encrypted.length === 0) warnings.push("nothing in this build is a file Cfx.re's escrow encrypts (Lua, .ydr, .ydd, .yft): every file stays readable");
  return { encrypted, ignored: [...ignored].sort(), notEncrypted };
}

/**
 * Writes `<parent>/<name>/` as a FiveM or RedM resource: the referenced files, the shim and a
 * generated fxmanifest.lua. Refuses a package that needs a licence check (the shim has none) and code
 * the Cfx.re Lua runtime cannot run, unless `allowUnportable` turns the portability findings into
 * warnings. With `cfxEscrow`, also writes `<parent>/<name>-<version>.zip` for Cfx.re's asset escrow.
 */
export function packForCfx(
  res: LoadedResource,
  parent: string,
  opts: CfxPackOptions = {},
): { dest: string; warnings: string[]; errors: FivemIssue[]; assets?: AssetPlan; escrow?: CfxEscrowBuild } {
  const game = opts.game ?? "fivem";
  const g = CFX_GAMES[game];
  const warnings: string[] = [];
  if (!res.result.ok) return { dest: "", warnings, errors: res.result.errors };
  const m = res.result.manifest;
  const files = listFiles(res.root);
  const problems = validateResourceFiles(m, files);
  if (problems.length > 0) return { dest: "", warnings, errors: problems };
  if (m.format === "open77") {
    return { dest: "", warnings, errors: [{ code: "fivem_open77_format", message: `an open77.lua resource uses OPEN//77 natives; give it a scriptgo.lua to pack it for ${g.name}` }] };
  }
  const assets = planAssets(res, game, { withoutAssets: opts.withoutAssets });
  warnings.push(...assets.warnings);
  if (assets.errors.length > 0) return { dest: "", warnings, errors: assets.errors, assets };
  if (opts.cfxEscrow && assets.fingerprint) {
    return {
      dest: "", warnings, assets,
      errors: [{ code: "cfx_escrow_buyer_copy", message: `this folder is a buyer's fingerprinted copy (${FINGERPRINT_FILE}): the Cfx.re escrow build is uploaded by the creator, from the creator's sources, to the creator's own Cfx.re account.` }],
    };
  }
  // The licence check is a runtime check in scripts. An asset-only package runs nothing: its
  // licence gate is the download (docs/spec/assets.md), which the shim's limit does not touch.
  const noLicensing = hasScripts(m) ? fivemLicensingUnavailable(m, warnings, game) : [];
  if (noLicensing.length > 0) return { dest: "", warnings, errors: noLicensing };
  if (!hasScripts(m) && m.licensed && !opts.cfxEscrow) warnings.push(`an asset-only package has no runtime licence check on ${g.name}: the licence gates the download, and every copy is fingerprinted to its buyer`);
  // Player match on RedM has no adapter yet: the shim's section is FiveM's (docs/spec/player-match.md).
  if (game === "redm" && hasScripts(m)) {
    if (m.capabilities.includes("presence")) {
      return { dest: "", warnings, errors: [{ code: "redm_presence_unavailable", message: `${m.name} requires the presence capability, which the shim does not provide on RedM yet.` }] };
    }
    if (m.optionalCapabilities.includes("presence")) warnings.push("presence is unavailable on RedM: ScriptGo.presence raises capability_unavailable:presence@redm there");
  }
  const portability = fivemPortability(res.root, m, files, game);
  if (portability.length > 0 && !opts.allowUnportable) {
    return { dest: "", warnings, errors: portability.map((p) => ({ code: p.code, message: `${p.file}:${p.line} ${p.message}` })) };
  }
  for (const p of portability) warnings.push(`${p.file}:${p.line} ${p.message}`);

  const dest = join(parent, m.name);
  if (existsSync(dest)) rmSync(dest, { recursive: true });
  mkdirSync(dest, { recursive: true });
  const included = new Set<string>();
  const add = (pattern: string): void => {
    for (const f of expandGlob(pattern, files)) included.add(f);
  };
  for (const p of [...m.sharedScripts, ...m.serverScripts, ...m.clientScripts, ...(m.environmentScripts[game] ?? [])]) add(p);
  for (const p of [...m.files, ...m.webFiles]) add(p);
  if (m.webUiPage) add(m.webUiPage);
  copyFiles(res.root, dest, [...new Set([...included, ...assets.delivered])].sort());
  copyFingerprint(assets, dest);
  if (hasScripts(m)) {
    // The shim keeps a capability's section only for a resource that declares it (player match, on
    // FiveM only), with the core's module included word for word, as for OPEN//77.
    const shimDir = join(sdkRoot, "adapters", "fivem");
    const declared = new Set([...m.capabilities, ...m.optionalCapabilities]);
    if (game !== "fivem") declared.delete("presence");
    let shim = expandIncludes(stripCapabilitySections(readFileSync(join(shimDir, "shim.lua"), "utf8"), declared), shimDir);
    if (game !== "fivem") {
      const line = `local ENVIRONMENT = ${luaString(game)}`;
      shim = shim.replace(/^local ENVIRONMENT = "fivem"\r?$/m, line);
      if (!shim.includes(line)) throw new Error("sdk/adapters/fivem/shim.lua: the line `local ENVIRONMENT = \"fivem\"` is missing");
    }
    writeFileSync(join(dest, FIVEM_SHIM_FILE), shim);
  }
  const fx = fivemAssets(m, assets, game, files);
  if (!opts.cfxEscrow) {
    writeFileSync(join(dest, "fxmanifest.lua"), fivemManifest(m, warnings, fx, { game }));
    return { dest, warnings, errors: [], assets };
  }

  const plan = cfxEscrowPlan(m, listFiles(dest), warnings);
  writeFileSync(join(dest, "fxmanifest.lua"), fivemManifest(m, warnings, fx, { game, escrowIgnore: plan.ignored }));
  // The upload: the resource folder, zipped. Fixed timestamps, so the same sources give the same zip.
  const entries: Record<string, Uint8Array> = {};
  for (const f of listFiles(dest).sort()) entries[`${m.name}/${f}`] = readFileSync(join(dest, ...f.split("/")));
  const zipBytes = zipSync(entries, { level: 9, mtime: new Date("2026-01-01T00:00:00Z") });
  const zip = join(parent, `${m.name}-${m.version}.zip`);
  writeFileSync(zip, zipBytes);
  const errors: FivemIssue[] = [];
  if (zipBytes.byteLength > CFX_ESCROW.maxUploadBytes) {
    errors.push({ code: "cfx_escrow_too_large", message: `${zip}: ${zipBytes.byteLength} bytes; Cfx.re takes escrowed assets up to 1 GB.` });
  }
  return { dest, warnings, errors, assets, escrow: { zip, bytes: zipBytes.byteLength, ...plan, serverBuild: g.escrowServerBuild } };
}

/** `packForCfx` for FiveM: the name the verify runner and the tests use. */
export function packForFivem(
  res: LoadedResource,
  parent: string,
  opts: Omit<CfxPackOptions, "game"> = {},
): ReturnType<typeof packForCfx> {
  return packForCfx(res, parent, { ...opts, game: "fivem" });
}

/** `scriptgo pack <dir> --target fivem|redm [--cfx-escrow] [--out dist]`: prints the result, returns the exit code. */
export function packCfxTarget(res: LoadedResource, out: string, game: CfxGame, opts: Omit<CfxPackOptions, "game"> = {}): number {
  const g = CFX_GAMES[game];
  const r = packForCfx(res, join(out, opts.cfxEscrow ? `${game}-cfx-escrow` : game), { ...opts, game });
  for (const w of r.warnings) console.log(`warning ${w}`);
  for (const e of r.errors) console.error(`error ${e.code}: ${e.message}`);
  if (r.errors.length > 0) return 1;
  if (r.assets) for (const line of describePlan(r.assets, game)) console.log(line);
  if (!r.escrow) {
    console.log(`packed for ${g.name} -> ${r.dest}`);
    return 0;
  }
  const e = r.escrow;
  console.log(`packed for ${g.name}, ready for Cfx.re's asset escrow -> ${r.dest}`);
  console.log(`  upload: ${e.zip} (${e.bytes} bytes)`);
  console.log(`  Cfx.re encrypts on upload: ${e.encrypted.length} files${e.encrypted.length ? ` (${e.encrypted.join(", ")})` : ""}`);
  console.log(`  left readable (escrow_ignore): ${e.ignored.length ? e.ignored.join(", ") : "none"}`);
  console.log(`  not encrypted by Cfx.re (other types): ${e.notEncrypted.length ? e.notEncrypted.join(", ") : "none"}`);
  console.log(`next: upload the zip at portal.cfx.re (Created Assets) with your own Cfx.re account; Cfx.re encrypts it there, and a server starts it only when its Cfx.re key holds the asset (${g.name} server build ${e.serverBuild} or later)`);
  console.log("note: SCRIPT//GO encrypts nothing in this build: Cfx.re does, on your Cfx.re account.");
  console.log("note: Cfx.re delivers one escrowed copy to every buyer: SCRIPT//GO's per-buyer fingerprint is not in it. Copies downloaded from SCRIPT//GO stay licence-gated and fingerprinted, and are not encrypted.");
  return 0;
}
