import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ActivateBody, ActivateResult, VerifyBody, VerifyResult } from "@scriptgo/shared";

/**
 * A loopback stand-in for the SCRIPT//GO licensing API, for `scriptgo verify --stub-api`.
 *
 * It speaks the real contract: every request body is parsed with the API's own zod schemas
 * (VerifyBody, ActivateBody from @scriptgo/shared) and every answer is checked against
 * VerifyResult / ActivateResult before it is sent. So a resource that passes against the stub
 * sends what the real API accepts and reads what the real API answers. It is not the API: one
 * license, in memory, no database, unsigned tokens.
 */
export interface StubRequest {
  method: string;
  path: string;
  /** null when the body matched the schema of its route, else the first zod issue. */
  bodyError: string | null;
  environment?: string;
  adapterVersion?: string | null;
}

export interface StubApi {
  url: string;
  /** The one license key the stub knows. Any other key is `unknown_key`. */
  licenseKey: string;
  /** Package references the key is valid for ("creator//name" or the resource name). */
  packages: string[];
  requests: StubRequest[];
  close(): Promise<void>;
}

const GRACE_MS = 72 * 3600 * 1000;

export async function startStubApi(opts: { packages: string[]; environments?: string[]; host?: string }): Promise<StubApi> {
  const licenseKey = "sg_live_stub_" + randomBytes(12).toString("hex");
  const environments = opts.environments ?? ["standalone", "love2d", "godot", "luanti", "openresty", "defold", "neovim", "open77", "dotnet", "garrysmod", "hytale", "rust", "beammp"];
  const deployments = new Map<string, { environment: string; activationId: string }>();
  const requests: StubRequest[] = [];
  const periodEnd = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

  const verifyAnswer = (valid: boolean, reason: string | null, environment: string, activation: boolean): VerifyResult =>
    VerifyResult.parse({
      valid,
      reason,
      status: valid || reason !== "unknown_key" ? "active" : null,
      activationStatus: activation ? "active" : null,
      expiresAt: valid ? periodEnd : null,
      offlineGraceUntil: valid ? new Date(Date.now() + GRACE_MS).toISOString() : null,
      environments: valid ? environments : [],
      token: `stub.unsigned.${environment}`,
    });

  const send = (res: ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  };
  const error = (res: ServerResponse, status: number, code: string, message: string) => send(res, status, { error: { code, message } });

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0]!;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const entry: StubRequest = { method: req.method ?? "", path, bodyError: null };
    requests.push(entry);

    if (req.method === "GET" && path === "/v1/health") return send(res, 200, { ok: true, version: "stub" });
    if (req.method !== "POST" || (path !== "/v1/licenses/verify" && path !== "/v1/licenses/activate")) {
      return error(res, 404, "not_found", "The stub serves /v1/health, /v1/licenses/verify and /v1/licenses/activate.");
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      entry.bodyError = "body is not JSON";
      return error(res, 400, "validation_failed", "The request does not match the schema.");
    }
    if (path === "/v1/licenses/activate") {
      const parsed = ActivateBody.safeParse(json);
      if (!parsed.success) {
        entry.bodyError = parsed.error.issues[0]?.message ?? "invalid";
        return error(res, 400, "validation_failed", "The request does not match the schema.");
      }
      const b = parsed.data;
      Object.assign(entry, { environment: b.environment, adapterVersion: b.adapterVersion });
      if (b.licenseKey !== licenseKey || !opts.packages.includes(b.package)) {
        return error(res, 404, "unknown_key", "Unknown license key for this package.");
      }
      const activationId = "act_" + randomBytes(8).toString("hex");
      const deploymentToken = "sg_dep_" + randomBytes(16).toString("hex");
      deployments.set(deploymentToken, { environment: b.environment, activationId });
      return send(res, 201, ActivateResult.parse({ activationId, deploymentToken }));
    }
    const parsed = VerifyBody.safeParse(json);
    if (!parsed.success) {
      entry.bodyError = parsed.error.issues[0]?.message ?? "invalid";
      return error(res, 400, "validation_failed", "The request does not match the schema.");
    }
    const b = parsed.data;
    Object.assign(entry, { environment: b.environment, adapterVersion: b.adapterVersion });
    if (!opts.packages.includes(b.package)) return send(res, 200, verifyAnswer(false, "unknown_key", b.environment, false));
    if (b.deploymentToken) {
      const d = deployments.get(b.deploymentToken);
      if (!d) return send(res, 200, verifyAnswer(false, "unknown_key", b.environment, false));
      if (d.environment !== b.environment) return send(res, 200, verifyAnswer(false, "environment_not_covered", b.environment, true));
      return send(res, 200, verifyAnswer(true, null, b.environment, true));
    }
    if (b.licenseKey !== licenseKey) return send(res, 200, verifyAnswer(false, "unknown_key", b.environment, false));
    if (!environments.includes(b.environment)) return send(res, 200, verifyAnswer(false, "environment_not_covered", b.environment, false));
    return send(res, 200, verifyAnswer(true, null, b.environment, false));
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => error(res, 500, "internal_error", String(e)));
  });
  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${host}:${port}`,
    licenseKey,
    packages: opts.packages,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
