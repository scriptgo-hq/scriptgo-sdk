import { ManifestSyntaxError } from "./lexer.ts";
import { parseDirectives, type RawDirective, type Value } from "./parser.ts";
import { isValidRange, isValidSemver } from "./semver.ts";

export const CAPABILITIES = [
  "events",
  "logging",
  "storage",
  "players",
  "permissions",
  "commands",
  "config",
  "ui",
  "http",
  "licensing",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const KNOWN_ENVIRONMENTS = ["standalone", "love2d", "godot", "luanti", "open77", "openresty", "defold", "neovim", "cctweaked", "dotnet", "garrysmod"] as const;
export const LUA_DIALECTS = ["5.1", "5.2", "5.3", "5.4", "luajit"] as const;
export const CATEGORIES = [
  "inventory",
  "permissions",
  "economy",
  "events",
  "ui",
  "admin",
  "framework",
  "vehicles",
  "housing",
  "quests",
  "library",
  "other",
] as const;

/** OPEN//77 rule: a lowercase slug of letters, digits and underscores, 3 to 64 characters, starting with a letter. */
export const RESOURCE_NAME = /^[a-z][a-z0-9_]{2,63}$/;
/** Environment ids and declarative export names (OPEN//77: `^[a-z0-9][a-z0-9_-]{0,63}$`). */
export const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const EXPORT_NAME = SLUG;
export const MAX_MANIFEST_BYTES = 256 * 1024;
/** Manifest file names, in the order a host looks for them in a resource folder. */
export const MANIFEST_FILES = ["scriptgo.lua", "scriptgo.json", "open77.lua"] as const;
/** Script entries: Lua, or JavaScript / TypeScript (compiled to JavaScript at pack time). */
export const SCRIPT_EXTENSION = /\.(lua|js|ts)$/;

export interface Diagnostic {
  code: string;
  message: string;
  line?: number;
}

export interface Dependency {
  name: string;
  range: string | null;
}

export interface ParsedManifest {
  /** Which manifest file was parsed. */
  format: "scriptgo" | "open77";
  name: string;
  version: string;
  title: string | null;
  description: string | null;
  author: string | null;
  license: string | null;
  repository: string | null;
  category: string;
  scriptgoVersion: string | null;
  open77Version: string | null;
  autoStart: boolean;
  licensed: boolean;
  lua: string[];
  environments: string[];
  capabilities: string[];
  optionalCapabilities: string[];
  sharedScripts: string[];
  serverScripts: string[];
  clientScripts: string[];
  environmentScripts: Record<string, string[]>;
  testScripts: string[];
  dependencies: Dependency[];
  permissions: string[];
  files: string[];
  exports: string[];
  serverExports: string[];
  webUiPage: string | null;
  webFiles: string[];
  /** Directives this parser does not interpret (OPEN//77-only or future). Kept, never fatal. */
  unknown: { directive: string; args: unknown[]; line: number }[];
}

export type ParseResult =
  | { ok: true; manifest: ParsedManifest; warnings: Diagnostic[] }
  | { ok: false; errors: Diagnostic[]; warnings: Diagnostic[] };

type Kind = "string" | "boolean" | "list" | "envlist";

/** Canonical directive -> how to read it. Plural and singular map to the same key. */
const DIRECTIVES: Record<string, { key: string; kind: Kind }> = {};
const def = (names: string[], key: string, kind: Kind): void => {
  for (const n of names) DIRECTIVES[n] = { key, kind };
};
def(["resource"], "resource", "string");
def(["version"], "version", "string");
def(["title"], "title", "string");
def(["description"], "description", "string");
def(["author"], "author", "string");
def(["license"], "license", "string");
def(["repository"], "repository", "string");
def(["category"], "category", "string");
def(["scriptgo_version"], "scriptgo_version", "string");
def(["open77_version"], "open77_version", "string");
def(["web_ui_page"], "web_ui_page", "string");
def(["auto_start"], "auto_start", "boolean");
def(["licensed"], "licensed", "boolean");
def(["shared_script", "shared_scripts"], "shared_scripts", "list");
def(["server_script", "server_scripts"], "server_scripts", "list");
def(["client_script", "client_scripts"], "client_scripts", "list");
def(["test_script", "test_scripts"], "test_scripts", "list");
def(["file", "files"], "files", "list");
def(["web_file", "web_files"], "web_files", "list");
def(["permission", "permissions"], "permissions", "list");
def(["dependency", "dependencies"], "dependencies", "list");
def(["export", "exports"], "exports", "list");
def(["server_export", "server_exports"], "server_exports", "list");
def(["lua"], "lua", "list");
def(["environments"], "environments", "list");
def(["capability", "capabilities"], "capabilities", "list");
def(["optional_capability", "optional_capabilities"], "optional_capabilities", "list");
def(["environment_script", "environment_scripts"], "environment_scripts", "envlist");

function flattenStrings(args: Value[], directive: RawDirective, errors: Diagnostic[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    if (typeof a === "string") out.push(a);
    else if (a !== null && typeof a === "object") {
      if (Object.keys(a.map).length > 0) {
        errors.push({ code: "invalid_value", message: `'${directive.name}' takes a list of strings, not key = value pairs.`, line: directive.line });
      }
      for (const item of a.list) {
        if (typeof item === "string") out.push(item);
        else errors.push({ code: "invalid_value", message: `'${directive.name}' entries must be strings.`, line: directive.line });
      }
    } else {
      errors.push({ code: "invalid_value", message: `'${directive.name}' entries must be strings.`, line: directive.line });
    }
  }
  return out;
}

function toPlain(v: Value): unknown {
  if (v !== null && typeof v === "object") {
    if (Object.keys(v.map).length === 0) return v.list.map(toPlain);
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v.map)) o[k] = toPlain(val);
    if (v.list.length > 0) o["_list"] = v.list.map(toPlain);
    return o;
  }
  return v;
}

