/**
 * Drawing production files, for the Gerber viewer and its pictures for the agent. Each layer is
 * drawn in a canvas of its own (dark objects painted, clear ones erasing what the file drew before
 * them, in the file's order), then laid over the layers below in its colour, in the order of the
 * stack seen from the side looked at; the holes go on top.
 */
import { arcAngles, stackRank, type FabFileRead, type FabLayer, type FabObject, type FabShape, type Path } from '@4k7/fab';
import type { Rect } from '@4k7/schema';

/** The canvas behind the layers (a fixed dark ground: the colours are chosen for it, in either theme). */
export const GROUND = '#0b0e13';
const INNER: [string, string][] = [['#c9a13d', 'gold'], ['#8e5cd6', 'purple'], ['#3dbf8e', 'green'], ['#d67a3d', 'orange'], ['#3db5c9', 'cyan'], ['#c93d8e', 'magenta']];

/** A layer's colour (and its name, for the agent) and how opaque it lies over the ones below (copper as in the Layout view). */
export function layerStyle(l: FabLayer): { colour: string; name: string; alpha: number } {
  const top = l.side === 'top';
  switch (l.kind) {
    case 'copper': {
      if (l.id === 'F.Cu') return { colour: '#c9463d', name: 'red', alpha: 0.8 };
      if (l.id === 'B.Cu') return { colour: '#3f7fd6', name: 'blue', alpha: 0.8 };
      // inner layers fainter: they are mostly planes over the whole board, and would hide the outer copper
      const [colour, name] = INNER[((l.order ?? 2) - 2) % INNER.length]!;
      return { colour, name, alpha: 0.45 };
    }
    case 'mask':
      return top ? { colour: '#e070c8', name: 'pink', alpha: 0.5 } : { colour: '#40d0c0', name: 'teal', alpha: 0.5 };
    case 'paste':
      return top ? { colour: '#b4b4bc', name: 'light grey', alpha: 0.65 } : { colour: '#8496a8', name: 'blue-grey', alpha: 0.65 };
    case 'silk':
      return top ? { colour: '#f2f0e6', name: 'white', alpha: 0.95 } : { colour: '#e8c89a', name: 'beige', alpha: 0.95 };
    case 'outline':
      return { colour: '#e0c341', name: 'yellow', alpha: 1 };
    case 'drill':
      return l.plated === false ? { colour: '#9aa3ad', name: 'grey', alpha: 1 } : { colour: '#d8a24a', name: 'amber', alpha: 1 };
    default:
      return { colour: '#7fdcb4', name: 'mint', alpha: 0.8 };
  }
}

/** The colours in words: "F.Cu red, F.Mask pink (its openings), …, PTH holes ringed amber". */
export function colourLegend(files: FabFileRead[]): string {
  return files
    .map((f) => {
      const { name } = layerStyle(f.layer);
      if (f.layer.kind === 'drill') return `${f.layer.id} holes dark, ringed ${name}`;
      return `${f.layer.id} ${name}${f.negative ? ' (its openings)' : ''}`;
    })
    .join(', ');
}

/** The order to draw in: the stack from the far side to the near one, then other layers, the outline and the holes. */
export function drawOrder(files: FabFileRead[], side: 'top' | 'bottom'): FabFileRead[] {
  const stacked = (f: FabFileRead) => ['copper', 'mask', 'paste', 'silk'].includes(f.layer.kind);
  const stack = files.filter(stacked).sort((a, b) => stackRank(a.layer) - stackRank(b.layer));
  const rest = files.filter((f) => !stacked(f)).sort((a, b) => rank(a) - rank(b));
  return [...(side === 'top' ? stack.reverse() : stack), ...rest];
}
const rank = (f: FabFileRead) => (f.layer.kind === 'other' ? 0 : f.layer.kind === 'outline' ? 1 : 2);

/** A run of objects of one polarity, built once per file: what it fills, what it strokes (by pen width), and the objects with parts cut out. */
interface Run {
  dark: boolean;
  fill: Path2D;
  strokes: Map<number, Path2D>;
  cut: FabObject[];
}
const built = new WeakMap<FabFileRead, Run[]>();

function addPath(p2: Path2D, p: Path, close: boolean) {
  p2.moveTo(p.x, p.y);
  let [x, y] = [p.x, p.y];
  for (const s of p.segs) {
    if (s.arc) {
      const { r, a0, a1 } = arcAngles(x, y, s as Parameters<typeof arcAngles>[2]);
      p2.arc(s.arc.cx, s.arc.cy, r, a0, a1, !s.arc.ccw);
    } else p2.lineTo(s.x, s.y);
    [x, y] = [s.x, s.y];
  }
  if (close) p2.closePath();
}

