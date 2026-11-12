import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PLATFORM_CONTAINER_SIGNERS, PlatformSigner, platformContainerSigners } from "../src/index.ts";

describe("platform container signers", () => {
  it("every listed key is well formed and its keyId is the SHA-256 of its public key", () => {
    for (const s of PLATFORM_CONTAINER_SIGNERS) {
      expect(PlatformSigner.parse(s)).toEqual(s);
      const raw = Buffer.from(s.publicKey, "base64url");
      expect(raw).toHaveLength(32);
      expect(createHash("sha256").update(raw).digest("hex").slice(0, 16)).toBe(s.keyId);
    }
    expect(new Set(PLATFORM_CONTAINER_SIGNERS.map((s) => s.publicKey)).size).toBe(PLATFORM_CONTAINER_SIGNERS.length);
  });

  it("returns only the keys for a kind, current first", () => {
    expect(platformContainerSigners("asset-container")).toEqual(
      [...PLATFORM_CONTAINER_SIGNERS].filter((s) => s.signs.includes("asset-container")).sort((a, b) => (a.status === "current" ? -1 : b.status === "current" ? 1 : 0)).map((s) => s.publicKey),
    );
    expect(() => PlatformSigner.parse({ keyId: "0".repeat(16), alg: "ed25519", publicKey: "short", signs: ["asset-container"], status: "current" })).toThrow();
  });
});
