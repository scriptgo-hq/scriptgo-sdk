// scriptgo pack <dir> --target scriptgo|open77|garrysmod|beammp|fivem|luanti|rust|hytale [--out dist]
//
//   scriptgo  a .zip of the resource for `scriptgo publish` (manifest, every referenced file, every
//             asset); each TypeScript entry x.ts is compiled to x.ts.js inside the archive
//   open77    a folder OPEN//77 loads as is: a generated open77.lua that loads the ScriptGo shim
//             (sdk/adapters/open77/shim*.lua) before the resource's scripts, the referenced files,
//             generic assets as resource files and preload packages as preload_mod lines.
//   garrysmod a server addon scriptgo_<name>/ holding the resource and its content (materials/,
//             models/, sound/, maps/ ...) with a generated download list, plus the runtime addon
//             scriptgo/ (lib/garrysmod.ts; --no-runtime leaves the runtime out).
//   beammp    Resources/Server/scriptgo/: the BeamMP plugin with the resource and its dependencies,
//             and Resources/Client/: the package's client mods (lib/beammp.ts).
//   fivem     a FiveM resource folder: a generated fxmanifest.lua, the one-file shim, the resource,
//             stream/ and data files (lib/fivem-pack.ts). The shim has no licence check: a package
//             with scripts that needs one is refused.
//   luanti    a Luanti media mod sgmedia_<name>/ (lib/asset-targets.ts), plus the SCRIPT//GO mod and
//             the resource when the package has scripts.
//   rust      the package's custom map, for the operator to host at server.levelurl.
//   hytale    the package's asset pack, for the server's mods/ folder.
//
// Assets are inspected for the target (lib/assets.ts): an asset the target cannot deliver is an
// error, never dropped; --without-assets builds a target that delivers none of the package's assets.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { zipSync } from "fflate";
import {
  allAssetFiles,
  describeAssetReport,
  expandGlob,
  OPEN77_SHIM,
  open77Manifest,
  open77ShimFiles,
  parseManifest,
  scriptLanguage,
  stripCapabilitySections,
  toOpen77Constraint,
  validateResourceFiles,
  type ParsedManifest,
} from "@scriptgo/manifest";
import { parseArgs } from "../lib/args.ts";
import { packForGarrysmod } from "../lib/garrysmod.ts";
import { open77Portability } from "../lib/portability.ts";
import { packFivemTarget } from "../lib/fivem-pack.ts";
import { listFiles, readResource, sdkRoot, type LoadedResource } from "../lib/sdk.ts";
import { compileTypeScript, type CompileIssue } from "../lib/typescript.ts";
import { packBeamMPCommand } from "../lib/beammp.ts";
import { packEscrow } from "../lib/escrow-pack.ts";
import { copyFiles, copyFingerprint, describePlan, planAssets, uploadAssetErrors, type AssetPlan } from "../lib/assets.ts";
import { packAssetTargetCommand } from "../lib/asset-targets.ts";

export const summary = "Package a resource: a publishable .zip, or a folder for OPEN//77, Garry's Mod, BeamMP or FiveM";

// The OPEN//77 generation (manifest, shim files) lives in @scriptgo/manifest so the master builds a
// protected release with the same files as this CLI. Re-exported here for the callers that had them.
export { OPEN77_SHIM, open77Manifest, stripCapabilitySections, toOpen77Constraint };

/** Files the manifest references, expanded against the folder listing (tests are left out). */
export function referencedFiles(m: ParsedManifest, files: string[], manifestFile: string): string[] {
  const set = new Set<string>([manifestFile]);
  const add = (pattern: string): void => {
    for (const f of expandGlob(pattern, files)) set.add(f);
  };
  for (const p of [...m.sharedScripts, ...m.serverScripts, ...m.clientScripts]) add(p);
  for (const paths of Object.values(m.environmentScripts)) for (const p of paths) add(p);
  for (const p of [...m.files, ...m.webFiles]) add(p);
  if (m.webUiPage) add(m.webUiPage);
  return [...set].sort();
}

