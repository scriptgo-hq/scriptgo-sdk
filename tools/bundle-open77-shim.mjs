#!/usr/bin/env node
// Copies the OPEN//77 shim (sdk/adapters/open77/shim*.lua) and every file it pulls in with
// `-- @include`, into <package>/dist/sdk/ with the same relative layout, so a published
// @scriptgo/manifest generates the OPEN//77 files without an SDK checkout next to it.
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sdk = join(root, "sdk");
const out = resolve(process.argv[2] ?? "dist", "sdk");
const shimDir = join(sdk, "adapters", "open77");

const queue = readdirSync(shimDir).filter((f) => /^shim.*\.lua$/.test(f)).map((f) => join(shimDir, f));
const done = new Set();
while (queue.length) {
  const file = queue.pop();
  if (done.has(file)) continue;
  done.add(file);
  const rel = relative(sdk, file);
  if (rel.startsWith("..")) throw new Error(`@include outside the SDK: ${file}`);
  mkdirSync(dirname(join(out, rel)), { recursive: true });
  copyFileSync(file, join(out, rel));
  for (const m of readFileSync(file, "utf8").matchAll(/^\s*--\s*@include\s+(\S+)/gm)) queue.push(resolve(dirname(file), m[1]));
}
console.log(`bundle-open77-shim: ${done.size} file(s) in ${out}`);
