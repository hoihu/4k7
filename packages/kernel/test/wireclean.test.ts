import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Design, SheetDrawing, SheetView, SymbolView } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { joinedWires } from '../src/drawing.ts';
import { cleanWires } from '../src/wireclean.ts';

/** A box with one pin at (x, y) facing `side`, on net `net`. */
function pinBox(id: string, x: number, y: number, side: 'left' | 'right' | 'top' | 'bottom', net: string): SymbolView {
  const body = { left: { x, y: y - 50, w: 200, h: 100 }, right: { x: x - 200, y: y - 50, w: 200, h: 100 }, top: { x: x - 50, y, w: 100, h: 200 }, bottom: { x: x - 50, y: y - 200, w: 100, h: 200 } }[side];
  void net;
  return { componentId: id, refdes: id, value: '', bbox: body, prims: [], pins: [{ number: '1', name: '1', x, y, side, showName: false, showNumber: false }], refPos: { x: -5000, y: -5000, anchor: 'start' }, valuePos: { x: -5000, y: -5000, anchor: 'start' } };
}

const area = () => ({ x: -2000, y: -2000, w: 6000, h: 6000 });

function world(pins: [string, number, number, 'left' | 'right' | 'top' | 'bottom', string][]) {
  const symbols = pins.map(([id, x, y, side, net]) => pinBox(id, x, y, side, net));
  const d = {
    components: Object.fromEntries(pins.map(([id, , , , net]) => [id, { id, refdes: id, pins: { '1': net } }])),
    nets: Object.fromEntries([...new Set(pins.map((p) => p[4]))].map((n) => [n, { id: n, name: n }])),
  } as unknown as Design;
  return { d, symbols };
}

const length = (wires: { pts: number[] }[]) =>
  wires.reduce((n, w) => {
    for (let i = 0; i + 3 < w.pts.length; i += 2) n += Math.abs(w.pts[i + 2]! - w.pts[i]!) + Math.abs(w.pts[i + 3]! - w.pts[i + 1]!);
    return n;
  }, 0);
/** The pins each pin is joined to by wires, as a sorted signature. */
const joins = (sd: SheetDrawing, symbols: SymbolView[], d: Design) =>
  symbols.map((s) => {
    const p = s.pins[0]!;
    const net = d.components[s.componentId]!.pins['1']!;
    const ws = joinedWires(sd.wires, net, p.x, p.y);
    return symbols.filter((o) => ws.some((i) => sd.wires[i]!.pts.length && onAny(o.pins[0]!, [sd.wires[i]!]))).map((o) => o.refdes).sort().join(',');
  });
const onAny = (p: { x: number; y: number }, ws: { pts: number[] }[]) =>
  ws.some((w) => {
    for (let i = 0; i + 3 < w.pts.length; i += 2) {
      const [x1, y1, x2, y2] = [w.pts[i]!, w.pts[i + 1]!, w.pts[i + 2]!, w.pts[i + 3]!];
      if (p.x >= Math.min(x1, x2) && p.x <= Math.max(x1, x2) && p.y >= Math.min(y1, y2) && p.y <= Math.max(y1, y2)) return true;
    }
    return false;
  });

