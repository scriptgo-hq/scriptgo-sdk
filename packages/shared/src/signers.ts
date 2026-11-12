import { z } from "zod";

/**
 * The SCRIPT//GO platform's container signers: the ed25519 public keys that sign the asset
 * containers (`.sgae`, docs/spec/assets.md) and the client-code containers (`SGCE`,
 * docs/spec/client-escrow.md) the platform seals for a deployment.
 *
 * THIS LIST IS THE SINGLE DOCUMENTED SOURCE of those keys. A game client that decrypts a platform
 * container pins one of them (libscriptgo `sg_asset_container_open` / `sg_clink_container_open`,
 * .NET `AssetContainer.Open` / `ClientCodeContainer.Open`, `@scriptgo/escrow` readers): it builds
 * them into its own binary or configuration, from this file at the SDK tag it ships with. It never
 * takes a signer from the game server it joins, nor from the container's own header: whoever holds
 * a deployment's content key (a game server does) can seal and sign a container of its own, and it
 * verifies under the key its header names.
 *
 * `status: "retired"` keys still verify containers sealed before a rotation; a client keeps them
 * until those containers are gone. Keys are base64url, 32 bytes.
 *
 * The list is empty until the platform publishes its key here: until then a host pins the key the
 * platform gives it out of band, and no container should be trusted for being signed at all.
 */
export const PlatformSigner = z.object({
  /** First 16 hex of the SHA-256 of the public key. */
  keyId: z.string().regex(/^[0-9a-f]{16}$/),
  alg: z.literal("ed25519"),
  /** base64url, 32 bytes. */
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  /** What the key signs. */
  signs: z.array(z.enum(["asset-container", "client-container"])).min(1),
  status: z.enum(["current", "retired"]),
});
export type PlatformSigner = z.infer<typeof PlatformSigner>;

export const PLATFORM_CONTAINER_SIGNERS: readonly PlatformSigner[] = Object.freeze([]);

/** The public keys a client pins for `kind`, current first. */
export function platformContainerSigners(kind: PlatformSigner["signs"][number]): string[] {
  return [...PLATFORM_CONTAINER_SIGNERS]
    .filter((s) => s.signs.includes(kind))
    .sort((a, b) => (a.status === b.status ? 0 : a.status === "current" ? -1 : 1))
    .map((s) => s.publicKey);
}
