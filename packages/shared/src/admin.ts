import { z } from "zod";
import { Timestamp } from "./common.ts";
import { AppealStatus, CaseStatus, Classification, ModerationActionKind, Provider } from "./enums.ts";
import { Offer, Release, RightsDeclaration } from "./registry.ts";

// ---------------------------------------------------------------- public report intake

export const ReportKind = z.enum(["ip", "abuse"]);
export const ReporterRole = z.enum(["rights_holder", "authorized_agent", "user"]);

/** Multipart text fields of POST /v1/reports (evidence[] are the file parts). */
export const ReportFields = z.object({
  kind: ReportKind.default("ip"),
  packageIdentifier: z.string().max(200).optional(),
  releaseVersion: z.string().max(64).optional(),
  url: z.string().max(1000).optional(),
  claimedWork: z.string().trim().max(5000).default(""),
  reporterRole: ReporterRole,
  description: z.string().trim().min(20).max(20_000),
  reporterName: z.string().trim().min(1).max(200),
  reporterEmail: z.string().trim().email().max(320),
  goodFaith: z.enum(["true", "false", "on"]).transform((v) => v !== "false"),
  accuracy: z.enum(["true", "false", "on"]).transform((v) => v !== "false"),
});
export type ReportFields = z.infer<typeof ReportFields>;
export const ReportReceipt = z.object({ caseId: z.string(), status: z.literal("received") });

// ---------------------------------------------------------------- audit

export const AuditEntry = z.object({
  id: z.string(),
  at: Timestamp,
  actor: z.object({ type: z.enum(["user", "admin", "system", "provider"]), id: z.string().nullable(), label: z.string().nullable() }),
  action: z.string(),
  subject: z.object({ type: z.string(), id: z.string() }),
  reference: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

// ---------------------------------------------------------------- cases

export const EvidenceFile = z.object({
  id: z.string(),
  fileName: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
  url: z.string(),
});

export const CaseSummary = z.object({
  id: z.string(),
  caseId: z.string(),
  status: CaseStatus,
  kind: z.enum(["ip", "abuse"]),
  reporterRole: z.string(),
  package: z.object({ identifier: z.string(), title: z.string() }).nullable(),
  releaseVersion: z.string().nullable(),
  escalated: z.boolean(),
  receivedAt: Timestamp,
  acknowledgedAt: Timestamp.nullable(),
});
export type CaseSummary = z.infer<typeof CaseSummary>;

export const ModerationDecision = z.object({
  id: z.string(),
  action: ModerationActionKind,
  reasons: z.string(),
  scope: z.string(),
  escalated: z.boolean(),
  decidedAt: Timestamp,
  decidedBy: z.string().nullable(),
  reversedAt: Timestamp.nullable(),
});
export type ModerationDecision = z.infer<typeof ModerationDecision>;

export const CaseAppeal = z.object({
  id: z.string(),
  status: AppealStatus,
  statement: z.string(),
  createdAt: Timestamp,
  decidedAt: Timestamp.nullable(),
  outcome: z.string().nullable(),
});

export const CaseDetail = CaseSummary.extend({
  claim: z.object({
    claimedWork: z.string(),
    description: z.string(),
    url: z.string().nullable(),
    reporterName: z.string(),
    reporterEmail: z.string(),
    goodFaith: z.boolean(),
    accuracy: z.boolean(),
  }),
  evidence: z.array(EvidenceFile),
  /** Listing as it was when the report was received. */
  snapshot: z.record(z.string(), z.unknown()).nullable(),
  rights: RightsDeclaration.nullable(),
  decisions: z.array(ModerationDecision),
  appeals: z.array(CaseAppeal),
  audit: z.array(AuditEntry),
});
export type CaseDetail = z.infer<typeof CaseDetail>;

export const ReportDecisionBody = z.object({
  action: ModerationActionKind,
  reasons: z.string().trim().min(10).max(10_000),
  escalate: z.boolean().default(false),
});
export type ReportDecisionBody = z.infer<typeof ReportDecisionBody>;

export const AppealDecisionBody = z.object({
  outcome: z.enum(["upheld", "reversed"]),
  reasons: z.string().trim().min(10).max(10_000),
});
export type AppealDecisionBody = z.infer<typeof AppealDecisionBody>;

// ---------------------------------------------------------------- reviews

export const ReviewOffer = Offer.extend({
  package: z.object({ identifier: z.string(), title: z.string() }),
  rights: RightsDeclaration.nullable(),
  classificationReason: z.string().nullable(),
  createdAt: Timestamp,
});
export type ReviewOffer = z.infer<typeof ReviewOffer>;

export const OfferDecisionBody = z.object({
  classification: Classification,
  reason: z.string().trim().min(3).max(5000),
});
export type OfferDecisionBody = z.infer<typeof OfferDecisionBody>;

export const ReviewRelease = z.object({
  release: Release,
  package: z.object({ identifier: z.string(), title: z.string() }),
  review: z.object({ id: z.string(), status: z.enum(["open", "approved", "restricted"]), reason: z.string(), createdAt: Timestamp }),
});
export type ReviewRelease = z.infer<typeof ReviewRelease>;

export const ReleaseDecisionBody = z.object({
  decision: z.enum(["approve", "restrict", "reinstate"]),
  reason: z.string().trim().min(3).max(5000),
});
export type ReleaseDecisionBody = z.infer<typeof ReleaseDecisionBody>;

// ---------------------------------------------------------------- operations

export const PaymentEventRow = z.object({
  id: z.string(),
  provider: Provider,
  eventId: z.string(),
  type: z.string(),
  status: z.enum(["processed", "deferred", "ignored", "failed"]),
  signatureValid: z.boolean(),
  occurredAt: Timestamp.nullable(),
  receivedAt: Timestamp,
  processedAt: Timestamp.nullable(),
  error: z.string().nullable(),
});
export type PaymentEventRow = z.infer<typeof PaymentEventRow>;

export const OperationalError = z.object({
  id: z.string(),
  at: Timestamp,
  method: z.string(),
  route: z.string(),
  statusCode: z.number().int(),
  code: z.string(),
  message: z.string(),
  requestId: z.string().nullable(),
});
export type OperationalError = z.infer<typeof OperationalError>;

export const GrantLicenseBody = z.object({
  userId: z.string().min(1),
  offerId: z.string().min(1),
  reason: z.string().trim().min(3).max(5000),
});
export type GrantLicenseBody = z.infer<typeof GrantLicenseBody>;

export const RevokeLicenseBody = z.object({ reason: z.string().trim().min(3).max(5000) });

export const IngestTokenCreated = z.object({ id: z.string(), token: z.string() });

export const StoreApprovalBody = z.object({ approved: z.boolean(), reason: z.string().trim().min(3).max(5000) });
