import { describe, expect, it } from "vitest";
import { PackageVersion, ReleaseProtection } from "../src/index.ts";

const base = { version: "1.0.0", status: "published", publishedAt: null, sha256: "0".repeat(64), size: 1, changelog: null };

describe("ReleaseProtection", () => {
  it("defaults to nothing protected when an older API sends no protection", () => {
    const v = PackageVersion.parse(base);
    expect(v.protection).toEqual({ serverCode: false, clientCode: null, assets: null, perBuyerCopies: false });
  });

  it("takes every kind together", () => {
    const p = ReleaseProtection.parse({
      serverCode: false,
      clientCode: { format: "scriptgo-client-escrow/1", environment: "open77", strip: "full", scripts: ["client/main.lua"], lineNumbers: "creator_only" },
      assets: { format: "scriptgo-asset-escrow/1", environment: "open77", containers: ["preload/maps.zip"] },
      perBuyerCopies: true,
    });
    expect(p.clientCode?.scripts).toEqual(["client/main.lua"]);
    expect(p.assets?.containers).toEqual(["preload/maps.zip"]);
  });

  it("refuses an unknown strip or line-number place", () => {
    const clientCode = { format: "scriptgo-client-escrow/1", environment: "open77", strip: "none", scripts: [], lineNumbers: "creator_only" };
    expect(ReleaseProtection.safeParse({ serverCode: false, clientCode, assets: null, perBuyerCopies: true }).success).toBe(false);
    expect(
      ReleaseProtection.safeParse({ serverCode: false, clientCode: { ...clientCode, strip: "full", lineNumbers: "shipped" }, assets: null, perBuyerCopies: true }).success,
    ).toBe(false);
  });
});
