/**
 * Manufacturing outputs from a board view: Gerber RS-274X with X2 attributes (copper, mask,
 * paste, silkscreen, outline), Excellon drill, BOM and pick-and-place. Board coordinates are
 * y down from the top-left corner; fab files use y up from the bottom-left corner.
 */
import { boardPolygon, cutoutPolygon, figureDepths, type BoardGraphic, type BoardPad, type BoardView, type CopperLayer } from '@tracewise/schema';
import { textStrokes, textWidth } from './font.ts';

export interface FabFile {
  name: string;
  content: string;
}

const MASK_MARGIN = 0.05;
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
    this.aperture(p.shape === 'round' ? `C,${(Math.min(w, h)).toFixed(6)}` : `R,${w.toFixed(6)}X${h.toFixed(6)}`);
    this.body.push(`${this.xy(p.x, p.y)}D03*`);
  }
  /** An exact plane: the outline filled, cutouts cleared (clear polarity), spokes drawn back. */
  plane(sh: import('@tracewise/schema').ZoneShape) {
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
      '%TF.GenerationSoftware,Tracewise,Tracewise,0.1*%',
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

export function gerbers(b: BoardView, project: string): FabFile[] {
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
    files.push({ name: `${base}-${layer.replace('.', '_')}.gbr`, content: g.toString() });
  });

  /* solder mask (openings; vias are tented) and paste (SMD pads only) */
  for (const [side, layer] of [['Top', 'F.Cu'], ['Bot', 'B.Cu']] as const) {
    const mask = new Gerber(h, [`FileFunction,Soldermask,${side}`, 'FilePolarity,Negative']);
    for (const p of pads) {
      if (p.npth) mask.circle(p.x, p.y, p.drill! + 2 * MASK_MARGIN); // bare hole: no mask over it
      else if (onLayer(p, layer)) mask.pad(p, MASK_MARGIN);
    }
    files.push({ name: `${base}-${side === 'Top' ? 'F' : 'B'}_Mask.gbr`, content: mask.toString() });
    const paste = new Gerber(h, [`FileFunction,Paste,${side}`, 'FilePolarity,Positive']);
    for (const p of pads) if (!p.drill && p.layers.includes(layer)) paste.pad(p);
    files.push({ name: `${base}-${side === 'Top' ? 'F' : 'B'}_Paste.gbr`, content: paste.toString() });
  }

  /* silkscreen: graphics (logos), body outlines and refdes, kept off pads */
  const silk = new Gerber(h, ['FileFunction,Legend,Top', 'FilePolarity,Positive']);
  // graphics first; then the pads (with their clearance) are cleared out of them
  const topGraphics = (b.graphics ?? []).filter((g) => g.side === 'top');
  for (const g of topGraphics) silk.graphic(g);
  if (topGraphics.length) {
    silk.polarity(true);
    for (const p of pads) if (p.npth || onLayer(p, 'F.Cu')) silk.pad(p.npth ? { ...p, w: p.drill!, h: p.drill!, shape: 'round' } : p, SILK_TO_PAD);
    for (const v of b.vias) silk.circle(v.x, v.y, v.pad + 2 * SILK_TO_PAD);
    silk.polarity(false);
  }
  const keepOff = [
    ...pads.map((p) => ({ x0: p.x - p.w / 2 - SILK_TO_PAD - SILK_WIDTH / 2, y0: p.y - p.h / 2 - SILK_TO_PAD - SILK_WIDTH / 2, x1: p.x + p.w / 2 + SILK_TO_PAD + SILK_WIDTH / 2, y1: p.y + p.h / 2 + SILK_TO_PAD + SILK_WIDTH / 2 })),
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
  const texts: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const part of b.parts) {
    if (part.componentId.startsWith('hole:')) continue; // mounting holes carry no silkscreen
    const r = part.body;
    if (r.round) {
      const n = 48;
      clipped(Array.from({ length: n + 1 }, (_, i) => [r.x + r.w / 2 + (r.w / 2) * Math.cos((2 * Math.PI * i) / n), r.y + r.h / 2 + (r.w / 2) * Math.sin((2 * Math.PI * i) / n)]).flat());
    } else clipped([r.x, r.y, r.x + r.w, r.y, r.x + r.w, r.y + r.h, r.x, r.y + r.h, r.x, r.y]);
    // pin-1 mark where the orientation matters: a short dash next to pin 1 (a dot would
    // disappear in the clipping)
    if (part.polarized) clipped([part.pin1.x - 0.2, part.pin1.y, part.pin1.x + 0.2, part.pin1.y]);
    // refdes above the part, else below, else on the body
    const th = Math.min(1, Math.max(0.6, Math.min(r.w, r.h) * 0.6));
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
      for (const stroke of textStrokes(part.refdes, at.x, at.y, th)) silk.line(stroke, SILK_WIDTH);
    }
  }
  files.push({ name: `${base}-F_Silkscreen.gbr`, content: silk.toString() });
  // bottom silkscreen: only graphics put there (parts are on top)
  const bottomGraphics = (b.graphics ?? []).filter((g) => g.side === 'bottom');
  if (bottomGraphics.length) {
    const bsilk = new Gerber(h, ['FileFunction,Legend,Bot', 'FilePolarity,Positive']);
    for (const g of bottomGraphics) bsilk.graphic(g);
    bsilk.polarity(true);
    for (const p of pads) if (p.npth || onLayer(p, 'B.Cu')) bsilk.pad(p.npth ? { ...p, w: p.drill!, h: p.drill!, shape: 'round' } : p, SILK_TO_PAD);
    for (const v of b.vias) bsilk.circle(v.x, v.y, v.pad + 2 * SILK_TO_PAD);
    bsilk.polarity(false);
    files.push({ name: `${base}-B_Silkscreen.gbr`, content: bsilk.toString() });
  }

  /* outline */
  // the board outline (rounded corners too) and every milled cutout, as closed contours
  const edge = new Gerber(h, ['FileFunction,Profile,NP', 'FilePolarity,Positive']);
  const closed = (pts: number[]) => [...pts, pts[0]!, pts[1]!];
  edge.line(closed(boardPolygon(b)), 0.1);
  for (const c of b.cutouts ?? []) edge.line(closed(cutoutPolygon(c)), 0.1);
  files.push({ name: `${base}-Edge_Cuts.gbr`, content: edge.toString() });

  files.push({ name: `${base}-PTH.drl`, content: drill(b) });
  if (b.parts.some((p) => p.pads.some((q) => q.npth))) files.push({ name: `${base}-NPTH.drl`, content: drill(b, false) });
  return files;
}

