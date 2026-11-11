// Generates the asset vectors: a per-buyer fingerprinted build and an asset-escrow container, from
// fixed test material, so any other implementation (the platform, a platform's client hook in C++
// or C#) can check it produces and reads the same bytes. Everything is deterministic: running this
// twice writes the same file, and packages/escrow/test/asset-vectors.test.ts rebuilds every value.
//
// Run: node packages/escrow/tools/gen-asset-vectors.ts   (Node 22.18+ runs TypeScript directly)
// Output: packages/escrow/test/vectors/asset-vectors.json (test-only material, never a real key).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assetVectors } from "../test/vectors/build.ts";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "test", "vectors", "asset-vectors.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(assetVectors(), null, 2) + "\n");
console.log(`wrote ${out}`);
