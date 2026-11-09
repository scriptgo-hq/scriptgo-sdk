/** Deterministic JSON (keys sorted at every level) so a signature is reproducible across languages
 * and runs. Used for the bytes the ed25519 release signature covers. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sort(value));
}

function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = sort((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}
