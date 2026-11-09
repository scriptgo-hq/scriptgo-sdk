// Builds the distributable Rust (Oxide/Carbon) plugin: dist/rust/ mirrors a dedicated server's root, so
// a server owner copies its content over the server folder.
//
//   node sdk/adapters/rust/build.mjs [--out <dir>] [--with <resourceDir>]... [--dotnet <path>]
//
//   RustDedicated_Data/Managed/ScriptGo.Bridge.dll, KeraLua.dll   managed side ("// Reference: ScriptGo.Bridge")
//   RustDedicated_Data/Plugins/x86_64/lua54.dll, liblua54.so      native Lua 5.4 (KeraLua's builds)
//   oxide/plugins/ScriptGo.cs, carbon/plugins/ScriptGo.cs         the plugin (keep the one for your framework)
//   oxide|carbon/data/ScriptGo/resources/<name>/                  resources given with --with
//   THIRD-PARTY-NOTICES.txt                                       KeraLua and Lua licences
//
// The bridge is built with the .NET SDK (dotnet build); see README.md for how dotnet is found.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
export const bridgeProject = join(here, "bridge", "ScriptGo.Bridge.csproj");
export const bridgeOutput = join(here, "bridge", "bin", "Release", "netstandard2.0");
export const pluginSource = join(here, "plugin", "ScriptGo.cs");

const LUA_LICENSE = `Lua 5.4.8 (built into KeraLua's native lua54 libraries)
Copyright (C) 1994-2025 Lua.org, PUC-Rio.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.
`;

/** The dotnet executable: --dotnet, SCRIPTGO_DOTNET, DOTNET_ROOT, PATH, then the usual install folders. */
export function findDotnet(explicit) {
  const exe = process.platform === "win32" ? "dotnet.exe" : "dotnet";
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.SCRIPTGO_DOTNET) candidates.push(process.env.SCRIPTGO_DOTNET);
  if (process.env.DOTNET_ROOT) candidates.push(join(process.env.DOTNET_ROOT, exe));
  for (const dir of (process.env.PATH ?? "").split(delimiter)) if (dir) candidates.push(join(dir, exe));
  if (process.platform === "win32") {
    for (const v of ["ProgramFiles", "ProgramW6432"]) if (process.env[v]) candidates.push(join(process.env[v], "dotnet", exe));
  } else {
    candidates.push("/usr/share/dotnet/dotnet", "/usr/lib/dotnet/dotnet", "/usr/local/share/dotnet/dotnet");
    if (process.env.HOME) candidates.push(join(process.env.HOME, ".dotnet", "dotnet"));
  }
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error("dotnet not found: install the .NET SDK, or pass --dotnet <path> / set SCRIPTGO_DOTNET");
  return found;
}

/** Builds ScriptGo.Bridge (Release) and returns its output folder. */
export function buildBridge(dotnet) {
  const r = spawnSync(dotnet, ["build", bridgeProject, "-c", "Release", "-nologo", "-v", "q"], {
    stdio: "inherit",
    env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" },
  });
  if (r.status !== 0) throw new Error(`dotnet build failed (${r.status ?? r.error?.message})`);
  return bridgeOutput;
}

/** KeraLua's package folder, from the restore's project.assets.json. */
export function keraLuaPackage() {
  const assets = JSON.parse(readFileSync(join(here, "bridge", "obj", "project.assets.json"), "utf8"));
  const key = Object.keys(assets.libraries).find((k) => k.toLowerCase().startsWith("keralua/"));
  if (!key) throw new Error("KeraLua is not in the bridge's restore output");
  for (const folder of Object.keys(assets.packageFolders)) {
    const dir = join(folder, assets.libraries[key].path);
    if (existsSync(dir)) return { dir, version: key.split("/")[1] };
  }
  throw new Error(`KeraLua ${key} not found in the NuGet package folders`);
}

export function buildPlugin(outDir, { withResources = [], dotnet } = {}) {
  const dest = resolve(outDir);
  const bridge = buildBridge(findDotnet(dotnet));
  const kera = keraLuaPackage();
  if (existsSync(dest)) rmSync(dest, { recursive: true });

  const managed = join(dest, "RustDedicated_Data", "Managed");
  const natives = join(dest, "RustDedicated_Data", "Plugins", "x86_64");
  mkdirSync(managed, { recursive: true });
  mkdirSync(natives, { recursive: true });
  cpSync(join(bridge, "ScriptGo.Bridge.dll"), join(managed, "ScriptGo.Bridge.dll"));
  cpSync(join(kera.dir, "lib", "netstandard2.0", "KeraLua.dll"), join(managed, "KeraLua.dll"));
  cpSync(join(kera.dir, "runtimes", "win-x64", "native", "lua54.dll"), join(natives, "lua54.dll"));
  cpSync(join(kera.dir, "runtimes", "linux-x64", "native", "liblua54.so"), join(natives, "liblua54.so"));

  for (const framework of ["oxide", "carbon"]) {
    mkdirSync(join(dest, framework, "plugins"), { recursive: true });
    cpSync(pluginSource, join(dest, framework, "plugins", "ScriptGo.cs"));
    for (const r of withResources) {
      cpSync(resolve(r), join(dest, framework, "data", "ScriptGo", "resources", basename(resolve(r))), {
        recursive: true,
        filter: (src) => !/[\\/](node_modules|\.[^\\/]+)$/.test(src),
      });
    }
  }

  const keraLicense = existsSync(join(kera.dir, "LICENSE")) ? readFileSync(join(kera.dir, "LICENSE"), "utf8") : "MIT";
  writeFileSync(
    join(dest, "THIRD-PARTY-NOTICES.txt"),
    `SCRIPT//GO for Rust redistributes KeraLua ${kera.version} (KeraLua.dll, lua54.dll, liblua54.so).\n\n` +
      `KeraLua\n${keraLicense.trim()}\n\n${LUA_LICENSE}`,
  );
  return dest;
}

/** Every file of a built dist folder, relative with '/'. */
export function listDist(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, "");
  return out.sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let out = join(repo, "dist", "rust");
  let dotnet;
  const withRes = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") out = args[++i];
    else if (args[i] === "--with") withRes.push(args[++i]);
    else if (args[i] === "--dotnet") dotnet = args[++i];
  }
  const dest = buildPlugin(out, { withResources: withRes, dotnet });
  console.log(`built ${dest}`);
  for (const f of listDist(dest)) if (!f.includes("/resources/")) console.log(`  ${f}`);
}
