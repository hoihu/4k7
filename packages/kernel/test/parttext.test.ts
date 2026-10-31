import { describe, expect, it } from 'vitest';
import { PAGE, type PartCard, type Rect, type ScopeInfo, type SheetView, type SymbolView } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { movesParts } from '../src/copperops.ts';
import { bodyOf, clashWords, clearTexts, placeTexts, textOverlaps, within } from '../src/parttext.ts';
import { textRect } from '../src/scene.ts';
import { segments } from '../src/scope.ts';

/**
 * The drawing it was asked for: two resistors lying in neighbouring rows of two connectors, with a
 * row 200 mils above the upper one and one 200 mils below the lower one. R7's name stands on the
 * row above, R8's value on R7's row, and neither pair has the height of a stack on its other side.
 */
const rows = [
  { op: 'add_part', part: 'generic:CONN_1x6', refdes: 'J1' },
  { op: 'add_part', part: 'generic:CONN_1x6', refdes: 'J2' },
  { op: 'add_part', part: 'generic:R', refdes: 'R7', params: { resistance: '27' } },
  { op: 'add_part', part: 'generic:R', refdes: 'R8', params: { resistance: '27' } },
  { op: 'connect', pins: ['J1.1', 'J2.1'], net: 'TOP' },
  { op: 'connect', pins: ['J1.3', 'R7.1'], net: 'A' },
  { op: 'connect', pins: ['R7.2', 'J2.3'], net: 'B' },
  { op: 'connect', pins: ['J1.4', 'R8.1'], net: 'C' },
  { op: 'connect', pins: ['R8.2', 'J2.4'], net: 'D' },
  { op: 'connect', pins: ['J1.6', 'J2.6'], net: 'BOTTOM' },
];

const sheetOf = (k: Kernel): SheetView => k.state().view.sheets[0]!;
const sym = (k: Kernel, ref: string) => sheetOf(k).symbols.find((s) => s.refdes === ref)!;
const edit = (k: Kernel, ops: unknown[], by?: 'user') => k.transact({ summary: 'edit', ops } as never, by);
function ok(k: Kernel, ops: unknown[], by?: 'user') {
  const r = edit(k, ops, by);
  expect(r.status, JSON.stringify(r)).toBe('ok');
  return r.results[0]!.effect;
}
const findings = (k: Kernel) => k.state().diagnostics.filter((d) => d.code === 'SCH.TEXT_OVERLAP');
const page = (k: Kernel) => sheetOf(k).pages[0]!.rect;

function scene() {
  const k = new Kernel();
  ok(k, rows);
  ok(k, [
    { op: 'place_symbol', ref: 'J1', page: 1, x: 2000, y: 3000 },
    { op: 'place_symbol', ref: 'J2', page: 1, x: 9000, y: 3000, mirror: true },
  ]);
  const y = (pin: string) => sym(k, 'J1').pins.find((p) => p.number === pin)!.y - page(k).y;
  ok(k, [
    { op: 'place_symbol', ref: 'R7', page: 1, x: 5000, y: y('3'), orient: 'lying' },
    { op: 'place_symbol', ref: 'R8', page: 1, x: 5600, y: y('4'), orient: 'lying' },
    { op: 'wire', from: 'J1.1', to: 'J2.1' },
    { op: 'wire', from: 'J1.3', to: 'R7.1' },
    { op: 'wire', from: 'R7.2', to: 'J2.3' },
    { op: 'wire', from: 'J1.4', to: 'R8.1' },
    { op: 'wire', from: 'R8.2', to: 'J2.4' },
    { op: 'wire', from: 'J1.6', to: 'J2.6' },
  ]);
  return k;
}

const crossesWire = (s: SheetView, r: Rect) =>
  s.wires.some((w) => segments(w.pts).some(([x1, y1, x2, y2]) => Math.max(x1, x2) >= r.x && Math.min(x1, x2) <= r.x + r.w && Math.max(y1, y2) > r.y && Math.min(y1, y2) < r.y + r.h));
const boxes = (s: SymbolView) => [textRect(s.refPos, [s.refdes]), textRect(s.valuePos, s.valueLines ?? [s.value])];
/** What must not change when only text moves. */
const drawn = (k: Kernel) => JSON.stringify({ wires: sheetOf(k).wires, labels: sheetOf(k).labels, parts: sheetOf(k).symbols.map((s) => [s.refdes, s.bbox, s.pins, s.rotation ?? 0]) });

