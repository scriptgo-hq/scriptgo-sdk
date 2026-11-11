// `scriptgo pack --target fivem`: a SCRIPT//GO resource as a FiveM resource folder.
//
// FiveM already runs this resource shape (CreateThread, Wait, events, exports, RegisterCommand),
// so the pack is a generated fxmanifest.lua plus one shim file (sdk/adapters/fivem/shim.lua)
// listed as the first shared_script: FXServer loads every shared_script before the side scripts
// (citizenfx/fivem, citizen-scripting-core ResourceScriptingComponent.cpp), so `ScriptGo` exists
// before any script of the resource runs, on both sides.
//
// The shim has no licence check (ADR-0020 wrote it without one, after the Rockstar Games Creator
// Platform License Agreement of 2026-09-10, §3.1(6)). So a package that needs one, `licensed true`
// or a required `licensing` capability, is refused here: the shim could not enforce it and the
// package would run unchecked. That is a technical limit of this adapter, not a selling rule: no
// environment blocks a paid offer on SCRIPT//GO (ADR-0037), and what the platform's terms say about
// paid server content is the platform's own rule, which the operator who runs a script there
// answers for.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expandGlob, expandIncludes, stripCapabilitySections, validateResourceFiles, type ParsedManifest } from "@scriptgo/manifest";
import { copyFiles, copyFingerprint, describePlan, hasScripts, planAssets, type AssetPlan } from "./assets.ts";
import { scanSource, type PortabilityIssue } from "./portability.ts";
import { listFiles, sdkRoot, type LoadedResource } from "./sdk.ts";

export const FIVEM_SHIM_FILE = "scriptgo_shim.lua";
export const NO_LICENCE_CHECK =
  "The FiveM shim has no licence check, so it could not enforce one: this is a technical limit of the adapter, not a selling rule. What the Rockstar Games Creator Platform License Agreement (2026-09-10, §3.1(6)) says about paid server content is the platform's own rule, which the operator who runs a script there answers for";

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

/**
 * What FiveM's Lua runtime lacks, from its source (citizenfx/fivem citizen-scripting-lua
 * LuaScriptRuntime.cpp): `require` resolves only the runtime's built-in modules, so a resource's
 * own modules are "not found"; `os` and `io` exist only on the server.
 */
