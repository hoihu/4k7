import type { TransactionResult } from '@tracewise/schema';

/** Transaction result as sent to a model: effects, counts, introduced/resolved diagnostics. */
export function compactTx(r: TransactionResult) {
  return {
    status: r.status,
    ...(r.dryRun ? { dry_run: true } : {}),
    ...(r.rejection ? { rejection: r.rejection } : {}),
    effects: r.results.map((x) => x.effect),
    diagnostics_now: r.counts,
    introduced: r.introduced.map((d) => ({ severity: d.severity, code: d.code, entities: d.entities, message: d.message, ...(d.fixHints ? { fix: d.fixHints } : {}) })),
    resolved: r.resolved.map((d) => `${d.code} ${d.entities.join(',')}`),
    ...(r.scope ? { scope: r.scope } : {}),
  };
}

/** One-line human summary of a transaction result. */
export function describeTx(r: TransactionResult): string {
  if (r.status !== 'ok') return `refused op ${r.rejection!.opIndex + 1}: ${r.rejection!.code} — ${r.rejection!.message}`;
  const parts = [`${r.results.length} applied`];
  if (r.scope) parts.push(`ripple ${r.scope.ripple.length} · crossings ${r.scope.baseline.crossings}→${r.scope.measures.crossings}`);
  if (r.introduced.length) parts.push(`+${r.introduced.length} diag (${r.introduced.map((d) => d.code).join(', ')})`);
  if (r.resolved.length) parts.push(`−${r.resolved.length} diag`);
  return parts.join(' · ');
}
