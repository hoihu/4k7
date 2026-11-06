/**
 * Tests that know the answer. The writer's own tests check the files' form; these hold what the
 * files draw against what the board is, the way a fab house's netlist test does:
 *
 * - generated boards (planes and areas per layer, pours, keep-outs, cutouts, round corners, a
 *   USB-C receptacle with oval pads round plated slots at every quarter turn, panels), each routed
 *   and its files checked against its netlist: no short, no open the board does not have, no pad
 *   without copper, no copper joined to nothing;
 * - an independent reader: the same files read by tracespace's gerber-parser and gerber-plotter (not
 *   our reader, fabread.ts) give the same copper per layer and the same check, so our reader and
 *   our writer cannot share a mistake about the format unseen.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { Kernel } from '@4k7/kernel';
import type { BoardView, EditOp } from '@4k7/schema';
import { boardNetDesign, checkCopper, copperCheckText, gerbers, panelBoard, readExcellon, readFabFiles, type Box, type FabObject, type FabPart, type FabShape, type NetDesign, type Path } from '../src/index.ts';
import { buckTransaction } from '../../kernel/test/fixtures.ts';

/* generated boards */

/** A small random generator (mulberry32), so each board is the same on every run. */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, pick: <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!, between: (lo: number, hi: number) => Math.round((lo + next() * (hi - lo)) * 10) / 10 };
}

interface Generated {
  board: BoardView;
  /** What was made, in words (for a failure's message). */
  what: string;
}

/**
 * The buck converter, an op-amp and a USB-C receptacle (power only, its shield on oval pads round
 * plated slots), on a board shaped, layered and planed by the seed.
 */