describe('a name or value in the way', () => {
  it('is reported, with the op that fixes it', () => {
    const k = scene();
    const found = findings(k);
    expect(found.map((d) => d.message)).toEqual(expect.arrayContaining(["R7's name runs through a wire of TOP", "R8's value runs through a wire of B"]));
    const r7 = found.find((d) => d.message.startsWith('R7'))!;
    expect(r7).toMatchObject({ severity: 'warning', entities: ['R7', 'R7.name', 'net:TOP'], fixHints: [{ op: 'place_text', ref: 'R7', auto: true }] });
  });

  it('counts a part and another part\'s text too, the two texts once', () => {
    const k = scene();
    const s = sheetOf(k);
    const [r7, r8] = [sym(k, 'R7'), sym(k, 'R8')];
    const bare = { ...s, wires: [], labels: [] };
    const onText = { ...bare, symbols: [{ ...r7, refPos: { ...r8.refPos } }, r8] };
    expect(textOverlaps(onText).map((c) => [c.sym.refdes, c.which, c.hit.on])).toEqual([['R7', 'name', 'text']]);
    const onPart = { ...bare, symbols: [{ ...r7, valuePos: { x: r8.bbox.x + 100, y: r8.bbox.y + 110, anchor: 'start' as const } }, r8] };
    expect(textOverlaps(onPart).map((c) => [c.sym.refdes, c.which, c.hit.on])).toEqual([['R7', 'value', 'symbol']]);
  });
});

