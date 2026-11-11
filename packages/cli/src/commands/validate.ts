// scriptgo validate <dir> [--json]: manifest grammar, OPEN//77 rules, file presence and assets (data
// only, sizes, each environment's delivery rules: docs/spec/assets.md).
import { describeAssetReport, validateResourceFiles, type AssetReport } from "@scriptgo/manifest";
import { inspectResourceAssets } from "../lib/assets.ts";
import { parseArgs } from "../lib/args.ts";
import { open77Portability } from "../lib/portability.ts";
import { listFiles, readResource } from "../lib/sdk.ts";

export const summary = "Check a resource: manifest, OPEN//77 rules, referenced files, assets";

export async function run(args: string[]): Promise<number> {
  const a = parseArgs(args, { booleans: ["json", "help"] });
  if (a.bools.has("help") || a.positional.length === 0) {
    console.log("scriptgo validate <resourceDir> [--json]");
    return a.bools.has("help") ? 0 : 2;
  }
  const res = readResource(a.positional[0]!);
  const files = listFiles(res.root);
  const errors = res.result.ok ? validateResourceFiles(res.result.manifest, files) : res.result.errors;
  const warnings = res.result.warnings;
  if (res.manifestFile === "scriptgo.lua" && files.includes("scriptgo.json")) {
    warnings.push({ code: "manifest_shadowed", message: "Both scriptgo.lua and scriptgo.json exist: hosts read scriptgo.lua and ignore scriptgo.json. Keep one." });
  }
  const folder = res.root.split(/[\\/]/).pop();
  if (res.result.ok && res.result.manifest.name !== folder) {
    errors.push({ code: "folder_mismatch", message: `Resource '${res.result.manifest.name}' must live in a folder of the same name (found '${folder}').` });
  }
  let assets: AssetReport | null = null;
  if (res.result.ok && errors.length === 0) {
    assets = inspectResourceAssets(res);
    errors.push(...assets.errors);
    warnings.push(...assets.warnings);
  }
  if (res.result.ok && errors.length === 0) {
    // A declared environment that lacks a global the scripts use is an error; an unrestricted
    // package (no `environments`) only gets a warning.
    const m = res.result.manifest;
    for (const p of open77Portability(res.root, m, files)) {
      const issue = { code: p.code, message: `${p.file}:${p.line} ${p.message}` };
      if (m.environments.includes("open77")) errors.push(issue);
      else warnings.push(issue);
    }
  }
  if (a.bools.has("json")) {
    const assetSummary = assets && assets.files.length > 0 ? { files: assets.files, totalBytes: assets.totalBytes, environments: assets.environments } : null;
    console.log(JSON.stringify({ ok: errors.length === 0, manifest: res.result.ok ? res.result.manifest : null, errors, warnings, assets: assetSummary }, null, 2));
  } else {
    for (const e of errors) console.log(`error   ${e.code}${e.line ? ` (line ${e.line})` : ""}: ${e.message}`);
    for (const w of warnings) console.log(`warning ${w.code}${w.line ? ` (line ${w.line})` : ""}: ${w.message}`);
    if (assets && assets.files.length > 0) for (const line of describeAssetReport(assets)) console.log(`info    ${line}`);
    if (errors.length === 0) {
      const m = res.result.ok ? res.result.manifest : null;
      console.log(`ok      ${m?.name} ${m?.version} (${res.manifestFile}, ${files.length} files)`);
    }
  }
  return errors.length === 0 ? 0 : 1;
}
