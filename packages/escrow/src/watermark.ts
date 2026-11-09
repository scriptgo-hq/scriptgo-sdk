import { createHmac, timingSafeEqual } from "node:crypto";
import { DELIVERY_MARKER } from "./format.ts";

/**
 * Watermarking is **traceability, not prevention** (CREATOR-PROTECTION.md §1, §3.5). It cannot stop
 * a determined, licensed operator from dumping decrypted code; it makes a later leak *attributable*
 * so revocation and takedown become possible. We never market it as protection.
 *
 * Two granularities:
 *  - a **release watermark** baked into the signed escrow manifest at pack time (identifies the
 *    release/creator, survives in every copy);
 *  - a **per-delivery marker** stamped by the loader into the decrypted/materialized copy, carrying
 *    an opaque token tied to the license + deployment that fetched the key.
 */

export interface DeliveryIdentity {
  releaseId: string;
  licenseId?: string | null;
  deploymentId?: string | null;
}

/** An opaque, non-reversible token over a release (optionally a license/deployment). HMAC-SHA256. */
export function watermarkToken(identity: DeliveryIdentity, secret: string): string {
  if (!secret || secret.length < 16) throw new Error("A watermark secret of at least 16 characters is required.");
  const material = [identity.releaseId, identity.licenseId ?? "", identity.deploymentId ?? ""].join("\n");
  return createHmac("sha256", secret).update(material).digest("base64url");
}

export function watermarkMatches(token: string, identity: DeliveryIdentity, secret: string): boolean {
  const expected = Buffer.from(watermarkToken(identity, secret));
  const got = Buffer.from(token);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

/**
 * Writes the per-delivery marker into a decrypted file map. The loader calls this before handing the
 * resource to the host, so a leaked copy carries the token of the license/deployment it came from.
 */
export function stampDelivery(files: Map<string, Buffer>, identity: DeliveryIdentity, secret: string): void {
  const payload = {
    note: "SCRIPT//GO escrow delivery marker. Traceability only; this copy is attributable to the license and deployment below.",
    releaseId: identity.releaseId,
    token: watermarkToken(identity, secret),
    stampedAt: new Date().toISOString(),
  };
  files.set(DELIVERY_MARKER, Buffer.from(JSON.stringify(payload, null, 2) + "\n", "utf8"));
}