/** Documents shipped in a SCRIPT//GO archive so the package page can show them. */
export const DOC_FILES = ["README.md", "CHANGELOG.md", "LICENSE", "LICENSE.md", "LICENSE.txt"];

/**
 * The SCRIPT//GO upload archive, shared by `pack --target scriptgo` and `publish`: the referenced
 * files plus test scripts and documents, and for TypeScript the compiled `<entry>.js` with every
 * source the bundle read. Deterministic (fixed timestamps, pinned esbuild), so the same sources
 * always give the same bytes and SHA-256. A TypeScript compile error leaves `errors` set and no zip.
 */
export async function scriptgoArchive(
  m: ParsedManifest, all: string[], root: string, manifestFile: string,
): Promise<{ zip: Uint8Array; files: string[]; errors: CompileIssue[] }> {
  const included = new Set(referencedFiles(m, all, manifestFile));
  for (const t of m.testScripts) for (const f of expandGlob(t, all)) included.add(f);
  for (const d of DOC_FILES) if (all.includes(d)) included.add(d);
  // Assets of every environment: the platform builds each buyer's copy from this one archive.
  for (const f of allAssetFiles(m, all)) included.add(f);
  const ts = await compileTypeScript(root, m, all);
  if (ts.errors.length > 0) return { zip: new Uint8Array(), files: [], errors: ts.errors };
  const compiled = new Map<string, Uint8Array>();
  for (const c of ts.entries) {
    compiled.set(c.output, c.code);
    for (const input of c.inputs) included.add(input);
  }
  for (const out of compiled.keys()) included.add(out);
  const files = [...included].sort();
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) entries[`${m.name}/${f}`] = compiled.get(f) ?? readFileSync(join(root, f));
  const zip = zipSync(entries, { level: 9, mtime: new Date("2026-01-01T00:00:00Z") });
  return { zip, files, errors: [] };
}

/** Every `--target` of `scriptgo pack`. */
export const PACK_TARGETS = ["scriptgo", "open77", "garrysmod", "beammp", "fivem", "luanti", "rust", "hytale"];

export interface PackIssue {
  code: string;
  message: string;
}

/**
 * Writes `<parent>/<name>/` as an OPEN//77 resource: the referenced files, the shim (cut to the
 * capabilities the manifest asks for) and a generated open77.lua, then re-validates the result.
 * A resource that is already in OPEN//77 format is copied as is.
 */
