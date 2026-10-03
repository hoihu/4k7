/**
 * The artwork library: silkscreen graphics (logos, clipart) saved in this browser for every
 * project. Saved from a board graphic (the agent's artwork tool) or imported from an SVG file;
 * exported as SVG. The kernel worker gets every artwork so add_graphic can place it by name.
 */
import { pathFigures, traceBitmap } from '@tracewise/kernel';
import type { Artwork, SilkGraphic } from '@tracewise/schema';
import { deleteArtwork, loadArtwork, saveArtwork } from './persist.ts';

interface KernelArtwork {
  registerArtwork(list: Artwork[]): Promise<void>;
  unregisterArtwork(id: string): Promise<void>;
}

/** Imported SVGs are scaled to this width (mm) unless they say their size in mm. */
const IMPORT_WIDTH = 20;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'artwork';

export class ArtworkLibrary {
  items = $state<Artwork[]>([]);
  /** Saved artwork a newer version of the app wrote; not loaded, left in storage. */
  newer = 0;
  #kernel: KernelArtwork;

  constructor(kernel: KernelArtwork) {
    this.#kernel = kernel;
  }

  async init() {
    const { items: list, newer } = await loadArtwork();
    this.newer = newer;
    await this.#kernel.registerArtwork(list.map(forKernel));
    this.items = sorted(list);
  }

  find(nameOrId: string): Artwork | undefined {
    const k = nameOrId.trim().toLowerCase();
    return this.items.find((a) => a.id === nameOrId || a.id.toLowerCase() === k || a.name.toLowerCase() === k);
  }

