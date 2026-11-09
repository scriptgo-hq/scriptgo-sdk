// Minimal semantic versioning: parse, compare, ranges ("^1.2.0", ">=0.1.0 <2.0.0", "1.x || 2.x").

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: (string | number)[];
}

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseSemver(v: string): SemVer | null {
  const m = SEMVER.exec(v.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [],
  };
}

export function isValidSemver(v: string): boolean {
  return parseSemver(v) !== null;
}

export function compareSemver(a: SemVer, b: SemVer): number {
  for (const k of ["major", "minor", "patch"] as const) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return b.prerelease.length - a.prerelease.length;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function compareVersions(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) throw new Error(`Invalid version: ${!x ? a : b}`);
  return compareSemver(x, y);
}

type Op = ">=" | ">" | "<=" | "<" | "=";
interface Comparator {
  op: Op;
  v: SemVer;
}

const sv = (major: number, minor = 0, patch = 0): SemVer => ({ major, minor, patch, prerelease: [] });

function partial(text: string): { parts: number[]; full: SemVer | null } | null {
  const t = text.replace(/^v/, "");
  const full = parseSemver(t);
  if (full) return { parts: [full.major, full.minor, full.patch], full };
  const m = /^(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(t);
  if (!m) return null;
  const parts: number[] = [];
  for (const p of [m[1], m[2], m[3]]) {
    if (p === undefined || /[xX*]/.test(p)) break;
    parts.push(Number(p));
  }
  return { parts, full: null };
}

function comparators(token: string): Comparator[] | null {
  if (token === "*" || token === "x" || token === "X") return [];
  const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(token);
  if (!m) return null;
  const op = m[1] ?? "";
  const p = partial(m[2]!);
  if (!p) return null;
  const [maj, min, pat] = p.parts;
  const lower = p.full ?? sv(maj ?? 0, min ?? 0, pat ?? 0);
  if (op === "^") {
    if (maj === undefined) return [];
    let upper: SemVer;
    if (maj > 0 || min === undefined) upper = sv(maj + 1);
    else if (min > 0 || pat === undefined) upper = sv(0, min + 1);
    else upper = sv(0, 0, pat + 1);
    return [
      { op: ">=", v: lower },
      { op: "<", v: upper },
    ];
  }
  if (op === "~") {
    if (maj === undefined) return [];
    const upper = min === undefined ? sv(maj + 1) : sv(maj, min + 1);
    return [
      { op: ">=", v: lower },
      { op: "<", v: upper },
    ];
  }
  if (op === "" || op === "=") {
    if (p.full) return [{ op: "=", v: p.full }];
    if (maj === undefined) return [];
    const upper = min === undefined ? sv(maj + 1) : pat === undefined ? sv(maj, min + 1) : sv(maj, min, pat + 1);
    return [
      { op: ">=", v: lower },
      { op: "<", v: upper },
    ];
  }
  if (maj === undefined) return null;
  return [{ op: op as Op, v: lower }];
}

function parseRange(range: string): Comparator[][] | null {
  const sets: Comparator[][] = [];
  for (const alt of range.split("||")) {
    const tokens = alt
      .trim()
      .replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1")
      .split(/\s+/)
      .filter(Boolean);
    const set: Comparator[] = [];
    for (const tok of tokens) {
      const c = comparators(tok);
      if (c === null) return null;
      set.push(...c);
    }
    sets.push(set);
  }
  return sets;
}

export function isValidRange(range: string): boolean {
  return range.trim().length > 0 && parseRange(range) !== null;
}

export function satisfies(version: string, range: string): boolean {
  const v = parseSemver(version);
  const sets = parseRange(range);
  if (!v || !sets) return false;
  return sets.some((set) =>
    set.every(({ op, v: target }) => {
      const c = compareSemver(v, target);
      if (op === ">=") return c >= 0;
      if (op === ">") return c > 0;
      if (op === "<=") return c <= 0;
      if (op === "<") return c < 0;
      return c === 0;
    }),
  );
}