export function packForOpen77(
  res: LoadedResource,
  parent: string,
  opts: { allowUnportable?: boolean; withoutAssets?: boolean } = {},
): { dest: string; warnings: string[]; errors: PackIssue[]; assets?: AssetPlan } {
  const warnings: string[] = [];
  if (!res.result.ok) return { dest: "", warnings, errors: res.result.errors };
  const m = res.result.manifest;
  const files = listFiles(res.root);
  const problems = validateResourceFiles(m, files);
  if (problems.length > 0) return { dest: "", warnings, errors: problems };
  const assets = planAssets(res, "open77", { withoutAssets: opts.withoutAssets });
  warnings.push(...assets.warnings);
  if (assets.errors.length > 0) return { dest: "", warnings, errors: assets.errors, assets };
  // OPEN//77 runs Lua only: every script it would load must be a .lua file.
  const shipped = [...m.sharedScripts, ...m.serverScripts, ...m.clientScripts, ...(m.environmentScripts["open77"] ?? [])];
  const foreign = shipped.filter((p) => scriptLanguage(p) !== "lua");
  if (foreign.length > 0) {
    return { dest: "", warnings, errors: foreign.map((p) => ({ code: "open77_lua_only", message: `${p}: OPEN//77 runs Lua scripts only.` })) };
  }
  const dest = join(parent, m.name);
  const included = referencedFiles(m, files, res.manifestFile);
  if (existsSync(dest)) rmSync(dest, { recursive: true });
  mkdirSync(dest, { recursive: true });

  if (m.format === "open77") {
    // An open77.lua names its preload packages itself (preload_mod / preload_mods): copy them too.
    const preloads = m.unknown
      .filter((u) => u.directive === "preload_mod" || u.directive === "preload_mods")
      .flatMap((u) => u.args.flatMap((a) => (Array.isArray(a) ? a : [a])))
      .filter((a): a is string => typeof a === "string");
    const missing = preloads.filter((p) => !files.includes(p));
    if (missing.length > 0) {
      rmSync(dest, { recursive: true });
      return { dest: "", warnings, errors: missing.map((p) => ({ code: "missing_file", message: `preload_mod '${p}' does not exist in the resource.` })) };
    }
    copyFiles(res.root, dest, [...new Set([...included, ...preloads])].sort());
    copyFingerprint(assets, dest);
    return { dest, warnings, errors: [], assets };
  }

  // Every SCRIPT//GO capability has an OPEN//77 mapping (players, permissions, config, http and
  // licensing on the server side only, as on every host). What can still break is the code itself.
  const portability = open77Portability(res.root, m, files);
  if (portability.length > 0 && !opts.allowUnportable) {
    rmSync(dest, { recursive: true });
    return { dest: "", warnings, errors: portability.map((p) => ({ code: p.code, message: `${p.file}:${p.line} ${p.message}` })) };
  }
  for (const p of portability) warnings.push(`${p.file}:${p.line} ${p.message}`);

  copyFiles(res.root, dest, included.filter((f) => f !== res.manifestFile));
  // Generic assets go to every player's client cache as resource files; preload packages are
  // mounted by the game (open77Manifest writes preload_mod lines and the archivexl dependency).
  copyFiles(res.root, dest, assets.delivered);
  copyFingerprint(assets, dest);
  for (const [to, data] of open77ShimFiles(m, join(sdkRoot, "adapters", "open77"))) writeFileSync(join(dest, to), data);
  const needs = assets.report.environments["open77"]?.needs ?? [];
  const manifestText = open77Manifest(m, warnings, res.manifestFile, { needs, preloads: assets.native });
  writeFileSync(join(dest, "open77.lua"), manifestText);
  // Re-check the generated resource with the same parser OPEN//77 rules are encoded in.
  const check = parseManifest(manifestText, { fileName: "open77.lua" });
  const errors = check.ok ? validateResourceFiles(check.manifest, listFiles(dest)) : check.errors;
  if (check.ok) {
    // Every preload line must name a file of the packed folder: nothing is dropped on the way.
    const packed = listFiles(dest);
    for (const p of assets.native) if (!packed.includes(p)) errors.push({ code: "missing_file", message: `preload_mod '${p}' is not in the packed resource.` });
  }
  return { dest, warnings, errors, assets };
}

