/**
 * The design document's bring-up section: the rails in power-up order with the voltage to expect
 * and where to probe, then the steps at the bench. The plan comes from the kernel (bringup.ts), one of
 * the whole design: on several boards a Board column names each rail's boards and the mates it crosses;
 * see docs/design/layout.md §4.
 */
import type { BringUpPlan } from '@4k7/schema';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const amps = (a: number) => (a < 1 ? `${Math.round(a * 1000)} mA` : `${+a.toFixed(2)} A`);

/** The section's HTML, or null when the design has no supply rails (the section is left out). */
export function bringUpHtml(plan: BringUpPlan | null): string | null {
  if (!plan?.rails.length) return null;
  const multi = plan.rails.some((r) => r.boards);
  const on = (b?: string) => (b ? ` <span class="muted">on ${esc(b)}</span>` : '');
  const rows = plan.rails.map((r, i) => {
    const probe = r.testPoints.length
      ? r.testPoints.map((t) => `<b>${esc(t.ref)}</b> <span class="mono">${esc(t.label)}</span>${on(t.board)}`).join(', ')
      : `<span class="muted">no test point${r.probeAt ? ` — probe at <span class="mono">${esc(r.probeAt)}</span>${r.probeBoard ? ` on ${esc(r.probeBoard)}` : ''}` : ''}</span>`;
    const crosses = (r.crosses ?? []).map((x) => `<br><span class="muted">reaches ${esc(x.board)} through ${esc(x.through)}, ${x.pins} pin${x.pins === 1 ? '' : 's'}</span>`).join('');
    const board = multi ? `<td>${esc((r.boards ?? []).join(', '))}${crosses}</td>` : '';
    const limit = !r.supply ? '' : r.supply.limit_a === 'unknown' ? 'unknown — start low' : amps(r.supply.limit_a);
    return (
      `<tr><td class="n">${i + 1}</td><td class="mono">${esc(r.net)}</td>${board}<td class="n">${r.voltage === 'unknown' ? 'unknown' : `${r.voltage} V`}</td>` +
      `<td>${esc(r.source)}</td><td>${probe}</td><td class="n">${limit}</td></tr>`
    );
  });
  return (
    `<p>Power the rails up in this order, checking each before the next. Set the bench supply's current limit as given for the rails that come in from outside: 1.5 × the current the board is expected to draw, from the loads stated (else the rails' maximum current), rounded up to 10 mA; a switching regulator is taken at 80 % efficiency. Where the current is not known, no number is given.${multi ? ' One sheet for all the boards, in one power-up order: the Board column says where each rail is and where it crosses to another board (check it there too).' : ''}</p>` +
    `<table><thead><tr><th class="n">#</th><th>Rail</th>${multi ? '<th>Board</th>' : ''}<th class="n">Expect</th><th>Made by</th><th>Probe at</th><th class="n">Current limit</th></tr></thead><tbody>${rows.join('')}</tbody></table>` +
    `<h3>At the bench</h3><ol>${plan.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`
  );
}