function generate(seed: number): Generated {
  const r = random(seed);
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  // (a part of the design's own, after the accept: one in no use would be dropped)
  const d = structuredClone(k.committedDesign());
  d.parts['acme:USBC'] = {
    id: 'acme:USBC',
    description: 'USB-C receptacle (power only)',
    category: 'connector',
    refPrefix: 'J',
    pins: [
      { number: 'A1', name: 'GND', type: 'pwr_in' },
      { number: 'A4', name: 'VBUS', type: 'pwr_in' },
      { number: 'S1', name: 'SHIELD', type: 'passive' },
      { number: 'S2', name: 'SHIELD', type: 'passive' },
    ],
    params: {},
    provenance: { source: 'datasheet' },
  };
  k.load(d);
  const layers = r.pick([2, 4, 4] as const);
  const [w, h] = [r.between(42, 55), r.between(34, 44)];
  const corner = r.pick([0, 0, 2, 4]);
  const rot = r.pick([0, 90, 180, 270] as const);
  const shieldNet = r.pick(['GND', '+12V', null]);
  const ops: EditOp[] = [
    { op: 'add_part', part: 'ti:LM358DR', refdes: 'U2' },
    { op: 'add_part', part: 'generic:C', refdes: 'C10', params: { capacitance: '100nF', voltage: '16V' } },
    { op: 'connect', pins: ['U2.V+', 'C10.1'], net: '+3V3' },
    { op: 'connect', pins: ['U2.GND', 'C10.2'], net: 'GND' },
    { op: 'connect', pins: ['U2.INA+', 'U2.OUTA', 'U2.INA-'], net: 'BUF' },
    { op: 'add_part', part: 'acme:USBC', refdes: 'J9' },
    { op: 'connect', pins: ['J9.A4', 'J1.1'], net: '+12V' },
    { op: 'connect', pins: ['J9.A1'], net: 'GND' },
    ...(shieldNet ? ([{ op: 'connect', pins: ['J9.S1', 'J9.S2'], net: shieldNet }] as EditOp[]) : []),
    {
      op: 'set_footprint',
      ref: 'J9',
      name: 'USB-C',
      pads: [
        { number: 'A1', x: -1, y: -2, w: 0.6, h: 1.15 },
        { number: 'A4', x: 1, y: -2, w: 0.6, h: 1.15 },
        { number: 'S1', x: -4.3, y: 1, w: 1.1, h: 2.2, slot: [0.6, 1.7] },
        { number: 'S2', x: 4.3, y: 1, w: 1.1, h: 2.2, slot: [0.6, 1.7] },
      ],
    },
    { op: 'set_board', layers, width_mm: w, height_mm: h, corner_radius_mm: corner },
    { op: 'place', ref: 'J9', x_mm: rot % 180 === 0 ? w / 2 : 7, y_mm: rot % 180 === 0 ? 7 : h / 2, rot, lock: true },
  ];
  const planes: string[] = [];
  const plane = (op: EditOp, what: string) => {
    ops.push(op);
    planes.push(what);
  };
  if (layers === 4) {
    const full = r.pick(['+12V', '+3V3']);
    plane({ op: 'set_plane', layer: 'In2.Cu', net: full }, `${full} on In2.Cu`);
    const area = full === '+12V' ? '+3V3' : '+12V';
    if (r.next() < 0.5) plane({ op: 'set_plane', layer: 'In2.Cu', net: area, under: [r.pick(['U2', 'U1'])] }, `${area} area under a part on In2.Cu`);
    else plane({ op: 'set_plane', layer: 'In2.Cu', net: area, rect: { x_mm: 2, y_mm: h - 14, width_mm: 14, height_mm: 12 } }, `${area} area in a rectangle on In2.Cu`);
    if (r.next() < 0.5) plane({ op: 'set_plane', layer: 'In2.Cu', net: full }, `${full} set again on In2.Cu`);
  }
  if (r.next() < 0.7) plane({ op: 'set_plane', layer: 'F.Cu', net: 'GND' }, 'GND pour on F.Cu');
  if (r.next() < 0.5) plane({ op: 'set_plane', layer: 'F.Cu', net: '+12V', rect: { x_mm: w - 16, y_mm: h - 14, width_mm: 14, height_mm: 12 } }, '+12V local pour on F.Cu');
  if (layers === 2 || r.next() < 0.5) plane({ op: 'set_plane', layer: 'B.Cu', net: r.pick(['GND', '+3V3']) }, 'a pour on B.Cu');
  if (r.next() < 0.6) {
    const on = layers === 4 ? r.pick(['In1.Cu', 'In2.Cu', 'B.Cu'] as const) : 'B.Cu';
    ops.push({ op: 'add_keepout', name: 'no pour', rect: { x_mm: r.between(w / 2 - 6, w / 2), y_mm: r.between(h / 2 - 4, h / 2), width_mm: 6, height_mm: 5 }, layers: [on], forbid: ['pours'] });
    planes.push(`no pours in a keep-out on ${on}`);
  }
  if (r.next() < 0.5) {
    ops.push({ op: 'add_cutout', shape: 'circle', x_mm: -6, y_mm: -6, anchor: 'bottom_right', diameter_mm: 3 });
    planes.push('a round cutout');
  }
  const panel = r.next() < 0.3;
  if (panel) ops.push({ op: 'set_panel' });
  ops.push({ op: 'route' });
  const res = k.transact({ summary: `board ${seed}`, ops });
  const what = `seed ${seed}: ${layers} layers, ${w} × ${h} mm, corners r ${corner}, USB-C turned ${rot}° (shield ${shieldNet ?? 'not connected'}), ${planes.join(', ') || 'no planes'}${panel ? ', panel' : ''}`;
  expect(res.status, `${what}: ${JSON.stringify(res.rejection ?? res).slice(0, 300)}`).toBe('ok');
  return { board: k.board(), what };
}

/** The board's own files (its panel's, if it has one), read back and checked against it. */
function ownFiles(b: BoardView) {
  const view = b.panel ? panelBoard(b, b.panel) : b;
  const files = gerbers(view, 'x', b.panel);
  return { files, design: boardNetDesign(b, b.panel) };
}

function check(files: { name: string; content: string }[], design: NetDesign, copper = readFabFiles(files).files.filter((f) => f.layer.kind === 'copper').map((f) => ({ id: f.layer.id, objects: f.objects }))) {
  const holes = files.filter((f) => f.name.endsWith('PTH.drl') && !f.name.endsWith('NPTH.drl')).flatMap((f) => readExcellon(f.content).holes);
  return checkCopper(copper, holes, design, { fresh: true });
}

const SEEDS = [11, 23, 37, 41, 59, 73];

