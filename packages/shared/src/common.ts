import { z } from "zod";

/** ISO-8601 UTC timestamp string, e.g. "2026-11-09T12:00:00.000Z". */
export const Timestamp = z.string().datetime({ offset: true });
export type Timestamp = z.infer<typeof Timestamp>;

/** Money in minor units: { amount: 600, currency: "EUR" } is 6.00 EUR. */
export const Money = z.object({
  amount: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/, "ISO-4217 currency code, uppercase"),
});
export type Money = z.infer<typeof Money>;

export const ErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

export const PageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
});
export type PageQuery = z.infer<typeof PageQuery>;

export function Page<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int().nonnegative(),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
  });
}
export type Page<T> = { items: T[]; total: number; page: number; pageSize: number };

/** Creator username: lowercase slug. */
export const USERNAME_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;
export const Username = z.string().regex(USERNAME_RE, "lowercase letters, digits and '-', 2-39 characters");

/** Package name (URL segment): lowercase slug. "inventory-pro". */
export const PACKAGE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const PackageName = z.string().regex(PACKAGE_NAME_RE, "lowercase letters, digits, '-' and '_', up to 64 characters");

/** Resource name from the manifest: same slug rule as docs/spec/manifest.md. */
/** OPEN//77 resource (manifest `resource`) name: 3-64 chars, letter first, letters/digits/underscore. Registry package slugs use PACKAGE_NAME_RE. */
export const RESOURCE_NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;

/** Report case id: RPT-YYYY-NNNNNN. */
export const CASE_ID_RE = /^RPT-\d{4}-\d{6}$/;

/** "kestrel//inventory-pro" */
export function formatIdentifier(creator: string, name: string): string {
  return `${creator}//${name}`;
}

/** Parses "creator//name" or "creator//name@1.2.3". Returns null when malformed. */
export function parseIdentifier(input: string): { creator: string; name: string; version: string | null } | null {
  const m = /^([a-z0-9][a-z0-9-]{1,38})\/\/([a-z0-9][a-z0-9_-]{0,63})(?:@([0-9A-Za-z.+-]+))?$/.exec(input.trim());
  if (!m) return null;
  return { creator: m[1]!, name: m[2]!, version: m[3] ?? null };
}

/**
 * Error thrown by domain packages (registry, licensing, compliance). The API turns it into
 * `{ error: { code, message, details } }` with `status`.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
