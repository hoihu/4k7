/**
 * The design document: what the design does (the description the agent wrote: an overview, then
 * each functional block with its parts, its schematic and its place on the board), the layout,
 * a dimensioned drawing of the outline and mounting holes, an assembly drawing (only the parts, for populating a board), the BOM and the schematic pages.
 * Printed like the schematic, through the browser's print dialog (which also saves a PDF);
 * schematic and board are drawn by the same canvas components as on screen.
 */
import { bomLines } from '@4k7/fab';
import type { Body3D } from '@4k7/parts';
import { PAPERS, planeNames, type BoardView, type CopperLayer, type DescriptionView, type DesignSummary, type DiagnosticCounts, type Rect, type SchematicView } from '@4k7/schema';
import BoardCanvas from './components/BoardCanvas.svelte';
import { boardDimensions } from './dimensions.ts';
import { markdown } from './markdown.ts';
import { SCHEMATIC_STYLE, drawOffscreen, drawSheets, esc, printHtml, sheetSvg } from './print.ts';

export interface DesignDocInput {
  name: string;
  view: SchematicView;
  summary: DesignSummary;
  counts: DiagnosticCounts;
  description: DescriptionView | null;
  /** The routed board; null when there is none (no parts, or it could not be computed). */
  board: BoardView | null;
  /** Changes waiting for review are in it. */
  pending: boolean;
}

/** The widest (inside a figure's card) and the tallest figure (mm) on the portrait pages. */
const TEXT_W = 170;
const FIG_H = 125;

/* The board canvas classes, restyled for paper: .lay = copper and silkscreen, .asm = only the parts. */
const BOARD_STYLE = `
.brd { display: block; }
.brd .substrate { fill: #fff; }
.brd .edge { fill: none; stroke: #000; stroke-width: 0.15; }
.brd .hit, .brd .mark, .brd .pl, .brd .tie, .brd .rats, .brd .court, .brd .marker { display: none; }
.brd .layer path { fill: none; stroke-linecap: round; stroke-linejoin: round; }
.brd .layer .zone { stroke: none; opacity: 0.16; }
.brd .fcu .zone { fill: #c9463d; }
.brd .bcu .zone { fill: #3f7fd6; }
.brd .in1 .zone { fill: #b98a1d; }
.brd .in2 .zone { fill: #8e5cd6; }
.brd .fcu path { stroke: #c9463d; }
.brd .bcu path { stroke: #3f7fd6; }
.brd .in1 path { stroke: #b98a1d; }
.brd .in2 path { stroke: #8e5cd6; }
.brd .pad { fill: #b8792a; }
.brd .drill { fill: #fff; stroke: #555; stroke-width: 0.05; }
.brd .keepout { fill: none; stroke: #888; stroke-width: 0.05; stroke-dasharray: 0.25 0.2; }
.brd .via circle { fill: #777; }
.brd .via .drill { fill: #fff; stroke: none; }
.brd .silk { fill: none; stroke: #222; stroke-width: 0.1; }
.brd .silkdot { fill: #222; }
.brd .ref { fill: #000; text-anchor: middle; dominant-baseline: central; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.brd .sgfx.fill { fill: #555; stroke: none; }
.brd .sgfx.outline { fill: none; stroke: #555; stroke-linejoin: round; }
.brd .sgfx.bottom { opacity: 0.3; }
.brd .part.bottom .pad:not(.tht) { fill: #4f86d2; }
.brd .part.bottom .silk { stroke: #2f6fc6; stroke-dasharray: 0.4 0.25; }
.brd .part.bottom .silkdot, .brd .part.bottom .ref { fill: #2f6fc6; }
.asm .pad { fill: #d4d4d4; }
.asm .via, .asm .sgfx { display: none; }
.asm .silk { stroke: #000; stroke-width: 0.15; }
.asm .silkdot { fill: #000; }
.asm .ref { font-weight: 700; }
.asm.side .part.bottom .pad:not(.tht) { fill: #d4d4d4; }
.asm.side .part.bottom .silk { stroke: #000; stroke-dasharray: none; }
.asm.side .part.bottom .silkdot, .asm.side .part.bottom .ref { fill: #000; }
.brd .dims .dl { fill: none; stroke: #000; }
.brd .dims .da { fill: #000; stroke: none; }
.brd .dims text { fill: #000; text-anchor: middle; dominant-baseline: central; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.brd .dims text.note { dominant-baseline: auto; }
.flip text { transform-box: fill-box; transform-origin: center; transform: scaleX(-1); }
.loc .ref { display: none; }
.loc .silk { stroke: #777; }
`;

/** The document's look: one accent (the app's), a colour per functional block, quiet tables. */
const ACCENT = '#2563eb';
const INK = '#0f172a';
/** Block colours (fills that carry black text), in the order of the blocks; repeated past eight. */
const BLOCK_COLORS = ['#f6b352', '#6cb4ee', '#86cf8b', '#f08a8f', '#b9a0e3', '#5fcfc2', '#e3cf57', '#f29ccb'];
const SANS = '-apple-system, "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
/** A string for CSS `content`. */
const cssString = (v: string) => `"${v.replace(/[\\"]/g, '\\$&').replace(/\n/g, ' ')}"`;

