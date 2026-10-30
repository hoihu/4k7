/**
 * Text for the enclosure script: glyph outlines from the font that ships with the app (Liberation
 * Sans Bold, SIL Open Font License: fonts/LICENSE-LiberationSans), as closed polygons in mm.
 */
/// <reference path="./opentype.d.ts" />
import { parse } from 'opentype.js/dist/opentype.mjs';

export interface TextOptions {
  /** The capitals' height (mm). */
  size: number;
  halign: 'left' | 'center' | 'right';
  valign: 'top' | 'center' | 'baseline' | 'bottom';
  /** Multiplies the distance from one letter to the next. */
  spacing: number;
}

type Point = [number, number];

/** How finely a curve is cut, in segments per curve (the letters are a few mm tall). */
const CURVE_STEPS = 8;

/** The closed contours of a glyph path, y up. */
function contours(commands: { type: string; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number }[]): Point[][] {
  const out: Point[][] = [];
  let cur: Point[] = [];
  let at: Point = [0, 0];
  for (const c of commands) {
    if (c.type === 'M') {
      if (cur.length > 2) out.push(cur);
      at = [c.x!, -c.y!];
      cur = [at];
    } else if (c.type === 'L') {
      at = [c.x!, -c.y!];
      cur.push(at);
    } else if (c.type === 'Q') {
      for (let i = 1; i <= CURVE_STEPS; i++) {
        const t = i / CURVE_STEPS;
        const u = 1 - t;
        cur.push([u * u * at[0] + 2 * u * t * c.x1! + t * t * c.x!, u * u * at[1] - 2 * u * t * c.y1! - t * t * c.y!]);
      }
      at = [c.x!, -c.y!];
    } else if (c.type === 'C') {
      for (let i = 1; i <= CURVE_STEPS; i++) {
        const t = i / CURVE_STEPS;
        const u = 1 - t;
        cur.push([u * u * u * at[0] + 3 * u * u * t * c.x1! + 3 * u * t * t * c.x2! + t * t * t * c.x!, u * u * u * at[1] - 3 * u * u * t * c.y1! - 3 * u * t * t * c.y2! - t * t * t * c.y!]);
      }
      at = [c.x!, -c.y!];
    }
  }
  if (cur.length > 2) out.push(cur);
  return out;
}

/** Reads the font the first time text is drawn: most boxes have none. */
export function textMaker(fontData: ArrayBuffer | undefined): (text: string, o: TextOptions) => Point[][] {
  let font: ReturnType<typeof parse> | null = null;
  return (text, o) => {
    if (!fontData) throw new Error('text: the font is not loaded');
    font ??= parse(fontData);
    const f = font;
    const capHeight = (f.tables.os2?.sCapHeight ?? f.unitsPerEm * 0.69) / f.unitsPerEm;
    const fontSize = o.size / capHeight;
    const scale = fontSize / f.unitsPerEm;
    const glyphs = f.stringToGlyphs(text);
    const all: Point[][] = [];
    let x = 0;
    glyphs.forEach((g, i) => {
      all.push(...contours(g.getPath(x, 0, fontSize).commands));
      const next = glyphs[i + 1];
      x += ((g.advanceWidth ?? 0) + (next ? f.getKerningValue(g, next) : 0)) * scale * o.spacing;
    });
    if (!all.length) return all;
    const ys = all.flat().map((p) => p[1]);
    const low = Math.min(...ys);
    const high = Math.max(...ys);
    const dx = o.halign === 'center' ? -x / 2 : o.halign === 'right' ? -x : 0;
    const dy = o.valign === 'center' ? -(low + high) / 2 : o.valign === 'top' ? -high : o.valign === 'bottom' ? -low : 0;
    return all.map((c) => c.map(([a, b]) => [a + dx, b + dy] as Point));
  };
}