describe('place_text auto', () => {
  it('sets the pair side by side where a stack does not fit, and moves nothing else', () => {
    const k = scene();
    const before = drawn(k);
    const effect = ok(k, [{ op: 'place_text', auto: true }]);
    expect(effect).toContain('R7 side by side above');
    expect(effect).toContain('R8 side by side below');
    const [r7, r8] = [sym(k, 'R7'), sym(k, 'R8')];
    expect(r7.refPos.y).toBe(r7.valuePos.y);
    expect(r7.refPos.y).toBeLessThan(r7.bbox.y + r7.bbox.h / 2);
    expect(r7.refPos.x).toBeLessThan(r7.valuePos.x);
    expect(r8.refPos.y).toBe(r8.valuePos.y);
    expect(r8.refPos.y).toBeGreaterThan(r8.bbox.y + r8.bbox.h / 2);
    for (const s of [r7, r8]) for (const r of boxes(s)) expect(crossesWire(sheetOf(k), r)).toBe(false);
    expect(findings(k)).toEqual([]);
    expect(drawn(k)).toBe(before);
  });

  it('leaves clear text where it is, and says so', () => {
    const k = scene();
    ok(k, [{ op: 'place_text', auto: true }]);
    const at = JSON.stringify([sym(k, 'R7').refPos, sym(k, 'J1').refPos]);
    expect(ok(k, [{ op: 'place_text', auto: true }])).toBe('no name or value moved');
    expect(JSON.stringify([sym(k, 'R7').refPos, sym(k, 'J1').refPos])).toBe(at);
  });

  it('keeps to the parts or the sheet it is given', () => {
    const k = scene();
    const r8 = JSON.stringify(sym(k, 'R8').refPos);
    expect(ok(k, [{ op: 'place_text', ref: 'R7', auto: true }])).toContain('R7 side by side');
    expect(JSON.stringify(sym(k, 'R8').refPos)).toBe(r8);
    expect(ok(k, [{ op: 'place_text', refs: ['R8'], auto: true }])).toContain('R8 side by side');
    const again = scene();
    expect(ok(again, [{ op: 'place_text', sheet: 'main', auto: true }])).toContain('R8 side by side');
    expect(edit(again, [{ op: 'place_text', sheet: 'Nope', auto: true }]).status).toBe('rejected');
  });

  it('says when no spot is clear, and leaves the text', () => {
    const k = scene();
    const s = sheetOf(k);
    const r7 = sym(k, 'R7');
    const c = { x: r7.bbox.x + r7.bbox.w / 2, y: r7.bbox.y + r7.bbox.h / 2 };
    // a thicket of wires round the part
    const thicket = Array.from({ length: 60 }, (_, i) => ({ netId: 'x', pts: [c.x - 3000, c.y - 1500 + i * 50 + 25, c.x + 3000, c.y - 1500 + i * 50 + 25] }));
    const dense = { ...s, wires: thicket, labels: [], symbols: [r7], blocks: [] };
    const at = r7.refPos;
    const out = clearTexts(dense);
    expect(out.moved).toEqual([]);
    expect(out.stuck.map((x) => x.which)).toContain('name');
    expect(r7.refPos).toBe(at);
  });

  it('never leaves its page', () => {
    const k = scene();
    const r7 = sym(k, 'R7');
    const mid = r7.bbox.y + r7.bbox.h / 2;
    // the page's frame just above the part: only the room below it is on the page
    const top = mid - 60;
    const near = { ...sheetOf(k), wires: [{ netId: 'x', pts: [r7.bbox.x - 500, mid - 200, r7.bbox.x + 900, mid - 200] }], labels: [], symbols: [r7], blocks: [], pages: [{ number: 1, name: '', rect: { x: r7.bbox.x - 3000, y: top - PAGE.margin, w: 8000, h: 8000 } }] };
    expect(clearTexts(near).moved.map((m) => m.side)).toEqual(['below']);
    for (const r of boxes(r7)) expect(r.y).toBeGreaterThanOrEqual(top);
  });

  it('puts no wire between a part and its text', () => {
    const k = scene();
    const r8 = sym(k, 'R8');
    const mid = r8.bbox.y + r8.bbox.h / 2;
    // one wire through its stack, one just above its body: a line of text would fit between them, but read as the wire's
    const across = (y: number) => ({ netId: 'x', pts: [r8.bbox.x - 900, y, r8.bbox.x + 1300, y] });
    const lone = { ...sheetOf(k), wires: [across(mid - 200), across(mid - 50)], labels: [], symbols: [r8], blocks: [] };
    expect(clearTexts(lone).moved.map((m) => m.side)).toEqual(['below']);
  });

  it('keeps inside its block\'s frame, and off its title', () => {
    const k = scene();
    const r7 = sym(k, 'R7');
    const mid = r7.bbox.y + r7.bbox.h / 2;
    const across = (y: number) => ({ netId: 'x', pts: [r7.bbox.x - 900, y, r7.bbox.x + 1300, y] });
    const lone = { ...sheetOf(k), wires: [across(mid - 200), across(mid - 100)], labels: [], symbols: [r7] };
    // above is taken: below is all that is left, unless the frame ends right under the part
    const room = (h: number) => ({ ...lone, blocks: [{ title: '', rect: { x: r7.bbox.x - 900, y: mid - 500, w: 2200, h } }] });
    expect(clearTexts(room(560)).moved).toEqual([]);
    expect(clearTexts(room(1500)).moved.map((m) => m.side)).toEqual(['below']);

    // a stack through a wire, a line above it: its place is taken by the frame's title, so it goes below
    const fresh = sym(k, 'R8');
    const m8 = fresh.bbox.y + fresh.bbox.h / 2;
    const titled = { ...sheetOf(k), wires: [{ netId: 'x', pts: [fresh.bbox.x - 900, m8 - 200, fresh.bbox.x + 1300, m8 - 200] }], labels: [], symbols: [fresh], blocks: [{ title: 'A BLOCK WITH A LONG TITLE', rect: { x: fresh.bbox.x - 900, y: m8 - 200, w: 3000, h: 800 } }] };
    expect(clearTexts(titled).moved.map((m) => m.side)).toEqual(['below']);
  });

  it('leaves a sheet the layout draws to the layout', () => {
    const k = new Kernel();
    ok(k, rows);
    expect(ok(k, [{ op: 'place_text', auto: true }])).toContain('drawn by the auto-layout, which keeps its text clear itself: Main');
    expect(k.draftDesign().drawing).toBeUndefined();
  });
});

