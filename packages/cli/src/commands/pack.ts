// scriptgo pack <dir> --target scriptgo|open77 [--out dist]
//
//   scriptgo  a .zip of the resource for `scriptgo publish` (manifest + every referenced file)
//   open77    a folder OPEN//77 loads as is: a generated open77.lua that loads the ScriptGo shim
//             (sdk/adapters/open77/shim*.lua) before the resource's scripts, and the referenced files.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { zipSync } from "fflate";
import { expandGlob, parseManifest, validateResourceFiles, type ParsedManifest } from "@scriptgo/manifest";
import { parseArgs } from "../lib/args.ts";
import { open77Portability } from "../lib/portability.ts";
import { packFivemTarget } from "../lib/fivem-pack.ts";
import { listFiles, readResource, sdkRoot, type LoadedResource } from "../lib/sdk.ts";

export const summary = "Package a resource: a publishable .zip, or an OPEN//77 resource folder";

// The shim is three files so the shared part references no server-only native: OPEN//77's
// validator flags those in a shared_script, and its client sandbox lacks `os` and `setmetatable`.
const SHIM = [
  { from: "shim.lua", to: "scriptgo_shim.lua", directive: "shared_script" },
  { from: "shim_server.lua", to: "scriptgo_shim_server.lua", directive: "server_script" },
  { from: "shim_client.lua", to: "scriptgo_shim_client.lua", directive: "client_script" },
] as const;

/**
 * Keeps a shim's `-- @capability <name>` ... `-- @end` sections only for the capabilities the
 * manifest asks for, so the packed resource neither references nor needs permissions for natives
 * it never uses (OPEN//77's validator checks permissions against every native a file names).
 */
export function stripCapabilitySections(text: string, caps: Set<string>): string {
  const out: string[] = [];
  let keep = true;
  let open: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const start = /^--\s*@capability\s+([a-z_]+)\s*$/.exec(line);
    if (start) {
      if (open) throw new Error(`shim: @capability ${start[1]} opened inside @capability ${open}`);
      open = start[1]!;
      keep = caps.has(open);
      continue;
    }
    if (/^--\s*@end\s*$/.test(line)) {
      if (!open) throw new Error("shim: @end without @capability");
      open = null;
      keep = true;
      continue;
    }
    if (keep) out.push(line);
  }
  if (open) throw new Error(`shim: @capability ${open} is never closed`);
  return out.join("\n");
}

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
 * files plus test scripts and documents. Deterministic (fixed timestamps), so the same sources
 * always give the same bytes and SHA-256.
 */
export function scriptgoArchive(m: ParsedManifest, all: string[], root: string, manifestFile: string): { zip: Uint8Array; files: string[] } {
  const included = new Set(referencedFiles(m, all, manifestFile));
  for (const t of m.testScripts) for (const f of expandGlob(t, all)) included.add(f);
  for (const d of DOC_FILES) if (all.includes(d)) included.add(d);
  const files = [...included].sort();
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) entries[`${m.name}/${f}`] = readFileSync(join(root, f));
  const zip = zipSync(entries, { level: 9, mtime: new Date("2026-01-01T00:00:00Z") });
  return { zip, files };
}

const quote = (s: string): string => JSON.stringify(s);
const list = (items: string[]): string => `{ ${items.map(quote).join(", ")} }`;

/**
 * Turns a SCRIPT//GO range into OPEN//77 dependency constraints (comparators against 1-3 part
 * numbers). `^` and `~` become two comparators; `||` cannot be expressed and is dropped.
 */
