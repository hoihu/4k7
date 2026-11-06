import { describe, expect, it } from 'vitest';
import { Kernel } from '@4k7/kernel';
import type { BoardView, CopperLayer, EditOp } from '@4k7/schema';
import { gerbers, panelBoard, readGerber, type FabShape, type Path } from '../src/index.ts';
import { buckTransaction } from '../../kernel/test/fixtures.ts';

/** A path's corners (flat x, y), its arcs in steps of 2° at most. */
function corners(p: Path): number[] {
  const out = [p.x, p.y];
  let [x, y] = [p.x, p.y];
  for (const s of p.segs) {
    if (s.arc) {
      const { cx, cy, ccw } = s.arc;
      const [r, a0] = [Math.hypot(x - cx, y - cy), Math.atan2(y - cy, x - cx)];
      let sweep = Math.atan2(s.y - cy, s.x - cx) - a0;
      if (ccw) while (sweep <= 1e-9) sweep += 2 * Math.PI;
      else while (sweep >= -1e-9) sweep -= 2 * Math.PI;
      const n = Math.ceil(Math.abs(sweep) / (Math.PI / 90));
      for (let k = 1; k <= n; k++) out.push(cx + r * Math.cos(a0 + (sweep * k) / n), cy + r * Math.sin(a0 + (sweep * k) / n));
    } else out.push(s.x, s.y);
    [x, y] = [s.x, s.y];
  }
  return out;
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const [dx, dy] = [bx - ax, by - ay];
  const l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Whether a shape covers x, y. */
function coverage(s: FabShape): (x: number, y: number) => boolean {
  if (s.k === 'circle') return (x, y) => Math.hypot(x - s.x, y - s.y) <= s.r;
  if (s.k === 'stroke') {
    const p = corners(s.path);
    return (x, y) => {
      if (p.length === 2) return Math.hypot(x - p[0]!, y - p[1]!) <= s.w / 2;
      for (let i = 0; i + 3 < p.length; i += 2) if (segDist(x, y, p[i]!, p[i + 1]!, p[i + 2]!, p[i + 3]!) <= s.w / 2) return true;
      return false;
    };
  }
  const loops = s.contours.map((c) => {
    const p = corners(c);
    return [...p, p[0]!, p[1]!];
  });
  return (x, y) => {
    let wind = 0;
    for (const p of loops) {
      for (let i = 0; i + 3 < p.length; i += 2) {
        const [ax, ay, bx, by] = [p[i]!, p[i + 1]!, p[i + 2]!, p[i + 3]!];
        const side = (bx - ax) * (y - ay) - (x - ax) * (by - ay);
        if (ay <= y && by > y && side > 0) wind++;
        else if (ay > y && by <= y && side < 0) wind--;
      }
    }
    return wind !== 0;
  };
}

/** Whether a Gerber file, read back, has copper at x, y of the board (mm from its top-left corner): its objects in order, found through 0.5 mm cells. */
function copperOf(content: string, h: number): (x: number, y: number) => boolean {
  const objects = readGerber(content).objects.map((o) => ({ dark: o.dark, box: o.box, parts: o.parts.map((p) => ({ off: !!p.off, covers: coverage(p.shape) })) }));
  const C = 0.5;
  const cells = new Map<string, number[]>();
  objects.forEach((o, n) => {
    for (let i = Math.floor(o.box[0] / C); i <= Math.floor(o.box[2] / C); i++) {
      for (let j = Math.floor(o.box[1] / C); j <= Math.floor(o.box[3] / C); j++) {
        const key = `${i},${j}`;
        cells.set(key, [...(cells.get(key) ?? []), n]);
      }
    }
  });
  return (x, by) => {
    const y = h - by; // the files count y up from the bottom edge
    let on = false;
    for (const n of cells.get(`${Math.floor(x / C)},${Math.floor(y / C)}`) ?? []) {
      const o = objects[n]!;
      if (x < o.box[0] || x > o.box[2] || y < o.box[1] || y > o.box[3]) continue;
      let covered = false;
      for (const p of o.parts) if (p.covers(x, y)) covered = !p.off;
      if (covered) on = o.dark;
    }
    return on;
  };
}

const layerFile = (b: BoardView, layer: CopperLayer) => gerbers(b, 'x').find((f) => f.name === `x-${layer.replace('.', '_')}.gbr`)!.content;

/** Where the layer's copper is worth a look: round every via and every pad on it, along each plane's outline, and a grid over the board. */
function samples(b: BoardView, layer: CopperLayer): [number, number][] {
  const out: [number, number][] = [];
  const square = (x0: number, y0: number, x1: number, y1: number, step: number) => {
    for (let x = x0; x <= x1; x += step) for (let y = y0; y <= y1; y += step) out.push([x, y]);
  };
  const near = 0.7;
  for (const v of b.vias) square(v.x - v.pad / 2 - near, v.y - v.pad / 2 - near, v.x + v.pad / 2 + near, v.y + v.pad / 2 + near, 0.071);
  for (const p of b.parts.flatMap((q) => q.pads)) if (p.drill || p.layers.includes(layer)) square(p.x - p.w / 2 - near, p.y - p.h / 2 - near, p.x + p.w / 2 + near, p.y + p.h / 2 + near, 0.071);
  for (const z of b.zones.filter((q) => q.layer === layer && q.shape)) {
    const [x0, y0, x1, y1] = z.shape!.outline;
    square(x0 - near, y0 - near, x1 + near, y0 + near, 0.071);
    square(x0 - near, y1 - near, x1 + near, y1 + near, 0.071);
    square(x0 - near, y0 - near, x0 + near, y1 + near, 0.071);
    square(x1 - near, y0 - near, x1 + near, y1 + near, 0.071);
  }
  square(0.013, 0.017, b.outline.w, b.outline.h, 0.29);
  return out;
}

/**
 * The layer's Gerber against its parts, each written alone: copper exactly where one of its
 * planes (cut and spoked as it is on the board), a pad, a via or a track has it. A point a few µm
 * from an edge may differ (a cut kept to a plane's outline is written as a polygon round its
 * circle), so a difference counts where the points round it differ too.
 */
function mismatches(b: BoardView, layer: CopperLayer): string[] {
  const h = b.outline.h;
  const file = copperOf(layerFile(b, layer), h);
  const alone = [
    copperOf(layerFile({ ...b, zones: [] }, layer), h),
    ...b.zones.filter((z) => z.layer === layer).map((z) => copperOf(layerFile({ ...b, zones: [z], parts: [], vias: [], tracks: [] }, layer), h)),
  ];
  const meant = (x: number, y: number) => alone.some((f) => f(x, y));
  const out: string[] = [];
  for (const [x, y] of samples(b, layer)) {
    if (file(x, y) === meant(x, y)) continue;
    const d = 0.003;
    if ([[d, 0], [-d, 0], [0, d], [0, -d]].some(([dx, dy]) => file(x + dx!, y + dy!) === meant(x + dx!, y + dy!))) continue;
    out.push(`${layer} ${x.toFixed(3)}, ${y.toFixed(3)}: ${file(x, y) ? 'copper' : 'none'} in the file`);
  }
  return out;
}

/** The buck converter on 4 layers with U2 (an op-amp and its capacitor on +3V3) beside it, and these planes, routed. */
function board(planes: EditOp[], board: EditOp[] = []): BoardView {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  const r = k.transact({
    summary: 'planes',
    ops: [
      { op: 'add_part', part: 'ti:LM358DR', refdes: 'U2' },
      { op: 'add_part', part: 'generic:C', refdes: 'C10', params: { capacitance: '100nF', voltage: '16V' } },
      { op: 'connect', pins: ['U2.V+', 'C10.1'], net: '+3V3' },
      { op: 'connect', pins: ['U2.GND', 'C10.2'], net: 'GND' },
      { op: 'connect', pins: ['U2.INA+', 'U2.OUTA', 'U2.INA-'], net: 'BUF' },
      { op: 'connect', pins: ['U2.INB+', 'U2.OUTB', 'U2.INB-'], net: 'BUF2' },
      { op: 'set_board', layers: 4 },
      ...board,
      ...planes,
      { op: 'route' },
    ],
  });
  expect(r.status, JSON.stringify(r).slice(0, 400)).toBe('ok');
  return k.board();
}

/** The spokes of the net's plane on the layer (every copy's on a panel) that come through to its vias and pads in the file, of all of them. */
function spokes(b: BoardView, layer: CopperLayer, net: string): [number, number] {
  const adds = b.zones.filter((q) => q.layer === layer && b.netNames[q.netId] === net).flatMap((z) => z.shape!.adds);
  const file = copperOf(layerFile(b, layer), b.outline.h);
  const whole = adds.filter(({ pts: [x0, y0, x1, y1] }) => Array.from({ length: 21 }, (_, i) => i / 20).every((t) => file(x0! + (x1! - x0!) * t, y0! + (y1! - y0!) * t)));
  return [whole.length, adds.length];
}

describe('planes sharing a layer, in the Gerber', () => {
  const full: EditOp = { op: 'set_plane', layer: 'In2.Cu', net: '+12V' };
  const area: EditOp = { op: 'set_plane', layer: 'In2.Cu', net: '+3V3', under: ['U2'] };

  it('keeps the full plane joined to its vias where an area plane lies in it (the area\'s clearances cut the spokes)', () => {
    const b = board([full, area]);
    const [whole, all] = spokes(b, 'In2.Cu', '+12V');
    expect(all).toBeGreaterThan(4);
    expect(whole).toBe(all);
    const [areaWhole, areaAll] = spokes(b, 'In2.Cu', '+3V3');
    expect(areaWhole).toBe(areaAll);
    expect(mismatches(b, 'In2.Cu')).toEqual([]);
  }, 60_000);

  it('keeps an area plane listed before the full plane round it (the full plane was set again: it wiped the area out)', () => {
    const b = board([full, area, full]);
    expect(b.planes.map((p) => `${b.netNames[p.netId]}${p.area ? ' area' : ''}@${p.layer}`).filter((p) => p.endsWith('In2.Cu'))).toEqual(['+3V3 area@In2.Cu', '+12V@In2.Cu']);
    const z = b.zones.find((q) => q.layer === 'In2.Cu' && b.netNames[q.netId] === '+3V3')!.shape!.outline;
    const file = copperOf(layerFile(b, 'In2.Cu'), b.outline.h);
    const inArea = Array.from({ length: 81 }, (_, n) => [z[0] + ((z[2] - z[0]) * ((n % 9) + 0.5)) / 9, z[1] + ((z[3] - z[1]) * (Math.floor(n / 9) + 0.5)) / 9] as const);
    expect(inArea.filter(([x, y]) => file(x, y)).length).toBeGreaterThan(60);
    expect(mismatches(b, 'In2.Cu')).toEqual([]);
  }, 60_000);

  it('does the same on a panel, each copy\'s planes in one file', () => {
    const b = board([full, area], [{ op: 'set_board', width_mm: 40, height_mm: 30 }, { op: 'set_panel' }]);
    const p = panelBoard(b, b.panel!);
    expect(p.zones.filter((z) => z.layer === 'In2.Cu').length).toBeGreaterThanOrEqual(4);
    const [whole, all] = spokes(p, 'In2.Cu', '+12V');
    expect(whole).toBe(all);
    expect(mismatches(p, 'In2.Cu')).toEqual([]);
  }, 60_000);

  it('keeps an outer pour joined to its pads where a local pour lies in it, on a board with round corners', () => {
    const b = board(
      [
        { op: 'set_plane', layer: 'F.Cu', net: 'GND' },
        { op: 'set_plane', layer: 'F.Cu', net: '+3V3', rect: { x_mm: 0, y_mm: 0, width_mm: 14, height_mm: 12 } },
      ],
      [{ op: 'set_board', corner_radius_mm: 4 }],
    );
    expect(b.zones.filter((z) => z.layer === 'F.Cu').every((z) => z.shape?.clip)).toBe(true);
    const [whole, all] = spokes(b, 'F.Cu', 'GND');
    expect(all).toBeGreaterThan(10);
    expect(whole).toBe(all);
    expect(mismatches(b, 'F.Cu')).toEqual([]);
  }, 60_000);
});