describe('place_text at and arrange', () => {
  it('sets a pair side by side where it stands', () => {
    const k = scene();
    expect(ok(k, [{ op: 'place_text', ref: 'R7', arrange: 'side_by_side' }])).toContain('R7: name and value side by side above');
    const r7 = sym(k, 'R7');
    expect(r7.refPos.y).toBe(r7.valuePos.y);
    // the name ends where the value begins, so a longer name or value keeps off the other
    expect(r7.refPos).toMatchObject({ anchor: 'end', x: r7.valuePos.x - 50 });
    expect(r7.valuePos.anchor).toBe('start');
    const centre = r7.bbox.x + r7.bbox.w / 2;
    expect(Math.abs((r7.refPos.x + r7.valuePos.x) / 2 - centre)).toBeLessThan(10);
  });

  it('puts a pair on any side, keeping how it stands unless asked', () => {
    const k = scene();
    const r7 = () => sym(k, 'R7');
    const mid = () => r7().bbox.y + r7().bbox.h / 2;
    ok(k, [{ op: 'place_text', ref: 'R7', at: 'below' }]);
    expect(r7().refPos.y).toBeGreaterThan(mid());
    expect(r7().valuePos.y).toBeGreaterThan(r7().refPos.y);
    ok(k, [{ op: 'place_text', ref: 'R7', arrange: 'side_by_side' }]);
    expect(r7().refPos.y).toBeGreaterThan(mid());
    expect(r7().refPos.y).toBe(r7().valuePos.y);
    ok(k, [{ op: 'place_text', ref: 'R7', at: 'above' }]);
    expect(r7().refPos.y).toBeLessThan(mid());
    expect(r7().refPos.y).toBe(r7().valuePos.y);
  });

  it('sets a pair side by side on the side of a standing part, off its axis', () => {
    const k = scene();
    ok(k, [{ op: 'place_symbol', ref: 'R7', page: 1, x: 5000, y: 6000, orient: 'upright' }]);
    const axis = () => sym(k, 'R7').bbox.x + sym(k, 'R7').bbox.w / 2;
    ok(k, [{ op: 'place_text', ref: 'R7', at: 'left', arrange: 'side_by_side' }]);
    const s = sym(k, 'R7');
    expect(s.refPos.y).toBe(s.valuePos.y);
    expect(s.refPos.x).toBeLessThan(s.valuePos.x);
    for (const r of boxes(s)) expect(r.x + r.w).toBeLessThan(axis());
    ok(k, [{ op: 'place_text', ref: 'R7', at: 'right' }]);
    for (const r of boxes(sym(k, 'R7'))) expect(r.x).toBeGreaterThan(axis());
  });

  it('puts both on the left of a standing part, right aligned to it, on several parts at once', () => {
    const k = scene();
    ok(k, [
      { op: 'place_symbol', ref: 'R7', page: 1, x: 5000, y: 6000, orient: 'upright' },
      { op: 'place_symbol', ref: 'R8', page: 1, x: 7000, y: 6000, orient: 'upright' },
    ]);
    expect(ok(k, [{ op: 'place_text', refs: ['R7', 'R8'], at: 'left' }])).toContain('R8: name and value stacked on the left');
    for (const ref of ['R7', 'R8']) {
      const s = sym(k, ref);
      expect(s.refPos).toMatchObject({ anchor: 'end', x: s.valuePos.x });
      expect(s.refPos.x).toBeLessThan(s.bbox.x + s.bbox.w / 2);
    }
  });

  it('slides along the side to keep clear of the part\'s own lead', () => {
    const k = scene();
    const r7 = sym(k, 'R7');
    const lead = r7.bbox.y + r7.bbox.h / 2;
    // no wire to keep it off the line of the lead: the lead itself does
    const to = placeTexts({ ...sheetOf(k), wires: [], labels: [], symbols: [r7], blocks: [] }, r7, { side: 'left' });
    expect(to).toMatchObject({ side: 'left', clashes: [] });
    for (const r of boxes(r7)) expect(r.y + r.h).toBeLessThanOrEqual(lead);
  });

  it('reports text on the part\'s own pin, in those words', () => {
    const k = scene();
    const r7 = sym(k, 'R7');
    const lead = r7.pins[0]!;
    const on = { ...r7, valuePos: { x: lead.x + 10, y: lead.y + 30, anchor: 'start' as const } };
    const found = textOverlaps({ ...sheetOf(k), wires: [], labels: [], symbols: [on], blocks: [] });
    expect(found.map((c) => clashWords(c, (n) => n))).toEqual(["R7's value runs through its own pin"]);
  });

  it('says what the text still runs into', () => {
    const k = scene();
    expect(ok(k, [{ op: 'place_text', ref: 'R8', at: 'above', arrange: 'side_by_side' }])).toContain("R8's name runs through a wire of B");
    expect(findings(k).map((d) => d.message)).toContain("R8's name runs through a wire of B");
  });

  it('finds a part added earlier in the transaction', () => {
    const k = scene();
    ok(k, [
      { op: 'add_part', part: 'generic:R', refdes: 'R9', params: { resistance: '1k' } },
      { op: 'connect', pins: ['R9.1', 'R9.2'], net: 'LOOP' },
      { op: 'place_text', ref: 'R9', at: 'left' },
    ]);
    expect(sym(k, 'R9').refPos.anchor).toBe('end');
  });

  it('makes a sheet the layout draws yours, and says so', () => {
    const k = new Kernel();
    ok(k, rows);
    expect(ok(k, [{ op: 'place_text', ref: 'R7', at: 'below' }])).toContain('sheet Main is drawn as you arrange it from now on');
    expect(k.draftDesign().drawing?.[sheetOf(k).id]).toBeDefined();
  });
});