function addShape(fill: Path2D, strokes: Map<number, Path2D>, s: FabShape) {
  if (s.k === 'circle') {
    fill.moveTo(s.x + s.r, s.y);
    fill.arc(s.x, s.y, s.r, 0, 2 * Math.PI);
  } else if (s.k === 'fill') for (const c of s.contours) addPath(fill, c, true);
  else {
    let p = strokes.get(s.w);
    if (!p) strokes.set(s.w, (p = new Path2D()));
    addPath(p, s.path, false);
  }
}

function runs(f: FabFileRead): Run[] {
  let out = built.get(f);
  if (out) return out;
  out = [];
  let run: Run | undefined;
  for (const o of f.objects) {
    if (run?.dark !== o.dark) out.push((run = { dark: o.dark, fill: new Path2D(), strokes: new Map(), cut: [] }));
    if (o.parts.some((p) => p.off)) run.cut.push(o);
    else for (const p of o.parts) addShape(run.fill, run.strokes, p.shape);
  }
  built.set(f, out);
  return out;
}

/** What is looked at: the files' point at the canvas's centre, px per mm, and whether it is seen from below (mirrored). */
export interface FabView {
  cx: number;
  cy: number;
  scale: number;
  below: boolean;
}

const setView = (ctx: CanvasRenderingContext2D, v: FabView, w: number, h: number) => {
  const sx = (v.below ? -1 : 1) * v.scale;
  ctx.setTransform(sx, 0, 0, -v.scale, w / 2 - sx * v.cx, h / 2 + v.scale * v.cy);
};

/** The view that shows `r` (files' mm) whole in a canvas w × h px. */
export function fitView(r: Rect, w: number, h: number, below: boolean): FabView {
  return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, scale: Math.min(w / Math.max(r.w, 1e-3), h / Math.max(r.h, 1e-3)), below };
}

/** The area a view shows in a canvas w × h px (files' mm; x, y the bottom-left corner). */
export function viewRect(v: FabView, w: number, h: number): Rect {
  return { x: v.cx - w / 2 / v.scale, y: v.cy - h / 2 / v.scale, w: w / v.scale, h: h / v.scale };
}

const canvases: { layer?: HTMLCanvasElement; cut?: HTMLCanvasElement } = {};
function scratch(k: 'layer' | 'cut', w: number, h: number): CanvasRenderingContext2D {
  const c = (canvases[k] ??= document.createElement('canvas'));
  if (c.width !== w || c.height !== h) [c.width, c.height] = [w, h];
  return c.getContext('2d')!;
}

/** An object with parts cut out of it (a macro's exposure off): drawn alone in a canvas the size of its box, then laid on the layer. */
function drawCut(lc: CanvasRenderingContext2D, o: FabObject, dark: boolean, colour: string) {
  const m = lc.getTransform();
  const xs = [o.box[0], o.box[2]].map((x) => m.a * x + m.e);
  const ys = [o.box[1], o.box[3]].map((y) => m.d * y + m.f);
  const [x0, x1] = [Math.max(0, Math.floor(Math.min(...xs)) - 1), Math.min(lc.canvas.width, Math.ceil(Math.max(...xs)) + 1)];
  const [y0, y1] = [Math.max(0, Math.floor(Math.min(...ys)) - 1), Math.min(lc.canvas.height, Math.ceil(Math.max(...ys)) + 1)];
  if (x1 <= x0 || y1 <= y0) return;
  const c = scratch('cut', x1 - x0, y1 - y0);
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, x1 - x0, y1 - y0);
  c.setTransform(m.a, m.b, m.c, m.d, m.e - x0, m.f - y0);
  c.fillStyle = c.strokeStyle = colour;
  c.lineCap = c.lineJoin = 'round';
  for (const p of o.parts) {
    c.globalCompositeOperation = p.off ? 'destination-out' : 'source-over';
    const [fill, strokes] = [new Path2D(), new Map<number, Path2D>()];
    addShape(fill, strokes, p.shape);
    c.fill(fill);
    for (const [w, s] of strokes) {
      c.lineWidth = w;
      c.stroke(s);
    }
  }
  lc.save();
  lc.setTransform(1, 0, 0, 1, 0, 0);
  lc.globalCompositeOperation = dark ? 'source-over' : 'destination-out';
  lc.drawImage(c.canvas, 0, 0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
  lc.restore();
}

