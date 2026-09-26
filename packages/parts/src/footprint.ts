/**
 * Deterministic land-pattern generator from datasheet package dimensions (millimetres,
 * origin at the package centre, y down, viewed from the top). Pad sizes follow the usual
 * IPC-7351 nominal-density rules of thumb: toe/heel extensions on gull-wing leads, pads
 * reaching out past the body edge on no-lead packages, balls at ~80 % diameter.
 */
import type { PackageInfo } from '@tracewise/schema';

export interface Pad {
  number: string;
  x: number;
  y: number;
  w: number;
  h: number;
  shape: 'rect' | 'round';
  /** Through-hole drill diameter. */
  drill?: number;
}

export interface Footprint {
  pads: Pad[];
  /** Package body outline (silkscreen/fab), centred. */
  body: { w: number; h: number };
  /** Keep-out rectangle around everything (courtyard), centred. */
  courtyard: { w: number; h: number };
  pin1: { x: number; y: number };
  notes: string[];
}

export type FootprintResult = { ok: true; footprint: Footprint } | { ok: false; reason: string };

const r2 = (v: number) => Math.round(v * 1000) / 1000;
const TOE = 0.35;
const HEEL = 0.35;
const COURTYARD = 0.5;

/** JEDEC ball rows: A B C … skipping I O Q S X Z, then AA AB … */
export function bgaRowName(i: number): string {
  const letters = 'ABCDEFGHJKLMNPRTUVWY';
  return i < letters.length ? letters[i]! : letters[Math.floor(i / letters.length) - 1]! + letters[i % letters.length]!;
}

export function footprintFor(pkg: PackageInfo, pinNumbers: string[] = []): FootprintResult {
  const need = (what: (keyof PackageInfo)[]) => {
    const missing = what.filter((k) => pkg[k] === undefined);
    return missing.length ? `needs ${missing.join(', ')} from the package drawing` : null;
  };
  switch (pkg.family) {
    case 'QFP': {
      const miss = need(['pitch_mm', 'body_mm']);
      if (miss) return { ok: false, reason: miss };
      if (pkg.pins % 4) return { ok: false, reason: `${pkg.pins} pins cannot be split over 4 sides` };
      return { ok: true, footprint: quad(pkg, true) };
    }
    case 'QFN': {
      const miss = need(['pitch_mm', 'body_mm']);
      if (miss) return { ok: false, reason: miss };
      if (pkg.pins % 4) return { ok: false, reason: `${pkg.pins} pins cannot be split over 4 sides` };
      return { ok: true, footprint: quad(pkg, false, epNumber(pkg, pinNumbers)) };
    }
    case 'SOIC':
    case 'SSOP':
    case 'TSSOP':
    case 'MSOP': {
      const miss = need(['pitch_mm', 'body_mm']);
      if (miss) return { ok: false, reason: miss };
      if (pkg.pins % 2) return { ok: false, reason: `${pkg.pins} pins cannot be split over 2 sides` };
      return { ok: true, footprint: dual(pkg, true, epNumber(pkg, pinNumbers)) };
    }
    case 'DFN': {
      const miss = need(['pitch_mm', 'body_mm']);
      if (miss) return { ok: false, reason: miss };
      return { ok: true, footprint: dual(pkg, false, epNumber(pkg, pinNumbers)) };
    }
    case 'BGA':
    case 'CSP': {
      const miss = need(['pitch_mm', 'grid']);
      if (miss) return { ok: false, reason: miss };
      return { ok: true, footprint: grid(pkg, pinNumbers) };
    }
    case 'DIP':
      return { ok: true, footprint: dip(pkg) };
    default:
      return { ok: false, reason: `no generator for ${pkg.family} packages yet` };
  }
}

function epNumber(pkg: PackageInfo, pinNumbers: string[]): string | null {
  if (!pkg.exposed_pad_mm) return null;
  return pinNumbers.find((n) => /^(EP|PAD|\d+)$/i.test(n) && (n.toUpperCase() === 'EP' || Number(n) === pkg.pins + 1)) ?? 'EP';
}

/** Quad packages: pin 1 at the top of the left side, counter-clockwise (viewed from the top). */
function quad(pkg: PackageInfo, gullWing: boolean, ep: string | null = null): Footprint {
  const n = pkg.pins / 4;
  const pitch = pkg.pitch_mm!;
  const [bw, bl] = pkg.body_mm!;
  const [sw, sl] = pkg.span_mm ?? (gullWing ? [bw + 2, bl + 2] : [bw, bl]);
  const foot = pkg.lead_length_mm ?? (gullWing ? 0.6 : 0.4);
  const padW = r2(Math.min(pkg.lead_width_mm ? pkg.lead_width_mm + 0.1 : pitch * 0.55, pitch * 0.6));
  // pad extent measured from the centre outwards
  const extent = (span: number, body: number) =>
    gullWing ? { outer: span / 2 + TOE, inner: span / 2 - foot - HEEL } : { outer: body / 2 + 0.3, inner: body / 2 - foot - 0.05 };
  const ex = extent(sw, bw);
  const ey = extent(sl, bl);
  const lenX = r2(ex.outer - ex.inner);
  const lenY = r2(ey.outer - ey.inner);
  const cx = r2((ex.outer + ex.inner) / 2);
  const cy = r2((ey.outer + ey.inner) / 2);
  const off = (i: number) => r2((i - (n - 1) / 2) * pitch);

  const pads: Pad[] = [];
  let num = 1;
  for (let i = 0; i < n; i++) pads.push({ number: String(num++), x: -cx, y: off(i), w: lenX, h: padW, shape: 'rect' }); // left, top → bottom
  for (let i = 0; i < n; i++) pads.push({ number: String(num++), x: off(i), y: cy, w: padW, h: lenY, shape: 'rect' }); // bottom, left → right
  for (let i = 0; i < n; i++) pads.push({ number: String(num++), x: cx, y: -off(i), w: lenX, h: padW, shape: 'rect' }); // right, bottom → top
  for (let i = 0; i < n; i++) pads.push({ number: String(num++), x: -off(i), y: -cy, w: padW, h: lenY, shape: 'rect' }); // top, right → left
  const notes: string[] = [];
  if (ep && pkg.exposed_pad_mm) {
    pads.push({ number: ep, x: 0, y: 0, w: pkg.exposed_pad_mm[0], h: pkg.exposed_pad_mm[1], shape: 'rect' });
    notes.push('Exposed pad: add thermal vias in the board layout.');
  }
  if (!pkg.span_mm && gullWing) notes.push('Lead span not given; assumed body + 2 mm.');
  return {
    pads,
    body: { w: bw, h: bl },
    courtyard: { w: r2(2 * ex.outer + 2 * COURTYARD), h: r2(2 * ey.outer + 2 * COURTYARD) },
    pin1: { x: r2(-ex.outer - 0.4), y: off(0) },
    notes,
  };
}