const style = (title: string, paper: SchematicView['paper']) => `
@page {
  size: A4; margin: 20mm 15mm 18mm;
  @top-left { content: ${cssString(title)}; font: 600 8pt ${SANS}; color: #64748b; vertical-align: bottom; padding-bottom: 3mm; }
  @top-right { content: "Design document"; font: 8pt ${SANS}; color: #94a3b8; vertical-align: bottom; padding-bottom: 3mm; }
  @bottom-right { content: counter(page) " / " counter(pages); font: 8pt ${SANS}; color: #64748b; }
}
@page :first { margin: 0; @top-left { content: none; } @top-right { content: none; } @bottom-right { content: none; } }
@page land { size: ${paper} landscape; margin: 0; @top-left { content: none; } @top-right { content: none; } @bottom-right { content: none; } }
html, body { margin: 0; padding: 0; background: #fff; color: ${INK}; font: 10pt/1.5 ${SANS}; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
h2 { font-size: 19pt; font-weight: 750; letter-spacing: -0.01em; margin: 0 0 6mm; padding-bottom: 2.5mm; border-bottom: 0.5mm solid ${INK}; display: flex; align-items: baseline; gap: 3.5mm; break-after: avoid; }
h2 .no { color: ${ACCENT}; font-size: 13pt; font-weight: 700; font-variant-numeric: tabular-nums; }
h3 { font-size: 12.5pt; font-weight: 700; margin: 8mm 0 2.5mm; display: flex; align-items: center; gap: 2.5mm; break-after: avoid; }
h3 .no { color: #64748b; font-weight: 600; font-variant-numeric: tabular-nums; }
h3 .chip { width: 4mm; height: 4mm; border-radius: 1mm; flex: none; border: 0.2mm solid rgba(0, 0, 0, 0.35); }
h5 { font-size: 10pt; margin: 3mm 0 1mm; break-after: avoid; }
p { margin: 0 0 2.5mm; orphans: 3; widows: 3; }
ul, ol { margin: 0 0 2.5mm; padding-left: 5mm; }
li::marker { color: ${ACCENT}; }
strong { font-weight: 650; }
code, .mono { font-family: ${MONO}; font-size: 0.9em; }
code { background: #f1f5f9; border-radius: 0.8mm; padding: 0 1mm; }
pre { font-size: 8.5pt; background: #f1f5f9; border-radius: 1.5mm; padding: 2.5mm; white-space: pre-wrap; }
pre code { background: none; padding: 0; }
a { color: ${ACCENT}; text-decoration: none; }
section { break-before: page; }
.lead > p:first-child { font-size: 11.5pt; line-height: 1.45; color: #1e293b; }
.muted { color: #64748b; }
.note { border-left: 1mm solid #d97706; background: #fffbeb; border-radius: 0 1.5mm 1.5mm 0; padding: 2.5mm 3.5mm; margin: 0 0 4mm; font-size: 9pt; break-inside: avoid; }

/* cover: the whole first page */
.cover { height: 297mm; box-sizing: border-box; padding: 18mm 18mm 14mm; display: flex; flex-direction: column; break-after: page; background: linear-gradient(180deg, #f8fafc 0%, #fff 55%); }
.brand { display: flex; align-items: center; gap: 2.5mm; font-size: 9pt; font-weight: 650; letter-spacing: 0.14em; text-transform: uppercase; color: #475569; }
.brand .logo { width: 6mm; height: 6mm; display: grid; place-items: center; }
.brand .date { margin-left: auto; font-weight: 500; letter-spacing: 0.04em; text-transform: none; color: #64748b; }
.cover h1 { font-size: 40pt; line-height: 1.05; font-weight: 800; letter-spacing: -0.025em; margin: 16mm 0 3mm; }
.cover .kind { font-size: 13pt; color: ${ACCENT}; font-weight: 650; margin-bottom: 4mm; }
.cover .tag { font-size: 12pt; line-height: 1.45; color: #334155; max-width: 150mm; }
.cover .tag p { margin: 0; }
.hero { flex: 1; min-height: 0; margin: 8mm 0; border-radius: 4mm; background: radial-gradient(ellipse at 50% 38%, #334155 0%, #0f172a 70%); display: grid; place-items: center; overflow: hidden; }
.hero canvas { max-width: 100%; max-height: 100%; object-fit: contain; }
.hero.flat { background: #f1f5f9; border: 0.2mm solid #e2e8f0; }
.facts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; margin: 0 0 7mm; }
.facts div { border-top: 0.6mm solid ${ACCENT}; background: #fff; padding: 2.5mm 0 0; }
.facts b { display: block; font-size: 15pt; font-weight: 750; letter-spacing: -0.01em; line-height: 1.2; }
.facts span { font-size: 8pt; color: #64748b; }
.toc { margin: 0; padding: 0; list-style: none; columns: 2; column-gap: 8mm; font-size: 10pt; }
.toc li { display: flex; gap: 3mm; padding: 1.2mm 0; border-bottom: 0.15mm solid #e2e8f0; break-inside: avoid; }
.toc .no { color: ${ACCENT}; font-weight: 700; width: 4mm; }
.toc .more { margin-left: auto; color: #94a3b8; font-size: 8.5pt; }

/* tables: a tinted head, hairlines, every other row shaded */
table { border-collapse: collapse; width: 100%; font-size: 8.5pt; margin: 0 0 3mm; }
thead { display: table-header-group; }
th { text-align: left; background: #eef2f7; color: #334155; padding: 1.6mm 2mm; font-weight: 650; font-size: 7.5pt; letter-spacing: 0.05em; text-transform: uppercase; }
thead th:first-child { border-radius: 1.2mm 0 0 1.2mm; }
thead th:last-child { border-radius: 0 1.2mm 1.2mm 0; }
td { border-bottom: 0.15mm solid #e2e8f0; padding: 1.5mm 2mm; vertical-align: top; }
tbody tr:nth-child(even) td { background: #f8fafc; }
tr { break-inside: avoid; }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
td.refs { font-family: ${MONO}; font-size: 8pt; }
td.box { width: 5mm; }
td.box i { display: block; width: 3.2mm; height: 3.2mm; border: 0.25mm solid #334155; border-radius: 0.6mm; background: #fff; }
table.kv th { width: 32mm; background: none; text-transform: none; letter-spacing: 0; font-size: 8.5pt; color: #64748b; font-weight: 600; border-bottom: 0.15mm solid #e2e8f0; border-radius: 0; }
table.kv tr:nth-child(even) td { background: none; }

/* figures: a soft card, a numbered caption */
figure { margin: 4mm 0 5mm; break-inside: avoid; }
figure .card { border: 0.2mm solid #e2e8f0; border-radius: 2.5mm; background: #fff; padding: 4mm; display: flex; justify-content: center; }
figure svg { display: block; }
figcaption { font-size: 8pt; color: #64748b; margin-top: 2mm; text-align: center; }
figcaption b { color: ${INK}; font-weight: 650; }
.sch-x .page { display: none; }
.blockhead { break-inside: avoid; }
.blockparts { display: flex; gap: 5mm; align-items: flex-start; break-inside: avoid; margin-top: 3mm; }
.blockparts table { flex: 1; }
.blockparts figure { flex: none; margin: 0; }
.blockparts figure .card { padding: 2mm; }
.glance { display: flex; gap: 6mm; align-items: flex-start; break-inside: avoid; }
.glance figure { flex: none; margin: 0; }
.glance ol { flex: 1; list-style: none; margin: 0; padding: 0; }
.glance li { display: grid; grid-template-columns: 4mm 1fr auto; gap: 0 2.5mm; align-items: baseline; padding: 1.8mm 0; border-bottom: 0.15mm solid #e2e8f0; }
.glance li i { width: 4mm; height: 4mm; border-radius: 1mm; border: 0.2mm solid rgba(0, 0, 0, 0.35); align-self: center; }
.glance li b { font-weight: 650; }
.glance li span { color: #64748b; font-size: 8.5pt; }
.glance li em { grid-column: 2 / 4; font-style: normal; color: #475569; font-size: 8.5pt; }
.pair { display: flex; flex-wrap: wrap; gap: 4mm; justify-content: center; }
.pair figure { margin: 0 0 3mm; }
.card.dark { background: radial-gradient(ellipse at 50% 38%, #334155 0%, #0f172a 70%); border-color: transparent; }
.card.dark canvas { display: block; max-width: 100%; max-height: 44mm; object-fit: contain; }
.card.dark.half canvas { width: 76mm; height: 44mm; }
.key { display: inline-block; width: 2.6mm; height: 2.6mm; border-radius: 0.6mm; vertical-align: -0.3mm; margin: 0 1mm 0 3mm; }
.schpage { page: land; break-before: page; }
.schpage svg { display: block; width: 100%; aspect-ratio: ${PAPERS[paper].mm.w} / ${PAPERS[paper].mm.h - 1}; }
${SCHEMATIC_STYLE}${BOARD_STYLE}`;


