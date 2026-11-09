// scriptgo license activate --package <creator//name> --environment <env> --name <deployment> [--key <sg_live_...>]
// scriptgo license verify   --package <creator//name> --environment <env> [--key <sg_live_...> | --deployment-token <sg_dep_...>]
//
// The key may also come from SCRIPTGO_LICENSE_KEY so it stays out of the shell history. verify exits
// 0 when the license is valid, 1 when the API refuses it (with the reason), 3 when the API cannot
// answer (deployments then rely on their offline grace).
import { parseArgs } from "../lib/args.ts";
import { ApiClient, ApiError, describeError } from "./_api-client.ts";

export const summary = "Activate a deployment or verify a license key";

interface VerifyResult {
  valid: boolean;
  reason: string | null;
  status: string | null;
  activationStatus: string | null;
  expiresAt: string | null;
  offlineGraceUntil: string | null;
  environments: string[];
}

const USAGE = [
  "scriptgo license activate --package <creator//name> --environment <env> --name <deployment> [--key <sg_live_...>] [--adapter-version <v>]",
  "scriptgo license verify --package <creator//name> --environment <env> [--key <sg_live_...> | --deployment-token <sg_dep_...>] [--json]",
].join("\n");

export async function run(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const a = parseArgs(rest, { booleans: ["help", "json"] });
  if (!sub || sub === "--help" || a.bools.has("help") || (sub !== "activate" && sub !== "verify")) {
    console.log(USAGE);
    return sub === "--help" || a.bools.has("help") ? 0 : 2;
  }
  const pkg = a.flags.package;
  const environment = a.flags.environment;
  const key = a.flags.key ?? process.env.SCRIPTGO_LICENSE_KEY;
  const deploymentToken = a.flags["deployment-token"];
  const adapterVersion = a.flags["adapter-version"] ?? null;
  if (!pkg || !environment) {
    console.error(`scriptgo license ${sub}: --package and --environment are required\n${USAGE}`);
    return 2;
  }
  const api = ApiClient.fromEnvironment();
  try {
    if (sub === "activate") {
      if (!key || !a.flags.name) {
        console.error(`scriptgo license activate: --key (or SCRIPTGO_LICENSE_KEY) and --name are required\n${USAGE}`);
        return 2;
      }
      const r = await api.post<{ activationId: string; deploymentToken: string }>("/v1/licenses/activate", {
        licenseKey: key,
        package: pkg,
        environment,
        deploymentName: a.flags.name,
        adapterVersion,
      });
      console.log(`activated deployment '${a.flags.name}' (${r.data.activationId}) for ${pkg} on ${environment}`);
      console.log("deployment token (shown once; configure it on that server):");
      console.log(r.data.deploymentToken);
      return 0;
    }
    if (!key && !deploymentToken) {
      console.error(`scriptgo license verify: pass --key or --deployment-token\n${USAGE}`);
      return 2;
    }
    const r = await api.post<VerifyResult>("/v1/licenses/verify", {
      ...(deploymentToken ? { deploymentToken } : { licenseKey: key }),
      package: pkg,
      environment,
      adapterVersion,
    });
    const v = r.data;
    if (a.bools.has("json")) console.log(JSON.stringify(v, null, 2));
    else if (v.valid) {
      console.log(`valid: ${pkg} on ${environment}, license ${v.status}${v.expiresAt ? `, paid through ${v.expiresAt}` : ""}`);
      if (v.offlineGraceUntil) console.log(`offline grace until ${v.offlineGraceUntil}`);
    } else {
      console.log(`not valid: ${v.reason}${v.status ? ` (license ${v.status})` : ""}`);
    }
    return v.valid ? 0 : 1;
  } catch (e) {
    console.error(`scriptgo license ${sub}: ${describeError(e)}`);
    return e instanceof ApiError && sub === "verify" ? 3 : 1;
  }
}
