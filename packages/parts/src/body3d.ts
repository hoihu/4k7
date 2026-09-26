/**
 * Simple 3D package bodies from datasheet package data (millimetres; x/y like the footprint,
 * viewed from the top with y down; z up, board surface at z = 0). Boxes and balls only: enough
 * for a 3D preview and collision/height checks, and the basis for a STEP/GLB export later.
 */
import type { PackageInfo } from '@tracewise/schema';
import { bgaRowName, footprintFor, type Pad } from './footprint.ts';

export interface Box3 {
  /** Min and max corners. */
  min: [number, number, number];
  max: [number, number, number];
  mat: 'body' | 'lead' | 'mark';
}

export interface Ball3 {
  c: [number, number, number];
  r: number;
}

export interface Body3D {
  boxes: Box3[];
  balls: Ball3[];
  /** Pin-1 mark on the top face (a small disc). */
  pin1: { x: number; y: number; z: number; r: number };
  /** Overall height above the board. */
  height: number;
  notes: string[];
}

export type Body3DResult = { ok: true; body: Body3D } | { ok: false; reason: string };

const r3 = (v: number) => Math.round(v * 1000) / 1000;

function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mat: Box3['mat']): Box3 {
  return { min: [r3(Math.min(x0, x1)), r3(Math.min(y0, y1)), r3(Math.min(z0, z1))], max: [r3(Math.max(x0, x1)), r3(Math.max(y0, y1)), r3(Math.max(z0, z1))], mat };
}

export function body3dFor(pkg: PackageInfo, pinNumbers: string[] = []): Body3DResult {
  const notes: string[] = [];
  const need = (keys: (keyof PackageInfo)[]) => {
    const miss = keys.filter((k) => pkg[k] === undefined);
    return miss.length ? `needs ${miss.join(', ')} from the package drawing` : null;
  };
  switch (pkg.family) {
    case 'QFP':
    case 'SOIC':
    case 'SSOP':
    case 'TSSOP':
    case 'MSOP': {
      const miss = need(['pitch_mm', 'body_mm']);
      if (miss) return { ok: false, reason: miss };
      const quad = pkg.family === 'QFP';
      if (!pkg.height_mm) notes.push('Height not given; assumed 1.6 mm.');
      return { ok: true, body: gullWing(pkg, quad ? 4 : 2, notes) };
    }
    case 'QFN':
    case 'DFN': {
      const miss = need(['pitch_mm', 'body_mm']);
      if (miss) return { ok: false, reason: miss };
      if (!pkg.height_mm) notes.push('Height not given; assumed 0.9 mm.');
      return { ok: true, body: noLead(pkg, pkg.family === 'QFN' ? 4 : 2, notes) };
    }
    case 'BGA':
    case 'CSP': {
      const miss = need(['pitch_mm', 'grid']);
      if (miss) return { ok: false, reason: miss };
      if (!pkg.height_mm) notes.push('Height not given; assumed 1.2 mm.');
      return { ok: true, body: ballGrid(pkg, pinNumbers, notes) };
    }
    case 'DIP':
      return { ok: true, body: dip(pkg, notes) };
    case 'CHIP':
      return pkg.body_mm ? { ok: true, body: chip(pkg) } : { ok: false, reason: 'needs body_mm' };
    case 'SOD':
    case 'SOT': {
      const fp = footprintFor(pkg, pinNumbers);
      if (!fp.ok || !pkg.body_mm) return { ok: false, reason: fp.ok ? 'needs body_mm' : fp.reason };
      return { ok: true, body: moulded(pkg, fp.footprint.pads) };
    }
    case 'HEADER':
      return { ok: true, body: header(pkg) };
    default:
      return { ok: false, reason: `no 3D generator for ${pkg.family} packages yet` };
  }
}

/** Lead centre offsets along a side, first lead first (same order as the footprint). */
const offsets = (n: number, pitch: number) => Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * pitch);

/** Unit vectors for the sides in footprint order: left (down), bottom (right), right (up), top (left). */
const SIDES = [
  { out: [-1, 0], along: [0, 1] },
  { out: [0, 1], along: [1, 0] },
  { out: [1, 0], along: [0, -1] },
  { out: [0, -1], along: [-1, 0] },
] as const;