describe('generated boards: their files against their netlist', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}`, () => {
      const { board, what } = generate(seed);
      const { files, design } = ownFiles(board);
      const c = check(files, design);
      // copper joined to nothing only where the board says so itself (a plane its net never reaches)
      const floating = new Set(board.zones.filter((z) => z.floating).map((z) => board.netNames[z.netId]));
      expect(board.diagnostics.filter((d) => d.code === 'DRC.FLOATING_PLANE').length, what).toBe(board.zones.filter((z) => z.floating).length);
      for (const f of c.findings.filter((x) => x.kind === 'floating')) expect(f.nets.some((n) => floating.has(n.replace(/ \(copy \d+\)$/, ''))), `${what}: ${f.text}`).toBe(true);
      expect(c.findings.filter((f) => f.kind !== 'floating'), `${what}\n${copperCheckText(c)}`).toEqual([]);
      expect(c.found, what).toBe(c.total);
      expect(c.openInDesign, what).toBe(board.unrouted.length * (board.panel?.copies.length ?? 1));
    }, 300_000);
  }
});

/* an independent reader: tracespace */

const require = createRequire(import.meta.url);
type Plotted = Record<string, unknown> & { type: string };

/** A Gerber file as tracespace's plotter draws it (its objects in order). */
function plot(src: string): Promise<Plotted[]> {
  const parser = require('gerber-parser')();
  const plotter = require('gerber-plotter')({ optimizePaths: false, plotAsOutline: false });
  return new Promise((resolve, reject) => {
    const out: Plotted[] = [];
    plotter.on('data', (o: Plotted) => out.push(o));
    plotter.on('error', reject);
    parser.on('error', reject);
    plotter.on('end', () => resolve(out));
    parser.pipe(plotter);
    parser.write(src);
    parser.end();
  });
}

type Pt = [number, number];
const ccw = (pts: Pt[]): Pt[] => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) a += pts[i]![0] * pts[(i + 1) % pts.length]![1] - pts[(i + 1) % pts.length]![0] * pts[i]![1];
  return a < 0 ? [...pts].reverse() : pts;
};
const polyPath = (pts: Pt[]): Path => ({ x: pts[0]![0], y: pts[0]![1], segs: [...pts.slice(1), pts[0]!].map(([x, y]) => ({ x, y })) });
const boxOf = (pts: Pt[], m = 0): Box => [Math.min(...pts.map((p) => p[0])) - m, Math.min(...pts.map((p) => p[1])) - m, Math.max(...pts.map((p) => p[0])) + m, Math.max(...pts.map((p) => p[1])) + m];

/** A tool's primitive flashed at x, y, as the shapes our check draws. */
function primitive(p: Record<string, unknown>, x: number, y: number): { shape: FabShape; box: Box } {
  const [cx, cy] = [x + (p.cx as number), y + (p.cy as number)];
  if (p.type === 'circle') {
    const r = p.r as number;
    return { shape: { k: 'circle', x: cx, y: cy, r }, box: [cx - r, cy - r, cx + r, cy + r] };
  }
  if (p.type === 'rect') {
    const [w, h, r] = [p.width as number, p.height as number, p.r as number];
    if (r > 0 && 2 * r >= Math.min(w, h) - 1e-9) {
      // an obround: the stroke along its long side
      const [hx, hy] = w > h ? [(w - h) / 2, 0] : [0, (h - w) / 2];
      return { shape: { k: 'stroke', path: { x: cx - hx, y: cy - hy, segs: [{ x: cx + hx, y: cy + hy }] }, w: Math.min(w, h) }, box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2] };
    }
    if (r > 0) throw new Error('a rounded rectangle: not converted');
    const pts: Pt[] = [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]];
    return { shape: { k: 'fill', contours: [polyPath(pts)] }, box: boxOf(pts) };
  }
  if (p.type === 'poly') {
    const pts = ccw((p.points as Pt[]).map(([px, py]) => [x + px, y + py] as Pt));
    return { shape: { k: 'fill', contours: [polyPath(pts)] }, box: boxOf(pts) };
  }
  throw new Error(`a ${String(p.type)} primitive: not converted`);
}

type Seg = { type: 'line' | 'arc'; start: Pt; end: Pt; center?: Pt; dir?: 'cw' | 'ccw'; radius?: number };

/** tracespace's objects as our reader's (FabObject), drawn in the same order. */
function objectsOf(plotted: Plotted[]): FabObject[] {
  const tools = new Map<string, Record<string, unknown>[]>();
  const out: FabObject[] = [];
  let dark = true;
  for (const o of plotted) {
    if (o.type === 'polarity') dark = o.polarity === 'dark';
    else if (o.type === 'shape') tools.set(o.tool as string, o.shape as Record<string, unknown>[]);
    else if (o.type === 'pad') {
      const prims = tools.get(o.tool as string)!.map((p) => primitive(p, o.x as number, o.y as number));
      const parts: FabPart[] = prims.map((p) => ({ shape: p.shape }));
      out.push({ dark, kind: 'flash', parts, box: prims.map((p) => p.box).reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]) });
    } else if (o.type === 'stroke') {
      const w = o.width as number;
      for (const s of o.path as Seg[]) {
        const path: Path = { x: s.start[0], y: s.start[1], segs: [s.type === 'arc' ? { x: s.end[0], y: s.end[1], arc: { cx: s.center![0], cy: s.center![1], ccw: s.dir === 'ccw' } } : { x: s.end[0], y: s.end[1] }] };
        const reach = s.type === 'arc' ? [[s.center![0] - s.radius!, s.center![1] - s.radius!], [s.center![0] + s.radius!, s.center![1] + s.radius!]] : [s.start, s.end];
        out.push({ dark, kind: 'draw', parts: [{ shape: { k: 'stroke', path, w } }], box: boxOf(reach as Pt[], w / 2) });
      }
    } else if (o.type === 'fill') {
      // each closed loop of the fill is a region of its own (G36 contours are filled one by one)
      let loop: Pt[] = [];
      const close = () => {
        if (loop.length >= 3) out.push({ dark, kind: 'region', parts: [{ shape: { k: 'fill', contours: [polyPath(ccw(loop))] } }], box: boxOf(loop) });
        loop = [];
      };
      for (const s of o.path as Seg[]) {
        if (s.type !== 'line') throw new Error('an arc in a region: not converted');
        const last = loop.at(-1);
        if (!last || Math.hypot(last[0] - s.start[0], last[1] - s.start[1]) > 1e-9) {
          close();
          loop.push(s.start);
        }
        loop.push(s.end);
      }
      close();
    } else if (o.type !== 'size') throw new Error(`tracespace's ${o.type}: not converted`);
  }
  // (a closed loop repeats its first corner: drop it)
  for (const o of out) for (const p of o.parts) if (p.shape.k === 'fill') for (const c of p.shape.contours) if (c.segs.length > 1) {
    const [a, z] = [c.segs.at(-2)!, { x: c.x, y: c.y }];
    if (Math.hypot(a.x - z.x, a.y - z.y) < 1e-9) c.segs.splice(-1, 1);
  }
  return out;
}

