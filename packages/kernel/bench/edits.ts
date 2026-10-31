/**
 * What one edit costs on saved designs (.twd.json files), and a snapshot of what edits produce.
 *
 *   node --experimental-transform-types --no-warnings packages/kernel/bench/edits.ts <file.twd.json>... [--rounds 5] [--snapshot out.txt]
 *
 * Prints the median time of the edits the app makes most (a symbol dragged, a part dragged on the
 * board, the commit and refresh after each, the board worker's request). With --snapshot, runs a
 * long list of edits instead, and writes a hash per edit of everything they produce: the drawing,
 * the board, the ledger, the view, the checks, the placement, the laid board, what the ops report.
 * Two trees that write the same file behave the same on these designs: compare with diff when
 * changing how something is computed rather than what. Copy the designs first (the app saves into
 * ~/Documents/4k7 while you work), and run one tree twice as a control. Real designs stay out of
 * the repository.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { BoardPart, Design, EditOp, PageView, SheetView, SymbolView } from '@4k7/schema';
import { Kernel } from '../src/index.ts';

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args.splice(i, 2)[1];
};
const snapshotTo = option('--snapshot');
const rounds = Number(option('--rounds') ?? 5);
const designs = args.map((file) => ({ name: basename(file).replace(/\.twd\.json$/, ''), design: JSON.parse(readFileSync(file, 'utf8')) as Design }));

const sha = (v: unknown) => createHash('sha1').update(JSON.stringify(v) ?? 'undefined').digest('hex').slice(0, 12);
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0;
const pageOf = (s: SheetView, sym: SymbolView): PageView => s.pages.find((p) => sym.bbox.x >= p.rect.x && sym.bbox.x <= p.rect.x + p.rect.w && sym.bbox.y >= p.rect.y && sym.bbox.y <= p.rect.y + p.rect.h) ?? s.pages[0]!;

/** A drag of a symbol as the app sends it: its centre so many grid steps on, wires drawn again. */
function dragSymbol(s: SheetView, sym: SymbolView, dx: number, dy: number): EditOp {
  const pg = pageOf(s, sym);
  const at = (v: number, o: number, step: number) => Math.round((v - o) / 100 + step) * 100;
  return { op: 'place_symbol', ref: sym.refdes + (sym.unit ?? ''), page: pg.number, x: at(sym.bbox.x + sym.bbox.w / 2, pg.rect.x, dx), y: at(sym.bbox.y + sym.bbox.h / 2, pg.rect.y, dy), rewire: true };
}

const movable = (p: BoardPart) => !p.componentId.startsWith('hole:') && !p.locked;

/* --------------------------------- timing --------------------------------- */

function timings(name: string, design: Design): void {
  const rows = new Map<string, number[]>();
  const timed = <T>(row: string, run: () => T): T => {
    const t = performance.now();
    const r = run();
    if (!rows.has(row)) rows.set(row, []);
    rows.get(row)!.push(performance.now() - t);
    return r;
  };
  for (let round = 0; round < rounds; round++) {
    const k = timed('new Kernel', () => new Kernel(design));
    timed('state, first', () => k.state());
    const free = k.boardPlacement().parts.find(movable);
    if (free) {
      timed('part drag: transact', () => k.transact({ summary: 'x', ops: [{ op: 'place', ref: free.refdes, x_mm: free.x + 0.5 + round, y_mm: free.y, rot: free.rot as 0 }] }, 'user'));
      timed('part drag: commit and refresh', () => {
        k.accept(undefined, 'user', 'x');
        k.state();
      });
    }
    const view = k.state().view;
    const sheet = view.sheets.find((s) => k.draftDesign().drawing?.[s.id]) ?? view.sheets[0]!;
    const sym = sheet.symbols.find((s) => /^R\d/.test(s.refdes)) ?? sheet.symbols[0];
    if (sym) {
      timed('symbol drag: transact', () => k.transact({ summary: 'x', ops: [dragSymbol(sheet, sym, 1 + round, 0)] }, 'user'));
      timed('symbol drag: commit and refresh', () => {
        k.accept(undefined, 'user', 'x');
        k.state();
      });
    }
    timed('board placed', () => k.boardPlacement());
    timed('board laid', () => k.board());
  }
  console.log(`\n${name}`);
  for (const [row, ms] of rows) console.log(`  ${row.padEnd(34)} ${median(ms.slice(1)).toFixed(0).padStart(6)} ms`);
}

