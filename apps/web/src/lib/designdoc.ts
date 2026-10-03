/**
 * The design document: what the design does (the description the agent wrote: an overview, then
 * each functional block with its parts, its schematic and its place on the board), the layout,
 * an assembly drawing (only the parts, for populating a board), the BOM and the schematic pages.
 * Printed like the schematic, through the browser's print dialog (which also saves a PDF);
 * schematic and board are drawn by the same canvas components as on screen.
 */
import { bomLines } from '@tracewise/fab';
import { PAGE, type BoardView, type CopperLayer, type DescriptionView, type DesignSummary, type DiagnosticCounts, type Rect, type SchematicView } from '@tracewise/schema';
import BoardCanvas from './components/BoardCanvas.svelte';
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

/** Printable width and the tallest figure (mm) on the portrait pages. */
const TEXT_W = 180;
const FIG_H = 160;

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
.asm .pad { fill: #d4d4d4; }
.asm .via, .asm .sgfx { display: none; }
.asm .silk { stroke: #000; stroke-width: 0.15; }
.asm .silkdot { fill: #000; }
.asm .ref { font-weight: 700; }
.loc .ref { display: none; }
.loc .silk { stroke: #777; }
`;

const STYLE = `
@page { size: A4; margin: 16mm 15mm; @bottom-center { content: counter(page); font: 8pt -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #666; } }
@page land { size: A4 landscape; margin: 0; @bottom-center { content: none; } }
html, body { margin: 0; padding: 0; background: #fff; color: #111; font: 10pt/1.45 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
h1 { font-size: 24pt; line-height: 1.15; margin: 0 0 1mm; }
h2 { font-size: 15pt; margin: 0 0 4mm; padding-bottom: 1.5mm; border-bottom: 0.3mm solid #111; break-after: avoid; }
h3 { font-size: 12pt; margin: 7mm 0 2mm; break-after: avoid; }
h5 { font-size: 10pt; margin: 3mm 0 1mm; break-after: avoid; }
p { margin: 0 0 2.5mm; orphans: 3; widows: 3; }
ul, ol { margin: 0 0 2.5mm; padding-left: 5mm; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; }
pre { font-size: 8.5pt; background: #f4f4f4; padding: 2mm; white-space: pre-wrap; }
a { color: inherit; }
section { break-before: page; }
.head { border-bottom: 0.6mm solid #111; padding-bottom: 4mm; margin-bottom: 6mm; }
.head .sub { font-size: 12pt; color: #444; }
.note { border: 0.3mm solid #b06a00; background: #fff6e5; padding: 2mm 3mm; margin: 0 0 4mm; font-size: 9pt; break-inside: avoid; }
.muted { color: #666; }
.facts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2mm; margin: 0 0 5mm; }
.facts div { border: 0.2mm solid #bbb; padding: 1.5mm 2.5mm; }
.facts b { display: block; font-size: 11pt; }
.facts span { font-size: 8pt; color: #555; }
.toc { margin: 0 0 6mm; padding: 0; list-style: none; columns: 2; font-size: 9.5pt; }
table { border-collapse: collapse; width: 100%; font-size: 8.5pt; margin: 0 0 3mm; }
th { text-align: left; border-bottom: 0.3mm solid #111; padding: 1mm 1.5mm; font-weight: 600; }
td { border-bottom: 0.1mm solid #bbb; padding: 1mm 1.5mm; vertical-align: top; }
tr { break-inside: avoid; }
thead { display: table-header-group; }
td.n, th.n { text-align: right; }
td.refs { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 8pt; }
td.box { width: 5mm; }
td.box i { display: block; width: 3mm; height: 3mm; border: 0.2mm solid #111; }
figure { margin: 3mm 0 4mm; break-inside: avoid; }
figure svg { display: block; margin: 0 auto; }
figcaption { font-size: 8pt; color: #555; margin-top: 1.5mm; text-align: center; }
.sch-x { border: 0.2mm solid #bbb; }
.sch-x .page { display: none; }
.blockparts { display: flex; gap: 5mm; align-items: flex-start; break-inside: avoid; }
.blockparts table { flex: 1; }
.blockparts figure { flex: none; margin: 0; }
.pair { display: flex; flex-wrap: wrap; gap: 4mm; justify-content: center; }
.pair figure { margin: 0 0 3mm; }
.key { display: inline-block; width: 2.6mm; height: 2.6mm; vertical-align: -0.3mm; margin: 0 1mm 0 3mm; }
.schpage { page: land; break-before: page; }
.schpage svg { display: block; width: 100%; aspect-ratio: ${PAGE.mm.w} / ${PAGE.mm.h - 1}; }
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

/** A board drawing (BoardCanvas content) on paper, with a millimetre of air around the outline. */
function boardSvg(inner: string, b: BoardView, cls: string, maxW: number, maxH: number, id?: string): { svg: string; scale: number } {
  const [w, h] = [b.outline.w + 2, b.outline.h + 2];
  const scale = drawingScale(w, h, maxW, maxH);
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" class="brd ${cls}"${id ? ` id="${id}"` : ''} viewBox="-1 -1 ${w} ${h}" style="width:${(w * scale).toFixed(1)}mm;height:${(h * scale).toFixed(1)}mm">${inner}</svg>`,
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
  const assemblyInner = b ? await drawOffscreen(BoardCanvas, { board: b, show: on(['board', 'silk']) }, 'svg.board') : '';
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
  const section = (heading: string, html: string, first = false) => {
    sectionNo++;
    toc.push(`<li>${sectionNo}&ensp;${esc(heading)}</li>`);
    body.push(`<section${first ? ' style="break-before:auto"' : ''}><h2>${sectionNo}&ensp;${esc(heading)}</h2>${html}</section>`);
  };

  /* 1 overview */
  const parts = summary.components.length;
  const lines = b ? bomLines(b) : [];
  const drc = b ? { e: b.diagnostics.filter((d) => d.severity === 'error').length, w: b.diagnostics.filter((d) => d.severity === 'warning').length } : null;
  const rails = summary.nets.filter((n) => n.voltage !== undefined);
  const facts = [
    [String(parts), 'parts' + (lines.length ? ` · ${plural(lines.length, 'BOM line')}` : '')],
    [b ? `${b.outline.w} × ${b.outline.h} mm` : '—', b ? `board · ${b.layers.length} layers` : 'no board yet'],
    [b ? (b.routing === 'done' ? `${b.stats.routed}/${b.stats.nets}` : '—') : '—', b?.routing === 'done' ? 'nets routed' : b?.routing === 'stale' ? 'routing out of date' : 'not routed'],
    [`${input.counts.errors + (drc?.e ?? 0)} / ${input.counts.warnings + (drc?.w ?? 0)}`, 'open errors / warnings'],
  ];
  const overview: string[] = [`<div class="facts">${facts.map(([v, l]) => `<div><b>${esc(v!)}</b><span>${esc(l!)}</span></div>`).join('')}</div>`];
  if (description?.overview) overview.push(markdown(description.overview));
  else overview.push(`<div class="note">This design has no written description yet. Ask the agent to describe the design; the overview and the functional blocks then appear here.</div>`);
  if (rails.length) {
    overview.push(
      `<h3>Supply rails</h3><table><thead><tr><th>Net</th><th class="n">Voltage</th><th>Source</th><th class="n">Pins</th></tr></thead><tbody>` +
        rails.map((n) => `<tr><td class="mono">${esc(n.name)}</td><td class="n">${n.voltage} V</td><td>${n.external ? 'from outside (connector)' : 'made on the board'}</td><td class="n">${n.pins}</td></tr>`).join('') +
        `</tbody></table>`,
    );
  }
  section('Overview', overview.join(''), true);

  /* 2 functional blocks: text, parts, the block in the schematic and on the board */
  const blocks = (description?.blocks ?? []).filter((x) => x.refs.length);
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
        locator = `<figure><style>${here} { fill: #f0a020; stroke: #000; }</style>${boardSvg(assemblyInner, b, 'asm loc', 55, 55, id).svg}<figcaption>On the board</figcaption></figure>`;
      }
      const excerpts = frameOf(view, refs).map((f, j) => {
        const id = `ex${i}_${j}`;
        const mm = (mil: number) => mil * 0.0254;
        const k = Math.min(1, TEXT_W / mm(f.rect.w), 125 / mm(f.rect.h));
        const others = `#${id} .sym${blk.refs.map((r) => `:not([data-ref="${attr(r)}"])`).join('')} { opacity: 0.3; }`;
        return (
          `<figure><style>${others}</style>` +
          sheetSvg(sheets.get(f.sheetId)!, f.rect, 'sch-x', `id="${id}" style="width:${(mm(f.rect.w) * k).toFixed(1)}mm;height:${(mm(f.rect.h) * k).toFixed(1)}mm"`) +
          `<figcaption>${esc(blk.title)} in the schematic${view.sheets.length > 1 ? ` (sheet ${esc(f.sheetName)})` : ''}; parts of other blocks are greyed</figcaption></figure>`
        );
      });
      return (
        `<h3>${sectionNo + 1}.${i + 1}&ensp;${esc(blk.title)}</h3>${markdown(blk.text)}` +
        `<div class="blockparts"><table><thead><tr><th>Ref</th><th>Value</th><th>Package</th><th>Part</th></tr></thead><tbody>${rows.join('')}</tbody></table>${locator}</div>` +
        excerpts.join('')
      );
    });
    const left = description!.undescribed;
    if (left.length) html.push(`<div class="note">In no block (added after the description was written): <span class="mono">${esc(left.join(', '))}</span>. Ask the agent to update the description.</div>`);
    section('Functional blocks', html.join(''));
  }

  /* 3 layout */
  if (b) {
    const html: string[] = [];
    const main = boardSvg(layoutInner, b, 'lay', TEXT_W, 150);
    const legend = b.layers.map((l) => {
      const plane = b.planes.find((p) => p.layer === l);
      return `<i class="key" style="background:${LAYER[l].color}"></i>${LAYER[l].name}${plane ? ` (${esc(b.netNames[plane.netId] ?? plane.netId)} ${l === 'F.Cu' || l === 'B.Cu' ? 'pour' : 'plane'})` : ''}`;
    });
    if (b.routing !== 'done') html.push(`<div class="note">The board is ${b.routing === 'stale' ? 'routed for an earlier placement (out of date)' : 'placed but not routed yet'}: the drawing shows the placement.</div>`);
    html.push(`<figure>${main.svg}<figcaption>Top view, all layers, scale ${scaleText(main.scale)}.${legend.join('')}</figcaption></figure>`);
    html.push(
      `<table><tbody>` +
        [
          ['Outline', `${b.outline.w} × ${b.outline.h} mm${b.shape ? ', free-form' : b.cornerRadius ? `, corners R${b.cornerRadius}` : ''}${b.cutouts.length ? `, ${plural(b.cutouts.length, 'cutout')}` : ''}`],
          ['Layers', `${b.layers.length} (${b.layers.join(', ')})`],
          ['Rules', `clearance ${b.rules.clearance} mm · track ${b.rules.track} mm, power ${b.rules.powerTrack} mm · via ${b.rules.viaPad}/${b.rules.viaDrill} mm · edge ${b.rules.edgeClearance} mm`],
          ['Routing', b.routing === 'done' ? `${b.stats.routed} of ${b.stats.nets} nets, ${Math.round(b.stats.trackLength)} mm of track, ${plural(b.stats.vias, 'via')}${b.ratsnest.length ? `, ${b.ratsnest.length} connections open` : ''}` : 'not routed'],
          ['Checks (DRC)', `${plural(drc!.e, 'error')}, ${plural(drc!.w, 'warning')}`],
          ...(b.missing.length ? [['No footprint', b.missing.join(', ')]] : []),
        ].map(([k, v]) => `<tr><th style="width:32mm">${esc(k!)}</th><td>${esc(v!)}</td></tr>`).join('') +
        `</tbody></table>`,
    );
    if (layerInner.length) {
      const each = layerInner.map(([l, inner]) => `<figure>${boardSvg(inner, b, 'lay', 86, 100).svg}<figcaption>${LAYER[l].name} (${l})</figcaption></figure>`);
      html.push(`<h3>Copper layers</h3><div class="pair">${each.join('')}</div>`);
    }
    section('Layout', html.join(''));

    /* 4 assembly: only the parts, as large as the page allows, and what goes where */
    const asm = boardSvg(assemblyInner, b, 'asm', TEXT_W, FIG_H);
    // (the list repeats the BOM's grouping with a box to tick, so the page can go to the bench on its own)
    const place = lines.map((g) => `<tr><td class="box"><i></i></td><td class="n">${g.refs.length}</td><td>${esc(g.value)}</td><td>${esc(g.pkg)}</td><td class="refs">${esc(g.refs.join(' '))}</td></tr>`);
    section(
      'Assembly',
      `<figure>${asm.svg}<figcaption>Top view, parts only, scale ${scaleText(asm.scale)}. A dot marks pin 1 of parts whose orientation matters.</figcaption></figure>` +
        `<h3>Population list</h3><table><thead><tr><th></th><th class="n">Qty</th><th>Value</th><th>Package</th><th>Place at</th></tr></thead><tbody>${place.join('')}</tbody></table>`,
    );

    /* 5 BOM */
    const rows = lines.map(
      (g, i) => `<tr><td class="n">${i + 1}</td><td class="n">${g.refs.length}</td><td class="refs">${esc(g.refs.join(' '))}</td><td>${esc(g.value)}</td><td>${esc(g.pkg)}</td><td>${esc(g.mpn)}</td><td>${esc(g.mfr)}</td><td class="mono">${esc(g.lcsc)}</td></tr>`,
    );
    const total = lines.reduce((n, g) => n + g.refs.length, 0);
    section(
      'Bill of materials',
      `<table><thead><tr><th class="n">#</th><th class="n">Qty</th><th>Designators</th><th>Value</th><th>Package</th><th>Part number</th><th>Manufacturer</th><th>LCSC</th></tr></thead><tbody>${rows.join('')}</tbody></table>` +
        `<p class="muted">${plural(total, 'part')} in ${plural(lines.length, 'line')}.${b.missing.length ? ` Not listed (no footprint): ${esc(b.missing.join(', '))}.` : ''}</p>`,
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
    toc.push(`<li>${sectionNo}&ensp;Schematic (${plural(pages.length, 'page')})</li>`);
    if (landscape) body.push(pages.map((svg) => `<div class="schpage">${svg}</div>`).join(''));
    else body.push(`<section><h2>${sectionNo}&ensp;Schematic</h2>${pages.map((svg) => `<figure>${svg.replace('<svg ', '<svg style="width:100%" ')}</figure>`).join('')}</section>`);
  }

  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const head =
    `<div class="head"><h1>${esc(title)}</h1><div class="sub">Design document · ${esc(date)}</div></div>` +
    (input.pending ? `<div class="note">Draft: this document includes changes that are still waiting for review.</div>` : '') +
    `<ol class="toc">${toc.join('')}</ol>`;
  await printHtml(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} · design document</title><style>${STYLE}</style></head><body>${head}${body.join('')}</body></html>`);
}
