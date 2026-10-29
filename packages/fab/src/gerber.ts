/**
 * Manufacturing outputs from a board view: Gerber RS-274X with X2 attributes (copper, mask,
 * paste, silkscreen, outline), Excellon drill, BOM and pick-and-place. Board coordinates are
 * y down from the top-left corner; fab files use y up from the bottom-left corner.
 */
import { boardPolygon, bodyOutline, cutoutPolygon, figureDepths, MASK_MARGIN, refdesHeight, textStrokes, textWidth, type BoardGraphic, type BoardPad, type BoardView, type CopperLayer, type HousePlacement, type PanelView } from '@4k7/schema';

export interface FabFile {
  name: string;
  content: string;
}

const SILK_WIDTH = 0.15;
const SILK_TO_PAD = 0.15;
const f6 = (v: number) => Math.round(v * 1e6).toString();

class Gerber {
  private apertures = new Map<string, number>();
  private body: string[] = [];
  private next = 10;
  private current = -1;
  constructor(private h: number, private attrs: string[]) {}

  private aperture(def: string): number {
    let d = this.apertures.get(def);
    if (d === undefined) {
      d = this.next++;
      this.apertures.set(def, d);
    }
    if (d !== this.current) {
      this.body.push(`D${d}*`);
      this.current = d;
    }
    return d;
  }
  private xy(x: number, y: number) {
    return `X${f6(x)}Y${f6(this.h - y)}`;
  }
  /** A pad: rectangle or circle flash (w/h already rotated). */
  pad(p: { x: number; y: number; w: number; h: number; shape: 'rect' | 'round' }, grow = 0) {
    const w = p.w + 2 * grow;
    const h = p.h + 2 * grow;
    // round and longer one way: an oval (obround), as a slotted hole's pad is
    this.aperture(p.shape === 'rect' ? `R,${w.toFixed(6)}X${h.toFixed(6)}` : Math.abs(w - h) < 1e-6 ? `C,${w.toFixed(6)}` : `O,${w.toFixed(6)}X${h.toFixed(6)}`);
    this.body.push(`${this.xy(p.x, p.y)}D03*`);
  }
  /** An exact plane: the outline filled, cutouts cleared (clear polarity), spokes drawn back. */
  plane(sh: import('@4k7/schema').ZoneShape) {
    const [x0, y0, x1, y1] = sh.outline;
    // the filled area: the clip polygon (a shaped board), else the rectangle
    const area = sh.clip ?? [x0, y0, x1, y0, x1, y1, x0, y1];
    this.body.push('G36*', `${this.xy(area[0]!, area[1]!)}D02*`);
    for (let i = 2; i < area.length; i += 2) this.body.push(`${this.xy(area[i]!, area[i + 1]!)}D01*`);
    this.body.push(`${this.xy(area[0]!, area[1]!)}D01*`, 'G37*');
    this.body.push('%LPC*%');
    for (const c of sh.cuts) {
      if (c.k === 'circle') this.circle(c.x, c.y, c.d);
      else if (c.k === 'rect') this.pad({ x: c.x + c.w / 2, y: c.y + c.h / 2, w: c.w, h: c.h, shape: 'rect' });
      else if (c.pts.length === 2) this.circle(c.pts[0]!, c.pts[1]!, c.w);
      else this.line(c.pts, c.w);
    }
    this.body.push('%LPD*%');
    for (const a of sh.adds) this.line(a.pts, a.w);
  }
  /** One closed polygon as a region, in dark or clear polarity. */
  region(pts: number[], clear = false) {
    if (pts.length < 6) return;
    if (clear) this.body.push('%LPC*%');
    this.body.push('G36*', `${this.xy(pts[0]!, pts[1]!)}D02*`);
    for (let i = 2; i + 1 < pts.length; i += 2) this.body.push(`${this.xy(pts[i]!, pts[i + 1]!)}D01*`);
    this.body.push(`${this.xy(pts[0]!, pts[1]!)}D01*`, 'G37*');
    if (clear) this.body.push('%LPD*%');
  }
  polarity(clear: boolean) {
    this.body.push(clear ? '%LPC*%' : '%LPD*%');
  }
  /** A silkscreen graphic: filled figures (outermost first, holes cleared) or closed outlines. */
  graphic(g: BoardGraphic) {
    if (g.mode === 'outline') {
      for (const p of g.polys) this.line([...p, p[0]!, p[1]!], g.line);
      return;
    }
    const depth = figureDepths(g.polys);
    g.polys.map((p, i) => ({ p, d: depth[i]! })).sort((a, b) => a.d - b.d).forEach(({ p, d }) => this.region(p, d % 2 === 1));
  }
  /** Filled rectangles as regions (copper pours). */
  regions(rects: number[]) {
    for (let i = 0; i + 3 < rects.length; i += 4) {
      const [x, y, w, h] = [rects[i]!, rects[i + 1]!, rects[i + 2]!, rects[i + 3]!];
      this.body.push('G36*', `${this.xy(x, y)}D02*`, `${this.xy(x + w, y)}D01*`, `${this.xy(x + w, y + h)}D01*`, `${this.xy(x, y + h)}D01*`, `${this.xy(x, y)}D01*`, 'G37*');
    }
  }
  circle(x: number, y: number, d: number) {
    this.aperture(`C,${d.toFixed(6)}`);
    this.body.push(`${this.xy(x, y)}D03*`);
  }
  /** A polyline stroked with a round aperture. */
  line(pts: number[], width: number) {
    if (pts.length < 4) return;
    this.aperture(`C,${width.toFixed(6)}`);
    this.body.push(`${this.xy(pts[0]!, pts[1]!)}D02*`);
    for (let i = 2; i + 1 < pts.length; i += 2) this.body.push(`${this.xy(pts[i]!, pts[i + 1]!)}D01*`);
  }
  toString(): string {
    const ads = [...this.apertures.entries()].map(([def, d]) => {
      const [shape, params] = def.split(',');
      return `%ADD${d}${shape},${params}*%`;
    });
    return [
      '%TF.GenerationSoftware,4k7,4k7,0.1*%',
      ...this.attrs.map((a) => `%TF.${a}*%`),
      '%FSLAX46Y46*%',
      '%MOMM*%',
      '%LPD*%',
      'G01*',
      ...ads,
      ...this.body,
      'M02*',
      '',
    ].join('\n');
  }
}

