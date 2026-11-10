#!/usr/bin/env node
// SCRIPT//GO CLI entry in the repository. The commands are TypeScript sources run through tsx, so the
// monorepo needs no build step. The published package runs dist/scriptgo.mjs instead, one bundle of
// compiled JavaScript (packages/cli/build.mjs, publishConfig.bin).
import { register } from "tsx/esm/api";

register();
const { main } = await import("../src/main.ts");
process.exitCode = await main(process.argv.slice(2));
