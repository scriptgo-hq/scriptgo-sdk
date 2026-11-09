// TypeScript resources: every `.ts` script entry is compiled by esbuild (pinned, see
// LEGAL_DEPENDENCIES.md) into one JavaScript file next to it, `<entry>.js` (server/main.ts ->
// server/main.ts.js), which is what a host loads. Each entry is bundled on its own as an IIFE, so
// relative imports between the resource's own .ts files are inlined and nothing is shared between
// entries except through the runtime (events, exports). esbuild strips types without checking
// them: run `tsc --noEmit` against @scriptgo/types for type errors.
//
// The runtime's `exports` is a global (a callable proxy). esbuild takes a file that names a free
// `exports` and has no `export` statement for CommonJS, and wraps it with an `exports` parameter of
// its own, which would hide the runtime's. So every file of the resource is loaded as an ES module
// (an empty `export {}` is appended): there `exports` stays the global. (`define` and `inject` do
// not change that detection; esbuild 0.25.12, checked.)
import { build, version as esbuildVersion, type Message, type Plugin } from "esbuild";
import { readFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { expandGlob, type ParsedManifest } from "@scriptgo/manifest";

export const ESBUILD_VERSION = esbuildVersion;
/** The JavaScript level of the output: what the Jint guest of the .NET kit runs. */
export const TS_TARGET = "es2022";

export interface CompiledEntry {
  /** The manifest entry, e.g. server/main.ts. */
  entry: string;
  /** The output path, e.g. server/main.ts.js. */
  output: string;
  code: Uint8Array;
  /** Resource files the bundle read (the entry and its relative imports), resource-relative. */
  inputs: string[];
}

export interface CompileIssue {
  code: string;
  message: string;
}

/** The .ts script entries of a manifest, globs expanded against the folder listing. */
export function typeScriptEntries(m: ParsedManifest, files: string[]): string[] {
  const patterns = [...m.sharedScripts, ...m.serverScripts, ...m.clientScripts, ...Object.values(m.environmentScripts).flat()];
  const out = new Set<string>();
  for (const p of patterns) {
    for (const f of /[*?]/.test(p) ? expandGlob(p, files) : [p]) if (f.endsWith(".ts")) out.add(f);
  }
  return [...out].sort();
}

function describe(m: Message): string {
  const at = m.location ? `${m.location.file}:${m.location.line}:${m.location.column + 1} ` : "";
  return `${at}${m.text}`;
}

const LOADERS: Record<string, "ts" | "js" | "tsx" | "jsx"> = { ".ts": "ts", ".mts": "ts", ".cts": "ts", ".tsx": "tsx", ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx" };

/** Loads every script of the bundle as an ES module (see the header). */
const asModules: Plugin = {
  name: "scriptgo-es-modules",
  setup(b) {
    b.onLoad({ filter: /\.(?:[cm]?[jt]s|[jt]sx)$/ }, async (args) => ({
      contents: (await readFile(args.path, "utf8")) + "\nexport {};\n",
      loader: LOADERS[extname(args.path)] ?? "js",
    }));
  },
};

/** Compiles every .ts entry of the resource in memory. Nothing is written. */
export async function compileTypeScript(root: string, m: ParsedManifest, files: string[]): Promise<{ entries: CompiledEntry[]; errors: CompileIssue[] }> {
  const entries: CompiledEntry[] = [];
  const errors: CompileIssue[] = [];
  for (const entry of typeScriptEntries(m, files)) {
    try {
      const r = await build({
        absWorkingDir: root,
        entryPoints: [entry],
        bundle: true,
        write: false,
        format: "iife",
        platform: "neutral",
        target: TS_TARGET,
        charset: "utf8",
        legalComments: "none",
        logLevel: "silent",
        metafile: true,
        plugins: [asModules],
        outfile: `${entry}.js`,
      });
      const out = r.outputFiles[0];
      if (!out) {
        errors.push({ code: "typescript_compile_failed", message: `${entry}: esbuild produced no output` });
        continue;
      }
      const inputs = Object.keys(r.metafile.inputs).map((p) => relative(root, join(root, p)).split(sep).join("/")).sort();
      // The archive ships the sources next to the output: a bundle may only read the resource's own files.
      const outside = inputs.filter((p) => p.startsWith("../") || /^[A-Za-z]:/.test(p) || p.startsWith("/"));
      if (outside.length > 0) {
        errors.push({ code: "typescript_import_outside_resource", message: `${entry}: imports ${outside.join(", ")}` });
        continue;
      }
      entries.push({ entry, output: `${entry}.js`, code: out.contents, inputs });
    } catch (e) {
      const failure = e as { errors?: Message[]; message?: string };
      const msgs = failure.errors?.length ? failure.errors.map(describe) : [String(failure.message ?? e)];
      errors.push({ code: "typescript_compile_failed", message: `${entry}: ${msgs.join("; ")}` });
    }
  }
  return { entries, errors };
}
