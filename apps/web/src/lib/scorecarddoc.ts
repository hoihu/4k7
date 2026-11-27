/**
 * The design document's scorecard on the cover: the open findings, what could not be judged, and
 * each board's size, layers and routing, as a short table. The card comes from the kernel
 * (get_scorecard); see docs/design/scorecard.md §4.
 */
import type { BoardScore, Scorecard } from '@4k7/schema';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function routingText(b: BoardScore): string {
  if (b.routing === 'none') return 'not routed';
  if (b.routing === 'stale') return 'routing out of date';
  const c = b.connections!;
  return c.open ? `routed, ${plural(c.open, 'connection')} open` : 'routed, all connected';
}

/** The table's HTML. */
export function scorecardHtml(card: Scorecard): string {
  const open = Object.entries(card.findings);
  const sum = (k: 'errors' | 'warnings' | 'infos') => open.reduce((n, [, f]) => n + f[k], 0);
  const families = open.filter(([, f]) => f.errors || f.warnings).map(([fam]) => fam);
  const findings =
    `${plural(sum('errors'), 'error')}, ${plural(sum('warnings'), 'warning')}, ${plural(sum('infos'), 'note')}` +
    (families.length ? ` <span class="muted">(${esc(families.join(', '))})</span>` : '') +
    (card.waived ? `; ${card.waived} waived` : '');
  const unknown = Object.entries(card.unknown);
  const rows: [string, string][] = [
    ['Findings', findings],
    ['Not judged', unknown.length ? unknown.map(([code, n]) => `<span class="mono">${esc(code)}</span> ${n}`).join(', ') : 'nothing'],
  ];
  const several = card.boards.length > 1;
  for (const b of card.boards) {
    const sides = b.parts.bottom ? `, parts on both sides` : '';
    rows.push([several ? `Board ${esc(b.name)}` : 'Board', `${b.width_mm} × ${b.height_mm} mm, ${b.layers} layers${sides}; ${routingText(b)}`]);
  }
  return `<table class="kv scorecard"><tbody>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</tbody></table>`;
}
