#!/usr/bin/env node
// SCRIPT//GO CLI entry. The commands are TypeScript sources run through tsx, so the monorepo needs
// no build step; a published CLI would ship compiled JavaScript instead.
import { register } from "tsx/esm/api";

register();
const { main } = await import("../src/main.ts");
process.exitCode = await main(process.argv.slice(2));
