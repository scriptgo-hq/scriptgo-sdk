// `scriptgo escrow`: inspect an escrow bundle, or install one for a host that loads encrypted
// resources from disk (OPEN//77 with resourceEscrow enabled). Nothing here handles a content key.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readBundle, verifyManifest } from "@scriptgo/escrow";
import { parseArgs } from "../lib/args.ts";
import { Open77EscrowError, installEscrowForOpen77 } from "../lib/open77-escrow.ts";

export const summary = "Inspect an escrow bundle, or install it encrypted into an OPEN//77 resources folder";

const USAGE = [
  "scriptgo escrow inspect <bundle.escrow.zip> [--trusted-signer <ed25519 public key>]",
  "scriptgo escrow install <bundle.escrow.zip> --target open77 --out <resources folder> [--trusted-signer <key>] [--force]",
].join("\n");

export async function run(args: string[]): Promise<number> {
  const a = parseArgs(args, { booleans: ["help", "force"] });
  const [sub, file] = a.positional;
  if (a.bools.has("help") || !sub || !file) {
    console.log(USAGE);
    return a.bools.has("help") ? 0 : 2;
  }
  const bundle = readFileSync(resolve(file));
  const trusted = a.flags["trusted-signer"];

  if (sub === "inspect") {
    const { manifest, clear, payload } = readBundle(bundle);
    const verdict = verifyManifest(manifest, { trustedSignerPublicKey: trusted });
    console.log(`${manifest.package} ${manifest.version}  (${manifest.format}, ${manifest.cipher})`);
    console.log(`signature: ${verdict.ok ? "valid" : `INVALID (${verdict.reason})`}  signer ${manifest.signerPublicKey}${trusted ? " (pinned)" : " (not pinned)"}`);
    console.log(`payload:   ${payload.length} bytes, ${manifest.encryptedFiles.length} encrypted file(s)`);
    for (const f of manifest.encryptedFiles) console.log(`  encrypted  ${f}`);
    for (const f of [...clear.keys()].sort()) console.log(`  clear      ${f}`);
    return verdict.ok ? 0 : 1;
  }

  if (sub === "install") {
    const target = a.flags.target ?? "open77";
    if (target !== "open77") {
      console.error(`scriptgo escrow install: unknown target '${target}'. Only open77 loads an encrypted folder from disk; other hosts take the bundle through their loader.`);
      return 2;
    }
    if (!a.flags.out) {
      console.error("scriptgo escrow install: --out <resources folder> is required.");
      return 2;
    }
    try {
      const r = installEscrowForOpen77({ bundle, resourcesRoot: resolve(a.flags.out), trustedSignerPublicKey: trusted, force: a.bools.has("force") });
      for (const w of r.warnings) console.log(`warning ${w}`);
      console.log(`installed ${r.package} ${r.version} -> ${r.dest}`);
      console.log(`  encrypted server scripts (stubs on disk): ${r.stubs.length === 0 ? "none" : r.stubs.join(", ")}`);
      console.log(`  clear files: ${r.clear.join(", ")}`);
      console.log("  The scripts stay encrypted on disk. The server needs resourceEscrow enabled, the native loader,");
      console.log("  and a deployment token for this resource; see the OPEN//77 setup guide.");
      return 0;
    } catch (err) {
      if (err instanceof Open77EscrowError) {
        console.error(`error ${err.code}: ${err.message}`);
        return 1;
      }
      throw err;
    }
  }

  console.error(USAGE);
  return 2;
}