/** Returns a reason string when `p` is not a safe resource-relative path. */
export function unsafePathReason(p: string): string | null {
  if (p.length === 0) return "empty path";
  if (p.includes("\\")) return "use '/' as the path separator";
  if (p.startsWith("/")) return "absolute path";
  if (/^[A-Za-z]:/.test(p)) return "drive path";
  if (p.split("/").some((seg) => seg === "..")) return "path escapes the resource";
  if (p.includes("\0")) return "NUL byte";
  return null;
}

/** The guest language a script entry runs in: `.lua` -> "lua", `.js` / `.ts` -> "js". */
export function scriptLanguage(path: string): "lua" | "js" | null {
  if (path.endsWith(".lua")) return "lua";
  if (path.endsWith(".js") || path.endsWith(".ts")) return "js";
  return null;
}

/** Languages of the shared, server, client and environment scripts, sorted and unique. */
export function scriptLanguages(m: ParsedManifest): string[] {
  const out = new Set<string>();
  const paths = [...m.sharedScripts, ...m.serverScripts, ...m.clientScripts, ...Object.values(m.environmentScripts).flat()];
  for (const p of paths) {
    const lang = scriptLanguage(p);
    if (lang) out.add(lang);
  }
  return [...out].sort();
}

function jsonValue(v: unknown): Value {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return { kind: "table", list: v.map(jsonValue), map: {} };
  if (typeof v === "object") {
    const map: Record<string, Value> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) map[k] = jsonValue(x);
    return { kind: "table", list: [], map };
  }
  return v as string | number | boolean;
}

const isScalar = (v: unknown): v is string | number | boolean => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/**
 * `scriptgo.json` as the same directive list the DSL produces: each member is a directive (key =
 * directive name), a scalar is one argument, an array is one list argument, and an object is only
 * accepted for environment_script(s) (one directive per environment). `$schema` is ignored.
 */
