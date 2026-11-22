/**
 * Deterministic land-pattern generator from datasheet package dimensions (millimetres,
 * origin at the package centre, y down, viewed from the top). Pad sizes follow the usual
 * IPC-7351 nominal-density rules of thumb: toe/heel extensions on gull-wing leads, pads
 * reaching out past the body edge on no-lead packages, balls at ~80 % diameter.
 */
import { padPins } from '@4k7/schema';
import type { BodyCorner, PackageInfo } from '@4k7/schema';

export interface Pad {
  number: string;
  x: number;
  y: number;
  w: number;
  h: number;
  shape: 'rect' | 'round';
  /** Through-hole drill diameter; a slot's width (its narrow side). */
  drill?: number;
  /** A slotted (oval) hole: width × height, round-ended along the longer side. */
  slot?: { w: number; h: number };
  /** Further pins on this pad (the datasheet lands them on one pad). */
  also?: string[];
}

export interface Footprint {
  pads: Pad[];
  /** Package body outline (silkscreen/fab), centred; round: a circle of diameter w; chamfer: corners cut off it (an electrolytic's + side). */
  body: { w: number; h: number; round?: boolean; chamfer?: { size: number; corners: BodyCorner[] } };
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

/**
 * A module (a small carrier board with two rows of pins, like a Raspberry Pi Pico): the MODULE
 * family, or a "DIP" whose body is wider than its pin rows (the pins would sit under the body,
 * which a DIP never has).
 */
export function isModule(pkg: PackageInfo): boolean {
  return pkg.family === 'MODULE' || (pkg.family === 'DIP' && !!pkg.body_mm && pkg.body_mm[0] > (pkg.span_mm?.[0] ?? 7.62));
}

/** A module's pin rows: centre to centre (given, else 1.61 mm in from each long edge, as on a Pico). */
export function moduleSpan(pkg: PackageInfo): number {
  return pkg.span_mm?.[0] ?? Math.max(2.54, (pkg.body_mm?.[0] ?? 21) - 3.22);
}

/**
 * A package as seen from above. Pads read off a bottom-view drawing (pads_view "bottom": many LED,
 * connector and module datasheets draw the pad side) are mirrored left to right here, once, with the
 * body's cut corners and the mating face; the result is top view and carries no pads_view. Imports
 * and set_footprint pass through this, so stored pads are always top view (docs/design/part-ingest.md).
 */
export function toTopView(pkg: PackageInfo): PackageInfo {
  const { pads_view, ...top } = pkg;
  if (pads_view !== 'bottom') return top;
  const corner: Record<BodyCorner, BodyCorner> = { tl: 'tr', tr: 'tl', bl: 'br', br: 'bl' };
  const flip = (x: number) => (x === 0 ? 0 : -x);
  if (top.pads) top.pads = top.pads.map((p) => ({ ...p, x: flip(p.x) }));
  if (top.body_chamfer) top.body_chamfer = { ...top.body_chamfer, corners: top.body_chamfer.corners.map((c) => corner[c]) };
  if (top.mating) {
    const m = top.mating;
    const face = m.face === 'left' ? 'right' : m.face === 'right' ? 'left' : m.face;
    // along the top or bottom face runs in x and flips; along a side face runs in y and stays
    const along = m.along_mm !== undefined && (m.face === 'top' || m.face === 'bottom') ? flip(m.along_mm) : m.along_mm;
    top.mating = { ...m, face, ...(along !== undefined ? { along_mm: along } : {}) };
  }
  return top;
}

export function footprintFor(pkg: PackageInfo, pinNumbers: string[] = []): FootprintResult {
  const need = (what: (keyof PackageInfo)[]) => {
    const missing = what.filter((k) => pkg[k] === undefined);
    return missing.length ? `needs ${missing.join(', ')} from the package drawing` : null;
  };
  if (pkg.pads?.length) return explicit(pkg, pinNumbers);
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
    case 'MODULE':
      return { ok: true, footprint: isModule(pkg) ? moduleFp(pkg) : dip(pkg) };
    case 'CHIP': {
      const miss = need(['body_mm']);
      if (miss) return { ok: false, reason: miss };
      return { ok: true, footprint: chip(pkg) };
    }
    case 'SOD': {
      const miss = need(['body_mm', 'span_mm']);
      if (miss) return { ok: false, reason: miss };
      return { ok: true, footprint: sod(pkg) };
    }
    case 'SOT': {
      const miss = need(['body_mm', 'span_mm', 'pitch_mm']);
      if (miss) return { ok: false, reason: miss };
      const fp = sot(pkg, pinNumbers);
      return fp ? { ok: true, footprint: fp } : { ok: false, reason: `no SOT generator for ${pkg.pins} pins` };
    }
    case 'HEADER':
      return { ok: true, footprint: header(pkg) };
    case 'AXIAL':
    case 'RADIAL': {
      const miss = need(['pitch_mm', 'body_mm']);
      if (miss) return { ok: false, reason: miss };
      return { ok: true, footprint: twoLead(pkg) };
    }
    default:
      return { ok: false, reason: `no generator for ${pkg.family} packages yet` };
  }
}