const LAYER: Record<CopperLayer, { name: string; color: string }> = {
  'F.Cu': { name: 'Top copper', color: '#c9463d' },
  'In1.Cu': { name: 'Inner 1', color: '#b98a1d' },
  'In2.Cu': { name: 'Inner 2', color: '#8e5cd6' },
  'B.Cu': { name: 'Bottom copper', color: '#3f7fd6' },
};

const natural = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isHole = (p: { componentId: string }) => p.componentId.startsWith('hole:');
const attr = (v: string) => v.replace(/["\\]/g, '\\$&');

/** The largest of the usual drawing scales at which w × h (mm) fits maxW × maxH; a smaller board than that fills the space. */
function drawingScale(w: number, h: number, maxW: number, maxH: number): number {
  const fit = Math.min(maxW / w, maxH / h);
  return [10, 8, 6, 5, 4, 3, 2.5, 2, 1.5, 1].find((s) => s <= fit) ?? fit;
}
const scaleText = (s: number) => (s >= 1 ? `${+s.toFixed(1)}:1` : `1:${+(1 / s).toFixed(1)}`);

/** A board drawing (BoardCanvas content) on paper, with `air` (mm) around the outline. */
function boardSvg(inner: string, b: BoardView, cls: string, maxW: number, maxH: number, id?: string, flip = false, air = 1): { svg: string; scale: number } {
  const [w, h] = [b.outline.w + 2 * air, b.outline.h + 2 * air];
  const scale = drawingScale(w, h, maxW, maxH);
  // seen from below: the board turned over left to right, its texts turned back so they read
  const content = flip ? `<g class="flip" transform="translate(${b.outline.w} 0) scale(-1 1)">${inner}</g>` : inner;
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" class="brd ${cls}"${id ? ` id="${id}"` : ''} viewBox="${-air} ${-air} ${w} ${h}" style="width:${(w * scale).toFixed(1)}mm;height:${(h * scale).toFixed(1)}mm">${content}</svg>`,
    scale,
  };
}

/** The frame around a block's symbols on one sheet (with room for their texts and supply symbols). */
function frameOf(view: SchematicView, refs: Set<string>): { sheetId: string; sheetName: string; rect: Rect }[] {
  const out: { sheetId: string; sheetName: string; rect: Rect }[] = [];
  for (const sheet of view.sheets) {
    // (a text runs about 50 mil per character from its anchor)
    const textBox = (p: { x: number; y: number; anchor: 'start' | 'middle' | 'end' }, text: string): Rect => {
      const w = text.length * 50;
      return { x: p.anchor === 'start' ? p.x : p.anchor === 'end' ? p.x - w : p.x - w / 2, y: p.y - 90, w, h: 90 };
    };
    const boxes = sheet.symbols
      .filter((s) => refs.has(s.refdes))
      .flatMap((s) => [s.bbox, textBox(s.refPos, s.refdes), ...(s.valueLines ?? [s.value]).map((line, i) => textBox({ ...s.valuePos, y: s.valuePos.y + i * 85 }, line))]);
    if (!boxes.length) continue;
    const m = 350;
    const x0 = Math.min(...boxes.map((r) => r.x)) - m;
    const y0 = Math.min(...boxes.map((r) => r.y)) - m;
    const x1 = Math.max(...boxes.map((r) => r.x + r.w)) + m;
    const y1 = Math.max(...boxes.map((r) => r.y + r.h)) + m;
    out.push({ sheetId: sheet.id, sheetName: sheet.name, rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
  }
  return out;
}

/** The views of the 3D board that the document shows: the cover's, then the layout section's. */
const VIEWS_3D = ['iso', 'isoBelow', 'front'] as const;
type View3D = (typeof VIEWS_3D)[number];

/** The assembled board in 3D (the Layout view's renderer), one picture per view on a transparent background; null where WebGL is not to be had. */
async function boardPictures(b: BoardView): Promise<Record<View3D, HTMLCanvasElement> | null> {
  try {
    const [{ createBoardViewer }, { body3dFor }] = await Promise.all([import('./three-body.ts'), import('@4k7/parts')]);
    const viewer = createBoardViewer(document.createElement('canvas'));
    try {
      const bodies = new Map<string, Body3D>();
      for (const p of b.parts) {
        const r = body3dFor(p.pkgInfo, p.pads.map((x) => x.number));
        if (r.ok) bodies.set(p.componentId, r.body);
      }
      viewer.resize(1500, 1000);
      viewer.setBoard(b, bodies);
      // pictures on parts (modules) load after the first frame
      if (b.parts.some((p) => p.topImage)) await new Promise((r) => setTimeout(r, 300));
      const out: Partial<Record<View3D, HTMLCanvasElement>> = {};
      for (const v of VIEWS_3D) {
        viewer.view(v);
        // a capture with nothing drawn in it (the GPU gave us an empty frame): once more, a frame later
        let shot = await trimmed(viewer.picture());
        if (!shot) {
          await new Promise((r) => requestAnimationFrame(r));
          viewer.view(v);
          shot = await trimmed(viewer.picture());
        }
        if (!shot) return null; // better the layout drawing on the cover than an empty box
        out[v] = shot;
      }
      return out as Record<View3D, HTMLCanvasElement>;
    } finally {
      viewer.dispose();
    }
  } catch {
    return null;
  }
}

/** A picture cut down to what is drawn in it (its transparent border goes), with a little air; null if nothing is drawn in it. */
async function trimmed(src: string): Promise<HTMLCanvasElement | null> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let [x0, y0, x1, y1] = [width, height, -1, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! < 8) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < x0) return null;
  // the drop shadow is drawn into the picture (no CSS filter for the print to leave out)
  const size = Math.max(x1 - x0, y1 - y0);
  const blur = Math.round(size * 0.05);
  const drop = Math.round(size * 0.04);
  const pad = Math.round(size * 0.04) + blur * 2;
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1 + 2 * pad;
  out.height = y1 - y0 + 1 + 2 * pad + drop;
  const octx = out.getContext('2d')!;
  octx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  octx.shadowBlur = blur;
  octx.shadowOffsetY = drop;
  octx.drawImage(canvas, x0, y0, x1 - x0 + 1, y1 - y0 + 1, pad, pad, x1 - x0 + 1, y1 - y0 + 1);
  return out;
}

/** The first sentence of a Markdown text, plain. */
function firstSentence(text: string): string {
  const plain = text.split(/\n\s*\n/)[0]!.replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim();
  const end = plain.search(/[.!?](\s|$)/);
  const one = end > 0 ? plain.slice(0, end + 1) : plain;
  return one.length > 140 ? `${one.slice(0, 137).trimEnd()}…` : one;
}

export async function printDesignDocument(input: DesignDocInput): Promise<void> {
  const { name, view, summary, description, board } = input;
  const title = name && name !== 'untitled' ? name : 'Untitled design';
  const b = board && board.parts.some((p) => !isHole(p)) ? board : null;
  const partsOnBoard = new Map((b?.parts ?? []).map((p) => [p.refdes, p]));
  const landscape = typeof CSS !== 'undefined' && CSS.supports('page', 'land');

  /* drawings: the sheets once, the board as layout (all copper), per copper layer, and as assembly drawing */
  const sheets = await drawSheets(view, title);
  const on = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, true]));
  const layoutInner = b ? await drawOffscreen(BoardCanvas, { board: b, show: on(['board', 'silk', ...b.layers]) }, 'svg.board') : '';
  // the dimensioned drawing: the outline and the mounting holes, nothing else
  const mechBoard = b ? { ...b, parts: b.parts.filter(isHole), tracks: [], vias: [], zones: [], graphics: [], ratsnest: [] } : null;
  const mechInner = mechBoard ? await drawOffscreen(BoardCanvas, { board: mechBoard, show: on(['board', 'dims', ...mechBoard.layers]) }, 'svg.board') : '';
  const assemblyInner = b ? await drawOffscreen(BoardCanvas, { board: b, show: on(['board', 'silk']) }, 'svg.board') : '';
  // the assembly drawings: one per side that carries parts (holes on both)
  const sides: { side: 'top' | 'bottom'; board: BoardView; inner: string }[] = [];
  for (const side of ['top', 'bottom'] as const) {
    if (!b?.parts.some((p) => !isHole(p) && p.side === side)) continue;
    const only = { ...b, parts: b.parts.filter((p) => isHole(p) || p.side === side) };
    sides.push({ side, board: only, inner: await drawOffscreen(BoardCanvas, { board: only, show: on(['board', 'silk']) }, 'svg.board') });
  }
  const twoSided = sides.length > 1;
  const pictures = b ? await boardPictures(b) : null;
  const layerInner: [CopperLayer, string][] = [];
  if (b && b.routing === 'done') {
    for (const l of b.layers) {
      // only the pads that are on this layer; the silkscreen with the top
      const only = { ...b, parts: b.parts.map((p) => ({ ...p, pads: p.pads.filter((q) => q.npth || q.layers.includes(l)) })) };
      layerInner.push([l, await drawOffscreen(BoardCanvas, { board: only, show: on(['board', l, ...(l === 'F.Cu' ? ['silk'] : [])]) }, 'svg.board')]);
    }
  }

  const body: string[] = [];
  const toc: string[] = [];
  let sectionNo = 0;
  const tocLine = (heading: string, more = '') => `<li><span class="no">${sectionNo}</span>${esc(heading)}${more ? `<span class="more">${esc(more)}</span>` : ''}</li>`;
  /** `more`: what the contents list says about it ("3 blocks"). The cover ends its page, so the first section needs no break. */
  const section = (heading: string, html: string, more = '') => {
    sectionNo++;
    toc.push(tocLine(heading, more));
    body.push(`<section${sectionNo === 1 ? ' style="break-before:auto"' : ''}><h2><span class="no">${String(sectionNo).padStart(2, '0')}</span>${esc(heading)}</h2>${html}</section>`);
  };
  let figureNo = 0;
  /** A drawing on its card with a numbered caption (`caption` is HTML). */
  const figure = (drawing: string, caption: string, extra = '', card = 'card') => `<figure>${extra}<div class="${card}">${drawing}</div><figcaption><b>Figure ${++figureNo}</b>&ensp;${caption}</figcaption></figure>`;
  const colorOf = (i: number) => BLOCK_COLORS[i % BLOCK_COLORS.length]!;

  /* 1 overview */
  const parts = summary.components.length;
  const lines = b ? bomLines(b) : [];
  const drc = b ? { e: b.diagnostics.filter((d) => d.severity === 'error' && !d.waivedBy).length, w: b.diagnostics.filter((d) => d.severity === 'warning' && !d.waivedBy).length } : null;
  const rails = summary.nets.filter((n) => n.voltage !== undefined);
  const facts = [
    [String(parts), 'parts' + (lines.length ? ` · ${plural(lines.length, 'BOM line')}` : '')],
    [b ? `${b.outline.w} × ${b.outline.h} mm` : '—', b ? `board · ${b.layers.length} layers` : 'no board yet'],
    [b ? (b.routing === 'done' ? `${b.stats.routed}/${b.stats.nets}` : '—') : '—', b?.routing === 'done' ? 'nets routed' : b?.routing === 'stale' ? 'routing out of date' : 'not routed'],
    [`${input.counts.errors + (drc?.e ?? 0)} / ${input.counts.warnings + (drc?.w ?? 0)}`, 'open errors / warnings'],
  ];
  const blocks = (description?.blocks ?? []).filter((x) => x.refs.length);
  const overview: string[] = [];
  if (description?.overview) overview.push(`<div class="lead">${markdown(description.overview)}</div>`);
  else overview.push(`<div class="note">This design has no written description yet. Ask the agent to describe the design; the overview and the functional blocks then appear here.</div>`);
  if (blocks.length) {
    // the blocks at a glance: each in its colour on the board, which the block sections keep
    const colours = blocks.map((blk, i) => `${blk.refs.map((r) => `#glance .part[data-ref="${attr(r)}"] .silk`).join(', ')} { fill: ${colorOf(i)}; stroke: #000; }`).join('\n');
    const list = blocks.map((blk, i) => `<li><i style="background:${colorOf(i)}"></i><b>${esc(blk.title)}</b><span>${plural(blk.refs.length, 'part')}</span><em>${esc(firstSentence(blk.text))}</em></li>`);
    const map = b ? figure(boardSvg(assemblyInner, b, 'asm loc', 75, 80, 'glance').svg, 'The blocks on the board', `<style>${colours}</style>`) : '';
    overview.push(`<h3>Functional blocks at a glance</h3><div class="glance">${map}<ol>${list.join('')}</ol></div>`);
  }
  if (rails.length) {
    overview.push(
      `<h3>Supply rails</h3><table><thead><tr><th>Net</th><th class="n">Voltage</th><th>Source</th><th class="n">Pins</th></tr></thead><tbody>` +
        rails.map((n) => `<tr><td class="mono">${esc(n.name)}</td><td class="n">${n.voltage} V</td><td>${n.external ? 'from outside (connector)' : 'made on the board'}</td><td class="n">${n.pins}</td></tr>`).join('') +
        `</tbody></table>`,
    );
  }
  section('Overview', overview.join(''));

  /* 2 functional blocks: text, parts, the block in the schematic and on the board */
  if (blocks.length) {
    const sheetOf = new Map(summary.components.map((c) => [c.refdes, c]));
    const html = blocks.map((blk, i) => {
      const refs = new Set(blk.refs);
      const rows = blk.refs.map((r) => {
        const p = partsOnBoard.get(r);
        const c = sheetOf.get(r);
        return `<tr><td class="mono">${esc(r)}</td><td>${esc(p?.value ?? c?.value ?? '')}</td><td>${esc(p?.pkg ?? '')}</td><td>${esc(p?.mpn ?? (c && !c.part.startsWith('generic:') ? c.part : ''))}</td></tr>`;
      });
      let locator = '';
      if (b) {
        const id = `loc${i}`;
        const here = blk.refs.map((r) => `#${id} .part[data-ref="${attr(r)}"] .silk`).join(', ');
        locator = figure(boardSvg(assemblyInner, b, 'asm loc', 50, 50, id).svg, `On the board${sides.some((x) => x.side === 'bottom') ? ' (bottom side dashed)' : ''}`, `<style>${here} { fill: ${colorOf(i)}; stroke: #000; }</style>`);
      }
      const excerpts = frameOf(view, refs).map((f, j) => {
        const id = `ex${i}_${j}`;
        const mm = (mil: number) => mil * 0.0254;
        const k = Math.min(1, TEXT_W / mm(f.rect.w), 125 / mm(f.rect.h));
        const others = `#${id} .sym${blk.refs.map((r) => `:not([data-ref="${attr(r)}"])`).join('')} { opacity: 0.3; }`;
        return figure(
          sheetSvg(sheets.get(f.sheetId)!, f.rect, 'sch-x', `id="${id}" style="width:${(mm(f.rect.w) * k).toFixed(1)}mm;height:${(mm(f.rect.h) * k).toFixed(1)}mm"`),
          `${esc(blk.title)} in the schematic${view.sheets.length > 1 ? ` (sheet ${esc(f.sheetName)})` : ''}; parts of other blocks are greyed`,
          `<style>${others}</style>`,
        );
      });
      return (
        `<div class="blockhead"><h3><i class="chip" style="background:${colorOf(i)}"></i><span class="no">${sectionNo + 1}.${i + 1}</span>${esc(blk.title)}</h3>${markdown(blk.text)}` +
        `<div class="blockparts"><table><thead><tr><th>Ref</th><th>Value</th><th>Package</th><th>Part</th></tr></thead><tbody>${rows.join('')}</tbody></table>${locator}</div></div>` +
        excerpts.join('')
      );
    });
    const left = description!.undescribed;
    if (left.length) html.push(`<div class="note">In no block (added after the description was written): <span class="mono">${esc(left.join(', '))}</span>. Ask the agent to update the description.</div>`);
    section('Functional blocks', html.join(''), plural(blocks.length, 'block'));
  }

  /* 3 layout */
  if (b) {
    const html: string[] = [];
    const main = boardSvg(layoutInner, b, 'lay', TEXT_W, 150);
    const legend = b.layers.map((l) => {
      const planes = planeNames(b, l);
      return `<i class="key" style="background:${LAYER[l].color}"></i>${LAYER[l].name}${planes ? ` (${esc(planes)} ${l === 'F.Cu' || l === 'B.Cu' ? 'pour' : 'plane'})` : ''}`;
    });
    if (b.routing !== 'done') html.push(`<div class="note">The board is ${b.routing === 'stale' ? 'routed for an earlier placement (out of date)' : 'placed but not routed yet'}: the drawing shows the placement.</div>`);
    html.push(figure(main.svg, `Top view, all layers, scale ${scaleText(main.scale)}.${legend.join('')}${twoSided || sides[0]?.side === 'bottom' ? '. Parts on the bottom side are dashed.' : ''}`));
    const nHoles = mechBoard!.parts.length;
    const mech = boardSvg(mechInner, b, 'mech', TEXT_W, FIG_H, undefined, false, boardDimensions(b).extent + 1);
    html.push(`<h3>Dimensions</h3>` + figure(mech.svg, `The outline${nHoles ? ` and the ${plural(nHoles, 'mounting hole')} (positions to their centres)` : ''}, in mm, scale ${scaleText(mech.scale)}.`));
    if (pictures) {
      const shot = (v: View3D, caption: string, cls = '') => figure(`<canvas data-pic="${v}"></canvas>`, caption, '', `card dark ${cls}`.trim());
      html.push(
        `<h3>The board in 3D</h3><div class="pair">` +
          shot('iso', 'From above, front left', 'half') +
          shot('isoBelow', `From below, front left${twoSided ? ' (the bottom side)' : ''}`, 'half') +
          `</div>` +
          shot('front', 'From the front, the heights of the parts'),
      );
    }
    html.push(
      `<table class="kv"><tbody>` +
        [
          ['Outline', `${b.outline.w} × ${b.outline.h} mm${b.shape ? ', free-form' : b.cornerRadius ? `, corners R${b.cornerRadius}` : ''}${b.cutouts.length ? `, ${plural(b.cutouts.length, 'cutout')}` : ''}`],
          ['Layers', `${b.layers.length} (${b.layers.join(', ')})`],
          ['Rules', `clearance ${b.rules.clearance} mm · track ${b.rules.track} mm, power ${b.rules.powerTrack} mm · via ${b.rules.viaPad}/${b.rules.viaDrill} mm · edge ${b.rules.edgeClearance} mm`],
          ...(b.fab ? [['Manufacturer', `${b.fab.house}, ${b.fab.tier}: track ${b.fab.limits.track} mm, gap ${b.fab.limits.clearance} mm at the narrowest (${b.fab.source.url}${b.fab.source.checked ? `, checked ${b.fab.source.checked}` : ''})`]] : []),
          ['Routing', b.routing === 'done' ? `${b.stats.routed} of ${b.stats.nets} nets, ${Math.round(b.stats.trackLength)} mm of track, ${plural(b.stats.vias, 'via')}${b.ratsnest.length ? `, ${b.ratsnest.length} connections open` : ''}` : 'not routed'],
          ['Checks (DRC)', `${plural(drc!.e, 'error')}, ${plural(drc!.w, 'warning')}`],
          ...(b.missing.length ? [['No footprint', b.missing.join(', ')]] : []),
        ].map(([k, v]) => `<tr><th>${esc(k!)}</th><td>${esc(v!)}</td></tr>`).join('') +
        `</tbody></table>`,
    );
    if (layerInner.length) {
      const each = layerInner.map(([l, inner]) => figure(boardSvg(inner, b, 'lay', 76, 95).svg, `${LAYER[l].name} (${l})`));
      html.push(`<h3>Copper layers</h3><div class="pair">${each.join('')}</div>`);
    }
    section('Layout', html.join(''), `${b.outline.w} × ${b.outline.h} mm, ${b.layers.length} layers`);

    /* 4 assembly: only the parts, per side, as large as the page allows, and what goes where */
    // (the list repeats the BOM's grouping with a box to tick, so the page can go to the bench on its own)
    const assembly = sides.map(({ side, board: only, inner }, i) => {
      const asm = boardSvg(inner, b, 'asm side', TEXT_W, FIG_H, undefined, side === 'bottom');
      const place = bomLines(only).map((g) => `<tr><td class="box"><i></i></td><td class="n">${g.refs.length}</td><td>${esc(g.value)}</td><td>${esc(g.pkg)}</td><td class="refs">${esc(g.refs.join(' '))}</td></tr>`);
      const view = side === 'top' ? 'Top view' : 'Bottom view (the board turned over left to right)';
      return (
        `<div${i ? ' style="break-before:page"' : ''}>${figure(asm.svg, `${view}, parts only, scale ${scaleText(asm.scale)}. A dot marks pin 1 of parts whose orientation matters.`)}` +
        `<h3>Population list${twoSided ? `, ${side} side` : ''}</h3><table><thead><tr><th></th><th class="n">Qty</th><th>Value</th><th>Package</th><th>Place at</th></tr></thead><tbody>${place.join('')}</tbody></table></div>`
      );
    });
    section('Assembly', assembly.join(''), twoSided ? 'both sides' : '');

    /* 5 BOM */
    const rows = lines.map(
      (g, i) => `<tr><td class="n">${i + 1}</td><td class="n">${g.refs.length}</td><td class="refs">${esc(g.refs.join(' '))}</td><td>${esc(g.value)}</td><td>${esc(g.pkg)}</td><td>${esc(g.mpn)}</td><td>${esc(g.mfr)}</td><td class="mono">${esc(g.lcsc)}</td></tr>`,
    );
    const total = lines.reduce((n, g) => n + g.refs.length, 0);
    section(
      'Bill of materials',
      `<table><thead><tr><th class="n">#</th><th class="n">Qty</th><th>Designators</th><th>Value</th><th>Package</th><th>Part number</th><th>Manufacturer</th><th>LCSC</th></tr></thead><tbody>${rows.join('')}</tbody></table>` +
        `<p class="muted">${plural(total, 'part')} in ${plural(lines.length, 'line')}.${b.missing.length ? ` Not listed (no footprint): ${esc(b.missing.join(', '))}.` : ''}</p>`,
      plural(lines.length, 'line'),
    );
  } else if (parts) {
    // no board: the BOM from the schematic
    const groups = new Map<string, { value: string; part: string; refs: string[] }>();
    for (const c of summary.components) {
      const g = groups.get(`${c.part}|${c.value}`) ?? { value: c.value, part: c.part, refs: [] };
      g.refs.push(c.refdes);
      groups.set(`${c.part}|${c.value}`, g);
    }
    const rows = [...groups.values()].sort((x, y) => natural(x.refs[0]!, y.refs[0]!));
    section(
      'Bill of materials',
      `<div class="note">The board could not be computed, so there is no layout or assembly drawing, and the list comes from the schematic (no packages).</div>` +
        `<table><thead><tr><th class="n">#</th><th class="n">Qty</th><th>Designators</th><th>Value</th><th>Part</th></tr></thead><tbody>` +
        rows.map((g, i) => `<tr><td class="n">${i + 1}</td><td class="n">${g.refs.length}</td><td class="refs">${esc(g.refs.join(' '))}</td><td>${esc(g.value)}</td><td class="mono">${esc(g.part)}</td></tr>`).join('') +
        `</tbody></table>`,
    );
  }

  /* 6 schematic: the pages as printed with ⌘P, landscape where the browser can mix page sizes */
  const pages = view.sheets.flatMap((sheet) => (sheet.symbols.length ? sheet.pages.map((p) => sheetSvg(sheets.get(sheet.id)!, p.rect)) : []));
  if (pages.length) {
    sectionNo++;
    toc.push(tocLine('Schematic', plural(pages.length, 'page')));
    if (landscape) body.push(pages.map((svg) => `<div class="schpage">${svg}</div>`).join(''));
    else body.push(`<section><h2><span class="no">${String(sectionNo).padStart(2, '0')}</span>Schematic</h2>${pages.map((svg) => `<figure>${svg.replace('<svg ', '<svg style="width:100%" ')}</figure>`).join('')}</section>`);
  }

  /* the cover: the board in 3D (else its layout drawing), the facts, the contents */
  const hero = pictures
    ? `<div class="hero"><canvas data-pic="iso"></canvas></div>`
    : b
      ? `<div class="hero flat">${boardSvg(layoutInner, b, 'lay', 150, 105).svg}</div>`
      : `<div class="hero flat"></div>`;
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const logo = `<span class="logo"><svg width="22" height="22" viewBox="0 0 64 64"><rect x="0" y="29" width="64" height="6" rx="3" fill="#b8b0a4"/><rect x="8" y="16" width="48" height="32" rx="12" fill="#e8d9bd"/><rect x="16" y="16" width="6" height="32" fill="#f2c230"/><rect x="25" y="16" width="6" height="32" fill="#7a3fb0"/><rect x="34" y="16" width="6" height="32" fill="#d6382f"/><rect x="45" y="16" width="6" height="32" fill="#d7a63a"/></svg></span>`;
  const cover =
    `<div class="cover"><div class="brand">${logo}4k7<span class="date">${esc(date)}</span></div>` +
    `<h1>${esc(title)}</h1><div class="kind">Design document</div>` +
    (description?.overview ? `<div class="tag">${esc(firstSentence(description.overview))}</div>` : '') +
    (input.pending ? `<div class="note" style="margin-top:5mm">Draft: this document includes changes that are still waiting for review.</div>` : '') +
    hero +
    `<div class="facts">${facts.map(([v, l]) => `<div><b>${esc(v!)}</b><span>${esc(l!)}</span></div>`).join('')}</div>` +
    `<ol class="toc">${toc.join('')}</ol></div>`;
  /* the pictures go in as canvases, drawn from ours: nothing for the print to load or decode */
  const drawPictures = (doc: Document) => {
    for (const c of doc.querySelectorAll<HTMLCanvasElement>('canvas[data-pic]')) {
      const src = pictures?.[c.dataset.pic as View3D];
      if (!src) continue;
      c.width = src.width;
      c.height = src.height;
      c.getContext('2d')!.drawImage(src, 0, 0);
    }
  };
  await printHtml(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} · design document</title><style>${style(title, view.paper)}</style></head><body>${cover}${body.join('')}</body></html>`, drawPictures);
}
