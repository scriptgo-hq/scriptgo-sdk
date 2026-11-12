// Secret files the CLI writes (an escrow content key, a server identity) and the rule that keeps
// them out of anything it packs or uploads.
//
// Honest stance: a key file is a key in clear on disk. On POSIX the file is created 0600; on Windows
// the mode bits do nothing, so the CLI replaces the file's ACL with one entry for the current user
// (icacls) and says so loudly when it cannot. Neither protects the key from that user, an
// administrator or a backup of the folder: keep these files out of the resource and out of shared
// folders, and treat any copy of them as a leaked key.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, relative, resolve, isAbsolute } from "node:path";

/** The CLI config folder: SCRIPTGO_CONFIG_DIR, else ~/.scriptgo. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SCRIPTGO_CONFIG_DIR || resolve(homedir(), ".scriptgo");
}

/** True when `path` is `dir` or inside it. */
export function isInside(path: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const SECRET_NAMES = [/\.escrow-key\.json$/i, /^release-signing\.key$/i, /^credentials\.json$/i, /^escrow-identity\.(bin|json|key)$/i];
const PEM_PRIVATE = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;

/**
 * Why `path` (with its bytes, when known) looks like a secret the CLI or a key tool wrote, or null.
 * By name: `*.escrow-key.json`, `release-signing.key`, `credentials.json`, `escrow-identity.*`. By
 * content (files up to 1 MiB): an escrow key file (`contentKeyBase64`, `contentKey`), a SCRIPT//GO server identity
 * (`"alg": "X25519"` with a `privateKey`), a PEM private key.
 */
export function secretFileReason(path: string, data?: Uint8Array): string | null {
  const name = basename(path.replace(/\\/g, "/"));
  if (SECRET_NAMES.some((r) => r.test(name))) return `${path} is named like a secret key file`;
  if (!data || data.length > 1024 * 1024) return null;
  const text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("latin1");
  if (/"contentKey(?:Base64)?"\s*:/.test(text)) return `${path} holds an escrow content key`;
  if (/"alg"\s*:\s*"X25519"/.test(text) && /"privateKey"\s*:/.test(text)) return `${path} holds a server identity private key`;
  if (PEM_PRIVATE.test(text)) return `${path} holds a PEM private key`;
  return null;
}

/** Every secret among `entries` (path, bytes), as messages. */
export function secretFiles(entries: Iterable<readonly [string, Uint8Array | undefined]>): string[] {
  const found: string[] = [];
  for (const [path, data] of entries) {
    const why = secretFileReason(path, data);
    if (why) found.push(why);
  }
  return found;
}

export interface SecretWrite {
  path: string;
  /** How the file is protected on this OS, in one honest line. */
  protection: string;
  /** Set when the file could not be restricted to the current user: print it. */
  warning: string | null;
}

/**
 * Restricts `path` to the current user on Windows: inherited entries dropped, one full-control entry
 * for this user (on a folder, inherited by what is created in it, so a new file gets no default
 * entries). Returns an error text or null.
 */
function restrictWindowsAcl(path: string, folder = false): string | null {
  const { username } = userInfo();
  const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${username}` : username;
  try {
    // No shell: the arguments reach icacls as they are.
    execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `${account}:${folder ? "(OI)(CI)F" : "F"}`], { stdio: "pipe", windowsHide: true });
    return null;
  } catch (e) {
    const detail = e instanceof Error ? e.message.split("\n")[0] : String(e);
    return `could not restrict ${path} to ${account} (icacls: ${detail})`;
  }
}

/** Creates `dir` (and parents) and, on Windows, restricts it to the current user when it is new. */
export function ensureSecretDir(dir: string): string | null {
  let existed = true;
  try {
    statSync(dir);
  } catch {
    existed = false;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existed && process.platform === "win32") return restrictWindowsAcl(dir, true);
  return null;
}

/**
 * Writes a secret file: 0600 on POSIX, an ACL for the current user only on Windows. The content is
 * still in clear on disk; the returned `protection` says what was done and `warning` what failed.
 */
export function writeSecretFile(path: string, content: string | Uint8Array): SecretWrite {
  const file = resolve(path);
  const dirWarning = ensureSecretDir(dirname(file));
  writeFileSync(file, content, { mode: 0o600 });
  if (process.platform !== "win32") {
    chmodSync(file, 0o600); // an existing file keeps its old mode otherwise
    return { path: file, protection: "in clear on disk, mode 0600 (this user and root can read it)", warning: dirWarning };
  }
  const aclWarning = restrictWindowsAcl(file);
  const warning = aclWarning ?? dirWarning;
  return {
    path: file,
    protection: aclWarning
      ? "in clear on disk, NOT restricted: any account that can read this folder can read the key"
      : "in clear on disk, ACL limited to this user (an administrator or a backup of the folder can still read it)",
    warning: warning ? `WARNING: ${warning}. The key file is readable by whoever can read its folder; move it somewhere only you can read.` : null,
  };
}

/**
 * On POSIX, why an existing secret file is too open (readable or writable by group or others), or
 * null. Windows ACLs are not inspected here.
 */
export function looseSecretFile(path: string): string | null {
  if (process.platform === "win32") return null;
  const mode = statSync(path).mode & 0o777;
  return (mode & 0o077) !== 0 ? `${path} is mode ${mode.toString(8).padStart(3, "0")}: group or others can access it (chmod 600 ${path})` : null;
}
