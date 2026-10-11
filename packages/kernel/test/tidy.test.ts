import { describe, expect, it } from 'vitest';
import type { LabelView, SheetView, SymbolView } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { emptyScene, type Scene } from '../src/scene.ts';
import { tidyWires } from '../src/tidy.ts';
import { buckTransaction } from './fixtures.ts';

const rail = (x: number, y: number): LabelView => ({ x, y, text: '+12V', netId: 'n', kind: 'rail', dir: 'up' });

/** A bus at y = 0 from a pin at x = 900 to the rail symbol at x = 0, with a drop at x = 200 and one at x = 600. */
function bus(): Scene {
  const s = emptyScene();
  s.wires.push({ netId: 'n', pts: [900, 0, 0, 0] }, { netId: 'n', pts: [200, 0, 200, 400] }, { netId: 'n', pts: [600, 0, 600, 400] });
  s.junctions.push({ x: 200, y: 0 }, { x: 600, y: 0 });
  s.labels.push(rail(0, 0));
  return s;
}

describe('wire tidy', () => {
  it('moves a supply symbol from the end of a bus onto the last connection', () => {
    const s = bus();
    expect(tidyWires(s)).toBe(1);
    expect(s.labels[0]!.x).toBe(200);
    expect(s.wires[0]!.pts).toEqual([900, 0, 200, 0]);
    expect(s.junctions).toContainEqual({ x: 200, y: 0 }); // wire end, drop and symbol meet: a T
  });

  it('leaves a symbol that already stands on the last connection', () => {
    const s = bus();
    s.wires[0]!.pts = [900, 0, 200, 0];
    s.labels[0]!.x = 200;
    expect(tidyWires(s)).toBe(0);
  });

  it('leaves a symbol at a real corner, where something else is attached', () => {
    const s = bus();
    s.wires.push({ netId: 'n', pts: [0, 0, 0, 300] });
    expect(tidyWires(s)).toBe(0);
  });

  it('leaves a symbol whose new place is taken by a part', () => {
    const s = bus();
    s.symbols.push({ bbox: { x: 150, y: -300, w: 100, h: 200 }, pins: [] } as unknown as SymbolView);
    expect(tidyWires(s)).toBe(0);
    expect(s.labels[0]!.x).toBe(0);
  });

  it('drops the dot where the point becomes a plain corner', () => {
    const s = emptyScene();
    // the only connection on the bus is a single drop, whose own wire ends here: wire, drop and symbol still make three
    s.wires.push({ netId: 'n', pts: [900, 0, 0, 0] }, { netId: 'n', pts: [200, 0, 200, 400] });
    s.junctions.push({ x: 200, y: 0 }, { x: 500, y: 0 }); // 500: a stale dot that is not a junction
    s.labels.push(rail(0, 0));
    tidyWires(s);
    expect(s.junctions).toContainEqual({ x: 200, y: 0 });
  });

  it('never changes what is connected: the buck keeps its wires, pins and symbols', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    const sheet: SheetView = k.state().view.sheets[0]!;
    // no supply symbol stands on a stub: nothing is connected between it and where its wire starts
    for (const l of sheet.labels.filter((x) => (x.kind === 'rail' || x.kind === 'ground') && !x.stub && !x.rise)) {
      const w = sheet.wires.find((x) => x.netId === l.netId && x.pts.at(-2) === l.x && x.pts.at(-1) === l.y && x.pts.length >= 4);
      if (!w) continue;
      const [ax, ay] = [w.pts.at(-4)!, w.pts.at(-3)!];
      if (ay !== l.y) continue;
      // a wire that carries on from the symbol's point (the feedback divider hanging off the output rail's end) makes it a real corner
      const attached = sheet.wires.filter((x) => x.netId === l.netId && x.pts.some((_, i) => i % 2 === 0 && x.pts[i] === l.x && x.pts[i + 1] === l.y));
      if (attached.length > 1) continue;
      const between = (x: number, y: number) => y === l.y && x > Math.min(ax, l.x) && x < Math.max(ax, l.x);
      const hits = [...sheet.junctions.filter((j) => between(j.x, j.y)), ...sheet.symbols.flatMap((s) => s.pins).filter((p) => between(p.x, p.y))];
      expect(hits, `${l.text} at ${l.x},${l.y}`).toEqual([]);
    }
  });
});