const onLayer = (p: BoardPad, layer: CopperLayer) => !p.npth && (!!p.drill || p.layers.includes(layer));

/** The Gerber set and drill files; with `panel`, `b` is the whole panel (panelBoard) and the panel's contours and fiducials are drawn. */
export function gerbers(b: BoardView, project: string, panel?: PanelView): FabFile[] {
  const { w, h } = b.outline;
  const base = project.replace(/[^\w.-]+/g, '_') || 'board';
  const files: FabFile[] = [];
  const pads = b.parts.flatMap((p) => p.pads);
  const n = b.layers.length;

  /* copper */
  b.layers.forEach((layer, i) => {
    const pos = i === 0 ? 'Top' : i === n - 1 ? 'Bot' : 'Inr';
    const g = new Gerber(h, [`FileFunction,Copper,L${i + 1},${pos}`, 'FilePolarity,Positive']);
    for (const z of b.zones) if (z.layer === layer) (z.shape ? g.plane(z.shape) : g.regions(z.rects));
    for (const p of pads) if (onLayer(p, layer)) g.pad(p);
    for (const v of b.vias) g.circle(v.x, v.y, v.pad);
    for (const t of b.tracks) if (t.layer === layer) g.line(t.pts, t.width);
    if (i === 0 || i === n - 1) for (const f of panel?.fiducials ?? []) g.circle(f.x, f.y, f.d);
    files.push({ name: `${base}-${layer.replace('.', '_')}.gbr`, content: g.toString() });
  });

  /* solder mask (openings; vias are tented) and paste (SMD pads only) */
  for (const [side, layer] of [['Top', 'F.Cu'], ['Bot', 'B.Cu']] as const) {
    const mask = new Gerber(h, [`FileFunction,Soldermask,${side}`, 'FilePolarity,Negative']);
    for (const p of pads) {
      if (p.npth) mask.circle(p.x, p.y, p.drill! + 2 * MASK_MARGIN); // bare hole: no mask over it
      else if (onLayer(p, layer)) mask.pad(p, MASK_MARGIN);
    }
    for (const f of panel?.fiducials ?? []) mask.circle(f.x, f.y, f.mask);
    files.push({ name: `${base}-${side === 'Top' ? 'F' : 'B'}_Mask.gbr`, content: mask.toString() });
    const paste = new Gerber(h, [`FileFunction,Paste,${side}`, 'FilePolarity,Positive']);
    for (const p of pads) if (!p.drill && p.layers.includes(layer)) paste.pad(p);
    files.push({ name: `${base}-${side === 'Top' ? 'F' : 'B'}_Paste.gbr`, content: paste.toString() });
  }

  /* silkscreen per side: graphics (logos), body outlines and refdes of the parts mounted there, kept off pads */
  for (const [side, layer] of [['top', 'F.Cu'], ['bottom', 'B.Cu']] as const) {
    const graphics = (b.graphics ?? []).filter((g) => g.side === side);
    const parts = b.parts.filter((p) => p.side === side && !p.componentId.startsWith('hole:')); // mounting holes carry no silkscreen
    // the bottom file only when something is printed there
    if (side === 'bottom' && !graphics.length && !parts.length) continue;
    const silk = new Gerber(h, [`FileFunction,Legend,${side === 'top' ? 'Top' : 'Bot'}`, 'FilePolarity,Positive']);
    // the pads exposed on this side
    const here = pads.filter((p) => p.npth || onLayer(p, layer));
    // graphics first; then the pads (with their clearance) are cleared out of them
    for (const g of graphics) silk.graphic(g);
    if (graphics.length) {
      silk.polarity(true);
      for (const p of here) silk.pad(p.npth ? { ...p, w: p.drill!, h: p.drill!, shape: 'round' } : p, SILK_TO_PAD);
      for (const v of b.vias) silk.circle(v.x, v.y, v.pad + 2 * SILK_TO_PAD);
      silk.polarity(false);
    }
    const keepOff = [
      ...here.map((p) => ({ x0: p.x - p.w / 2 - SILK_TO_PAD - SILK_WIDTH / 2, y0: p.y - p.h / 2 - SILK_TO_PAD - SILK_WIDTH / 2, x1: p.x + p.w / 2 + SILK_TO_PAD + SILK_WIDTH / 2, y1: p.y + p.h / 2 + SILK_TO_PAD + SILK_WIDTH / 2 })),
      // and off vias (ink on a via's ring prints badly)
      ...b.vias.map((v) => ({ x0: v.x - v.pad / 2 - SILK_WIDTH, y0: v.y - v.pad / 2 - SILK_WIDTH, x1: v.x + v.pad / 2 + SILK_WIDTH, y1: v.y + v.pad / 2 + SILK_WIDTH })),
    ];
    const clear = (x: number, y: number) =>
      x > SILK_WIDTH && y > SILK_WIDTH && x < w - SILK_WIDTH && y < h - SILK_WIDTH && !keepOff.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
    const clipped = (pts: number[]) => {
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const [ax, ay, bx, by] = [pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!];
        const len = Math.hypot(bx - ax, by - ay);
        const steps = Math.max(1, Math.ceil(len / 0.05));
        let run: number[] = [];
        for (let s = 0; s <= steps; s++) {
          const x = ax + ((bx - ax) * s) / steps;
          const y = ay + ((by - ay) * s) / steps;
          if (clear(x, y)) run.push(x, y);
          else {
            if (run.length >= 4) silk.line([run[0]!, run[1]!, run.at(-2)!, run.at(-1)!], SILK_WIDTH);
            run = [];
          }
        }
        if (run.length >= 4) silk.line([run[0]!, run[1]!, run.at(-2)!, run.at(-1)!], SILK_WIDTH);
      }
    };
    // the polarity marks first (the kernel placed them clear of copper, holes and the edge), and
    // the refdes texts keep off them
    const texts: { x0: number; y0: number; x1: number; y1: number }[] = [];
    for (const part of parts) {
      for (const s of part.mark?.strokes ?? []) {
        silk.line(s.pts, s.w);
        const xs = s.pts.filter((_, i) => i % 2 === 0);
        const ys = s.pts.filter((_, i) => i % 2 === 1);
        texts.push({ x0: Math.min(...xs) - s.w / 2, y0: Math.min(...ys) - s.w / 2, x1: Math.max(...xs) + s.w / 2, y1: Math.max(...ys) + s.w / 2 });
      }
      for (const d of part.mark?.dots ?? []) {
        silk.circle(d.x, d.y, d.d);
        texts.push({ x0: d.x - d.d / 2, y0: d.y - d.d / 2, x1: d.x + d.d / 2, y1: d.y + d.d / 2 });
      }
    }
    for (const part of parts) {
      const r = part.body;
      if (r.round) {
        const n = 48;
        clipped(Array.from({ length: n + 1 }, (_, i) => [r.x + r.w / 2 + (r.w / 2) * Math.cos((2 * Math.PI * i) / n), r.y + r.h / 2 + (r.w / 2) * Math.sin((2 * Math.PI * i) / n)]).flat());
      } else {
        // the body, with pin 1's corner chamfered
        const o = bodyOutline(r);
        clipped([...o, o[0]!, o[1]!]);
      }
      // refdes above the part, else below, else on the body
      const th = refdesHeight(r);
      const tw = textWidth(part.refdes, th);
      const spots = [
        { x: part.x, y: part.courtyard.y - th / 2 - 0.2 },
        { x: part.x, y: part.courtyard.y + part.courtyard.h + th / 2 + 0.2 },
        { x: part.x, y: part.y },
      ];
      const box = (sx: number, sy: number) => ({ x0: sx - tw / 2 - 0.15, y0: sy - th / 2 - 0.15, x1: sx + tw / 2 + 0.15, y1: sy + th / 2 + 0.15 });
      const fits = (sx: number, sy: number) => {
        const bx = box(sx, sy);
        if (texts.some((t) => bx.x0 < t.x1 && t.x0 < bx.x1 && bx.y0 < t.y1 && t.y0 < bx.y1)) return false;
        return [0, 0.25, 0.5, 0.75, 1].every((fx) => [0, 0.5, 1].every((fy) => clear(sx - tw / 2 + fx * tw, sy - th / 2 + fy * th)));
      };
      const at = spots.find((s) => fits(s.x, s.y));
      if (at) {
        texts.push(box(at.x, at.y));
        // bottom text is mirrored in the file (top view), so it reads right on the board's underside
        for (const stroke of textStrokes(part.refdes, at.x, at.y, th)) silk.line(side === 'bottom' ? stroke.map((v, i) => (i % 2 === 0 ? 2 * at.x - v : v)) : stroke, SILK_WIDTH);
      }
    }
    files.push({ name: `${base}-${side === 'top' ? 'F' : 'B'}_Silkscreen.gbr`, content: silk.toString() });
  }

  /* outline */
  // the board outline (rounded corners too; a panel: its milled contours) and every milled cutout, as closed contours
  const edge = new Gerber(h, ['FileFunction,Profile,NP', 'FilePolarity,Positive']);
  const closed = (pts: number[]) => [...pts, pts[0]!, pts[1]!];
  for (const contour of panel ? panel.edges : [boardPolygon(b)]) edge.line(closed(contour), 0.1);
  for (const c of b.cutouts ?? []) edge.line(closed(cutoutPolygon(c)), 0.1);
  files.push({ name: `${base}-Edge_Cuts.gbr`, content: edge.toString() });

  files.push({ name: `${base}-PTH.drl`, content: drill(b) });
  if (b.parts.some((p) => p.pads.some((q) => q.npth))) files.push({ name: `${base}-NPTH.drl`, content: drill(b, false) });
  return files;
}

