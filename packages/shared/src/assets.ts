import { z } from "zod";
import { Timestamp } from "./common.ts";

/**
 * Assets on the platform (docs/spec/assets.md, "What the platform (API) must do"): what a release's
 * assets are, per environment; the per-buyer fingerprinted copies; lookup of a copy found elsewhere;
 * asset reports and the staff actions on them. Licensed, fingerprinted, traceable: nothing here
 * describes encryption, and no asset-escrow key is ever part of these shapes.
 */

/**
 * The seller's statement of what their assets are, made on the release. Information for operators
 * and for staff acting on a report; not a legal assessment. `original`: made by the seller (or
 * licensed to them); `game_edits`: edits of, or made from, a game's own files; `game_extracted`:
 * includes files taken from a game.
 */
export const AssetRightsCase = z.enum(["original", "game_edits", "game_extracted"]);
export type AssetRightsCase = z.infer<typeof AssetRightsCase>;

export const AssetSupport = z.enum(["supported", "partial", "bundled", "unsupported"]);
export type AssetSupport = z.infer<typeof AssetSupport>;

/** One container (an environment's .zip) of a release: its published bytes, before any fingerprint. */
export const AssetContainerInfo = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  entries: z.number().int().nonnegative(),
  expandedBytes: z.number().int().nonnegative(),
});
export type AssetContainerInfo = z.infer<typeof AssetContainerInfo>;

/** What one environment delivers of a release's assets (the inspection report, per environment). */
export const AssetEnvironmentInfo = z.object({
  environment: z.string(),
  support: AssetSupport,
  /** Asset files delivered there. */
  files: z.number().int().nonnegative(),
  /** What each player downloads there, in bytes; 0 where no player downloads anything (bundled). */
  downloadBytes: z.number().int().nonnegative(),
  /** What the server needs: archivexl, tweakxl, levelurl, fastdl, this_is_a_map. */
  needs: z.array(z.string()),
  /** Game builds the seller made the assets for. Information only, never a load gate. */
  gameBuilds: z.array(z.string()),
  containers: z.array(AssetContainerInfo),
});
export type AssetEnvironmentInfo = z.infer<typeof AssetEnvironmentInfo>;

/** A release's assets. Null on a release that carries none. */
export const ReleaseAssetsInfo = z.object({
  files: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  environments: z.array(AssetEnvironmentInfo),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  /** The seller's statement (AssetRightsCase); null until declared. */
  rightsCase: AssetRightsCase.nullable(),
  /** How each download is made traceable. */
  fingerprint: z.literal("scriptgo-asset-fingerprint/1"),
  /** SDK version of the inspection that accepted the release. */
  inspectedWith: z.string(),
});
export type ReleaseAssetsInfo = z.infer<typeof ReleaseAssetsInfo>;

// ---------------------------------------------------------------- lookup

/**
 * Look a copy up: by the SHA-256 of a file (a whole copy, or a container in it), or by a fingerprint
 * record found in a file (`.scriptgo/fingerprint.json`, `*.scriptgo-fingerprint.json`).
 */
export const AssetLookupBody = z
  .object({
    sha256: z.string().trim().toLowerCase().regex(/^[0-9a-f]{64}$/).optional(),
    record: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((b) => Boolean(b.sha256) !== Boolean(b.record), { message: "Give either sha256 or record." });
export type AssetLookupBody = z.infer<typeof AssetLookupBody>;

/** One delivered copy. `account` is staff-only (null for a creator looking up their own package). */
export const AssetDeliveryMatch = z.object({
  deliveryId: z.string(),
  package: z.string(),
  version: z.string(),
  matchedBy: z.enum(["copy_sha256", "container_sha256", "marker"]),
  /** The container the hash matched, when it was one. */
  container: z.string().nullable(),
  license: z.object({ id: z.string(), status: z.string() }).nullable(),
  /** Set for a copy fingerprinted to the creator's or staff's own account (no licence). */
  accountCopy: z.boolean(),
  account: z.object({ id: z.string(), name: z.string(), email: z.string() }).nullable(),
  deployment: z.object({ id: z.string(), name: z.string(), environment: z.string(), status: z.string() }).nullable(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
  createdAt: Timestamp,
  lastDownloadedAt: Timestamp.nullable(),
  downloadCount: z.number().int().nonnegative(),
});
export type AssetDeliveryMatch = z.infer<typeof AssetDeliveryMatch>;

export const AssetLookupResult = z.object({
  by: z.enum(["sha256", "record"]),
  /** For a record: whether its signature verifies, by a platform key, and its marker is the platform's. */
  record: z
    .object({
      signatureValid: z.boolean(),
      signerKnown: z.boolean(),
      markerValid: z.boolean(),
      reason: z.string().nullable(),
      package: z.string().nullable(),
      version: z.string().nullable(),
      container: z.string().nullable(),
    })
    .nullable(),
  matches: z.array(AssetDeliveryMatch),
});
export type AssetLookupResult = z.infer<typeof AssetLookupResult>;

// ---------------------------------------------------------------- reports

export const AssetEvidence = z.object({
  kind: z.enum(["sha256", "record", "url", "note"]),
  value: z.string().trim().min(1).max(20_000),
});
export type AssetEvidence = z.infer<typeof AssetEvidence>;

/** A leak or an infringing asset, reported by a signed-in account (the package's creator or anyone). */
export const CreateAssetReportBody = z.object({
  /** creator//name */
  package: z.string().trim().min(3).max(200),
  version: z.string().trim().max(64).optional(),
  evidence: z.array(AssetEvidence).min(1).max(20),
  description: z.string().trim().min(10).max(10_000),
  /** The statements every report carries (POST /v1/reports): both must be true. */
  goodFaith: z.literal(true),
  accuracy: z.literal(true),
});
export type CreateAssetReportBody = z.infer<typeof CreateAssetReportBody>;

export const AssetReportStatus = z.enum(["open", "actioned", "rejected"]);
export type AssetReportStatus = z.infer<typeof AssetReportStatus>;

/**
 * What staff can do on an asset report. revoke_license / deactivate_deployment act on the copy the
 * report resolved to; restrict_release decides the linked case (notice and appeal to the seller);
 * takedown_notice records a notice sent by a person to a third-party host; reject closes the report.
 */
export const AssetReportAction = z.enum(["revoke_license", "deactivate_deployment", "restrict_release", "takedown_notice", "reject"]);
export type AssetReportAction = z.infer<typeof AssetReportAction>;

export const AssetReportActionBody = z.object({
  action: AssetReportAction,
  reasons: z.string().trim().min(10).max(10_000),
});
export type AssetReportActionBody = z.infer<typeof AssetReportActionBody>;

export const ResolveAssetReportBody = z.object({ deliveryId: z.string().min(1).max(64) });
export type ResolveAssetReportBody = z.infer<typeof ResolveAssetReportBody>;

export const AssetReportRow = z.object({
  id: z.string(),
  package: z.string(),
  version: z.string().nullable(),
  status: AssetReportStatus,
  /** The compliance case opened with the report (notice and appeal go through it). */
  caseId: z.string().nullable(),
  reporter: z.object({ id: z.string(), name: z.string(), isCreator: z.boolean() }).nullable(),
  evidence: z.array(AssetEvidence),
  description: z.string(),
  resolved: AssetDeliveryMatch.nullable(),
  actions: z.array(z.object({ action: AssetReportAction, reasons: z.string(), at: Timestamp, by: z.string().nullable() })),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type AssetReportRow = z.infer<typeof AssetReportRow>;