describe('place_text with exact spots', () => {
  it('moves each text on its own, in page coordinates, its anchor kept unless given', () => {
    const k = scene();
    const v = sym(k, 'R7').valuePos;
    const anchor = sym(k, 'R7').refPos.anchor;
    expect(ok(k, [{ op: 'place_text', ref: 'R7', name: { x: 4000, y: 2000 } }])).toContain('R7: name at (4000, 2000)');
    const p = page(k);
    expect(sym(k, 'R7').refPos).toEqual({ x: p.x + 4000, y: p.y + 2000, anchor });
    expect(sym(k, 'R7').valuePos).toEqual(v);
    ok(k, [{ op: 'place_text', ref: 'R7', value: { x: 4100, y: 2200, anchor: 'end' } }]);
    expect(sym(k, 'R7').valuePos).toEqual({ x: p.x + 4100, y: p.y + 2200, anchor: 'end' });
    expect(sym(k, 'R7').refPos.y).toBe(p.y + 2000);
  });

  it('counts from the paper of the page the part stands on', () => {
    const k = scene();
    ok(k, [{ op: 'place_symbol', ref: 'R7', page: 2, x: 3000, y: 3000 }]);
    const p2 = sheetOf(k).pages[1]!.rect;
    expect(p2.x).toBeGreaterThan(0);
    ok(k, [{ op: 'place_text', ref: 'R7', value: { x: 2500, y: 2500 } }]);
    expect(sym(k, 'R7').valuePos).toMatchObject({ x: p2.x + 2500, y: p2.y + 2500 });
    const q = k.query({ op: 'get_schematic', texts: true } as never) as { symbols: { ref: string; page: number; value?: { x: number; y: number } }[] };
    expect(q.symbols.find((s) => s.ref === 'R7')).toMatchObject({ page: 2, value: { x: 2500, y: 2500 } });
  });

  it('stays on the part\'s page', () => {
    const k = scene();
    const r = edit(k, [{ op: 'place_text', ref: 'R7', name: { x: 40000, y: 2000 } }]);
    expect(r.status).toBe('rejected');
    expect(JSON.stringify(r)).toContain('would leave the drawing area of page 1');
  });

  it('takes one way at a time, and exact spots for one part', () => {
    const k = scene();
    const code = (op: object) => (edit(k, [{ op: 'place_text', ...op }]) as { rejection?: { code: string } }).rejection?.code;
    expect(code({ ref: 'R7' })).toBe('INVALID_OP');
    expect(code({ at: 'above' })).toBe('INVALID_OP');
    expect(code({ ref: 'R7', at: 'above', auto: true })).toBe('INVALID_OP');
    expect(code({ ref: 'R7', at: 'above', name: { x: 4000, y: 2000 } })).toBe('INVALID_OP');
    expect(code({ refs: ['R7', 'R8'], name: { x: 4000, y: 2000 } })).toBe('INVALID_OP');
    expect(code({ ref: 'R99', at: 'above' })).toBe('REF_UNKNOWN');
  });
});