/**
 * Excellon, metric, decimal coordinates: plated holes (vias, through-hole pads, plated
 * mounting holes), or with `plated = false` the non-plated ones (mounting holes). A slotted
 * hole is routed with its width's tool from one end's centre to the other (G00 … M15 G01 … M16).
 */
export function drill(b: BoardView, plated = true): string {
  const holes: { d: number; x: number; y: number; to?: [number, number] }[] = [
    ...(plated ? b.vias.map((v) => ({ d: v.drill, x: v.x, y: v.y })) : []),
    ...b.parts.flatMap((p) => p.pads.filter((q) => q.drill && !!q.npth !== plated).map((q) => ({ d: q.drill!, ...slotEnds(q) }))),
  ];
  const sizes = [...new Set(holes.map((x) => x.d.toFixed(3)))].sort();
  const lines = ['M48', '; 4k7 0.1', `; ${plated ? 'PLATED' : 'NON-PLATED'} holes`, '; FORMAT={-:-/ absolute / metric / decimal}', 'FMAT,2', 'METRIC,TZ'];
  sizes.forEach((s, i) => lines.push(`T${i + 1}C${s}`));
  lines.push('%', 'G90', 'G05');
  const at = (x: number, y: number) => `X${x.toFixed(3)}Y${(b.outline.h - y).toFixed(3)}`;
  sizes.forEach((s, i) => {
    lines.push(`T${i + 1}`);
    for (const hole of holes) {
      if (hole.d.toFixed(3) !== s) continue;
      if (hole.to) lines.push(`G00${at(hole.x, hole.y)}`, 'M15', `G01${at(...hole.to)}`, 'M16', 'G05');
      else lines.push(at(hole.x, hole.y));
    }
  });
  lines.push('M30', '');
  return lines.join('\n');
}

