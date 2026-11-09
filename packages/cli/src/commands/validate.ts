// scriptgo validate <dir> [--json]: manifest grammar, OPEN//77 rules and file presence.
import { validateResourceFiles } from "@scriptgo/manifest";
import { parseArgs } from "../lib/args.ts";
import { open77Portability } from "../lib/portability.ts";
import { listFiles, readResource } from "../lib/sdk.ts";

export const summary = "Check a resource: manifest, OPEN//77 rules, referenced files";

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
  const folder = res.root.split(/[\\/]/).pop();
  if (res.result.ok && res.result.manifest.name !== folder) {
    errors.push({ code: "folder_mismatch", message: `Resource '${res.result.manifest.name}' must live in a folder of the same name (found '${folder}').` });
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
    console.log(JSON.stringify({ ok: errors.length === 0, manifest: res.result.ok ? res.result.manifest : null, errors, warnings }, null, 2));
  } else {
    for (const e of errors) console.log(`error   ${e.code}${e.line ? ` (line ${e.line})` : ""}: ${e.message}`);
    for (const w of warnings) console.log(`warning ${w.code}${w.line ? ` (line ${w.line})` : ""}: ${w.message}`);
    if (errors.length === 0) {
      const m = res.result.ok ? res.result.manifest : null;
      console.log(`ok      ${m?.name} ${m?.version} (${res.manifestFile}, ${files.length} files)`);
    }
  }
  return errors.length === 0 ? 0 : 1;
}