/** One file's layer drawn alone, in its colour, at full strength. */
function drawLayer(lc: CanvasRenderingContext2D, f: FabFileRead, v: FabView, colour: string) {
  const [w, h] = [lc.canvas.width, lc.canvas.height];
  lc.setTransform(1, 0, 0, 1, 0, 0);
  lc.globalCompositeOperation = 'source-over';
  lc.clearRect(0, 0, w, h);
  setView(lc, v, w, h);
  lc.fillStyle = lc.strokeStyle = colour;
  lc.lineCap = lc.lineJoin = 'round';
  const hair = 1 / v.scale;
  if (f.layer.kind === 'drill') {
    // holes: the ground showing through, ringed in the layer's colour
    for (const run of runs(f)) {
      lc.fillStyle = GROUND;
      lc.fill(run.fill);
      lc.lineWidth = 1.5 * hair;
      lc.stroke(run.fill);
      for (const [d, p] of run.strokes) {
        lc.lineWidth = d;
        lc.stroke(p);
        lc.strokeStyle = GROUND;
        lc.lineWidth = Math.max(d - 3 * hair, d / 2);
        lc.stroke(p);
        lc.strokeStyle = colour;
      }
    }
    return;
  }
  for (const run of runs(f)) {
    lc.globalCompositeOperation = run.dark ? 'source-over' : 'destination-out';
    lc.fill(run.fill);
    for (const [pen, p] of run.strokes) {
      // a pen of no width (an outline drawn with a zero aperture) still shows, one pixel wide
      lc.lineWidth = Math.max(pen, hair);
      lc.stroke(p);
    }
    for (const o of run.cut) drawCut(lc, o, run.dark, colour);
  }
}

/** The files shown, over the ground, as seen from `v` on a canvas of its own size (device pixels). */
export function drawFabFiles(ctx: CanvasRenderingContext2D, files: FabFileRead[], v: FabView) {
  const [w, h] = [ctx.canvas.width, ctx.canvas.height];
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = GROUND;
  ctx.fillRect(0, 0, w, h);
  const seen = viewRect(v, w, h);
  const lc = scratch('layer', w, h);
  for (const f of drawOrder(files, v.below ? 'bottom' : 'top')) {
    if (!f.box || f.box[2] < seen.x || f.box[0] > seen.x + seen.w || f.box[3] < seen.y || f.box[1] > seen.y + seen.h) continue;
    const { colour, alpha } = layerStyle(f.layer);
    drawLayer(lc, f, v, colour);
    ctx.globalAlpha = alpha;
    ctx.drawImage(lc.canvas, 0, 0);
  }
  ctx.globalAlpha = 1;
}

/** A scale bar in the bottom-left corner, `bottom` px up: a round length about a fifth of the width. */
export function drawScaleBar(ctx: CanvasRenderingContext2D, scale: number, px = 1, bottom = 12) {
  const want = ctx.canvas.width / 5 / scale;
  const step = 10 ** Math.floor(Math.log10(want));
  const mm = [5, 2, 1].map((k) => k * step).find((s) => s <= want) ?? step;
  const [x, y, len] = [12 * px, ctx.canvas.height - bottom * px, mm * scale];
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = ctx.fillStyle = '#e6e9ee';
  ctx.lineWidth = 1.5 * px;
  ctx.beginPath();
  ctx.moveTo(x, y - 5 * px);
  ctx.lineTo(x, y);
  ctx.lineTo(x + len, y);
  ctx.lineTo(x + len, y - 5 * px);
  ctx.stroke();
  ctx.font = `${11 * px}px system-ui, sans-serif`;
  ctx.fillText(`${+mm.toPrecision(3)} mm`, x + len + 6 * px, y);
}

/** A picture of the files shown in `frame` (files' mm), `width` px wide, as a base64 PNG. */
export function fabPicture(files: FabFileRead[], frame: Rect, below: boolean, width: number): { data: string; mimeType: string } {
  const height = Math.max(1, Math.round((width * frame.h) / frame.w));
  const canvas = document.createElement('canvas');
  [canvas.width, canvas.height] = [width, Math.min(height, 4 * width)];
  const ctx = canvas.getContext('2d')!;
  const v = fitView(frame, canvas.width, canvas.height, below);
  drawFabFiles(ctx, files, v);
  drawScaleBar(ctx, v.scale, Math.max(1, width / 1000));
  const url = canvas.toDataURL('image/png');
  return { data: url.slice(url.indexOf(',') + 1), mimeType: 'image/png' };
}