/** A hole's start, and for a slot the centre of its other end (along its longer side). */
function slotEnds(p: BoardPad): { x: number; y: number; to?: [number, number] } {
  if (!p.slot) return { x: p.x, y: p.y };
  const half = (Math.max(p.slot.w, p.slot.h) - Math.min(p.slot.w, p.slot.h)) / 2;
  const [dx, dy] = p.slot.w > p.slot.h ? [half, 0] : [0, half];
  return { x: p.x - dx, y: p.y - dy, to: [p.x + dx, p.y + dy] };
}

const csv = (rows: (string | number)[][]) => rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(',')).join('\n') + '\n';

export interface BomLine {
  value: string;
  pkg: string;
  mpn: string;
  mfr: string;
  lcsc: string;
  /** The part Eurocircuits assembles (a generic number or an MPN), when the components name one. */
  eurocircuits: string;
  /** What kind of part it is ("resistor"), and whether it is soldered through holes. */
  category: string;
  tht: boolean;
  /** Designators, in natural order. */
  refs: string[];
}

/** Bill of materials grouped by part, value and package, in the order of each line's first designator. */
export function bomLines(b: BoardView): BomLine[] {
  const groups = new Map<string, BomLine>();
  for (const p of b.parts) {
    if (p.componentId.startsWith('hole:')) continue; // board features, not parts to buy
    const key = `${p.part}|${p.value}|${p.pkg}|${p.mpn ?? ''}|${p.lcsc ?? ''}|${p.eurocircuits ?? ''}`;
    const plated = p.pads.filter((d) => !d.npth);
    const g = groups.get(key) ?? {
      value: p.value,
      pkg: p.pkg,
      mpn: p.mpn ?? '',
      mfr: p.manufacturer ?? '',
      lcsc: p.lcsc ?? '',
      eurocircuits: p.eurocircuits ?? '',
      category: p.category ?? '',
      tht: plated.length > 0 && plated.every((d) => d.drill !== undefined),
      refs: [],
    };
    g.refs.push(p.refdes);
    groups.set(key, g);
  }
  const natural = (a: string, c: string) => a.localeCompare(c, 'en', { numeric: true });
  for (const g of groups.values()) g.refs.sort(natural);
  return [...groups.values()].sort((a, c) => natural(a.refs[0]!, c.refs[0]!));
}

