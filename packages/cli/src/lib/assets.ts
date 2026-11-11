// Assets in `scriptgo pack` (docs/spec/assets.md, "Packing"): one inspection per target, shared by
// every pack target, so a declared asset is either delivered in the target's own form or refused.
// Nothing is dropped silently: a package whose assets are all for other targets is an error unless
// the creator asks for a build without them (`--without-assets`).
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { verifyFingerprintRecord, type FingerprintRecord } from "@scriptgo/escrow";
import {
  ASSET_RULES,
  describeAssetReport,
  environmentAssetFiles,
  genericAssetFiles,
  hasAssets,
  inspectAssets,
  RESERVED_ASSET_PREFIX,
  type AssetReport,
  type ParsedManifest,
} from "@scriptgo/manifest";
import { listFiles, type LoadedResource } from "./sdk.ts";

export interface AssetIssue {
  code: string;
  message: string;
}

/** The per-buyer fingerprint a downloaded release carries at its root (docs/spec/assets.md). */
export const FINGERPRINT_FILE = `${RESERVED_ASSET_PREFIX}fingerprint.json`;

export interface AssetPlan {
  report: AssetReport;
  /** Asset files this target delivers (generic when the target takes them, plus its native ones). */
  delivered: string[];
  /** The target's native asset files (`environment_asset "<target>"`). */
  native: string[];
  /** Generic asset files, when the target takes them. */
  generic: string[];
  /** Asset files of other environments, not delivered by this target. */
  elsewhere: Record<string, string[]>;
  /** `.scriptgo/fingerprint.json` when the resource is a buyer's fingerprinted download. */
  fingerprint: { path: string; record: FingerprintRecord | null; ok: boolean; reason?: string } | null;
  errors: AssetIssue[];
  warnings: string[];
}

/** True when the package runs code (any script), false for an asset-only package. */
export function hasScripts(m: ParsedManifest): boolean {
  return m.sharedScripts.length + m.serverScripts.length + m.clientScripts.length + Object.values(m.environmentScripts).flat().length > 0;
}