describe('the wire clean-up', () => {
  it('takes out loops, runs drawn twice and U-turns, keeping what is joined', () => {
    const { d, symbols } = world([['A', 0, 0, 'right', 'N'], ['B', 1000, 0, 'left', 'N'], ['C', 500, 600, 'top', 'N']]);
    const sd: SheetDrawing = {
      pages: [area()],
      symbols: [],
      labels: [],
      wires: [
        { netId: 'N', pts: [0, 0, 200, 0, 200, -200, 400, -200, 400, 0, 1000, 0] }, // a hump
        { netId: 'N', pts: [0, 0, 1000, 0] }, // the same run straight: a loop with the hump
        { netId: 'N', pts: [0, 0, 500, 0] }, // drawn twice
        { netId: 'N', pts: [500, 600, 500, 0] }, // a T onto it
      ],
    };
    const before = joins(sd, symbols, d);
    expect(cleanWires(d, sd, symbols, area)).toBe(true);
    expect(length(sd.wires)).toBe(1000 + 600);
    expect(joins(sd, symbols, d)).toEqual(before);
    // nothing left to do
    expect(cleanWires(d, sd, symbols, area)).toBe(false);
  });

  it('draws a piece afresh when its wire leaves a pin sideways', () => {
    // B's wire starts downwards although the pin faces left: the old lying-part wires
    const { d, symbols } = world([['A', 0, 0, 'right', 'N'], ['B', 1000, 0, 'left', 'N']]);
    const sd: SheetDrawing = { pages: [area()], symbols: [], labels: [], wires: [{ netId: 'N', pts: [0, 0, 0, 100, 900, 100, 900, -100, 1000, -100, 1000, 0] }] };
    expect(cleanWires(d, sd, symbols, area)).toBe(true);
    expect(sd.wires.map((w) => w.pts)).toEqual([[0, 0, 1000, 0]].map((p) => (sd.wires[0]!.pts[0] === 0 ? p : [1000, 0, 0, 0])));
  });

  it('takes out the hop over a pin that a wire came into from above', () => {
    // A faces left, B (standing) up: the wire went over B's top pin to come down onto it
    const { d, symbols } = world([['A', 1000, 0, 'left', 'N'], ['B', 0, 0, 'top', 'N']]);
    const hop = [1000, 0, 100, 0, 100, -100, 0, -100, 0, 0];
    const sd: SheetDrawing = { pages: [area()], symbols: [], labels: [], wires: [{ netId: 'N', pts: [...hop] }] };
    expect(cleanWires(d, sd, symbols, area)).toBe(true);
    expect(sd.wires.map((w) => [...w.pts].sort((p, q) => p - q))).toEqual([[0, 0, 0, 1000]]);
    expect(cleanWires(d, sd, symbols, area)).toBe(false);
    // given through the agent's own corners it stays what it asked for
    const kept: SheetDrawing = { pages: [area()], symbols: [], labels: [], wires: [{ netId: 'N', pts: [...hop], via: true }] };
    expect(cleanWires(d, kept, symbols, area)).toBe(false);
  });

  it('takes out that hop with a wire leaving the pin on the other side, into one straight run', () => {
    // the screenshot: the hop between C27's top pin and Y1, the wire to R9 going on in line
    const { d, symbols } = world([['Y', 1000, 0, 'left', 'N'], ['C', 0, 0, 'top', 'N'], ['R', -500, 0, 'right', 'N']]);
    const sd: SheetDrawing = { pages: [area()], symbols: [], labels: [], wires: [{ netId: 'N', pts: [1000, 0, 100, 0, 100, -100, 0, -100, 0, 0] }, { netId: 'N', pts: [0, 0, -500, 0] }] };
    expect(cleanWires(d, sd, symbols, area)).toBe(true);
    expect(sd.wires.map((w) => [...w.pts].sort((p, q) => p - q)).sort((p, q) => q[3]! - p[3]!)).toEqual([[0, 0, 0, 1000], [-500, 0, 0, 0]]);
  });

  it('takes out a hop between two top pins', () => {
    const { d, symbols } = world([['A', 0, 0, 'top', 'N'], ['B', 1000, 0, 'top', 'N']]);
    const sd: SheetDrawing = { pages: [area()], symbols: [], labels: [], wires: [{ netId: 'N', pts: [0, 0, 0, -100, 1000, -100, 1000, 0] }] };
    expect(cleanWires(d, sd, symbols, area)).toBe(true);
    expect(sd.wires.map((w) => [...w.pts].sort((p, q) => p - q))).toEqual([[0, 0, 0, 1000]]);
  });

  it('does not move a corner into the side of a pin when that saves nothing', () => {
    // up out of the pin, across, on up: moving the step to the pin would only swap one corner for another
    const { d, symbols } = world([['A', 0, 0, 'top', 'N'], ['B', 500, -500, 'bottom', 'N']]);
    const pts = [0, 0, 0, -100, 500, -100, 500, -500];
    const sd: SheetDrawing = { pages: [area()], symbols: [], labels: [], wires: [{ netId: 'N', pts: [...pts] }] };
    expect(cleanWires(d, sd, symbols, area)).toBe(false);
    expect(sd.wires[0]!.pts).toEqual(pts);
  });

  it('leaves a wire drawn straight out of its pins, back along a row, as it is', () => {
    // the return from the end of one row of a chain to the start of the next
    const { d, symbols } = world([['A', 3000, 0, 'right', 'N'], ['B', 0, 1000, 'left', 'N']]);
    const pts = [3000, 0, 3100, 0, 3100, 500, -100, 500, -100, 1000, 0, 1000];
    const sd: SheetDrawing = { pages: [area()], symbols: [], labels: [], wires: [{ netId: 'N', pts: [...pts] }] };
    expect(cleanWires(d, sd, symbols, area)).toBe(false);
    expect(sd.wires[0]!.pts).toEqual(pts);
  });

  it('keeps a wire drawn through the agent\'s corners, and leaves other nets and plain crossings alone', () => {
    const { d, symbols } = world([['A', 0, 0, 'right', 'N'], ['B', 1000, 0, 'left', 'N'], ['C', 500, -500, 'bottom', 'M'], ['D', 500, 500, 'top', 'M']]);
    const via = { netId: 'N', pts: [0, 0, 100, 0, 100, -300, 900, -300, 900, 0, 1000, 0], via: true };
    const sd: SheetDrawing = { pages: [area()], symbols: [], labels: [], wires: [via, { netId: 'M', pts: [500, -500, 500, 500] }] };
    expect(cleanWires(d, sd, symbols, area)).toBe(false);
    expect(sd.wires[0]).toEqual(via);
  });

  describe('a run through a part', () => {
    /** A part's box, with no pin on what runs through it. */
    const part = (id: string, x: number, y: number, w: number, h: number): SymbolView => ({ ...pinBox(id, x, y - 500, 'top', 'P'), bbox: { x, y, w, h } });
    const clear = (sd: SheetDrawing, ...boxes: SymbolView[]) => {
      for (const w of sd.wires) for (let i = 0; i + 3 < w.pts.length; i += 2) for (const { bbox: b } of boxes) {
        const [x1, y1, x2, y2] = [w.pts[i]!, w.pts[i + 1]!, w.pts[i + 2]!, w.pts[i + 3]!];
        const [ax, bx, ay, by] = [Math.min(x1, x2), Math.max(x1, x2), Math.min(y1, y2), Math.max(y1, y2)];
        expect(ay === by ? ay > b.y && ay < b.y + b.h && Math.max(ax, b.x) < Math.min(bx, b.x + b.w) : ax > b.x && ax < b.x + b.w && Math.max(ay, b.y) < Math.min(by, b.y + b.h), JSON.stringify(w.pts)).toBe(false);
      }
    };

    it('goes round the part from pin to pin', () => {
      const { d, symbols } = world([['A', 0, 0, 'right', 'N'], ['B', 1000, 0, 'left', 'N']]);
      const box = part('P', 400, -100, 200, 200);
      const all = [...symbols, box];
      const sd: SheetDrawing = { pages: [area()], symbols: [], labels: [], wires: [{ netId: 'N', pts: [0, 0, 1000, 0] }] };
      expect(cleanWires(d, sd, all, area)).toBe(true);
      clear(sd, box);
      expect(sd.wires.length).toBe(1);
      expect([sd.wires[0]!.pts.slice(0, 2).join(), sd.wires[0]!.pts.slice(-2).join()].sort()).toEqual(['0,0', '1000,0']);
      expect(cleanWires(d, sd, all, area)).toBe(false);
    });

    it('moves only what stood behind the part, the rest of the net stays as drawn', () => {
      // a T from C onto the wire A–B; the part stands on the run from the T to B
      const { d, symbols } = world([['A', 0, 0, 'right', 'N'], ['B', 1500, 0, 'left', 'N'], ['C', 400, 600, 'top', 'N']]);
      const box = part('P', 800, -100, 200, 200);
      const all = [...symbols, box];
      const sd: SheetDrawing = { pages: [area()], symbols: [], labels: [], wires: [{ netId: 'N', pts: [0, 0, 1500, 0] }, { netId: 'N', pts: [400, 600, 400, 0] }] };
      expect(cleanWires(d, sd, all, area)).toBe(true);
      clear(sd, box);
      const forwards = (pts: number[]) => (pts[0]! <= pts.at(-2)! ? pts : Array.from({ length: pts.length / 2 }, (_, i) => pts.slice(-2 * (i + 1), pts.length - 2 * i)).flat());
      const runs = sd.wires.map((w) => forwards(w.pts));
      expect(runs).toContainEqual([0, 0, 400, 0, 400, 600]); // A to C, as it was
      expect(runs.length).toBe(2);
      const way = runs.find((r) => r.at(-2) === 1500)!; // on to B from the part's near side only
      expect(way.slice(-4)).toEqual([1000, 0, 1500, 0]);
      expect(cleanWires(d, sd, all, area)).toBe(false);
    });

    it('joins again the pins of a T that stood behind the part', () => {
      const { d, symbols } = world([['A', 0, 0, 'right', 'N'], ['B', 1000, 0, 'left', 'N'], ['C', 500, 800, 'top', 'N']]);
      const box = part('P', 400, -100, 200, 200);
      const all = [...symbols, box];
      const sd: SheetDrawing = { pages: [area()], symbols: [], labels: [], wires: [{ netId: 'N', pts: [0, 0, 1000, 0] }, { netId: 'N', pts: [500, 800, 500, 0] }] };
      expect(cleanWires(d, sd, all, area)).toBe(true);
      clear(sd, box);
      for (const s of symbols) expect(joinedWires(sd.wires, 'N', s.pins[0]!.x, s.pins[0]!.y).length, s.refdes).toBe(sd.wires.length);
      expect(cleanWires(d, sd, all, area)).toBe(false);
    });

    it('goes round even with the agent\'s corners, and then no longer keeps them', () => {
      const { d, symbols } = world([['A', 0, 0, 'right', 'N'], ['B', 1000, 0, 'left', 'N']]);
      const box = part('P', 400, -400, 200, 200);
      const sd: SheetDrawing = { pages: [area()], symbols: [], labels: [], wires: [{ netId: 'N', pts: [0, 0, 100, 0, 100, -300, 900, -300, 900, 0, 1000, 0], via: true }] };
      expect(cleanWires(d, sd, [...symbols, box], area)).toBe(true);
      clear(sd, box);
      expect(sd.wires.some((w) => w.via)).toBe(false);
    });

    it('leaves a run along the edge of a box, as the router draws it', () => {
      const { d, symbols } = world([['A', 0, 0, 'right', 'N'], ['B', 1000, 0, 'left', 'N']]);
      const box = part('P', 400, 0, 200, 200);
      const sd: SheetDrawing = { pages: [area()], symbols: [], labels: [], wires: [{ netId: 'N', pts: [0, 0, 1000, 0] }] };
      expect(cleanWires(d, sd, [...symbols, box], area)).toBe(false);
    });

    it('stays where there is no way round, and joins nothing else', () => {
      // the part covers B's pin: nothing can reach it
      const { d, symbols } = world([['A', 0, 0, 'right', 'N'], ['B', 1000, 0, 'left', 'N']]);
      const box = part('P', 800, -400, 800, 800);
      const pts = [0, 0, 1000, 0];
      const sd: SheetDrawing = { pages: [area()], symbols: [], labels: [], wires: [{ netId: 'N', pts: [...pts] }] };
      expect(cleanWires(d, sd, [...symbols, box], area)).toBe(false);
      expect(sd.wires[0]!.pts).toEqual(pts);
    });

    it('leaves a slanted lead alone: it belongs to the part drawn at 45°', () => {
      const { d, symbols } = world([['A', 150, 50, 'top', 'N'], ['B', 250, 350, 'bottom', 'N']]);
      const box = part('P', 100, 100, 200, 200);
      const pts = [150, 50, 250, 350];
      const sd: SheetDrawing = { pages: [area()], symbols: [], labels: [], wires: [{ netId: 'N', pts: [...pts] }] };
      expect(cleanWires(d, sd, [...symbols, box], area)).toBe(false);
      expect(sd.wires[0]!.pts).toEqual(pts);
    });
  });
});

