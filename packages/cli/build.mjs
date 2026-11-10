#!/usr/bin/env node
// Builds the installable CLI into packages/cli/dist:
//
//   dist/scriptgo.mjs   one ES module: the commands and @scriptgo/{manifest,escrow,shared}, zod and
//                       fflate bundled by esbuild, so the package needs no other SCRIPT//GO package
//                       and no TypeScript runtime. Only esbuild stays a dependency: it compiles
//                       TypeScript scripts at run time and ships a native binary per platform.
//   dist/sdk/           the parts of sdk/ the commands read at run time: the Lua core, the adapters
//                       (their build.mjs files stay separate modules, next to the files they copy)
//                       and the first-party packages.
//
// In the repository the CLI runs from its sources (bin/scriptgo.mjs, through tsx): this build is only
// what `pnpm pack` puts in the tarball (`prepack`).
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const dist = join(here, "dist");
const sdkOut = join(dist, "sdk");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// The command table, the same files src/main.ts lists from the sources (isCommandFile).
const names = readdirSync(join(here, "src", "commands"))
  .filter((f) => f.endsWith(".ts") && !f.startsWith("_") && !f.endsWith(".test.ts"))
  .map((f) => f.slice(0, -3))
  .sort();
const entry = [
  'import { main } from "./src/main.ts";',
  "const commands = {",
  ...names.map((n) => `  ${JSON.stringify(n)}: () => import("./src/commands/${n}.ts"),`),
  "};",
  "process.exitCode = await main(process.argv.slice(2), commands);",
].join("\n");

// sdk/adapters/<name>/*.mjs locate their files from their own path: keep them as modules of
// dist/sdk/adapters instead of inlining them into the bundle.
const sdkAdaptersExternal = {
  name: "sdk-adapters-external",
  setup(b) {
    b.onResolve({ filter: /[\\/]sdk[\\/]adapters[\\/].+\.mjs$/ }, (args) => {
      const file = resolve(args.resolveDir, args.path);
      const rel = relative(join(repo, "sdk"), file);
      if (rel.startsWith("..")) return undefined;
      return { path: "./sdk/" + rel.split(sep).join("/"), external: true };
    });
  },
};

await build({
  stdin: { contents: entry, resolveDir: here, sourcefile: "scriptgo-entry.ts", loader: "ts" },
  outfile: join(dist, "scriptgo.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["esbuild"],
  plugins: [sdkAdaptersExternal],
  banner: {
    // A CommonJS dependency inside an ES module bundle still calls require() for Node's built-ins.
    js: '#!/usr/bin/env node\nimport { createRequire as __sgCreateRequire } from "node:module";\nconst require = __sgCreateRequire(import.meta.url);',
  },
  legalComments: "inline",
  logLevel: "warning",
});

// What the commands read from sdk/ at run time. Build output and local state never go in.
const SKIP_DIRS = new Set(["bin", "obj", "target", "node_modules", "TestResults", "spec", "dist"]);
function copyTree(from, to) {
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    if (statSync(src).isDirectory()) {
      if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
      copyTree(src, join(to, name));
    } else {
      mkdirSync(to, { recursive: true });
      cpSync(src, join(to, name));
    }
  }
}
for (const part of ["lua", "adapters", "packages"]) copyTree(join(repo, "sdk", part), join(sdkOut, part));
for (const file of ["environments.json", "LICENSE"]) cpSync(join(repo, "sdk", file), join(sdkOut, file));

if (!existsSync(join(sdkOut, "lua", "scriptgo", "host.lua"))) throw new Error("build: the Lua core was not copied");
console.log(`cli build: ${basename(dist)}/scriptgo.mjs (${names.length} commands) and ${relative(here, sdkOut)}/`);
