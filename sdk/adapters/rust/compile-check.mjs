// Compiles plugin/ScriptGo.cs the way a server would, against a Rust server's managed assemblies plus
// Oxide's or Carbon's, with Roslyn from the .NET SDK, -nostdlib and C# 7.3. A compile check only: it
// proves the plugin matches the framework's API, not that it runs (that needs a real server).
//
//   node sdk/adapters/rust/compile-check.mjs --framework oxide  --managed <RustDedicated_Data/Managed> --oxide <Oxide.Rust zip root>
//   node sdk/adapters/rust/compile-check.mjs --framework carbon --managed <RustDedicated_Data/Managed> --carbon <Carbon zip root>
//   [--dotnet <path>] [--bridge <ScriptGo.Bridge.dll>] [--langversion 7.3]
//
// Oxide: the Managed folder overlaid with the Oxide.Rust release's RustDedicated_Data/Managed (its
// patched Assembly-CSharp and Oxide.*.dll), as an installed Oxide server has it.
// Carbon: the Managed folder plus carbon/managed/*.dll and carbon/managed/lib/*.dll, after Carbon.targets.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readSync, closeSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bridgeOutput, buildBridge, findDotnet, keraLuaPackage, pluginSource } from "./build.mjs";

/** True when a file is a .NET assembly (a PE with a CLI header), false for native DLLs. */
export function isManagedAssembly(file) {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(4096);
    const n = readSync(fd, head, 0, head.length, 0);
    if (n < 0x40 || head.readUInt16LE(0) !== 0x5a4d) return false;
    const pe = head.readUInt32LE(0x3c);
    if (pe + 0x18 + 0x70 + 15 * 8 > n || head.readUInt32LE(pe) !== 0x4550) return false;
    const opt = pe + 0x18;
    const magic = head.readUInt16LE(opt);
    const dirs = opt + (magic === 0x20b ? 112 : 96);
    return head.readUInt32LE(dirs + 14 * 8) !== 0 && head.readUInt32LE(dirs + 14 * 8 + 4) !== 0;
  } finally {
    closeSync(fd);
  }
}

function dlls(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".dll"))
    .map((f) => join(dir, f))
    .filter(isManagedAssembly);
}

/** The reference set: file name -> path, later folders overriding earlier ones. */
export function referenceSet(framework, { managed, oxide, carbon }) {
  const refs = new Map();
  const add = (files) => { for (const f of files) refs.set(basename(f).toLowerCase(), f); };
  add(dlls(managed));
  if (framework === "oxide") {
    if (!oxide) throw new Error("--oxide <Oxide.Rust release root> is required");
    add(dlls(join(oxide, "RustDedicated_Data", "Managed")));
    // Oxide.References carries Oxide's own Newtonsoft.Json; plugins compile against it (it is what
    // Oxide's config and data-file serializer reads attributes from), not Rust's Newtonsoft.Json.dll.
    if (refs.has("oxide.references.dll")) refs.delete("newtonsoft.json.dll");
  } else if (framework === "carbon") {
    if (!carbon) throw new Error("--carbon <Carbon release root> is required");
    add(dlls(join(carbon, "carbon", "managed")));
    add(dlls(join(carbon, "carbon", "managed", "lib")));
  } else {
    throw new Error(`unknown framework ${framework}`);
  }
  return refs;
}

/** The newest SDK's csc.dll. */
export function findCsc(dotnet) {
  const sdkDir = join(dirname(dotnet), "sdk");
  const versions = existsSync(sdkDir) ? readdirSync(sdkDir).filter((v) => /^\d+\.\d+\.\d+/.test(v)) : [];
  versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const v of versions) {
    const csc = join(sdkDir, v, "Roslyn", "bincore", "csc.dll");
    if (existsSync(csc)) return { csc, sdk: v };
  }
  throw new Error(`no Roslyn csc.dll under ${sdkDir}`);
}

export function compileCheck({ framework, managed, oxide, carbon, dotnet, bridge, langVersion = "7.3" }) {
  const dn = findDotnet(dotnet);
  const bridgeDll = bridge ?? join(existsSync(join(bridgeOutput, "ScriptGo.Bridge.dll")) ? bridgeOutput : buildBridge(dn), "ScriptGo.Bridge.dll");
  const refs = referenceSet(framework, { managed, oxide, carbon });
  if (!refs.has("assembly-csharp.dll")) throw new Error(`Assembly-CSharp.dll not found under ${managed}`);
  refs.set("scriptgo.bridge.dll", bridgeDll);
  // KeraLua is a transitive reference: the server loads it next to the bridge; the compiler needs its metadata.
  refs.set("keralua.dll", join(keraLuaPackage().dir, "lib", "netstandard2.0", "KeraLua.dll"));
  const { csc, sdk } = findCsc(dn);
  const work = mkdtempSync(join(tmpdir(), "scriptgo-rust-csc-"));
  try {
    const rsp = [
      "-nostdlib+", "-nologo", "-target:library", `-langversion:${langVersion}`, "-warn:4",
      "-nowarn:1701,1702,0169,0414,0649",
      `-out:${join(work, "ScriptGo.Plugin.dll")}`,
      ...[...refs.values()].map((r) => `-r:"${r}"`),
      `"${pluginSource}"`,
    ];
    writeFileSync(join(work, "csc.rsp"), rsp.join("\n"));
    const r = spawnSync(dn, ["exec", csc, "-noconfig", `@${join(work, "csc.rsp")}`], { encoding: "utf8" });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    return { ok: r.status === 0, status: r.status, output, references: refs.size, sdk, framework };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    if (k === "--framework") opts.framework = args[++i];
    else if (k === "--managed") opts.managed = args[++i];
    else if (k === "--oxide") opts.oxide = args[++i];
    else if (k === "--carbon") opts.carbon = args[++i];
    else if (k === "--dotnet") opts.dotnet = args[++i];
    else if (k === "--bridge") opts.bridge = args[++i];
    else if (k === "--langversion") opts.langVersion = args[++i];
  }
  if (!opts.framework || !opts.managed) {
    console.error("usage: compile-check.mjs --framework oxide|carbon --managed <dir> (--oxide <dir> | --carbon <dir>)");
    process.exit(2);
  }
  const result = compileCheck(opts);
  if (result.output) console.log(result.output);
  console.log(`compile-check ${result.framework}: ${result.ok ? "OK" : "FAILED"} (${result.references} references, C# ${opts.langVersion ?? "7.3"}, Roslyn from SDK ${result.sdk})`);
  process.exit(result.ok ? 0 : 1);
}