/** Dual rows: pin 1 at the top of the left row, counter-clockwise. */
function dual(pkg: PackageInfo, gullWing: boolean, ep: string | null): Footprint {
  const n = pkg.pins / 2;
  const pitch = pkg.pitch_mm!;
  const [bw, bl] = pkg.body_mm!;
  const span = pkg.span_mm?.[0] ?? (gullWing ? bw + 2.1 : bw);
  const foot = pkg.lead_length_mm ?? (gullWing ? 0.6 : 0.4);
  const outer = gullWing ? span / 2 + TOE : bw / 2 + 0.3;
  const inner = gullWing ? span / 2 - foot - HEEL : bw / 2 - foot - 0.05;
  const len = r2(outer - inner);
  const cx = r2((outer + inner) / 2);
  const padW = r2(Math.min(pkg.lead_width_mm ? pkg.lead_width_mm + 0.1 : pitch * 0.55, pitch * 0.6));
  const off = (i: number) => r2((i - (n - 1) / 2) * pitch);
  const pads: Pad[] = [];
  let num = 1;
  for (let i = 0; i < n; i++) pads.push({ number: String(num++), x: -cx, y: off(i), w: len, h: padW, shape: 'rect' });
  for (let i = 0; i < n; i++) pads.push({ number: String(num++), x: cx, y: -off(i), w: len, h: padW, shape: 'rect' });
  const notes: string[] = [];
  if (ep && pkg.exposed_pad_mm) {
    pads.push({ number: ep, x: 0, y: 0, w: pkg.exposed_pad_mm[0], h: pkg.exposed_pad_mm[1], shape: 'rect' });
    notes.push('Exposed pad: add thermal vias in the board layout.');
  }
  return {
    pads,
    body: { w: bw, h: bl },
    courtyard: { w: r2(2 * outer + 2 * COURTYARD), h: r2(bl + 2 * COURTYARD) },
    pin1: { x: r2(-outer - 0.4), y: off(0) },
    notes,
  };
}

/** Ball grid: row letters top → bottom, columns 1… left → right; only balls in the pin list. */
function grid(pkg: PackageInfo, pinNumbers: string[]): Footprint {
  const { rows, cols } = pkg.grid!;
  const pitch = pkg.pitch_mm!;
  const d = r2((pkg.ball_mm ?? pitch * 0.5) * 0.8);
  const present = new Set(pinNumbers.map((n) => n.toUpperCase()));
  const pads: Pad[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const name = `${bgaRowName(r)}${c + 1}`;
      if (present.size && !present.has(name)) continue;
      pads.push({ number: name, x: r2((c - (cols - 1) / 2) * pitch), y: r2((r - (rows - 1) / 2) * pitch), w: d, h: d, shape: 'round' });
    }
  }
  const [bw, bl] = pkg.body_mm ?? [cols * pitch, rows * pitch];
  return {
    pads,
    body: { w: bw, h: bl },
    courtyard: { w: r2(bw + 2 * COURTYARD), h: r2(bl + 2 * COURTYARD) },
    pin1: { x: r2(-bw / 2 - 0.3), y: r2(-bl / 2 - 0.3) },
    notes: [],
  };
}

/** Through-hole DIP: 2.54 mm pitch, 7.62 mm row spacing unless given. */
function dip(pkg: PackageInfo): Footprint {
  const n = pkg.pins / 2;
  const pitch = pkg.pitch_mm ?? 2.54;
  const rowSpan = pkg.span_mm?.[0] ?? 7.62;
  const off = (i: number) => r2((i - (n - 1) / 2) * pitch);
  const pads: Pad[] = [];
  let num = 1;
  for (let i = 0; i < n; i++) pads.push({ number: String(num++), x: -rowSpan / 2, y: off(i), w: 1.6, h: 1.6, shape: i === 0 ? 'rect' : 'round', drill: 0.8 });
  for (let i = 0; i < n; i++) pads.push({ number: String(num++), x: rowSpan / 2, y: -off(i), w: 1.6, h: 1.6, shape: 'round', drill: 0.8 });
  const bw = pkg.body_mm?.[0] ?? 6.35;
  const bl = pkg.body_mm?.[1] ?? n * pitch + 0.5;
  return { pads, body: { w: bw, h: bl }, courtyard: { w: r2(rowSpan + 1.6 + 2 * COURTYARD), h: r2(bl + 2 * COURTYARD) }, pin1: { x: r2(-rowSpan / 2 - 1.2), y: off(0) }, notes: [] };
}