function jsonDirectives(source: string, errors: Diagnostic[]): RawDirective[] | Diagnostic {
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch (e) {
    return { code: "invalid_json", message: `scriptgo.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { code: "invalid_json", message: "scriptgo.json must hold one JSON object." };
  }
  const out: RawDirective[] = [];
  // Like a DSL list: scalar items are kept, each nested array, object or null is reported.
  const list = (key: string, items: unknown[]): Value => {
    const values: Value[] = [];
    for (const item of items) {
      if (isScalar(item)) values.push(item);
      else errors.push({ code: "invalid_value", message: `'${key}' entries must be strings, not arrays, objects or null.` });
    }
    return { kind: "table", list: values, map: {} };
  };
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (key === "$schema") continue;
    const spec = DIRECTIVES[key];
    if (!spec) {
      out.push({ name: key, args: [jsonValue(value)], line: 0 });
      continue;
    }
    if (value === null) {
      errors.push({ code: "invalid_value", message: `'${key}' cannot be null.` });
    } else if (Array.isArray(value)) {
      out.push({ name: key, args: [list(key, value)], line: 0 });
    } else if (typeof value === "object") {
      if (spec.kind !== "envlist") {
        errors.push({ code: "invalid_value", message: `'${key}' does not take an object; only environment_scripts maps environments to scripts.` });
        continue;
      }
      for (const [env, paths] of Object.entries(value as Record<string, unknown>)) {
        if (typeof paths === "string") out.push({ name: key, args: [env, paths], line: 0 });
        else if (Array.isArray(paths)) {
          out.push({ name: key, args: [env, list(key, paths)], line: 0 });
        } else {
          errors.push({ code: "invalid_value", message: `'${key}' maps each environment to a script path or a list of paths.` });
        }
      }
    } else {
      out.push({ name: key, args: [value as string | number | boolean], line: 0 });
    }
  }
  return out;
}

function parseDependency(entry: string): Dependency | null {
  const m = /^\s*([a-z0-9][a-z0-9_-]{0,63})\s*(.*)$/.exec(entry);
  if (!m) return null;
  const range = m[2]!.trim();
  return { name: m[1]!, range: range.length > 0 ? range : null };
}

export function parseManifest(source: string, opts: { fileName?: string } = {}): ParseResult {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const format: ParsedManifest["format"] = opts.fileName?.endsWith("open77.lua") ? "open77" : "scriptgo";
  const json = opts.fileName?.endsWith(".json") ?? false;

  if (Buffer.byteLength(source, "utf8") > MAX_MANIFEST_BYTES) {
    return { ok: false, errors: [{ code: "manifest_too_large", message: "The manifest exceeds 256 KiB." }], warnings };
  }

  let directives: RawDirective[];
  if (json) {
    const converted = jsonDirectives(source, errors);
    if (!Array.isArray(converted)) return { ok: false, errors: [converted], warnings };
    directives = converted;
  } else {
    try {
      directives = parseDirectives(source);
    } catch (e) {
      if (e instanceof ManifestSyntaxError) {
        return { ok: false, errors: [{ code: e.code, message: e.message, line: e.line }], warnings };
      }
      throw e;
    }
  }

  const scalars: Record<string, { value: string | boolean; line: number }> = {};
  const lists: Record<string, string[]> = {};
  const envScripts: Record<string, string[]> = {};
  const unknown: ParsedManifest["unknown"] = [];

  for (const d of directives) {
    const spec = DIRECTIVES[d.name];
    if (!spec) {
      unknown.push({ directive: d.name, args: d.args.map(toPlain), line: d.line });
      warnings.push({ code: "unknown_directive", message: `Directive '${d.name}' is not used by SCRIPT//GO and is kept as is.`, line: d.line });
      continue;
    }
    if (spec.kind === "string" || spec.kind === "boolean") {
      if (d.args.length !== 1) {
        errors.push({ code: "invalid_value", message: `'${d.name}' takes exactly one value.`, line: d.line });
        continue;
      }
      const v = d.args[0];
      if (spec.kind === "string" && typeof v !== "string") {
        errors.push({ code: "invalid_value", message: `'${d.name}' must be a string.`, line: d.line });
        continue;
      }
      if (spec.kind === "boolean" && typeof v !== "boolean") {
        errors.push({ code: "invalid_value", message: `'${d.name}' must be true or false.`, line: d.line });
        continue;
      }
      if (scalars[spec.key]) {
        const first = json ? "" : ` (first on line ${scalars[spec.key]!.line})`;
        errors.push({ code: "duplicate_directive", message: `'${d.name}' is declared more than once${first}.`, line: d.line });
        continue;
      }
      scalars[spec.key] = { value: v as string | boolean, line: d.line };
      continue;
    }
    if (spec.kind === "envlist") {
      const [env, ...rest] = d.args;
      if (typeof env !== "string" || rest.length === 0) {
        errors.push({ code: "invalid_value", message: `'${d.name}' needs an environment and at least one script, e.g. ${d.name} "love2d" "env/love2d/hud.lua".`, line: d.line });
        continue;
      }
      (envScripts[env] ??= []).push(...flattenStrings(rest, d, errors));
      continue;
    }
    (lists[spec.key] ??= []).push(...flattenStrings(d.args, d, errors));
  }

  const str = (key: string): string | null => {
    const v = scalars[key]?.value;
    return typeof v === "string" ? v : null;
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const v = scalars[key]?.value;
    return typeof v === "boolean" ? v : fallback;
  };
  const list = (key: string): string[] => lists[key] ?? [];
  const lineOf = (key: string): number | undefined => scalars[key]?.line;

  const name = str("resource");
  if (name === null) errors.push({ code: "missing_directive", message: "Directive 'resource' is required." });
  else if (!RESOURCE_NAME.test(name)) {
    errors.push({ code: "invalid_resource_name", message: "Resource name must be 3 to 64 lowercase letters, digits or '_', starting with a letter (the OPEN//77 rule).", line: lineOf("resource") });
  }

  const version = str("version");
  if (version === null) errors.push({ code: "missing_directive", message: "Directive 'version' is required." });
  else if (!isValidSemver(version)) errors.push({ code: "invalid_version", message: `Version '${version}' is not valid semantic versioning (e.g. 1.4.0).`, line: lineOf("version") });

  for (const key of ["scriptgo_version", "open77_version"]) {
    const r = str(key);
    if (r !== null && !isValidRange(r)) errors.push({ code: "invalid_range", message: `'${key}' range '${r}' is not valid (e.g. ">=0.1.0").`, line: lineOf(key) });
  }

  const scriptKeys = ["shared_scripts", "server_scripts", "client_scripts", "test_scripts"];
  const checkScript = (p: string, where: string): void => {
    if (p.startsWith("@")) {
      errors.push({ code: "cross_resource_include", message: `'${p}' in ${where}: cross-resource includes are refused. Share code through dependencies and exports.` });
      return;
    }
    const reason = unsafePathReason(p);
    if (reason) errors.push({ code: "unsafe_path", message: `'${p}' in ${where}: ${reason}.` });
    else if (where === "test_scripts" && !p.endsWith(".lua")) errors.push({ code: "unsupported_script", message: `'${p}' in ${where}: test scripts must be .lua files.` });
    else if (!SCRIPT_EXTENSION.test(p)) errors.push({ code: "unsupported_script", message: `'${p}' in ${where}: script entries must be .lua, .js or .ts files.` });
  };
  for (const key of scriptKeys) for (const p of list(key)) checkScript(p, key);
  for (const [env, paths] of Object.entries(envScripts)) {
    if (!SLUG.test(env)) errors.push({ code: "invalid_environment", message: `Environment '${env}' in environment_script is not a valid slug.` });
    for (const p of paths) checkScript(p, `environment_script "${env}"`);
  }
  for (const key of ["files", "web_files"]) {
    for (const p of list(key)) {
      const reason = unsafePathReason(p);
      if (reason) errors.push({ code: "unsafe_path", message: `'${p}' in ${key}: ${reason}.` });
    }
  }
  const webUiPage = str("web_ui_page");
  if (webUiPage !== null) {
    const reason = unsafePathReason(webUiPage);
    if (reason) errors.push({ code: "unsafe_path", message: `'${webUiPage}' in web_ui_page: ${reason}.`, line: lineOf("web_ui_page") });
  }

  // Declarative exports name global functions, as in OPEN//77 (manifest_export_missing at start).
  for (const key of ["exports", "server_exports"]) {
    for (const e of list(key)) {
      if (!EXPORT_NAME.test(e)) errors.push({ code: "invalid_export_name", message: `'${e}' in ${key}: export names are ^[a-z0-9][a-z0-9_-]{0,63}$.` });
    }
  }

  const dependencies: Dependency[] = [];
  for (const entry of list("dependencies")) {
    const dep = parseDependency(entry);
    if (!dep) errors.push({ code: "invalid_dependency", message: `Dependency '${entry}' must look like "name" or "name >=1.0.0".` });
    else if (dep.range !== null && !isValidRange(dep.range)) errors.push({ code: "invalid_dependency", message: `Dependency '${entry}' has an invalid version range.` });
    else dependencies.push(dep);
  }

  for (const d of list("lua")) {
    if (!(LUA_DIALECTS as readonly string[]).includes(d)) errors.push({ code: "invalid_lua_dialect", message: `Lua dialect '${d}' is unknown. Use ${LUA_DIALECTS.map((x) => `"${x}"`).join(", ")}.` });
  }
  for (const e of list("environments")) {
    if (!SLUG.test(e)) errors.push({ code: "invalid_environment", message: `Environment '${e}' is not a valid slug.` });
    else if (!(KNOWN_ENVIRONMENTS as readonly string[]).includes(e)) warnings.push({ code: "unknown_environment", message: `Environment '${e}' is not a SCRIPT//GO environment yet; it will show as not tested.` });
  }
  const capOk = (c: string): boolean => (CAPABILITIES as readonly string[]).includes(c) || /^x-[a-z0-9-]+$/.test(c);
  for (const c of [...list("capabilities"), ...list("optional_capabilities")]) {
    if (!capOk(c)) errors.push({ code: "unknown_capability", message: `Capability '${c}' is unknown. Use one of ${CAPABILITIES.join(", ")} or an 'x-' extension.` });
  }
  const category = str("category") ?? "other";
  if (!(CATEGORIES as readonly string[]).includes(category)) {
    warnings.push({ code: "unknown_category", message: `Category '${category}' is unknown and will be shown as 'other'.`, line: lineOf("category") });
  }
  const license = str("license");
  if (license !== null && !/^[A-Za-z0-9.+-]+(\s+(AND|OR|WITH)\s+[A-Za-z0-9.+-]+)*$/.test(license)) {
    warnings.push({ code: "license_not_spdx", message: `License '${license}' does not look like an SPDX expression.`, line: lineOf("license") });
  }
  if (format === "scriptgo" && str("scriptgo_version") === null) {
    warnings.push({ code: "missing_scriptgo_version", message: "Declare scriptgo_version (e.g. \">=0.1.0\") so hosts can check compatibility." });
  }
  const hasCode = scriptKeys.slice(0, 3).some((k) => list(k).length > 0) || Object.keys(envScripts).length > 0;
  if (!hasCode && list("files").length === 0) errors.push({ code: "empty_resource", message: "The resource declares no scripts and no files." });

  // scriptgo.json has no line numbers to report.
  if (json) for (const d of [...errors, ...warnings]) delete d.line;
  if (errors.length > 0) return { ok: false, errors, warnings };

  const manifest: ParsedManifest = {
    format,
    name: name!,
    version: version!,
    title: str("title"),
    description: str("description"),
    author: str("author"),
    license,
    repository: str("repository"),
    category: (CATEGORIES as readonly string[]).includes(category) ? category : "other",
    scriptgoVersion: str("scriptgo_version"),
    open77Version: str("open77_version"),
    autoStart: bool("auto_start", true),
    licensed: bool("licensed", false),
    lua: list("lua"),
    environments: list("environments"),
    capabilities: list("capabilities"),
    optionalCapabilities: list("optional_capabilities"),
    sharedScripts: list("shared_scripts"),
    serverScripts: list("server_scripts"),
    clientScripts: list("client_scripts"),
    environmentScripts: envScripts,
    testScripts: list("test_scripts"),
    dependencies,
    permissions: list("permissions"),
    files: list("files"),
    exports: list("exports"),
    serverExports: list("server_exports"),
    webUiPage,
    webFiles: list("web_files"),
    unknown,
  };
  return { ok: true, manifest, warnings };
}