export async function run(args: string[]): Promise<number> {
  const a = parseArgs(args, { booleans: ["help", "allow-unportable", "no-runtime", "escrow", "without-assets"], repeatable: ["escrow-ignore"] });
  if (a.bools.has("help") || a.positional.length === 0) {
    console.log(`scriptgo pack <resourceDir> [--target ${PACK_TARGETS.join("|")}] [--out dist] [--allow-unportable] [--no-runtime] [--without-assets] [--escrow [--escrow-ignore <glob>]...]`);
    return a.bools.has("help") ? 0 : 2;
  }
  const res = readResource(a.positional[0]!);
  if (!res.result.ok) {
    for (const e of res.result.errors) console.error(`error ${e.code}: ${e.message}`);
    return 1;
  }
  const m = res.result.manifest;
  const files = listFiles(res.root);
  const problems = validateResourceFiles(m, files);
  if (problems.length > 0) {
    for (const e of problems) console.error(`error ${e.code}: ${e.message}`);
    return 1;
  }
  const target = a.flags.target ?? "scriptgo";
  const out = resolve(a.flags.out ?? "dist");
  const withoutAssets = a.bools.has("without-assets");
  if (target === "scriptgo") {
    // The upload carries every environment's assets: check them all before building it.
    const { report: assets, errors: assetErrors } = uploadAssetErrors(res);
    for (const w of assets.warnings) console.log(`warning ${w.code}: ${w.message}`);
    for (const e of assetErrors) console.error(`error ${e.code}: ${e.message}`);
    if (assetErrors.length > 0) return 1;
    for (const line of assets.files.length > 0 ? describeAssetReport(assets) : []) console.log(line);
    // Same archive as `scriptgo publish` uploads, so a zip uploaded on the website gets the same page.
    const { zip, files: packed, errors } = await scriptgoArchive(m, files, res.root, res.manifestFile);
    for (const e of errors) console.error(`error ${e.code}: ${e.message}`);
    if (errors.length > 0) return 1;
    if (a.bools.has("escrow")) {
      const identifier = m.author ? `${m.author}//${m.name.replace(/_/g, "-")}` : m.name;
      const r = packEscrow({
        archive: zip, manifest: m, manifestFile: res.manifestFile, identifier, outDir: out,
        allowlist: a.multi["escrow-ignore"] ?? [],
      });
      console.log(`escrow bundle -> ${r.bundlePath} (${r.bytes} bytes)`);
      console.log(`  clear:     ${r.clearFiles.join(", ")}`);
      console.log(`  encrypted: ${r.encryptedFiles.join(", ")}`);
      console.log(`  content key (SECRET, master only) -> ${r.keyPath}`);
      console.log("  note: real code secrecy only on a host that can hold the key (.NET / native kit);");
      console.log("        on a pure-Lua host escrow degrades to license-only — do not claim code secrecy there.");
      return 0;
    }
    mkdirSync(out, { recursive: true });
    const file = join(out, `${m.name}-${m.version}.zip`);
    writeFileSync(file, zip);
    console.log(`packed ${packed.length} files -> ${file} (${zip.byteLength} bytes)`);
    return 0;
  }

  if (target === "open77") {
    const r = packForOpen77(res, join(out, "open77"), { allowUnportable: a.bools.has("allow-unportable"), withoutAssets });
    for (const w of r.warnings) console.log(`warning ${w}`);
    if (r.assets) for (const line of describePlan(r.assets, "open77")) console.log(line);
    for (const e of r.errors) console.error(`error ${e.code}: ${e.message}`);
    if (r.errors.length > 0) return 1;
    console.log(`packed for OPEN//77 -> ${r.dest}`);
    return 0;
  }

  if (target === "garrysmod") {
    const r = packForGarrysmod(res, join(out, "garrysmod"), { runtime: !a.bools.has("no-runtime"), withoutAssets });
    for (const w of r.warnings) console.log(`warning ${w}`);
    for (const e of r.errors) console.error(`error ${e.code}: ${e.message}`);
    if (r.errors.length > 0) return 1;
    if (r.assets) for (const line of describePlan(r.assets, "garrysmod")) console.log(line);
    console.log(`packed for Garry's Mod -> ${r.dest}${r.runtime ? ` (runtime addon -> ${r.runtime})` : ""}; copy into garrysmod/addons/`);
    return 0;
  }

  if (target === "beammp") return packBeamMPCommand(res, join(out, "beammp"), { withoutAssets });

  if (target === "fivem") return packFivemTarget(res, out, a.bools.has("allow-unportable"), withoutAssets); // lib/fivem-pack.ts
  if (target === "luanti" || target === "rust" || target === "hytale") return packAssetTargetCommand(res, target, join(out, target)); // lib/asset-targets.ts
  console.error(`unknown target '${target}' (${PACK_TARGETS.join(", ")})`);
  return 2;
}
