// Garry's Mod packaging: a resource becomes an ordinary server addon folder,
//
//   scriptgo_<name>/addon.json
//   scriptgo_<name>/lua/scriptgo/resources/<name>/<the manifest and every file it references>
//
// which the SCRIPT//GO runtime addon (sdk/adapters/garrysmod, built by its build.mjs) finds through
// GMod's LUA search path, merged across every addon. Nothing is rewritten: GLua runs the portable
// core (LuaJIT, Lua 5.1 semantics) and the resource keeps its format.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expandGlob, validateResourceFiles, type ParsedManifest } from "@scriptgo/manifest";
// @ts-expect-error plain ESM build script without type declarations
import { buildAddon } from "../../../../sdk/adapters/garrysmod/build.mjs";
import { referencedFiles } from "../commands/pack.ts";
import { stripCommentsAndStrings, type PortabilityIssue } from "./portability.ts";
import { listFiles, type LoadedResource } from "./sdk.ts";

/** Builds the runtime addon (the GLua host + the core) into `dest`. */
export function buildGarrysmodRuntime(dest: string): string {
  return buildAddon(dest) as string;
}

/**
 * What can go wrong for this resource on a Garry's Mod server, as warnings: client scripts (they
 * do not run yet), Lua dialects GLua lacks, GLua's extra `continue` keyword, and upper-case paths
 * (GMod's Linux servers and .gma archives use lower-case paths).
 */
export function garrysmodPortability(root: string, m: ParsedManifest, files: string[]): PortabilityIssue[] {
  const issues: PortabilityIssue[] = [];
  const manifestFile = files.includes("scriptgo.lua") ? "scriptgo.lua" : "open77.lua";
  if (m.clientScripts.length > 0) {
    issues.push({ code: "garrysmod_no_client", file: manifestFile, line: 0, message: "client scripts do not run on Garry's Mod yet: only the server side runs (no game client is driven)" });
  }
  if (m.lua.length > 0 && !m.lua.includes("5.1") && !m.lua.includes("luajit")) {
    issues.push({ code: "garrysmod_dialect", file: manifestFile, line: 0, message: `the package declares Lua ${m.lua.join(", ")}; Garry's Mod runs LuaJIT with Lua 5.1 semantics` });
  }
  const scripts = new Set<string>();
  for (const p of [...m.sharedScripts, ...m.serverScripts, ...(m.environmentScripts["garrysmod"] ?? [])]) {
    for (const f of expandGlob(p, files)) scripts.add(f);
  }
  for (const file of [...scripts].sort()) {
    const lines = stripCommentsAndStrings(readFileSync(join(root, file), "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (/(?<![\w.:])continue(?!\w)/.test(line)) {
        issues.push({ code: "garrysmod_continue_keyword", file, line: i + 1, message: "`continue` is a keyword in GLua: rename this identifier" });
      }
    });
  }
  for (const f of referencedFiles(m, files, manifestFile)) {
    if (f !== f.toLowerCase()) issues.push({ code: "garrysmod_path_case", file: f, line: 0, message: "upper-case path: GMod lower-cases paths on Linux servers and in .gma archives" });
  }
  return issues;
}

export interface GarrysmodPack {
  dest: string;
  warnings: string[];
  errors: { code: string; message: string }[];
}

/** Copies the manifest and every file it references into `<resourcesDir>/<name>/`. */
export function copyResourceForGarrysmod(res: LoadedResource, resourcesDir: string): GarrysmodPack {
  const warnings: string[] = [];
  if (!res.result.ok) return { dest: "", warnings, errors: res.result.errors };
  const m = res.result.manifest;
  const files = listFiles(res.root);
  const problems = validateResourceFiles(m, files);
  if (problems.length > 0) return { dest: "", warnings, errors: problems };
  const dest = join(resourcesDir, m.name);
  if (existsSync(dest)) rmSync(dest, { recursive: true });
  for (const f of referencedFiles(m, files, res.manifestFile)) {
    mkdirSync(dirname(join(dest, f)), { recursive: true });
    copyFileSync(join(res.root, f), join(dest, f));
  }
  for (const p of garrysmodPortability(res.root, m, files)) warnings.push(`${p.file}${p.line ? `:${p.line}` : ""} ${p.message}`);
  if (m.environments.length > 0 && !m.environments.includes("garrysmod")) {
    warnings.push("the manifest does not list garrysmod in environments; the package is untested there");
  }
  return { dest, warnings, errors: [] };
}

export function addonJson(title: string): string {
  return JSON.stringify({ title, type: "servercontent", tags: ["build", "roleplay"], ignore: ["*.md"] }, null, 2) + "\n";
}

/**
 * `scriptgo pack --target garrysmod`: `<parent>/scriptgo_<name>/` (the resource as an addon) and,
 * unless `runtime` is false, `<parent>/scriptgo/` (the runtime addon). Copy both into
 * garrysmod/addons/.
 */
export function packForGarrysmod(res: LoadedResource, parent: string, opts: { runtime?: boolean } = {}): GarrysmodPack & { runtime?: string } {
  if (!res.result.ok) return { dest: "", warnings: [], errors: res.result.errors };
  const m = res.result.manifest;
  const addon = join(parent, `scriptgo_${m.name}`);
  if (existsSync(addon)) rmSync(addon, { recursive: true });
  const r = copyResourceForGarrysmod(res, join(addon, "lua", "scriptgo", "resources"));
  if (r.errors.length > 0) {
    rmSync(addon, { recursive: true, force: true });
    return r;
  }
  writeFileSync(join(addon, "addon.json"), addonJson(`${m.title ?? m.name} (SCRIPT//GO resource)`));
  const runtime = opts.runtime === false ? undefined : buildGarrysmodRuntime(join(parent, "scriptgo"));
  if (m.capabilities.includes("http") || m.capabilities.includes("licensing") || m.optionalCapabilities.includes("licensing")) {
    r.warnings.push("licensing calls the SCRIPT//GO API at the scriptgo_api convar (default https://api.scriptgo.dev); the server needs outbound HTTPS to it");
  }
  return { dest: addon, warnings: r.warnings, errors: [], runtime };
}
