import type { Diagnostic, ParsedManifest } from "./manifest.ts";

/**
 * Converts a manifest glob to a RegExp with OPEN//77 semantics: `*` and `?` stay inside one path
 * segment; `**` crosses segments, but `a/**` followed by `/b` needs at least one intermediate
 * directory, exactly as the OPEN//77 resource loader does.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:[^/]+/)+";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export function expandGlob(pattern: string, files: string[]): string[] {
  if (!/[*?]/.test(pattern)) return files.includes(pattern) ? [pattern] : [];
  const re = globToRegExp(pattern);
  return files.filter((f) => re.test(f)).sort();
}

/** Checks that every path the manifest references exists in the archive or folder listing. */
export function validateResourceFiles(manifest: ParsedManifest, filePaths: string[]): Diagnostic[] {
  const files = filePaths.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, ""));
  const set = new Set(files);
  const out: Diagnostic[] = [];
  const need = (p: string, where: string): void => {
    if (!set.has(p)) out.push({ code: "missing_file", message: `${where} '${p}' does not exist in the resource.` });
  };
  for (const p of manifest.sharedScripts) need(p, "shared_script");
  for (const p of manifest.serverScripts) need(p, "server_script");
  for (const p of manifest.clientScripts) need(p, "client_script");
  for (const p of manifest.testScripts) need(p, "test_script");
  for (const [env, paths] of Object.entries(manifest.environmentScripts)) {
    for (const p of paths) need(p, `environment_script "${env}"`);
  }
  if (manifest.webUiPage) need(manifest.webUiPage, "web_ui_page");
  for (const pattern of manifest.files) {
    if (expandGlob(pattern, files).length === 0) out.push({ code: "pattern_empty", message: `files pattern '${pattern}' matches no file.` });
  }
  for (const pattern of manifest.webFiles) {
    if (expandGlob(pattern, files).length === 0) out.push({ code: "pattern_empty", message: `web_files pattern '${pattern}' matches no file.` });
  }
  const manifestNames = manifest.format === "open77" ? ["open77.lua"] : ["scriptgo.lua", "scriptgo.json"];
  if (!manifestNames.some((n) => set.has(n))) {
    out.push({ code: "missing_manifest", message: `${manifestNames.join(" or ")} must be at the root of the resource.` });
  }
  return out;
}
