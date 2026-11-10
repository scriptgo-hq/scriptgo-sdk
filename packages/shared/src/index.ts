/**
 * @scriptgo/shared — the HTTP contract of SCRIPT//GO (docs/spec/api.md) as zod schemas.
 *
 * Every exported schema has a TypeScript type of the same name:
 *   import { PackageSummary } from "@scriptgo/shared";          // the zod schema
 *   import type { PackageSummary } from "@scriptgo/shared";     // the inferred type
 */
export * from "./enums.ts";
export * from "./common.ts";
export * from "./manifest.ts";
export * from "./registry.ts";
export * from "./account.ts";
export * from "./admin.ts";
export * from "./readiness.ts";
export * from "./perks.ts";