/**
 * A land pattern given pad by pad (from the datasheet's drawing): checked for a pad per pin, no
 * overlapping copper and drills (round or slotted) inside their pads. The body is the given one, else the pads'
 * extent; the courtyard covers both.
 */
function explicit(pkg: PackageInfo, pinNumbers: string[]): FootprintResult {
  const pads: Pad[] = pkg.pads!.map((p) => {
    const slot = p.slot && { w: r2(p.slot[0]), h: r2(p.slot[1]) };
    const drill = slot ? Math.min(slot.w, slot.h) : p.drill && r2(p.drill);
    const also = [...new Set(p.also ?? [])].filter((n) => n.toUpperCase() !== p.number.toUpperCase());
    // an exposed (thermal) pad lands on the part's pin for it, if it has one
    const number = p.number.toUpperCase() === 'EP' && pkg.exposed_pad_mm ? epNumber(pkg, pinNumbers)! : p.number;
    return {
      number,
      x: r2(p.x),
      y: r2(p.y),
      w: r2(p.w),
      h: r2(p.h ?? p.w),
      shape: p.shape ?? (drill ? 'round' : 'rect'),
      ...(drill ? { drill } : {}),
      ...(slot && slot.w !== slot.h ? { slot } : {}),
      ...(also.length ? { also } : {}),
    };
  });
  const pinsOf = (p: Pad) => padPins(p).map((n) => n.toUpperCase());
  const have = new Set(pads.flatMap(pinsOf));
  if (pinNumbers.length) {
    const known = new Set(pinNumbers.map((n) => n.toUpperCase()));
    const noPad = pinNumbers.filter((n) => !have.has(n.toUpperCase()));
    if (noPad.length) return { ok: false, reason: `pins without a pad: ${noPad.join(', ')}` };
    const stray = [...new Set(pads.flatMap((p) => padPins(p)).filter((n) => !known.has(n.toUpperCase()) && !(n === 'EP' && pkg.exposed_pad_mm)))];
    if (stray.length) return { ok: false, reason: `pads for pins the part does not have: ${stray.join(', ')} (pins: ${pinNumbers.join(', ')})` };
  }
  for (const p of pads) {
    const [hw, hh] = p.slot ? [p.slot.w, p.slot.h] : [p.drill ?? 0, p.drill ?? 0];
    const hole = p.slot ? `${hw} × ${hh} mm slot` : `${hw} mm drill`;
    if (p.drill && (hw >= p.w - 0.2 || hh >= p.h - 0.2)) return { ok: false, reason: `pad ${p.number}: the ${hole} leaves no copper ring in a ${p.w} × ${p.h} mm pad (make the pad at least the hole + 0.5 mm on each axis)` };
  }
  for (let i = 0; i < pads.length; i++) {
    for (let j = i + 1; j < pads.length; j++) {
      const [a, b] = [pads[i]!, pads[j]!];
      if (pinsOf(a).some((n) => pinsOf(b).includes(n))) continue; // several pads of one pin may touch
      if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2) {
        return { ok: false, reason: `pads ${a.number} and ${b.number} overlap (centres ${a.x}, ${a.y} and ${b.x}, ${b.y} mm)` };
      }
    }
  }
  const ex = Math.max(...pads.map((p) => Math.abs(p.x) + p.w / 2));
  const ey = Math.max(...pads.map((p) => Math.abs(p.y) + p.h / 2));
  const round = pkg.body_shape === 'round';
  const [bw, bh] = pkg.body_mm ? (round ? [pkg.body_mm[0], pkg.body_mm[0]] : pkg.body_mm) : [r2(2 * ex + 0.5), r2(2 * ey + 0.5)];
  const first = pads.find((p) => p.number === '1') ?? pads[0]!;
  const notes = pkg.body_mm ? [] : ['Body size not given; drawn around the pads.'];
  return {
    ok: true,
    footprint: {
      pads,
      body: { w: bw, h: bh, ...(round ? { round: true } : !round && pkg.body_chamfer ? { chamfer: { size: pkg.body_chamfer.mm, corners: [...pkg.body_chamfer.corners] } } : {}) },
      courtyard: { w: r2(Math.max(bw, 2 * ex) + 2 * COURTYARD), h: r2(Math.max(bh, 2 * ey) + 2 * COURTYARD) },
      pin1: { x: r2(first.x - first.w / 2 - 0.4), y: first.y },
      notes,
    },
  };
}