/* -------------------------------- snapshots ------------------------------- */

function snapshot(name: string, design: Design, lines: string[]): void {
  const k = new Kernel(design);
  const snap = (label: string, laid = false) => {
    const d = k.draftDesign();
    const { copper: _c, ...board } = d.board ?? {};
    const s = k.state();
    const p = k.boardPlacement();
    const laidOut = laid ? k.board() : null;
    const { history: _h, nextRedo: _r, ...rest } = s; // (they hold the time)
    lines.push(`${name} | ${label} | drawing ${sha(d.drawing ?? null)} board ${sha(board)} ledger ${sha(d.ledger)} nets ${sha(d.nets)} parts ${sha(d.components)} state ${sha(rest)} placed ${sha(p)}${laidOut ? ` laid ${sha([laidOut.tracks, laidOut.vias, laidOut.zones, laidOut.ratsnest, laidOut.stats, laidOut.diagnostics, laidOut.unrouted])}` : ''}`);
  };
  /** An edit, committed unless it was refused; what it did goes into the snapshot. */
  const edit = (label: string, ops: EditOp[], by: 'user' | 'agent' = 'user') => {
    const r = k.transact({ summary: 'x', ops }, by);
    lines.push(`${name} | ${label} | ${r.status} ${sha(r.results.map((o) => o.effect))} ${sha(r.rejection ?? null)} ${sha(r.introduced)} ${sha(r.resolved)} ${sha(r.counts)}`);
    if (r.status === 'ok') k.accept(undefined, by, 'x');
    snap(`after ${label}`);
  };
  const sheets = () => k.state().view.sheets;
  const symbols = () => sheets().flatMap((s) => s.symbols.map((sym) => ({ s, sym })));

  snap('open', true);

  // symbols dragged, turned and mirrored, on every sheet
  for (const [i, { s, sym }] of symbols().entries()) {
    if (i % 7 !== 0 || i > 100) continue;
    const ref = sym.refdes + (sym.unit ?? '');
    const now = sheets().find((x) => x.id === s.id)?.symbols.find((x) => x.refdes === sym.refdes && x.unit === sym.unit);
    if (!now) continue;
    edit(`drag ${ref}`, [dragSymbol(s, now, 2, 1)]);
    if (i % 3 === 0) edit(`turn ${ref}`, [{ ...dragSymbol(s, now, 0, 0), ...(now.twoPin ? { orient: now.rotation ? 'upright' : 'lying' } : { rotate: 90 }) } as EditOp]);
    if (i % 5 === 0) edit(`mirror ${ref}`, [{ ...dragSymbol(s, now, 0, 0), mirror: !now.mirrored } as EditOp]);
  }

  // what is drawn by hand: labels, wires, erasing, a supply symbol moved, text
  const pinsOf = (sym: SymbolView) => sym.pins.map((p) => `${sym.refdes}${sym.unit ?? ''}.${p.number}`);
  const design0 = () => k.draftDesign();
  const nets = Object.values(design0().nets).sort((a, b) => a.id.localeCompare(b.id));
  for (const [i, net] of nets.entries()) {
    if (i % 9 !== 0) continue;
    const on = symbols().flatMap(({ sym }) => pinsOf(sym).filter((_, j) => design0().components[sym.componentId]?.pins[sym.pins[j]!.number] === net.id));
    if (on.length >= 2) {
      edit(`wire ${net.name}`, [{ op: 'wire', from: on[0]!, to: on[1]! }]);
      edit(`label ${on[0]}`, [{ op: 'label', pin: on[0]! }]);
      edit(`erase ${on[1]}`, [{ op: 'erase', pins: [on[1]!] }]);
    }
  }
  for (const [i, s] of sheets().entries()) {
    const l = s.labels.find((x) => x.kind !== 'net');
    const pg = s.pages[0];
    if (l && pg) edit(`supply on sheet ${i}`, [{ op: 'move_supply', page: pg.number, x: l.x - pg.rect.x, y: l.y - pg.rect.y, to: { x: l.x - pg.rect.x + 200, y: l.y - pg.rect.y } }]);
  }
  for (const { sym } of symbols().filter((_, i) => i % 23 === 0)) edit(`text ${sym.refdes}`, [{ op: 'place_text', ref: sym.refdes + (sym.unit ?? ''), at: 'above' }]);
  edit('text auto', [{ op: 'place_text', auto: true }]);

  // the netlist
  const comps = Object.values(design0().components).sort((a, b) => a.id.localeCompare(b.id));
  const resistor = comps.find((c) => c.params.resistance);
  if (resistor) edit(`value ${resistor.refdes}`, [{ op: 'set_param', ref: resistor.refdes, params: { resistance: '47k' } }]);
  const two = comps.find((c) => Object.keys(c.pins).length === 2);
  if (two) {
    const pin = Object.keys(two.pins)[0]!;
    const net = design0().nets[two.pins[pin]!]!;
    edit(`disconnect ${two.refdes}.${pin}`, [{ op: 'disconnect', pins: [`${two.refdes}.${pin}`] }]);
    edit(`connect ${two.refdes}.${pin}`, [{ op: 'connect', pins: [`${two.refdes}.${pin}`], net: net.name }]);
    edit(`rename ${two.refdes}`, [{ op: 'rename', ref: two.refdes, refdes: `${two.refdes}9` }]);
  }
  const named = nets.find((n) => !n.attrs.voltage);
  if (named) edit(`voltage ${named.name}`, [{ op: 'set_net', net: named.name, voltage: 3.3 }]);
  edit('add a part', [{ op: 'add_part', part: 'generic:R', params: { resistance: '1k' } }] as EditOp[]);
  const last = comps.at(-1);
  if (last) edit(`remove ${last.refdes}`, [{ op: 'remove', ref: last.refdes }]);

  // parts on the board
  const placed = k.boardPlacement().parts.filter(movable);
  for (const p of placed.filter((_, i) => i % 11 === 0).slice(0, 10)) {
    edit(`place ${p.refdes}`, [{ op: 'place', ref: p.refdes, x_mm: p.x + 0.5, y_mm: p.y + 0.3, rot: p.rot as 0 }]);
    const now = k.boardPlacement().parts.find((q) => q.refdes === p.refdes);
    if (now) edit(`turn ${p.refdes} on the board`, [{ op: 'place', ref: p.refdes, x_mm: now.x, y_mm: now.y, rot: ((now.rot + 90) % 360) as 0 }]);
  }
  snap('parts placed', true);

  // copper by hand, when it is drawn
  const drawn = design0().board?.drawn;
  if (drawn?.tracks.length) {
    const t = drawn.tracks[Math.floor(drawn.tracks.length / 2)]!;
    edit(`draw a via on ${t.id}`, [{ op: 'draw_via', net: t.netId, at: [t.pts[0]!, t.pts[1]!] }] as EditOp[], 'agent');
    edit(`erase ${t.id}`, [{ op: 'erase_copper', ids: [t.id] }] as EditOp[], 'agent');
    snap('copper edited', true);
  }

  // going back, and proposals: taken in part, rejected
  k.undo();
  k.undo();
  k.redo();
  snap('undo undo redo');
  const net = nets[0];
  if (net) {
    const value = resistor && k.draftDesign().components[resistor.id];
    const r = k.transact({ summary: 'x', ops: [{ op: 'set_net', net: k.draftDesign().nets[net.id]?.name ?? net.name, voltage: 5 }, ...(value ? [{ op: 'set_param' as const, ref: value.refdes, params: { resistance: '22k' } }] : [])] }, 'agent');
    lines.push(`${name} | proposal | ${r.status} ${sha(r.diff)}`);
    snap('with a proposal');
    const hunks = k.state().proposal?.hunks ?? [];
    if (hunks.length > 1) {
      k.accept([hunks[0]!.id], 'agent', 'x');
      snap('proposal taken in part');
    }
    k.reject();
    snap('proposal rejected');
  }
}

if (snapshotTo) {
  const lines: string[] = [];
  for (const { name, design } of designs) snapshot(name, design, lines);
  writeFileSync(snapshotTo, lines.join('\n') + '\n');
  console.log(`${snapshotTo}: ${lines.length} lines`);
} else {
  for (const { name, design } of designs) timings(name, design);
}