/** A part's kind in a BOM's description. */
const KINDS: Record<string, string> = { resistor: 'Resistor', capacitor: 'Capacitor', inductor: 'Inductor', diode: 'Diode', led: 'LED', ic: 'IC', connector: 'Connector', transistor: 'Transistor', crystal: 'Crystal' };

/** The BOM in the form an assembly house's upload reads ("jlcpcb", the default; "eurocircuits"; "pcbway"). */
export function bom(b: BoardView, house = 'jlcpcb'): string {
  const lines = bomLines(b);
  const what = (g: BomLine) => [KINDS[g.category] ?? '', g.value].filter(Boolean).join(' ');
  if (house === 'eurocircuits') {
    // Eurocircuits reads the MPN column (its generic numbers go there too), the designators and quantity, a description, value and package
    return csv([['Reference Designators', 'Quantity', 'MPN', 'Manufacturer', 'Description', 'Value', 'Package'], ...lines.map((g) => [g.refs.join(','), g.refs.length, g.eurocircuits || g.mpn, g.eurocircuits && g.eurocircuits !== g.mpn ? '' : g.mfr, what(g), g.value, g.pkg])]);
  }
  if (house === 'pcbway') {
    // PCBWay's BOM template; resistors and capacitors may go by value and package without a part number
    return csv([['Item #', 'Designator', 'Qty', 'Manufacturer', 'Mfg Part #', 'Description / Value', 'Package/Footprint', 'Type'], ...lines.map((g, i) => [i + 1, g.refs.join(','), g.refs.length, g.mfr, g.mpn, what(g), g.pkg, g.tht ? 'Thru-hole' : 'SMD'])]);
  }
  // "LCSC Part #" is the column JLCPCB's assembly upload reads
  return csv([['Comment', 'Designator', 'Footprint', 'Quantity', 'MPN', 'Manufacturer', 'LCSC Part #'], ...lines.map((g) => [g.value, g.refs.join(','), g.pkg, g.refs.length, g.mpn, g.mfr, g.lcsc])]);
}

