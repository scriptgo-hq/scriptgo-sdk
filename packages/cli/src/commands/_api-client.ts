// Shared HTTP client for the commands that talk to the SCRIPT//GO API (login, publish, add,
// license). The leading underscore keeps it out of the command list (see src/main.ts).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_API = "http://localhost:4100";

export interface Credentials {
  api: string;
  token: string | null;
}

/** ~/.scriptgo/credentials.json, or SCRIPTGO_CONFIG_DIR/credentials.json. */
export function credentialsFile(): string {
  return join(process.env.SCRIPTGO_CONFIG_DIR || join(homedir(), ".scriptgo"), "credentials.json");
}

/** SCRIPTGO_API / SCRIPTGO_TOKEN win over the saved file. */
export function loadCredentials(): Credentials {
  let saved: Partial<Credentials> = {};
  const file = credentialsFile();
  if (existsSync(file)) {
    try {
      saved = JSON.parse(readFileSync(file, "utf8")) as Partial<Credentials>;
    } catch {
      throw new Error(`${file} is not valid JSON; run 'scriptgo login' again`);
    }
  }
  return {
    api: (process.env.SCRIPTGO_API || saved.api || DEFAULT_API).replace(/\/$/, ""),
    token: process.env.SCRIPTGO_TOKEN || saved.token || null,
  };
}

export function saveCredentials(c: Credentials): string {
  const file = credentialsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ api: c.api, token: c.token }, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* not supported on every file system */
  }
  return file;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> | undefined,
  ) {
    super(message);
  }
}

export interface ApiResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

export class ApiClient {
  constructor(
    readonly base: string,
    private readonly token: string | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  static fromEnvironment(opts: { requireToken?: boolean } = {}): ApiClient {
    const c = loadCredentials();
    if (opts.requireToken && !c.token) throw new Error("not logged in: run 'scriptgo login --token <sg_pat_...>' (or set SCRIPTGO_TOKEN)");
    return new ApiClient(c.api, c.token);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { accept: "application/json", ...extra };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  async raw(method: string, path: string, init: { json?: unknown; form?: FormData } = {}): Promise<Response> {
    const headers = this.headers(init.json !== undefined ? { "content-type": "application/json" } : {});
    const body = init.json !== undefined ? JSON.stringify(init.json) : init.form;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, { method, headers, body });
    } catch (e) {
      throw new Error(`cannot reach the SCRIPT//GO API at ${this.base} (${e instanceof Error ? e.message : String(e)})`);
    }
    return res;
  }

  /** JSON request; non-2xx answers become ApiError with the API's error code and message. */
  async request<T>(method: string, path: string, init: { json?: unknown; form?: FormData } = {}): Promise<ApiResponse<T>> {
    const res = await this.raw(method, path, init);
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null)?.error;
      throw new ApiError(res.status, err?.code ?? `http_${res.status}`, err?.message ?? `HTTP ${res.status}`, err?.details);
    }
    return { status: res.status, data: data as T, headers: res.headers };
  }

  get<T>(path: string) {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, json?: unknown) {
    return this.request<T>("POST", path, { json: json ?? {} });
  }
}

/** Formats an error for the terminal (the token is never part of it). */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    const blockers = Array.isArray(e.details?.blockers) ? `\n  - ${(e.details!.blockers as string[]).join("\n  - ")}` : "";
    return `${e.code}: ${e.message}${blockers}`;
  }
  return e instanceof Error ? e.message : String(e);
}