describe('an independent reader (tracespace) reads the same copper', () => {
  for (const seed of SEEDS.slice(0, 3)) {
    it(`seed ${seed}`, async () => {
      const { board, what } = generate(seed);
      const { files, design } = ownFiles(board);
      const ours = check(files, design);
      const copperFiles = readFabFiles(files).files.filter((f) => f.layer.kind === 'copper');
      const theirs = check(files, design, await Promise.all(copperFiles.map(async (f) => ({ id: f.layer.id, objects: objectsOf(await plot(files.find((x) => x.name === f.name)!.content)) }))));
      for (const layer of ours.layers) {
        const [a, b] = [ours.copper[layer]!, theirs.copper[layer]!];
        expect(Math.abs(a.area - b.area) / Math.max(a.area, 1), `${what}: ${layer} copper, ours ${a.area} mm², tracespace's ${b.area} mm²`).toBeLessThan(0.001);
        expect(b.islands, `${what}: ${layer} pieces of copper`).toBe(a.islands);
      }
      expect(theirs.findings.map((f) => `${f.kind}: ${f.nets.join(', ')}`), `${what}\n${copperCheckText(theirs)}`).toEqual(ours.findings.map((f) => `${f.kind}: ${f.nets.join(', ')}`));
    }, 300_000);
  }
});