/**
 * Two through-hole leads on the x axis, pitch apart, pin 1 left (square pad). Axial: the body lies
 * between them (length × diameter); radial: a round can standing over both.
 */
function twoLead(pkg: PackageInfo): Footprint {
  const p = pkg.pitch_mm!;
  const lead = pkg.lead_width_mm ?? 0.6;
  const drill = r2(Math.max(0.7, Math.ceil((lead + 0.3) * 10) / 10));
  const pad = r2(Math.max(1.6, drill + 0.7));
  const round = pkg.family === 'RADIAL';
  const [bw, bh] = round ? [pkg.body_mm![0], pkg.body_mm![0]] : pkg.body_mm!;
  const pads: Pad[] = [
    { number: '1', x: r2(-p / 2), y: 0, w: pad, h: pad, shape: 'rect', drill },
    { number: '2', x: r2(p / 2), y: 0, w: pad, h: pad, shape: 'round', drill },
  ];
  const cw = Math.max(bw, p + pad);
  const ch = Math.max(bh, pad);
  return {
    pads,
    body: { w: bw, h: bh, ...(round ? { round: true } : {}) },
    courtyard: { w: r2(cw + 2 * COURTYARD), h: r2(ch + 2 * COURTYARD) },
    pin1: { x: r2(-p / 2 - pad / 2 - 0.4), y: 0 },
    notes: [],
  };
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

/** A module: two rows of through-hole pads under the board's long edges, numbered like a DIP. */
function moduleFp(pkg: PackageInfo): Footprint {
  const n = Math.ceil(pkg.pins / 2);
  const pitch = pkg.pitch_mm ?? 2.54;
  const span = moduleSpan(pkg);
  const bw = pkg.body_mm?.[0] ?? span + 3.22;
  const bl = pkg.body_mm?.[1] ?? n * pitch + 1;
  const off = (i: number) => r2((i - (n - 1) / 2) * pitch);
  const pads: Pad[] = [];
  let num = 1;
  for (let i = 0; i < n && num <= pkg.pins; i++) pads.push({ number: String(num++), x: r2(-span / 2), y: off(i), w: 1.7, h: 1.7, shape: i === 0 ? 'rect' : 'round', drill: 1 });
  for (let i = 0; i < n && num <= pkg.pins; i++) pads.push({ number: String(num++), x: r2(span / 2), y: -off(i), w: 1.7, h: 1.7, shape: 'round', drill: 1 });
  return {
    pads,
    body: { w: bw, h: bl },
    courtyard: { w: r2(Math.max(bw, span + 1.7) + 2 * COURTYARD), h: r2(Math.max(bl, n * pitch) + 2 * COURTYARD) },
    pin1: { x: r2(-span / 2 + 1.6), y: off(0) },
    notes: [],
  };
}

/** Two-terminal chip (resistor, capacitor, moulded inductor): pads along x, pin 1 left. */
function chip(pkg: PackageInfo): Footprint {
  const [l, w] = pkg.body_mm!;
  const t = pkg.lead_length_mm ?? Math.min(0.5, l * 0.2);
  const toe = Math.min(0.35, 0.1 + l * 0.08);
  const outer = l / 2 + toe;
  const inner = Math.max(l / 2 - t - 0.05, Math.min(0.2, l * 0.15));
  const len = r2(outer - inner);
  const cx = r2((outer + inner) / 2);
  const h = r2(w + (w < 1 ? 0.15 : 0.2));
  return {
    pads: [
      { number: '1', x: -cx, y: 0, w: len, h, shape: 'rect' },
      { number: '2', x: cx, y: 0, w: len, h, shape: 'rect' },
    ],
    body: { w: l, h: w },
    courtyard: { w: r2(2 * outer + 2 * COURTYARD * 0.5), h: r2(Math.max(h, w) + 2 * COURTYARD * 0.5) },
    pin1: { x: r2(-outer - 0.25), y: 0 },
    notes: [],
  };
}

/** Moulded diode packages with two leads (SOD-123, SMA …): pin 1 (cathode) left. */
function sod(pkg: PackageInfo): Footprint {
  const [bl, bw] = pkg.body_mm!;
  const span = pkg.span_mm![0];
  const lead = pkg.lead_length_mm ?? 0.5;
  const lw = pkg.lead_width_mm ?? bw * 0.4;
  const len = r2(lead + 0.45);
  const cx = r2(span / 2 - lead / 2 + 0.05);
  const h = r2(lw + 0.35);
  const outer = cx + len / 2;
  return {
    pads: [
      { number: '1', x: -cx, y: 0, w: len, h, shape: 'rect' },
      { number: '2', x: cx, y: 0, w: len, h, shape: 'rect' },
    ],
    body: { w: bl, h: bw },
    courtyard: { w: r2(2 * outer + 0.5), h: r2(Math.max(h, bw) + 0.5) },
    pin1: { x: r2(-outer - 0.25), y: 0 },
    notes: [],
  };
}

/**
 * SOT packages, leads along y (body long side along x), viewed from the top:
 * SOT-23: 1 bottom left, 2 bottom right, 3 top middle. SOT-23-5/6: 1-2-3 bottom left→right,
 * then 4… top right→left. SOT-223: 1-2-3 bottom, the tab on top carries pin 2 (or 4).
 */
function sot(pkg: PackageInfo, pinNumbers: string[]): Footprint | null {
  const [bl, bw] = pkg.body_mm!;
  const spanY = pkg.span_mm![1];
  const lead = pkg.lead_length_mm ?? 0.45;
  const lw = pkg.lead_width_mm ?? 0.4;
  const p = pkg.pitch_mm!;
  const padH = r2(lead + 0.5);
  const padW = r2(lw + 0.2);
  const cy = r2(spanY / 2 - lead / 2 + 0.05);
  const pad = (number: string, x: number, y: number, w = padW, h = padH): Pad => ({ number, x: r2(x), y: r2(y), w, h, shape: 'rect' });
  let pads: Pad[];
  if (pkg.name === 'SOT-223') {
    const tab = pinNumbers.includes('4') ? '4' : '2';
    pads = [pad('1', -p, cy), pad('2', 0, cy), pad('3', p, cy), pad(tab, 0, -cy, 3.3, r2(lead + 1.1))];
  } else if (pkg.pins === 3) {
    pads = [pad('1', -p, cy), pad('2', p, cy), pad('3', 0, -cy)];
  } else if (pkg.pins === 5 || pkg.pins === 6) {
    pads = [pad('1', -p, cy), pad('2', 0, cy), pad('3', p, cy)];
    if (pkg.pins === 5) pads.push(pad('4', p, -cy), pad('5', -p, -cy));
    else pads.push(pad('4', p, -cy), pad('5', 0, -cy), pad('6', -p, -cy));
  } else return null;
  const maxY = Math.max(...pads.map((q) => Math.abs(q.y) + q.h / 2));
  const maxX = Math.max(bl / 2, ...pads.map((q) => Math.abs(q.x) + q.w / 2));
  return {
    pads,
    body: { w: bl, h: bw },
    courtyard: { w: r2(2 * maxX + 0.5), h: r2(2 * maxY + 0.5) },
    pin1: { x: r2(-p - padW), y: r2(cy + padH / 2 + 0.2) },
    notes: [],
  };
}

/** 2.54 mm pin header, one row along y, pin 1 (square pad) on top. */
function header(pkg: PackageInfo): Footprint {
  const n = pkg.pins;
  const pitch = pkg.pitch_mm ?? 2.54;
  const pads: Pad[] = Array.from({ length: n }, (_, i) => ({
    number: String(i + 1),
    x: 0,
    y: r2((i - (n - 1) / 2) * pitch),
    w: 1.7,
    h: 1.7,
    shape: i === 0 ? 'rect' : 'round',
    drill: 1.0,
  }));
  // a housing (JST XH) is the body where it is given, else the pin strip
  const [bw, bh] = pkg.body_mm ?? [2.54, r2(n * pitch)];
  return {
    pads,
    body: { w: bw, h: bh },
    courtyard: pkg.body_mm ? { w: r2(bw + 0.5), h: r2(bh + 0.5) } : { w: 3.0, h: r2(n * pitch + 0.5) },
    pin1: { x: pkg.body_mm ? r2(-bw / 2 - 0.4) : -1.6, y: r2(-((n - 1) / 2) * pitch) },
    notes: [],
  };
}

/** How far a pad ring's rows or columns may lie off its centre before it is reported (mm). */
export const LAND_RING_TOLERANCE = 0.05;

/**
 * A land whose pads run round all four sides (QFN, QFP, LGA modules): its left and right columns
 * should be centred between its top and bottom rows, and those rows between the columns, whatever
 * the land's offset from the body centre (a module's antenna end puts it off centre). A column or
 * row off that centre is a land read wrongly off the drawing, as the bike lamp's ESP32-C3-MINI-1 got
 * it (rows moved, side pads left where they were) and JLCPCB's footprint check caught. A row or
 * column is three or more pads of one size on one line; the ring needs all four, the rows between
 * the columns' ends and the columns between the rows (a grid or a two-sided land is not one). Null
 * when it lines up or is no ring; else the worst line, by how much, in words.
 */
export function landRingOffset(pads: readonly { number: string; x: number; y: number; w: number; h?: number }[]): { offset: number; text: string } | null {
  type Line = { at: number; lo: number; hi: number; numbers: string[] };
  const lines = (along: 'x' | 'y'): Line[] => {
    const across = along === 'x' ? 'y' : 'x';
    const groups = new Map<string, typeof pads[number][]>();
    for (const p of pads) {
      const key = `${Math.round(p[across] * 100)}|${p.w}|${p.h ?? p.w}`;
      groups.set(key, [...(groups.get(key) ?? []), p]);
    }
    return [...groups.values()]
      .filter((g) => new Set(g.map((p) => p.number)).size >= 3)
      .map((g) => ({ at: g[0]![across], lo: Math.min(...g.map((p) => p[along])), hi: Math.max(...g.map((p) => p[along])), numbers: g.map((p) => p.number) }));
  };
  const rows = lines('x');
  const cols = lines('y');
  if (rows.length < 2 || cols.length < 2) return null;
  const pick = (ls: Line[], dir: 1 | -1) => ls.reduce((a, b) => (dir * (b.at - a.at) > 0 ? b : a));
  const [top, bottom, left, right] = [pick(rows, -1), pick(rows, 1), pick(cols, -1), pick(cols, 1)];
  // a ring: the rows lie between the columns and the columns between the rows
  if (!(top.lo > left.at && top.hi < right.at && bottom.lo > left.at && bottom.hi < right.at)) return null;
  if (!(left.lo > top.at && left.hi < bottom.at && right.lo > top.at && right.hi < bottom.at)) return null;
  const cx = (left.at + right.at) / 2;
  const cy = (top.at + bottom.at) / 2;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const span = (l: Line) => {
    const ns = [...new Set(l.numbers)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return ns.length > 2 ? `${ns[0]}–${ns[ns.length - 1]}` : ns.join(', ');
  };
  const off = [
    { line: left, name: 'left column', d: (left.lo + left.hi) / 2 - cy, axis: 'y' as const },
    { line: right, name: 'right column', d: (right.lo + right.hi) / 2 - cy, axis: 'y' as const },
    { line: top, name: 'top row', d: (top.lo + top.hi) / 2 - cx, axis: 'x' as const },
    { line: bottom, name: 'bottom row', d: (bottom.lo + bottom.hi) / 2 - cx, axis: 'x' as const },
  ].sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0]!;
  if (Math.abs(off.d) <= LAND_RING_TOLERANCE) return null;
  const between = off.axis === 'y' ? `the top and bottom rows (pads ${span(top)} at y ${r2(top.at)} and ${span(bottom)} at y ${r2(bottom.at)} mm, ${r2(bottom.at - top.at)} mm apart)` : `the left and right columns (pads ${span(left)} at x ${r2(left.at)} and ${span(right)} at x ${r2(right.at)} mm, ${r2(right.at - left.at)} mm apart)`;
  const dir = off.axis === 'y' ? (off.d < 0 ? 'above' : 'below') : off.d < 0 ? 'left of' : 'right of';
  return {
    offset: r2(Math.abs(off.d)),
    text: `the ${off.name} (pads ${span(off.line)}) is centred ${r2(Math.abs(off.d))} mm ${dir} the midpoint between ${between}`,
  };
}