function gullWing(pkg: PackageInfo, sides: 2 | 4, notes: string[]): Body3D {
  const [bw, bl] = pkg.body_mm!;
  const H = pkg.height_mm ?? 1.6;
  const standoff = 0.1;
  const span = pkg.span_mm ?? [bw + (sides === 4 ? 2 : 2.1), bl + (sides === 4 ? 2 : 2.1)];
  if (!pkg.span_mm) notes.push('Lead span not given; assumed body + 2 mm.');
  const foot = pkg.lead_length_mm ?? 0.6;
  const lw = pkg.lead_width_mm ?? pkg.pitch_mm! * 0.45;
  const t = 0.15; // lead thickness
  const arm = standoff + (H - standoff) * 0.45; // where the lead leaves the body
  const boxes: Box3[] = [box(-bw / 2, -bl / 2, standoff, bw / 2, bl / 2, H, 'body')];
  const n = pkg.pins / sides;
  const used = sides === 4 ? SIDES : [SIDES[0], SIDES[2]];
  for (const s of used) {
    const horizontal = s.out[0] !== 0; // leads leave along x
    const half = horizontal ? bw / 2 : bl / 2;
    const tip = horizontal ? span[0] / 2 : span[1] / 2;
    const bend = tip - foot;
    for (const o of offsets(n, pkg.pitch_mm!)) {
      const a = o * (s.along[0] + s.along[1]); // signed position along the side
      const seg = (r0: number, r1: number, z0: number, z1: number) =>
        horizontal
          ? box(s.out[0] * r0, a - lw / 2, z0, s.out[0] * r1, a + lw / 2, z1, 'lead')
          : box(a - lw / 2, s.out[1] * r0, z0, a + lw / 2, s.out[1] * r1, z1, 'lead');
      boxes.push(seg(half, bend + t / 2, arm - t / 2, arm + t / 2)); // shoulder
      boxes.push(seg(bend - t / 2, bend + t / 2, 0, arm)); // bend down
      boxes.push(seg(bend, tip, 0, t)); // foot
    }
  }
  return { boxes, balls: [], pin1: pin1Mark(pkg, bw, bl, H, sides === 4), height: H, notes };
}

function noLead(pkg: PackageInfo, sides: 2 | 4, notes: string[]): Body3D {
  const [bw, bl] = pkg.body_mm!;
  const H = pkg.height_mm ?? 0.9;
  const L = pkg.lead_length_mm ?? 0.4;
  const lw = pkg.lead_width_mm ?? pkg.pitch_mm! * 0.5;
  const boxes: Box3[] = [box(-bw / 2, -bl / 2, 0.02, bw / 2, bl / 2, H, 'body')];
  const n = pkg.pins / sides;
  for (const s of sides === 4 ? SIDES : [SIDES[0], SIDES[2]]) {
    const horizontal = s.out[0] !== 0;
    const half = horizontal ? bw / 2 : bl / 2;
    for (const o of offsets(n, pkg.pitch_mm!)) {
      const a = o * (s.along[0] + s.along[1]);
      // terminal flush with the side, slightly proud so it shows
      boxes.push(
        horizontal
          ? box(s.out[0] * (half - L), a - lw / 2, 0, s.out[0] * (half + 0.02), a + lw / 2, 0.2, 'lead')
          : box(a - lw / 2, s.out[1] * (half - L), 0, a + lw / 2, s.out[1] * (half + 0.02), 0.2, 'lead'),
      );
    }
  }
  if (pkg.exposed_pad_mm) boxes.push(box(-pkg.exposed_pad_mm[0] / 2, -pkg.exposed_pad_mm[1] / 2, 0, pkg.exposed_pad_mm[0] / 2, pkg.exposed_pad_mm[1] / 2, 0.02, 'lead'));
  return { boxes, balls: [], pin1: pin1Mark(pkg, bw, bl, H, sides === 4), height: H, notes };
}

function ballGrid(pkg: PackageInfo, pinNumbers: string[], notes: string[]): Body3D {
  const { rows, cols } = pkg.grid!;
  const pitch = pkg.pitch_mm!;
  const [bw, bl] = pkg.body_mm ?? [cols * pitch, rows * pitch];
  const H = pkg.height_mm ?? 1.2;
  const d = pkg.ball_mm ?? pitch * 0.5;
  const zBall = d * 0.4; // ball centre: the ball is slightly flattened on the pad
  const present = new Set(pinNumbers.map((n) => n.toUpperCase()));
  const balls: Ball3[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (present.size && !present.has(`${bgaRowName(r)}${c + 1}`)) continue;
      balls.push({ c: [r3((c - (cols - 1) / 2) * pitch), r3((r - (rows - 1) / 2) * pitch), r3(zBall)], r: r3(d / 2) });
    }
  }
  return {
    // the body rests on the ball tops (solids never overlap, which the viewer relies on)
    boxes: [box(-bw / 2, -bl / 2, zBall + d / 2, bw / 2, bl / 2, H, 'body')],
    balls,
    pin1: { x: r3(-bw / 2 + Math.min(bw, bl) * 0.08), y: r3(-bl / 2 + Math.min(bw, bl) * 0.08), z: H, r: r3(Math.min(bw, bl) * 0.03) },
    height: H,
    notes,
  };
}

