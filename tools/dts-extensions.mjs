#!/usr/bin/env node
// After `tsc` emits a package's dist/: rewrite relative `.ts` specifiers in the declaration files to
// `.js`. The sources import "./x.ts" (run as-is by tsx and Next.js in development); `tsc` rewrites
// the emitted JavaScript (rewriteRelativeImportExtensions) but leaves the .d.ts files untouched, and
// a consumer's TypeScript would then look for .ts files that are not published.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "dist";
const spec = /((?:from|import)\s*\(?\s*["'])(\.\.?\/[^"']+?)\.ts(["'])/g;
let changed = 0;
for (const walk = [dir]; walk.length; ) {
  const d = walk.pop();
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk.push(p);
    else if (name.endsWith(".d.ts")) {
      const src = readFileSync(p, "utf8");
      const out = src.replace(spec, "$1$2.js$3");
      if (out !== src) { writeFileSync(p, out); changed++; }
    }
  }
}
console.log(`dts-extensions: ${changed} declaration file(s) rewritten in ${dir}`);
