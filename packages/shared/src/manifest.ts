import { z } from "zod";

/**
 * HTTP shape of `ParsedManifest` from `@scriptgo/manifest` (the parser is the source of truth;
 * this schema only describes what the API returns). Unknown directives are kept.
 */
export const ParsedManifestSchema = z.object({
  format: z.enum(["scriptgo", "open77"]),
  name: z.string(),
  version: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  author: z.string().nullable(),
  license: z.string().nullable(),
  repository: z.string().nullable(),
  category: z.string(),
  scriptgoVersion: z.string().nullable(),
  open77Version: z.string().nullable(),
  autoStart: z.boolean(),
  licensed: z.boolean(),
  lua: z.array(z.string()),
  environments: z.array(z.string()),
  capabilities: z.array(z.string()),
  optionalCapabilities: z.array(z.string()),
  sharedScripts: z.array(z.string()),
  serverScripts: z.array(z.string()),
  clientScripts: z.array(z.string()),
  environmentScripts: z.record(z.string(), z.array(z.string())),
  testScripts: z.array(z.string()),
  dependencies: z.array(z.object({ name: z.string(), range: z.string().nullable() })),
  permissions: z.array(z.string()),
  files: z.array(z.string()),
  exports: z.array(z.string()),
  serverExports: z.array(z.string()),
  webUiPage: z.string().nullable(),
  webFiles: z.array(z.string()),
  /** Client-delivered assets (docs/spec/assets.md). Defaults keep releases parsed before them valid. */
  assets: z.array(z.string()).default([]),
  environmentAssets: z.record(z.string(), z.array(z.string())).default({}),
  gameBuilds: z.record(z.string(), z.array(z.string())).default({}),
  dataFiles: z.record(z.string(), z.array(z.string())).default({}),
  unknown: z.array(z.object({ directive: z.string(), args: z.array(z.unknown()), line: z.number().int().optional() })),
});
export type ParsedManifestShape = z.infer<typeof ParsedManifestSchema>;