/**
 * Pick-and-place: centre, counter-clockwise rotation, y up from the bottom-left corner. A part with a
 * placement in the house's frame (by refdes: the house's own footprint for it, turned and placed on
 * our pads, see HousePlacement) gets that footprint's rotation and origin instead of the board's, so
 * the house places it without turning it first.
 */
export function pickAndPlace(b: BoardView, placements: Record<string, HousePlacement> = {}): string {
  return csv([
    ['Designator', 'Val', 'Package', 'Mid X', 'Mid Y', 'Rotation', 'Layer'],
    ...b.parts
      .filter((p) => p.pads.some((q) => !q.drill))
      .map((p) => {
        const at = p.side === 'top' ? placements[p.refdes] : undefined;
        const [x, y, rot] = at ? [p.x + at.at[0], p.y + at.at[1], at.rotation] : [p.x, p.y, (360 - p.rot) % 360];
        return [p.refdes, p.value, p.pkg, x.toFixed(3), (b.outline.h - y).toFixed(3), (((rot % 360) + 360) % 360).toFixed(0), p.side === 'top' ? 'Top' : 'Bottom'];
      }),
  ]);
}

/** Gerbers, drill, BOM (in the assembly house's form, see bom) and pick-and-place (in the house's frame where `placements` say it). */
export function fabFiles(b: BoardView, project: string, house?: string, placements?: Record<string, HousePlacement>): FabFile[] {
  const base = project.replace(/[^\w.-]+/g, '_') || 'board';
  return [...gerbers(b, project), { name: `${base}-BOM.csv`, content: bom(b, house) }, { name: `${base}-PnP.csv`, content: pickAndPlace(b, placements) }];
}