export function toOpen77Constraint(range: string | null): { constraint: string | null; warning?: string } {
  if (!range || range === "*") return { constraint: null };
  if (range.includes("||")) return { constraint: null, warning: `range '${range}' uses ||, which OPEN//77 cannot express; dropped` };
  const out: string[] = [];
  for (const token of range.replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1").split(/\s+/).filter(Boolean)) {
    const m = /^(>=|<=|>|<|==?|\^|~)?v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(token);
    if (!m) return { constraint: null, warning: `range '${range}' is not expressible in OPEN//77; dropped` };
    const [, op = "", maj, min, pat] = m;
    const n = (v: string | undefined): number | null => (v === undefined || v === "x" || v === "*" ? null : Number(v));
    const M = Number(maj), mi = n(min), p = n(pat);
    const ver = [M, mi ?? 0, p ?? 0].join(".");
    if (op === "^") {
      const upper = M > 0 || mi === null ? `${M + 1}.0.0` : mi > 0 || p === null ? `0.${mi + 1}.0` : `0.0.${(p ?? 0) + 1}`;
      out.push(`>=${ver}`, `<${upper}`);
    } else if (op === "~") {
      out.push(`>=${ver}`, `<${mi === null ? `${M + 1}.0.0` : `${M}.${mi + 1}.0`}`);
    } else {
      out.push(`${op === "==" ? "=" : op || "="}${ver}`);
    }
  }
  return { constraint: out.join(" ") };
}

export function open77Manifest(m: ParsedManifest, warnings: string[]): string {
  const lines: string[] = [
    `-- Generated by \`scriptgo pack --target open77\` from scriptgo.lua ${m.version}. Edit scriptgo.lua, not this file.`,
    `resource ${quote(m.name)}`,
    `version ${quote(m.version)}`,
    `open77_version ${quote(m.open77Version ?? "*")}`,
    `auto_start ${m.autoStart ? "true" : "false"}`,
  ];
  const permissions = new Set(m.permissions);
  const caps = new Set([...m.capabilities, ...m.optionalCapabilities]);
  // The shim reads the server ACL for ScriptGo.permissions and sends notifications over the network.
  if (caps.has("permissions")) permissions.add("acl.read");
  if (caps.has("ui")) permissions.add("network.events");
  // ScriptGo.http and ScriptGo.licensing go through Open77.http.request (server side).
  if (caps.has("http") || caps.has("licensing")) permissions.add("http.request");
  if (permissions.size > 0) lines.push(`permissions ${list([...permissions].sort())}`);
  for (const dep of m.dependencies) {
    const { constraint, warning } = toOpen77Constraint(dep.range);
    if (warning) warnings.push(`dependency ${dep.name}: ${warning}`);
    lines.push(`dependency ${quote(constraint ? `${dep.name} ${constraint}` : dep.name)}`);
  }
  // OPEN//77 loads scripts in manifest order, so the shim comes before every script of the resource.
  lines.push("");
  for (const s of SHIM) lines.push(`${s.directive} ${quote(s.to)}`);
  for (const p of m.sharedScripts) lines.push(`shared_script ${quote(p)}`);
  for (const p of m.environmentScripts["open77"] ?? []) lines.push(`shared_script ${quote(p)}`);
  for (const p of m.serverScripts) lines.push(`server_script ${quote(p)}`);
  for (const p of m.clientScripts) lines.push(`client_script ${quote(p)}`);
  if (m.files.length > 0) lines.push(`files ${list(m.files)}`);
  if (m.webFiles.length > 0) lines.push(`web_files ${list(m.webFiles)}`);
  if (m.exports.length > 0) lines.push(`exports ${list(m.exports)}`);
  if (m.serverExports.length > 0) lines.push(`server_exports ${list(m.serverExports)}`);
  if (m.webUiPage) warnings.push("web_ui_page has no OPEN//77 equivalent; use web_files and WebUI.Page");
  for (const env of Object.keys(m.environmentScripts)) {
    if (env !== "open77") warnings.push(`environment_script "${env}" is not shipped to OPEN//77`);
  }
  if (!m.environments.includes("open77") && m.environments.length > 0) {
    warnings.push("the manifest does not list open77 in environments; the package is untested there");
  }
  if (caps.has("http") || caps.has("licensing")) {
    warnings.push(
      "outbound HTTP is off on an OPEN//77 server until the operator sets server.jsonc http.enabled and lists every host the resource calls in http.allowedHosts" +
        (caps.has("licensing") ? " (licensing calls the SCRIPT//GO API at the scriptgo_api convar, default http://localhost:4100)" : ""),
    );
  }
  return lines.join("\n") + "\n";
}

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
  opts: { allowUnportable?: boolean } = {},
): { dest: string; warnings: string[]; errors: PackIssue[] } {
  const warnings: string[] = [];
  if (!res.result.ok) return { dest: "", warnings, errors: res.result.errors };
  const m = res.result.manifest;
  const files = listFiles(res.root);
  const problems = validateResourceFiles(m, files);
  if (problems.length > 0) return { dest: "", warnings, errors: problems };
  const dest = join(parent, m.name);
  const included = referencedFiles(m, files, res.manifestFile);
  if (existsSync(dest)) rmSync(dest, { recursive: true });
  mkdirSync(dest, { recursive: true });

  if (m.format === "open77") {
    for (const f of included) {
      mkdirSync(dirname(join(dest, f)), { recursive: true });
      copyFileSync(join(res.root, f), join(dest, f));
    }
    return { dest, warnings, errors: [] };
  }

  // Every SCRIPT//GO capability has an OPEN//77 mapping (players, permissions, config, http and
  // licensing on the server side only, as on every host). What can still break is the code itself.
  const portability = open77Portability(res.root, m, files);
  if (portability.length > 0 && !opts.allowUnportable) {
    rmSync(dest, { recursive: true });
    return { dest: "", warnings, errors: portability.map((p) => ({ code: p.code, message: `${p.file}:${p.line} ${p.message}` })) };
  }
  for (const p of portability) warnings.push(`${p.file}:${p.line} ${p.message}`);

  for (const f of included) {
    if (f === res.manifestFile) continue;
    mkdirSync(dirname(join(dest, f)), { recursive: true });
    copyFileSync(join(res.root, f), join(dest, f));
  }
  const caps = new Set([...m.capabilities, ...m.optionalCapabilities]);
  for (const s of SHIM) {
    const text = readFileSync(join(sdkRoot, "adapters", "open77", s.from), "utf8");
    writeFileSync(join(dest, s.to), stripCapabilitySections(text, caps));
  }
  const manifestText = open77Manifest(m, warnings);
  writeFileSync(join(dest, "open77.lua"), manifestText);
  // Re-check the generated resource with the same parser OPEN//77 rules are encoded in.
  const check = parseManifest(manifestText, { fileName: "open77.lua" });
  const errors = check.ok ? validateResourceFiles(check.manifest, listFiles(dest)) : check.errors;
  return { dest, warnings, errors };
}

