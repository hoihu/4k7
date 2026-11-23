/**
 * Canonical, deterministic JSON for the native format: sorted keys, 2-space indent.
 * Same design → byte-identical output, so files diff cleanly in git.
 */
import { DESIGN_FORMAT_VERSION, MULTI_BOARD_FORMAT, type Design } from '@4k7/schema';

export function canonicalJson(value: unknown): string {
  type Settings = { copper?: unknown };
  const sorted = sortKeys(value) as { board?: Settings; boards?: Record<string, { settings?: Settings }> } | null;
  // the routed copper (a cache of thousands of numbers) goes on one line: one number per line
  // would make it most of the file, and a git diff of it is noise either way (each board's)
  const copper: unknown[] = [];
  const mark = (s: Settings | undefined) => (s?.copper ? { ...s, copper: `${COPPER_MARK}${copper.push(s.copper) - 1}` } : s);
  if (!sorted?.board?.copper && !Object.values(sorted?.boards ?? {}).some((e) => e.settings?.copper)) return JSON.stringify(sorted, null, 2) + '\n';
  const marked = {
    ...sorted,
    ...(sorted!.board ? { board: mark(sorted!.board) } : {}),
    ...(sorted!.boards ? { boards: Object.fromEntries(Object.entries(sorted!.boards).map(([k, e]) => [k, e.settings ? { ...e, settings: mark(e.settings) } : e])) } : {}),
  };
  const text = JSON.stringify(marked, null, 2);
  return text.replace(new RegExp(`"\\\\u0000copper(\\d+)"`, 'g'), (_, i: string) => JSON.stringify(copper[Number(i)])) + '\n';
}

const COPPER_MARK = '\u0000copper';

/** JSON with sorted keys on one line: equal values give equal text, whatever order their keys were set in (for keys and hashes). */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
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
  if (d.format !== DESIGN_FORMAT_VERSION && d.format !== MULTI_BOARD_FORMAT) {
    throw new Error(`Unsupported design format ${String(d.format)} (expected ${DESIGN_FORMAT_VERSION} or ${MULTI_BOARD_FORMAT})`);
  }
  for (const c of Object.values(d.components)) c.noConnect ??= [];
  return d;
}