describe('text and the rest of the drawing', () => {
  it('goes along when its part moves, as it stood', () => {
    const k = scene();
    ok(k, [{ op: 'place_text', ref: 'R7', at: 'below', arrange: 'side_by_side' }]);
    const a = sym(k, 'R7');
    ok(k, [{ op: 'place_symbol', ref: 'R7', page: 1, x: 5000, y: 6000 }]);
    const b = sym(k, 'R7');
    const dy = b.bbox.y - a.bbox.y;
    expect(b.refPos).toEqual({ ...a.refPos, x: a.refPos.x + b.bbox.x - a.bbox.x, y: a.refPos.y + dy });
    expect(b.valuePos.y).toBe(a.valuePos.y + dy);
  });

  it('comes back where the symbol has it when the part is turned, stays when a two-pin part swaps its ends', () => {
    const k = scene();
    ok(k, [{ op: 'place_text', ref: 'R7', name: { x: 4000, y: 2000 } }], 'user');
    const at = sym(k, 'R7').refPos;
    const c = { x: sym(k, 'R7').bbox.x + 200 - page(k).x, y: sym(k, 'R7').bbox.y + 100 - page(k).y };
    ok(k, [{ op: 'place_symbol', ref: 'R7', page: 1, ...c, mirror: !sym(k, 'R7').mirrored }], 'user');
    expect(sym(k, 'R7').refPos).toEqual(at);
    expect(sym(k, 'R7').textBy).toBe('user');
    ok(k, [{ op: 'place_symbol', ref: 'R7', page: 1, ...c, orient: 'upright' }], 'user');
    expect(sym(k, 'R7').refPos).not.toEqual(at);
    expect(sym(k, 'R7').textBy).toBeUndefined();
  });

  it('survives saving and loading', () => {
    const k = scene();
    ok(k, [{ op: 'place_text', ref: 'R7', name: { x: 4000, y: 2000 } }], 'user');
    k.accept(undefined, 'user', 'edit');
    const again = new Kernel();
    again.load(JSON.parse(JSON.stringify(k.committedDesign())));
    expect(sym(again, 'R7').refPos).toEqual(sym(k, 'R7').refPos);
    expect(sym(again, 'R7').textBy).toBe('user');
  });

  it('is one undo step for the user', () => {
    const k = scene();
    k.accept();
    const at = sym(k, 'R7').refPos;
    ok(k, [{ op: 'place_text', ref: 'R7', name: { x: 4000, y: 2000 } }], 'user');
    k.accept(undefined, 'user', "Move R7's name");
    expect(sym(k, 'R7').refPos).not.toEqual(at);
    k.undo();
    expect(sym(k, 'R7').refPos).toEqual(at);
  });

  it('is told apart in a changeset', () => {
    const k = scene();
    k.accept();
    ok(k, [{ op: 'place_text', ref: 'R7', at: 'below' }]);
    const hunk = k.proposal()?.hunks.find((h) => h.kind === 'drawing');
    expect(hunk?.details).toEqual(['name or value moved: R7']);
  });

  it('moves no part, so drawn copper needs no following', () => {
    expect(movesParts({ op: 'place_text', ref: 'R7', auto: true } as never)).toBe(false);
  });
});

describe('text the user put somewhere', () => {
  it('is theirs: auto leaves it, get_schematic marks it, and the agent\'s own placement says so', () => {
    const k = scene();
    ok(k, [{ op: 'place_text', ref: 'R7', name: { x: 4000, y: 2000 } }], 'user');
    expect(sym(k, 'R7').textBy).toBe('user');
    const at = sym(k, 'R7').refPos;
    const onTop = sym(k, 'R7').valuePos;
    ok(k, [{ op: 'place_text', auto: true }]);
    expect(sym(k, 'R7').refPos).toEqual(at);
    expect(sym(k, 'R7').valuePos).toEqual(onTop);
    const q = k.query({ op: 'get_schematic' } as never) as { symbols: { ref: string; text_user_placed?: boolean }[] };
    expect(q.symbols.find((s) => s.ref === 'R7')?.text_user_placed).toBe(true);
    expect(ok(k, [{ op: 'place_text', ref: 'R7', at: 'below' }])).toContain("R7's text was the user's placement; now yours");
    expect(sym(k, 'R7').textBy).toBeUndefined();
  });

  it('auto says what stays in the way because the user put it there', () => {
    const k = scene();
    const y = sym(k, 'R7').refPos.y - page(k).y;
    const x = sym(k, 'R7').refPos.x - page(k).x;
    ok(k, [{ op: 'place_text', ref: 'R7', name: { x, y } }], 'user');
    expect(ok(k, [{ op: 'place_text', ref: 'R7', auto: true }])).toContain("left where the user put them: R7's name runs through a wire of TOP");
  });
});