function dip(pkg: PackageInfo, notes: string[]): Body3D {
  const n = pkg.pins / 2;
  const pitch = pkg.pitch_mm ?? 2.54;
  const row = pkg.span_mm?.[0] ?? 7.62;
  const bw = pkg.body_mm?.[0] ?? 6.35;
  const bl = pkg.body_mm?.[1] ?? n * pitch + 0.5;
  const H = pkg.height_mm ?? 4.5;
  const z0 = 0.5;
  const boxes: Box3[] = [box(-bw / 2, -bl / 2, z0, bw / 2, bl / 2, H - 0.5, 'body')];
  for (const [side, sign] of [[0, -1], [1, 1]] as const) {
    for (const o of offsets(n, pitch)) {
      const y = side === 0 ? o : -o;
      boxes.push(box(sign * bw / 2, y - 0.25, z0 + 0.5, sign * (row / 2 + 0.1), y + 0.25, z0 + 0.75, 'lead')); // shoulder
      boxes.push(box(sign * (row / 2 - 0.15), y - 0.25, -3, sign * (row / 2 + 0.1), y + 0.25, z0 + 0.75, 'lead')); // pin through the board
    }
  }
  notes.push('Through-hole pins shown 3 mm below the board surface.');
  return { boxes, balls: [], pin1: pin1Mark(pkg, bw, bl, H - 0.5, false), height: H - 0.5, notes };
}

/** Pin-1 dimple near the corner of pin 1 (top-left in the footprint view). */
function pin1Mark(_pkg: PackageInfo, bw: number, bl: number, H: number, quad: boolean): Body3D['pin1'] {
  const m = Math.min(bw, bl);
  return quad
    ? { x: r3(-bw / 2 + m * 0.12), y: r3(-bl / 2 + m * 0.12), z: H, r: r3(m * 0.04) }
    : { x: r3(-bw / 2 + m * 0.2), y: r3(-bl / 2 + m * 0.15), z: H, r: r3(m * 0.06) };
}

/** Chip parts: a ceramic body with metal end caps (pin 1 at −x). */
function chip(pkg: PackageInfo): Body3D {
  const [l, w] = pkg.body_mm!;
  const t = pkg.lead_length_mm ?? l * 0.2;
  const H = pkg.height_mm ?? w * 0.7;
  return {
    boxes: [
      box(-l / 2 + t, -w / 2, 0, l / 2 - t, w / 2, H, 'body'),
      box(-l / 2, -w / 2, 0, -l / 2 + t, w / 2, H, 'lead'),
      box(l / 2 - t, -w / 2, 0, l / 2, w / 2, H, 'lead'),
    ],
    balls: [],
    pin1: { x: r3(-l / 2 + t + (l - 2 * t) * 0.15), y: 0, z: H, r: r3(Math.min(w, l) * 0.08) },
    height: H,
    notes: [],
  };
}

/** Moulded packages with short leads (SOD, SOT): body plus a flat lead to each pad. */
function moulded(pkg: PackageInfo, pads: Pad[]): Body3D {
  const [bl, bw] = pkg.body_mm!;
  const H = pkg.height_mm ?? 1.1;
  const z0 = 0.05;
  const boxes: Box3[] = [box(-bl / 2, -bw / 2, z0, bl / 2, bw / 2, H, 'body')];
  for (const p of pads) {
    // leads leave the body along the axis where the pad lies outside it
    const alongX = Math.abs(p.x) - p.w / 2 >= bl / 2 - 0.3 && Math.abs(p.x) > Math.abs(p.y);
    if (alongX) {
      const s = Math.sign(p.x);
      const half = Math.min(p.h, 1.4) / 2;
      boxes.push(box(s * (bl / 2), p.y - half * 0.7, 0, p.x + s * (p.w / 2 - 0.1), p.y + half * 0.7, 0.15, 'lead'));
    } else {
      const s = Math.sign(p.y);
      const half = Math.min(p.w, 3.3) / 2;
      boxes.push(box(p.x - half * 0.8, s * (bw / 2), 0, p.x + half * 0.8, p.y + s * (p.h / 2 - 0.1), 0.15, 'lead'));
    }
  }
  const lx = Math.min(...pads.map((p) => p.x));
  return { boxes, balls: [], pin1: { x: r3(Math.max(-bl / 2 + 0.3, lx)), y: r3(bw / 4), z: H, r: r3(Math.min(bl, bw) * 0.1) }, height: H, notes: [] };
}

/** Pin header: plastic strip with square posts, pins through the board. */
function header(pkg: PackageInfo): Body3D {
  const n = pkg.pins;
  const pitch = pkg.pitch_mm ?? 2.54;
  const boxes: Box3[] = [box(-1.27, (-n * pitch) / 2, 0, 1.27, (n * pitch) / 2, 2.5, 'body')];
  for (let i = 0; i < n; i++) {
    const y = (i - (n - 1) / 2) * pitch;
    boxes.push(box(-0.32, y - 0.32, -3, 0.32, y + 0.32, 2.5 - 0.001, 'lead')); // below and inside the strip
    boxes.push(box(-0.32, y - 0.32, 2.5, 0.32, y + 0.32, (pkg.height_mm ?? 8.5), 'lead'));
  }
  return { boxes, balls: [], pin1: { x: -0.9, y: r3(-((n - 1) / 2) * pitch), z: 2.5, r: 0.2 }, height: pkg.height_mm ?? 8.5, notes: ['Pins shown 3 mm below the board surface.'] };
}