  async #store(a: Artwork) {
    const plain = JSON.parse(JSON.stringify(a)) as Artwork;
    await saveArtwork(plain);
    await this.#kernel.registerArtwork([forKernel(plain)]);
    this.items = sorted([...this.items.filter((x) => x.id !== plain.id), plain]);
    return plain;
  }

  /** A free id for a name ("snowflake-fern", "snowflake-fern-2" …). */
  #idFor(name: string): string {
    const base = slug(name);
    for (let i = 1; ; i++) {
      const id = i === 1 ? base : `${base}-${i}`;
      if (!this.items.some((a) => a.id === id)) return id;
    }
  }

  /** Save a board graphic (its figures are stored centred and unrotated, at its size). */
  async saveGraphic(g: SilkGraphic, name: string): Promise<Artwork> {
    if (this.find(name)) throw new Error(`An artwork named "${name}" exists already; pick another name or delete it first.`);
    return this.#store({ id: this.#idFor(name), name, mode: g.mode, ...(g.mode === 'outline' ? { line: g.line ?? 0.2 } : {}), polys: g.polys, w: g.w, h: g.h, source: `board ${g.id}` });
  }

  async rename(id: string, name: string): Promise<Artwork> {
    const a = this.items.find((x) => x.id === id);
    if (!a) throw new Error(`No artwork ${id}.`);
    const other = this.find(name);
    if (other && other.id !== id) throw new Error(`An artwork named "${name}" exists already.`);
    return this.#store({ ...$state.snapshot(a), name } as Artwork);
  }

  async remove(id: string) {
    await deleteArtwork(id);
    await this.#kernel.unregisterArtwork(id);
    this.items = this.items.filter((a) => a.id !== id);
  }

  /**
   * A rasterized picture as artwork: its ink traced into outlines (holes and all), dot by dot. The
   * picture and the settings are kept, so it can be adjusted later; `replace` updates that artwork.
   */
  async saveRaster(name: string, grid: { ink: Uint8Array; cols: number; rows: number }, o: RasterOptions, source: string, src: string, replace?: string): Promise<Artwork> {
    const dotMm = o.dotMm;
    const loops = traceBitmap(grid.ink, grid.cols, grid.rows);
    if (!loops.length) throw new Error('The picture has no ink at this threshold.');
    const xs = loops.flatMap((p) => p.filter((_, i) => i % 2 === 0));
    const ys = loops.flatMap((p) => p.filter((_, i) => i % 2 === 1));
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const polys = loops.map((p) => p.map((v, i) => r3((v - (i % 2 === 0 ? (x0 + x1) / 2 : (y0 + y1) / 2)) * dotMm)));
    const clash = this.find(name);
    const unique = clash && clash.id !== replace ? `${name} ${this.items.length + 1}` : name;
    return this.#store({
      id: replace ?? this.#idFor(unique),
      name: unique,
      mode: 'fill',
      polys,
      w: r3((x1 - x0) * dotMm),
      h: r3((y1 - y0) * dotMm),
      source,
      raster: { src, widthMm: o.widthMm, dotMm: o.dotMm, threshold: o.threshold, invert: o.invert, dither: o.dither },
    });
  }

  /**
   * An SVG file as artwork: every shape (path, rect, circle, ellipse, polygon, polyline) with its
   * transforms, filled even-odd; outlines if nothing in it is filled. Sized from its width/height in
   * mm, else scaled to 20 mm wide.
   */
  async importSvg(file: File): Promise<Artwork> {
    const text = await file.text();
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const root = doc.documentElement;
    if (root.nodeName.toLowerCase() !== 'svg') throw new Error('That is not an SVG file.');
    // measure in the live DOM (transforms, inherited styles), off screen
    const host = document.createElement('div');
    // (a real size, so a viewBox maps sanely; transparent rather than hidden, which would be inherited)
    host.style.cssText = 'position:absolute;left:-20000px;top:0;width:1000px;height:1000px;opacity:0;pointer-events:none';
    const svg = document.importNode(root, true) as unknown as SVGSVGElement;
    svg.setAttribute('width', '1000');
    svg.setAttribute('height', '1000');
    host.appendChild(svg);
    document.body.appendChild(host);
    try {
      const figs: number[][] = [];
      let filled = false;
      let stroke = 0;
      const shapes = svg.querySelectorAll<SVGGraphicsElement>('path, rect, circle, ellipse, polygon, polyline, line');
      for (const el of shapes) {
        if (el.closest('defs, clipPath, mask, symbol, title')) continue;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const d = shapePath(el);
        if (!d) continue;
        const parsed = pathFigures(d);
        if (!parsed.ok) continue;
        const m = el.getCTM();
        const rootM = svg.getCTM();
        const toRoot = m && rootM ? rootM.inverse().multiply(m) : m;
        for (const f of parsed.figs) {
          const pts: number[] = [];
          for (let i = 0; i + 1 < f.length; i += 2) {
            const p = toRoot ? new DOMPoint(f[i], f[i + 1]).matrixTransform(toRoot) : { x: f[i]!, y: f[i + 1]! };
            pts.push(p.x, p.y);
          }
          figs.push(pts);
        }
        if (style.fill !== 'none') filled = true;
        else stroke = Math.max(stroke, parseFloat(style.strokeWidth) || 1);
      }
      if (!figs.length) throw new Error('No closed shapes found in the SVG (text must be converted to paths first).');
      const xs = figs.flatMap((p) => p.filter((_, i) => i % 2 === 0));
      const ys = figs.flatMap((p) => p.filter((_, i) => i % 2 === 1));
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const mmW = /^\s*([\d.]+)\s*mm\s*$/.exec(root.getAttribute('width') ?? '');
      const vbW = svg.viewBox.baseVal?.width || x1 - x0;
      const k = mmW ? Number(mmW[1]) / vbW : IMPORT_WIDTH / (x1 - x0);
      const polys = figs.map((p) => p.map((v, i) => r3((v - (i % 2 === 0 ? (x0 + x1) / 2 : (y0 + y1) / 2)) * k)));
      const name = file.name.replace(/\.svg$/i, '');
      const unique = this.find(name) ? `${name} ${this.items.length + 1}` : name;
      return this.#store({
        id: this.#idFor(unique),
        name: unique,
        mode: filled ? 'fill' : 'outline',
        ...(filled ? {} : { line: Math.max(0.15, r3(stroke * k)) }),
        polys,
        w: r3((x1 - x0) * k),
        h: r3((y1 - y0) * k),
        source: file.name,
      });
    } finally {
      host.remove();
    }
  }
}

/** How a picture becomes black and white dots (stored with the artwork, see Artwork.raster). */
export interface RasterOptions {
  /** Width on the board (mm). */
  widthMm: number;
  /** Dot size (mm): silkscreen prints about 0.15 mm at best. */
  dotMm: number;
  /** Brightness below which a dot is ink (0–255); with dithering, it darkens or lightens the picture instead. */
  threshold: number;
  invert: boolean;
  /** Error diffusion (Floyd–Steinberg), for photos and shading. */
  dither: boolean;
}

