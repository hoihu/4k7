/**
 * Canonical, deterministic JSON for the native format: sorted keys, 2-space indent.
 * Same design → byte-identical output, so files diff cleanly in git.
 */
import { DESIGN_FORMAT_VERSION, type Design } from '@tracewise/schema';

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2) + '\n';
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

/** Bring older documents up to the current format version. */
export function migrate(d: Design): Design {
  if ((d.format as number) === 1) {
    // format 2: a manual placement is the user's choice (soft), locking is explicit
    for (const k of Object.values(d.ledger)) if (k.kind === 'position' && k.strength === 'hard') k.strength = 'soft';
    d.format = DESIGN_FORMAT_VERSION;
  }
  if (d.format !== DESIGN_FORMAT_VERSION) {
    throw new Error(`Unsupported design format ${String(d.format)} (expected ${DESIGN_FORMAT_VERSION})`);
  }
  for (const c of Object.values(d.components)) c.noConnect ??= [];
  return d;
}
