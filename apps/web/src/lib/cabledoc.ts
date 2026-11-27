/**
 * The design document's cable section: for each cable or wire mate, a table for whoever makes or
 * buys it: both ends with their boards, the kind and length, and pin to pin with the nets, the pins
 * that meet another net marked. The table comes from the kernel (cableTable in mates.ts); see
 * docs/design/multi-board.md §4.
 */
import type { CableEntry, CableRow } from '@4k7/kernel';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The section's HTML, or null when the design has no cables or wires (the section is left out). */
export function cableHtml(table: CableEntry[] | null): string | null {
  if (!table?.length) return null;
  const pin = (ref: string, p: CableRow['a']) => `${ref}.${p.number}${p.name !== p.number ? ` ${p.name}` : ''}`;
  const cables = table.map((c) => {
    const kind = c.kind === 'cable' ? `cable, ${c.cable ?? 'straight'}` : 'wires';
    const length = c.length_mm ? `${c.length_mm} mm` : 'length not set';
    const rows = c.rows.map((r) => {
      const far = esc(pin(c.b.refdes, r.b));
      const bad = r.mismatch ? `<br><b style="color:#b91c1c">mismatch: ${far} is on ${r.mismatch.net === null ? 'no net' : esc(r.mismatch.net)}</b>` : '';
      return `<tr><td class="mono">${esc(pin(c.a.refdes, r.a))}</td><td class="mono">${r.net === null ? '<span class="muted">no net</span>' : esc(r.net)}</td><td><span class="mono">${far}</span>${bad}</td></tr>`;
    });
    return (
      `<h3>${esc(`${c.a.refdes} (${c.a.board}) ↔ ${c.b.refdes} (${c.b.board})`)}</h3>` +
      `<p class="muted">${kind}, ${length}; <span class="mono">${esc(c.a.part)}</span> to <span class="mono">${esc(c.b.part)}</span></p>` +
      `<table><thead><tr><th>Pin A</th><th>Net</th><th>Pin B</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
    );
  });
  return `<p>Each cable and set of wires between the boards, pin to pin, for whoever makes or buys it. A row marked mismatch joins two nets or leaves one open at the far end: check the cable's direction before ordering it.</p>${cables.join('')}`;
}
