// Locating the Lua SDK, the interpreters and a resource on disk, for the commands that run Lua.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest, type ParseResult } from "@scriptgo/manifest";

/** Repository root (the CLI runs from the monorepo; a published CLI would bundle `sdk/`). */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const sdkRoot = join(repoRoot, "sdk");
export const standaloneMain = join(sdkRoot, "adapters", "standalone", "main.lua");

export interface Interpreter {
  name: string;
  path: string;
}

/** Interpreters built by tools/build-lua.ps1, then the ones on the PATH. */
export function findInterpreters(): Interpreter[] {
  const exe = process.platform === "win32" ? ".exe" : "";
  const bin = join(repoRoot, "tools", "runtimes", "bin");
  const found: Interpreter[] = [];
  for (const name of ["lua54", "lua51", "luajit"]) {
    const p = join(bin, name + exe);
    if (existsSync(p)) found.push({ name, path: p });
  }
  if (found.length > 0) return found;
  for (const name of ["luajit", "lua5.4", "lua54", "lua5.1", "lua"]) {
    const probe = spawnSync(name, ["-v"], { encoding: "utf8" });
    if (probe.status === 0 || /Lua/.test((probe.stdout ?? "") + (probe.stderr ?? ""))) found.push({ name, path: name });
  }
  return found;
}

export function pickInterpreters(choice: string | undefined): Interpreter[] {
  const all = findInterpreters();
  if (all.length === 0) {
    throw new Error("no Lua interpreter found: build them with `pwsh -File tools/build-lua.ps1` or put lua/luajit on the PATH");
  }
  if (!choice || choice === "all") return all;
  if (existsSync(choice)) return [{ name: "custom", path: choice }];
  const picked = all.filter((i) => i.name === choice);
  if (picked.length === 0) throw new Error(`interpreter '${choice}' not found (have: ${all.map((i) => i.name).join(", ")})`);
  return picked;
}

export interface LoadedResource {
  root: string;
  manifestFile: string;
  source: string;
  result: ParseResult;
}

export function readResource(dir: string): LoadedResource {
  const root = resolve(dir);
  for (const file of ["scriptgo.lua", "open77.lua"]) {
    const p = join(root, file);
    if (existsSync(p)) {
      const source = readFileSync(p, "utf8");
      return { root, manifestFile: file, source, result: parseManifest(source, { fileName: file }) };
    }
  }
  throw new Error(`no scriptgo.lua or open77.lua in ${root}`);
}

/** Every file under a folder, relative with forward slashes (skips node_modules and dot folders). */
export function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

/** Default dependency search paths: the official packages and the examples. */
export function defaultSearchPaths(): string[] {
  return [join(sdkRoot, "packages"), join(repoRoot, "examples", "packages")].filter((p) => existsSync(p));
}