/** The TPS40222 buck of docs/design/schematic-drawing.md §1, with its sheet taken over. */
function buck() {
  const k = new Kernel();
  k.load(JSON.parse(readFileSync(new URL('./tps40222.json', import.meta.url), 'utf8')) as Design);
  k.transact({ summary: 'arrange', ops: [{ op: 'place_symbol', ref: 'U1', page: 1, x: 4000, y: 4000 }] });
  k.accept();
  return k;
}
const sheetOf = (k: Kernel): SheetView => k.state().view.sheets[0]!;

describe('wiring on an arranged sheet', () => {
  it('turns a lying part\'s pins with it, so wires leave them sideways', () => {
    const k = buck();
    const at = sheetOf(k).symbols.find((s) => s.refdes === 'R1')!.bbox;
    const page = sheetOf(k).pages[0]!.rect;
    const r = k.transact({ summary: 'lie', ops: [{ op: 'place_symbol', ref: 'R1', x: at.x + at.w / 2 - page.x, y: at.y + at.h / 2 - page.y, orient: 'lying' }] });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const r1 = sheetOf(k).symbols.find((s) => s.refdes === 'R1')!;
    expect(r1.rotation).toBeTruthy();
    expect(r1.pins.map((p) => p.side).sort()).toEqual(['left', 'right']);
  });

  it('joins a net drawn bit by bit into one tree, and draws nothing for pins already joined', () => {
    const k = buck();
    const d = k.committedDesign();
    const sw = Object.values(d.components).find((c) => c.refdes === 'U1')!.pins['3']!;
    // the switch node's pins that can be reached where the fixture draws them (C2.2 is boxed in)
    const pins = ['U1.3', 'R3.1', 'D1.1', 'L1.1'];
    k.transact({ summary: 'clear', ops: [{ op: 'erase', net: d.nets[sw]!.name }] });
    for (const p of pins.slice(1)) {
      const r = k.transact({ summary: 'wire', ops: [{ op: 'wire', from: p, to: pins[0]! }] });
      expect(r.status, JSON.stringify(r).slice(0, 300)).toBe('ok');
    }
    const again = k.transact({ summary: 'again', ops: [{ op: 'wire', from: pins[1]!, to: pins[2]! }] });
    expect(again.status === 'ok' && again.results[0]!.effect).toContain('already joined');
    // one tree: split at every joint, one piece and no loop (pieces = joints - 1)
    const ws = sheetOf(k).wires.filter((w) => w.netId === sw && !w.auto);
    const segs = ws.flatMap((w) => Array.from({ length: w.pts.length / 2 - 1 }, (_, i) => w.pts.slice(2 * i, 2 * i + 4) as [number, number, number, number]));
    const nodes = new Map<string, [number, number]>();
    for (const [x1, y1, x2, y2] of segs) (nodes.set(`${x1},${y1}`, [x1, y1]), nodes.set(`${x2},${y2}`, [x2, y2]));
    const on = ([x, y]: [number, number], [x1, y1, x2, y2]: number[]) => x >= Math.min(x1!, x2!) && x <= Math.max(x1!, x2!) && y >= Math.min(y1!, y2!) && y <= Math.max(y1!, y2!);
    const edges = new Set<string>();
    for (const sg of segs) {
      const pts = [...nodes.values()].filter((p) => on(p, sg)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      for (let i = 0; i + 1 < pts.length; i++) edges.add(`${pts[i]}|${pts[i + 1]}`);
    }
    expect(edges.size).toBe(nodes.size - 1);
    expect(k.state().diagnostics.filter((x) => x.code === 'SCH.DANGLING')).toEqual([]);
  });
});