/** Reads and checks the per-buyer fingerprint at the resource root, if any. */
export function readFingerprint(root: string): AssetPlan["fingerprint"] {
  const path = join(root, ...FINGERPRINT_FILE.split("/"));
  if (!existsSync(path)) return null;
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as FingerprintRecord;
    const v = verifyFingerprintRecord(record);
    return { path, record, ok: v.ok, ...(v.ok ? {} : { reason: v.reason }) };
  } catch (e) {
    return { path, record: null, ok: false, reason: `unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** The asset inspection of a resource folder, every declared environment (validate, pack scriptgo). */
export function inspectResourceAssets(res: LoadedResource): AssetReport {
  if (!res.result.ok) return { errors: [], warnings: [], files: [], totalBytes: 0, environments: {}, fingerprinted: [] };
  return inspectAssets({ manifest: res.result.manifest, files: listFiles(res.root), read: (p) => readFileSync(join(res.root, p)) });
}

/**
 * What refuses a folder as an upload (`pack --target scriptgo`, `publish`): the inspection's errors,
 * and a buyer's fingerprinted copy, which is never re-published (the platform stamps each copy once).
 */
export function uploadAssetErrors(res: LoadedResource): { report: AssetReport; errors: AssetIssue[] } {
  const report = inspectResourceAssets(res);
  const errors: AssetIssue[] = [...report.errors];
  if (readFingerprint(res.root) || report.fingerprinted.length > 0) {
    errors.push({ code: "asset_fingerprinted", message: `this folder is a buyer's fingerprinted copy (${[FINGERPRINT_FILE, ...report.fingerprinted].join(", ")}): publish from the creator's sources, not from a download.` });
  }
  return { report, errors };
}

/**
 * Inspects a resource's assets for one pack target. Errors: anything the inspection refuses (for
 * any environment: the package is one product), and a package with assets none of which this
 * target delivers, unless `withoutAssets`.
 */
export function planAssets(res: LoadedResource, target: string, opts: { withoutAssets?: boolean } = {}): AssetPlan {
  const empty: AssetReport = { errors: [], warnings: [], files: [], totalBytes: 0, environments: {}, fingerprinted: [] };
  const plan: AssetPlan = { report: empty, delivered: [], native: [], generic: [], elsewhere: {}, fingerprint: readFingerprint(res.root), errors: [], warnings: [] };
  if (!res.result.ok) return plan;
  const m = res.result.manifest;
  if (plan.fingerprint && !plan.fingerprint.ok) plan.warnings.push(`${FINGERPRINT_FILE}: ${plan.fingerprint.reason ?? "invalid"}; this copy's fingerprint does not verify`);
  if (!hasAssets(m)) return plan;
  const files = listFiles(res.root);
  plan.report = inspectAssets({ manifest: m, files, read: (p) => readFileSync(join(res.root, p)), targets: [target] });
  plan.errors.push(...plan.report.errors);
  plan.warnings.push(...plan.report.warnings.map((w) => w.message));
  const rule = ASSET_RULES[target];
  plan.native = environmentAssetFiles(m, target, files);
  plan.generic = rule?.generic ? genericAssetFiles(m, files) : [];
  plan.delivered = [...new Set([...plan.generic, ...plan.native])].sort();
  const delivered = new Set(plan.delivered);
  for (const env of Object.keys(m.environmentAssets)) {
    if (env === target) continue;
    const rest = environmentAssetFiles(m, env, files).filter((f) => !delivered.has(f));
    if (rest.length > 0) plan.elsewhere[env] = rest;
  }
  if (plan.delivered.length === 0 && plan.errors.length === 0) {
    const where = Object.keys(plan.elsewhere);
    const message = `${m.name} has assets, but none for ${target}${where.length ? ` (they are for ${where.join(", ")})` : ""}`;
    if (opts.withoutAssets) plan.warnings.push(`${message}: packed without them (--without-assets)`);
    else plan.errors.push({ code: "assets_not_for_target", message: `${message}. Pack for ${where.length ? where.join(" or ") : "another target"}, or pass --without-assets to build ${target} without them.` });
  }
  return plan;
}

/** Copies `files` (resource-relative) from `root` to `dest`, keeping their paths. */
export function copyFiles(root: string, dest: string, files: string[]): void {
  for (const f of files) {
    const to = join(dest, ...f.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(root, ...f.split("/")), to);
  }
}

/** Copies the buyer's fingerprint next to the delivered files, so the built folder stays traceable. */
export function copyFingerprint(plan: AssetPlan, dest: string): void {
  if (!plan.fingerprint) return;
  const to = join(dest, ...FINGERPRINT_FILE.split("/"));
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(plan.fingerprint.path, to);
}

/** Terminal lines for a plan: the report, what this target leaves to the others, the fingerprint. */
export function describePlan(plan: AssetPlan, target: string): string[] {
  if (plan.report.files.length === 0 && !plan.fingerprint) return [];
  const out = plan.report.files.length > 0 ? describeAssetReport(plan.report) : [];
  if (plan.delivered.length > 0) out.push(`  ${target} delivers ${plan.delivered.length} asset files`);
  for (const [env, files] of Object.entries(plan.elsewhere)) out.push(`  not in this build: ${files.length} files for ${env} (scriptgo pack --target ${env})`);
  const f = plan.fingerprint;
  if (f?.ok && f.record) out.push(`  fingerprinted copy: licence ${f.record.licence}, deployment ${f.record.deployment || "-"} (kept in ${FINGERPRINT_FILE})`);
  return out;
}

/** The last path segment. */
export const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** Refuses two delivered files that would land on the same name in a flat folder. */
export function flatNameClashes(files: string[], target: string): AssetIssue[] {
  const seen = new Map<string, string>();
  const out: AssetIssue[] = [];
  for (const f of files) {
    const b = baseName(f).toLowerCase();
    const other = seen.get(b);
    if (other) out.push({ code: "asset_name_clash", message: `${other} and ${f}: ${target} puts these files in one folder, so their names must differ.` });
    else seen.set(b, f);
  }
  return out;
}