const FIVEM_RULES = [
  {
    code: "fivem_no_require",
    pattern: /(?<![\w.:])require\s*[("'[]/,
    sides: ["shared", "server", "client"] as ("shared" | "server" | "client")[],
    message: "FiveM's `require` finds no resource module: list the module as a shared/server/client script and share it through a global or an export",
  },
  {
    code: "fivem_client_no_os",
    pattern: /(?<![\w.:])os\s*\.\s*[A-Za-z_]+/,
    sides: ["shared", "client"] as ("shared" | "server" | "client")[],
    message: "`os` is nil in FiveM's client Lua: use ScriptGo.time.monotonic() (ScriptGo.time.now() is nil on the client)",
  },
];

/** Portability issues for every script of a resource that declares (or does not restrict) fivem. */
export function fivemPortability(root: string, m: ParsedManifest, files: string[]): PortabilityIssue[] {
  if (m.environments.length > 0 && !m.environments.includes("fivem")) return [];
  const bySide: ["shared" | "server" | "client", string[]][] = [
    ["shared", m.sharedScripts],
    ["server", m.serverScripts],
    ["client", m.clientScripts],
    // Environment scripts run on both sides, after the side scripts.
    ["shared", m.environmentScripts["fivem"] ?? []],
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
export function fivemLicensingUnavailable(m: ParsedManifest, warnings: string[]): FivemIssue[] {
  const errors: FivemIssue[] = [];
  if (m.licensed) errors.push({ code: "fivem_licensing_unavailable", message: `${m.name} is licensed (licensed true). ${NO_LICENCE_CHECK}` });
  if (m.capabilities.includes("licensing")) {
    errors.push({ code: "fivem_licensing_unavailable", message: `${m.name} requires the licensing capability, which the FiveM shim does not provide. ${NO_LICENCE_CHECK}` });
  }
  if (!m.licensed && m.optionalCapabilities.includes("licensing")) {
    warnings.push("licensing is unavailable on FiveM (the shim has no licence check): ScriptGo.licensing raises capability_unavailable:licensing@fivem there");
  }
  return errors;
}

/** What fxmanifest.lua needs to know about a package's assets (lib/assets.ts). */
export interface FivemAssets {
  /** Asset files the resource carries, resource-relative. */
  files: string[];
  /** `data_file` lines: FiveM type and path (a file, or a folder of asset files). */
  dataFiles: { type: string; path: string }[];
  /** True when a .ymap is streamed: the resource is a map (`this_is_a_map`). */
  map: boolean;
}

/** The asset part of fxmanifest from an asset plan: every carried file and every data_file line. */
export function fivemAssets(m: ParsedManifest, plan: AssetPlan): FivemAssets {
  const dataFiles: { type: string; path: string }[] = [];
  for (const [type, paths] of Object.entries(m.dataFiles)) for (const path of paths) dataFiles.push({ type, path });
  return { files: plan.delivered, dataFiles, map: (plan.report.environments["fivem"]?.needs ?? []).includes("this_is_a_map") };
}

/**
 * The generated fxmanifest.lua. `game` stays gta5: RedM (rdr3) would reuse it but is not built.
 * Assets: files under stream/ are streamed by FXServer on its own; every other asset file is listed
 * in `files`, so players download it, and `data_file` lines name the ones the game loads as data.
 * An asset-only package has no shim and no scripts.
 */
export function fivemManifest(m: ParsedManifest, warnings: string[], assets?: FivemAssets): string {
  const lines: string[] = [
    `-- Generated by \`scriptgo pack --target fivem\` from scriptgo.lua ${m.version}. Edit scriptgo.lua, not this file.`,
    `fx_version "cerulean"`,
    `game "gta5"`,
    "",
    `version ${luaString(m.version)}`,
  ];
  if (m.author) lines.push(`author ${luaString(m.author)}`);
  if (m.description ?? m.title) lines.push(`description ${luaString((m.description ?? m.title)!)}`);
  if (m.repository) lines.push(`repository ${luaString(m.repository)}`);
  // Read back by ScriptGo.resource.hasPermission (FiveM keeps unknown keys as metadata).
  for (const p of m.permissions) lines.push(`scriptgo_permission ${luaString(p)}`);
  if (m.dependencies.length > 0) {
    // FiveM's `dependency` only names a resource that must load first; version ranges are dropped.
    const ranged = m.dependencies.filter((d) => d.range && d.range !== "*");
    if (ranged.length > 0) {
      warnings.push(`FiveM dependencies carry no version: ${ranged.map((d) => `${d.name} ${d.range}`).join(", ")} became plain resource names`);
    }
    lines.push(`dependencies ${luaList(m.dependencies.map((d) => d.name))}`);
  }
  if (assets?.map) lines.push(`this_is_a_map "yes"`);
  const scripts = hasScripts(m);
  if (scripts) {
    lines.push("", `shared_script ${luaString(FIVEM_SHIM_FILE)}`);
    for (const p of m.sharedScripts) lines.push(`shared_script ${luaString(p)}`);
  }
  const envScripts = m.environmentScripts["fivem"] ?? [];
  for (const p of [...m.serverScripts, ...envScripts]) lines.push(`server_script ${luaString(p)}`);
  for (const p of [...m.clientScripts, ...envScripts]) lines.push(`client_script ${luaString(p)}`);
  const assetFiles = (assets?.files ?? []).filter((f) => !f.startsWith("stream/"));
  const files = [...new Set([...m.files, ...m.webFiles, ...(m.webUiPage ? [m.webUiPage] : []), ...assetFiles])];
  if (files.length > 0) lines.push(`files ${luaList(files)}`);
  for (const d of assets?.dataFiles ?? []) lines.push(`data_file ${luaString(d.type)} ${luaString(d.path)}`);
  if (m.webUiPage) lines.push(`ui_page ${luaString(m.webUiPage)}`);
  // Declarative exports: a global function of that name, exported by FiveM itself.
  for (const e of m.exports) lines.push(`export ${luaString(e)}`);
  for (const e of m.serverExports) lines.push(`server_export ${luaString(e)}`);
  for (const env of Object.keys(m.environmentScripts)) {
    if (env !== "fivem") warnings.push(`environment_script "${env}" is not shipped to FiveM`);
  }
  if (m.environments.length > 0 && !m.environments.includes("fivem")) {
    warnings.push("the manifest does not list fivem in environments; the package is untested there");
  }
  return lines.join("\n") + "\n";
}

/**
 * Writes `<parent>/<name>/` as a FiveM resource: the referenced files, the shim and a generated
 * fxmanifest.lua. Refuses a package that needs a licence check (the shim has none) and code FiveM's Lua cannot run, unless
 * `allowUnportable` turns the portability findings into warnings.
 */
export function packForFivem(
  res: LoadedResource,
  parent: string,
  opts: { allowUnportable?: boolean; withoutAssets?: boolean } = {},
): { dest: string; warnings: string[]; errors: FivemIssue[]; assets?: AssetPlan } {
  const warnings: string[] = [];
  if (!res.result.ok) return { dest: "", warnings, errors: res.result.errors };
  const m = res.result.manifest;
  const files = listFiles(res.root);
  const problems = validateResourceFiles(m, files);
  if (problems.length > 0) return { dest: "", warnings, errors: problems };
  if (m.format === "open77") {
    return { dest: "", warnings, errors: [{ code: "fivem_open77_format", message: "an open77.lua resource uses OPEN//77 natives; give it a scriptgo.lua to pack it for FiveM" }] };
  }
  const assets = planAssets(res, "fivem", { withoutAssets: opts.withoutAssets });
  warnings.push(...assets.warnings);
  if (assets.errors.length > 0) return { dest: "", warnings, errors: assets.errors, assets };
  // The licence check is a runtime check in scripts. An asset-only package runs nothing: its
  // licence gate is the download (docs/spec/assets.md), which the shim's limit does not touch.
  const noLicensing = hasScripts(m) ? fivemLicensingUnavailable(m, warnings) : [];
  if (noLicensing.length > 0) return { dest: "", warnings, errors: noLicensing };
  if (!hasScripts(m) && m.licensed) warnings.push("an asset-only package has no runtime licence check on FiveM: the licence gates the download, and every copy is fingerprinted to its buyer");
  const portability = fivemPortability(res.root, m, files);
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
  for (const p of [...m.sharedScripts, ...m.serverScripts, ...m.clientScripts, ...(m.environmentScripts["fivem"] ?? [])]) add(p);
  for (const p of [...m.files, ...m.webFiles]) add(p);
  if (m.webUiPage) add(m.webUiPage);
  copyFiles(res.root, dest, [...new Set([...included, ...assets.delivered])].sort());
  copyFingerprint(assets, dest);
  if (hasScripts(m)) {
    // The shim keeps a capability's section only for a resource that declares it (player match), with
    // the core's module included word for word, as for OPEN//77.
    const shimDir = join(sdkRoot, "adapters", "fivem");
    const declared = new Set([...m.capabilities, ...m.optionalCapabilities]);
    writeFileSync(join(dest, FIVEM_SHIM_FILE), expandIncludes(stripCapabilitySections(readFileSync(join(shimDir, "shim.lua"), "utf8"), declared), shimDir));
  }
  writeFileSync(join(dest, "fxmanifest.lua"), fivemManifest(m, warnings, fivemAssets(m, assets)));
  return { dest, warnings, errors: [], assets };
}

/** `scriptgo pack <dir> --target fivem [--out dist]`: prints warnings and errors, returns the exit code. */
export function packFivemTarget(res: LoadedResource, out: string, allowUnportable: boolean, withoutAssets = false): number {
  const r = packForFivem(res, join(out, "fivem"), { allowUnportable, withoutAssets });
  for (const w of r.warnings) console.log(`warning ${w}`);
  for (const e of r.errors) console.error(`error ${e.code}: ${e.message}`);
  if (r.errors.length > 0) return 1;
  if (r.assets) for (const line of describePlan(r.assets, "fivem")) console.log(line);
  console.log(`packed for FiveM -> ${r.dest}`);
  return 0;
}