describe('Optimize', () => {
  const around = (k: Kernel, refs: string[]) => {
    const bs = sheetOf(k).symbols.filter((s) => refs.includes(s.refdes)).map((s) => s.bbox);
    const x = Math.min(...bs.map((b) => b.x)) - 400;
    const y = Math.min(...bs.map((b) => b.y)) - 400;
    return { x, y, w: Math.max(...bs.map((b) => b.x + b.w)) + 400 - x, h: Math.max(...bs.map((b) => b.y + b.h)) + 400 - y };
  };
  const refused = (k: Kernel, op: object) => {
    const r = edit(k, [{ op: 'place_text', ...op }]) as { status: string; rejection?: { code: string } };
    return r.status === 'rejected' ? r.rejection?.code : 'ok';
  };

  it('counts text of its parts in the overlaps, and lets it move inside the area', () => {
    const k = scene();
    const info = k.setScope({ view: 'schematic', sheet: sheetOf(k).id, rect: around(k, ['R7', 'R8']) }) as ScopeInfo;
    expect(info.free).toEqual(['R7', 'R8']);
    expect(info.measures.overlaps).toBe(2);
    const r = edit(k, [{ op: 'place_text', refs: ['R7', 'R8'], auto: true }]) as { status: string; scope?: { measures: { overlaps: number }; ripple: string[] } };
    expect(r.status).toBe('ok');
    expect(r.scope?.measures.overlaps).toBe(0);
    expect(r.scope?.ripple).toEqual([]);
    k.setScope(null);
  });

  it('keeps to the area and to what the user put somewhere', () => {
    const k = scene();
    ok(k, [{ op: 'place_text', ref: 'R8', name: { x: 6000, y: 4000 } }], 'user');
    k.setScope({ view: 'schematic', sheet: sheetOf(k).id, rect: around(k, ['R7', 'R8']) });
    expect(refused(k, { auto: true })).toBe('OUT_OF_SCOPE');
    expect(refused(k, { ref: 'J1', auto: true })).toBe('OUT_OF_SCOPE');
    expect(refused(k, { ref: 'R8', at: 'below' })).toBe('OUT_OF_SCOPE');
    expect(refused(k, { ref: 'R8', auto: true })).toBe('ok');
    expect(refused(k, { ref: 'R7', at: 'below' })).toBe('ok');
    k.setScope(null);
  });
});

describe('units of a split symbol', () => {
  const split = () => {
    const k = new Kernel();
    const d = k.committedDesign();
    d.parts['acme:DUAL'] = {
      id: 'acme:DUAL',
      mpn: 'acme:DUAL',
      description: 'dual',
      category: 'ic',
      refPrefix: 'U',
      pins: [
        { number: '1', name: 'A1', type: 'in' },
        { number: '2', name: 'A2', type: 'out' },
        { number: '3', name: 'B1', type: 'in' },
        { number: '4', name: 'B2', type: 'out' },
      ],
      units: [{ name: 'A', title: 'A', layout: { left: [['1']], right: [['2']], top: [], bottom: [] } }, { name: 'B', title: 'B', layout: { left: [['3']], right: [['4']], top: [], bottom: [] } }],
      params: {},
      provenance: { source: 'datasheet' },
    };
    k.load(d);
    ok(k, [{ op: 'add_part', part: 'acme:DUAL', refdes: 'U1' }]);
    ok(k, [{ op: 'place_symbol', ref: 'U1A', page: 1, x: 3000, y: 3000 }]);
    return k;
  };
  const of = (k: Kernel, unit: string) => sheetOf(k).symbols.find((s) => s.unit === unit)!;

  it('takes one unit by its name, every unit by the part\'s', () => {
    const k = split();
    const b = of(k, 'B').refPos;
    expect(ok(k, [{ op: 'place_text', ref: 'U1A', at: 'below' }])).toContain('U1A: name and value');
    expect(of(k, 'B').refPos).toEqual(b);
    const effect = ok(k, [{ op: 'place_text', ref: 'U1', at: 'below' }]);
    expect(effect).toContain('U1A');
    expect(effect).toContain('U1B');
  });

  it('asks which unit for an exact spot', () => {
    const k = split();
    const r = edit(k, [{ op: 'place_text', ref: 'U1', name: { x: 3000, y: 2000 } }]);
    expect(r.status).toBe('rejected');
    expect(JSON.stringify(r)).toContain('drawn as units');
    expect(ok(k, [{ op: 'place_text', ref: 'U1B', name: { x: 3000, y: 2000 } }])).toContain('U1B: name at');
    expect(of(k, 'B').refPos).toMatchObject({ x: page(k).x + 3000, y: page(k).y + 2000 });
  });
});