export async function run(args: string[]): Promise<number> {
  const a = parseArgs(args, { booleans: ["help", "allow-unportable"] });
  if (a.bools.has("help") || a.positional.length === 0) {
    console.log("scriptgo pack <resourceDir> [--target scriptgo|open77] [--out dist] [--allow-unportable]");
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
  if (target === "scriptgo") {
    // Same archive as `scriptgo publish` uploads, so a zip uploaded on the website gets the same page.
    const { zip, files: packed } = scriptgoArchive(m, files, res.root, res.manifestFile);
    mkdirSync(out, { recursive: true });
    const file = join(out, `${m.name}-${m.version}.zip`);
    writeFileSync(file, zip);
    console.log(`packed ${packed.length} files -> ${file} (${zip.byteLength} bytes)`);
    return 0;
  }

  if (target === "open77") {
    const r = packForOpen77(res, join(out, "open77"), { allowUnportable: a.bools.has("allow-unportable") });
    for (const w of r.warnings) console.log(`warning ${w}`);
    for (const e of r.errors) console.error(`error ${e.code}: ${e.message}`);
    if (r.errors.length > 0) return 1;
    console.log(`packed for OPEN//77 -> ${r.dest}`);
    return 0;
  }

  if (target === "fivem") return packFivemTarget(res, out, a.bools.has("allow-unportable")); // lib/fivem-pack.ts
  console.error(`unknown target '${target}' (scriptgo, open77)`);
  return 2;
}