/**
 * Excellon, metric, decimal coordinates: plated holes (vias, through-hole pads, plated
 * mounting holes), or with `plated = false` the non-plated ones (mounting holes).
 */
export function drill(b: BoardView, plated = true): string {
  const holes: { d: number; x: number; y: number }[] = [
    ...(plated ? b.vias.map((v) => ({ d: v.drill, x: v.x, y: v.y })) : []),
    ...b.parts.flatMap((p) => p.pads.filter((q) => q.drill && !!q.npth !== plated).map((q) => ({ d: q.drill!, x: q.x, y: q.y }))),
  ];
  const sizes = [...new Set(holes.map((x) => x.d.toFixed(3)))].sort();
  const lines = ['M48', '; Tracewise 0.1', `; ${plated ? 'PLATED' : 'NON-PLATED'} holes`, '; FORMAT={-:-/ absolute / metric / decimal}', 'FMAT,2', 'METRIC,TZ'];
  sizes.forEach((s, i) => lines.push(`T${i + 1}C${s}`));
  lines.push('%', 'G90', 'G05');
  sizes.forEach((s, i) => {
    lines.push(`T${i + 1}`);
    for (const hole of holes) if (hole.d.toFixed(3) === s) lines.push(`X${hole.x.toFixed(3)}Y${(b.outline.h - hole.y).toFixed(3)}`);
  });
  lines.push('M30', '');
  return lines.join('\n');
}

const csv = (rows: (string | number)[][]) => rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(',')).join('\n') + '\n';

/** Bill of materials grouped by part, value and package. */
export function bom(b: BoardView): string {
  const groups = new Map<string, { value: string; pkg: string; mpn: string; mfr: string; refs: string[] }>();
  for (const p of b.parts) {
    if (p.componentId.startsWith('hole:')) continue; // board features, not parts to buy
    const key = `${p.part}|${p.value}|${p.pkg}|${p.mpn ?? ''}`;
    const g = groups.get(key) ?? { value: p.value, pkg: p.pkg, mpn: p.mpn ?? '', mfr: p.manufacturer ?? '', refs: [] };
    g.refs.push(p.refdes);
    groups.set(key, g);
  }
  const natural = (a: string, c: string) => a.localeCompare(c, 'en', { numeric: true });
  const rows = [...groups.values()].sort((a, c) => natural(a.refs[0]!, c.refs[0]!));
  return csv([['Comment', 'Designator', 'Footprint', 'Quantity', 'MPN', 'Manufacturer'], ...rows.map((g) => [g.value, g.refs.sort(natural).join(','), g.pkg, g.refs.length, g.mpn, g.mfr])]);
}

/** Pick-and-place: centre, counter-clockwise rotation, y up from the bottom-left corner. */
export function pickAndPlace(b: BoardView): string {
  return csv([
    ['Designator', 'Val', 'Package', 'Mid X', 'Mid Y', 'Rotation', 'Layer'],
    ...b.parts
      .filter((p) => p.pads.some((q) => !q.drill))
      .map((p) => [p.refdes, p.value, p.pkg, p.x.toFixed(3), (b.outline.h - p.y).toFixed(3), ((360 - p.rot) % 360).toFixed(0), p.side === 'top' ? 'Top' : 'Bottom']),
  ]);
}

export function fabFiles(b: BoardView, project: string): FabFile[] {
  const base = project.replace(/[^\w.-]+/g, '_') || 'board';
  return [...gerbers(b, project), { name: `${base}-BOM.csv`, content: bom(b) }, { name: `${base}-PnP.csv`, content: pickAndPlace(b) }];
}