describe('get_schematic', () => {
  it('says where the text stands when asked', () => {
    const k = scene();
    const of = (q: object) => (k.query({ op: 'get_schematic', ...q } as never) as { symbols: { ref: string; name?: unknown; value?: unknown }[] }).symbols.find((s) => s.ref === 'R7')!;
    expect(of({}).name).toBeUndefined();
    const s = sym(k, 'R7');
    const p = page(k);
    expect(of({ texts: true })).toMatchObject({ name: { x: s.refPos.x - p.x, y: s.refPos.y - p.y, anchor: s.refPos.anchor }, value: { x: s.valuePos.x - p.x, y: s.valuePos.y - p.y, anchor: s.valuePos.anchor } });
  });
});

describe('the layout', () => {
  /** A chain of LEDs with a long part number as one block: the wire round to its next row runs through a value. */
  const led: PartCard = {
    id: 'acme:LED',
    mpn: 'XL-5050RGBC-2812B',
    description: 'addressable LED',
    category: 'led',
    refPrefix: 'D',
    pins: [
      { number: '1', name: 'VDD', type: 'pwr_in' },
      { number: '2', name: 'DOUT', type: 'out' },
      { number: '3', name: 'VSS', type: 'pwr_in' },
      { number: '4', name: 'DIN', type: 'in' },
    ],
    params: {},
    provenance: { source: 'datasheet' },
  };
  const refs = Array.from({ length: 6 }, (_, i) => `D${i + 1}`);

  it('keeps text off wires by itself, inside the block\'s frame, on a sheet it draws afresh', () => {
    const k = new Kernel();
    const d = k.committedDesign();
    d.parts[led.id] = led;
    k.load(d);
    ok(k, [
      ...refs.map((refdes) => ({ op: 'add_part', part: led.id, refdes })),
      ...refs.slice(1).map((r, i) => ({ op: 'connect', pins: [`${refs[i]}.DOUT`, `${r}.DIN`], net: `N${i}` })),
      ...refs.flatMap((r) => [{ op: 'connect', pins: [`${r}.VDD`], net: '+5V' }, { op: 'connect', pins: [`${r}.VSS`], net: 'GND' }]),
      { op: 'describe', blocks: [{ title: 'LEDs', refs }] },
    ]);
    expect(k.draftDesign().drawing).toBeUndefined();
    const s = sheetOf(k);
    expect(textOverlaps(s)).toEqual([]);
    const frame = s.blocks![0]!.rect;
    for (const part of s.symbols) for (const r of boxes(part)) expect(within(frame, r)).toBe(true);
  });
});

describe('what a symbol draws', () => {
  it('tells its core from its leads, turned with it', () => {
    const k = scene();
    const lying = bodyOf(sym(k, 'R7'));
    const s = sym(k, 'R7');
    const [cx, cy] = [s.bbox.x + 200, s.bbox.y + 100];
    expect(lying.all.x).toBe(cx - 200);
    expect(lying.all.w).toBe(400);
    expect(lying.core.w).toBeLessThan(300);
    expect(lying.core.h).toBeLessThan(120);
    expect(lying.core.y + lying.core.h / 2).toBe(cy);
    expect(lying.leads).toHaveLength(2);
    const box = bodyOf(sym(k, 'J1'));
    expect(box.core.w).toBeLessThan(box.all.w);
    expect(box.leads.length).toBe(6);
  });
});