/** A picture as a grid of ink dots: `cols` × `rows`, 1 = ink. Transparent counts as white. */
export function rasterize(img: ImageBitmap | HTMLImageElement, o: RasterOptions): { ink: Uint8Array; cols: number; rows: number } {
  const iw = 'naturalWidth' in img ? img.naturalWidth : img.width;
  const ih = 'naturalHeight' in img ? img.naturalHeight : img.height;
  const cols = Math.max(4, Math.min(800, Math.round(o.widthMm / o.dotMm)));
  const rows = Math.max(4, Math.min(800, Math.round((cols * ih) / iw)));
  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, cols, rows);
  const px = ctx.getImageData(0, 0, cols, rows).data;
  const lum = new Float32Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) {
    const [r, g, b, a] = [px[i * 4]!, px[i * 4 + 1]!, px[i * 4 + 2]!, px[i * 4 + 3]! / 255];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const v = l * a + 255 * (1 - a); // on white
    const t = o.invert ? 255 - v : v;
    if (!o.dither) lum[i] = t;
    else {
      // dithering decides at the middle; the slider shifts the tones instead, and areas that end up
      // (almost) white or black are snapped, so they never collect stray dots
      const s = Math.min(255, Math.max(0, t + (128 - o.threshold)));
      lum[i] = s > 247 ? 255 : s < 8 ? 0 : s;
    }
  }
  const ink = new Uint8Array(cols * rows);
  const cut = o.dither ? 128 : o.threshold;
  for (let y = 0; y < rows; y++) {
    // serpentine: every other row right to left, so the error does not pile up into regular patterns
    const rtl = o.dither && y % 2 === 1;
    for (let k = 0; k < cols; k++) {
      const x = rtl ? cols - 1 - k : k;
      const i = y * cols + x;
      const on = lum[i]! < cut;
      ink[i] = on ? 1 : 0;
      if (!o.dither) continue;
      const err = lum[i]! - (on ? 0 : 255);
      const fwd = rtl ? -1 : 1;
      const spread = (dx: number, dy: number, f: number) => {
        const nx = x + dx;
        if (nx < 0 || nx >= cols || y + dy >= rows) return;
        const j = (y + dy) * cols + nx;
        lum[j] = lum[j]! + err * f;
      };
      spread(fwd, 0, 7 / 16);
      spread(-fwd, 1, 3 / 16);
      spread(0, 1, 5 / 16);
      spread(fwd, 1, 1 / 16);
    }
  }
  return { ink, cols, rows };
}

/** The kernel only needs the figures, not the stored picture. */
const forKernel = (a: Artwork): Artwork => {
  const { raster: _, ...rest } = a;
  return rest;
};

/** A picture kept for later adjusting: flattened on white, at most 1200 px, as a JPEG data URL. */
export function keepPicture(img: ImageBitmap): string {
  const k = Math.min(1, 1200 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.width * k));
  c.height = Math.max(1, Math.round(img.height * k));
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.92);
}

const sorted = (list: Artwork[]) => [...list].sort((a, b) => a.name.localeCompare(b.name));

/** An SVG shape element as path data. */
function shapePath(el: Element): string | null {
  const n = (a: string) => parseFloat(el.getAttribute(a) ?? '0') || 0;
  switch (el.nodeName.toLowerCase()) {
    case 'path':
      return el.getAttribute('d');
    case 'rect': {
      const [x, y, w, h] = [n('x'), n('y'), n('width'), n('height')];
      if (!(w > 0 && h > 0)) return null;
      const rx = Math.min(n('rx') || n('ry'), w / 2);
      const ry = Math.min(n('ry') || n('rx'), h / 2);
      if (!rx) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
    }
    case 'circle':
    case 'ellipse': {
      const [cx, cy] = [n('cx'), n('cy')];
      const rx = el.nodeName.toLowerCase() === 'circle' ? n('r') : n('rx');
      const ry = el.nodeName.toLowerCase() === 'circle' ? n('r') : n('ry');
      if (!(rx > 0 && ry > 0)) return null;
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 1 ${cx + rx} ${cy}A${rx} ${ry} 0 1 1 ${cx - rx} ${cy}Z`;
    }
    case 'polygon':
    case 'polyline': {
      const pts = (el.getAttribute('points') ?? '').trim().split(/[\s,]+/).map(Number);
      if (pts.length < 6) return null;
      return `M${pts.slice(0, 2).join(' ')}L${pts.slice(2).join(' ')}Z`;
    }
    default:
      return null;
  }
}

/** An artwork as an SVG file (mm), filled even-odd or as outlines. */
export function artworkSvg(a: Artwork): string {
  const d = a.polys.map((p) => `M${p.slice(0, 2).join(' ')}L${p.slice(2).join(' ')}Z`).join('');
  const pad = a.mode === 'outline' ? (a.line ?? 0.2) : 0;
  const [w, h] = [r3(a.w + 2 * pad), r3(a.h + 2 * pad)];
  const style = a.mode === 'fill' ? 'fill="#000" fill-rule="evenodd"' : `fill="none" stroke="#000" stroke-width="${a.line ?? 0.2}" stroke-linejoin="round"`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="${r3(-w / 2)} ${r3(-h / 2)} ${w} ${h}">\n  <title>${a.name.replace(/[<&]/g, '')}</title>\n  <path ${style} d="${d}"/>\n</svg>\n`;
}
