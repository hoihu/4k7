/**
 * Print the schematic: one A4 landscape sheet per page, black on white, through the browser's
 * print dialog (which also saves a PDF). The pages are the ones the layout derived; each is
 * drawn by the same canvas component as on screen, framed on its paper.
 */
import { mount, tick, unmount, type Component } from 'svelte';
import { PAGE, type Rect, type SchematicView } from '@tracewise/schema';
import SchematicCanvas from './components/SchematicCanvas.svelte';

/* The canvas classes, restyled for paper (its own stylesheet is scoped to the app). */
export const SCHEMATIC_STYLE = `
.sch-p text { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; fill: #000; }
.sch-p .paper { fill: #fff; stroke: none; }
.sch-p .frame { fill: none; stroke: #000; stroke-width: 10; }
.sch-p .title { font-size: 220px; font-weight: 700; }
.sch-p .title-s { font-size: 170px; fill: #333; }
.sch-p .wire { stroke: #000; stroke-width: 14; fill: none; stroke-linecap: round; stroke-linejoin: round; }
.sch-p .wire-hit, .sch-p .hit, .sch-p .ov, .sch-p .selbox { display: none; }
.sch-p .junction { fill: #000; }
.sch-p .sym line, .sch-p .sym path, .sch-p .sym polyline { stroke: #000; stroke-width: 12; fill: none; stroke-linecap: round; stroke-linejoin: round; }
.sch-p .sym rect, .sch-p .sym polygon, .sch-p .sym circle { stroke: #000; stroke-width: 12; fill: none; }
.sch-p .sym .filled { fill: #f2f2f2; }
.sch-p .sym polygon.filled { fill: #000; }
.sch-p .ref { font-size: 88px; font-weight: 700; }
.sch-p .val { font-size: 80px; }
.sch-p .pin-n { font-size: 70px; }
.sch-p .pin-no { font-size: 52px; fill: #555; }
.sch-p .pwr line { stroke: #000; stroke-width: 14; stroke-linecap: round; }
.sch-p .pwr .arrow { fill: #000; stroke: #000; stroke-width: 8; stroke-linejoin: round; }
.sch-p .rail-t { font-size: 78px; font-weight: 700; }
.sch-p .net-t { font-size: 72px; font-weight: 600; }
.sch-p .flag { fill: #fff; stroke: #000; stroke-width: 10; }
.sch-p .nc line { stroke: #000; stroke-width: 12; }
`;

const STYLE = `
@page { size: A4 landscape; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
svg { display: block; width: ${PAGE.mm.w}mm; height: ${PAGE.mm.h}mm; page-break-after: always; break-after: page; }
svg:last-child { page-break-after: auto; break-after: auto; }
${SCHEMATIC_STYLE}`;

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Draw `component` off screen (the real canvas, as on screen) and take the content of its SVG. */
export async function drawOffscreen<P extends Record<string, unknown>>(component: Component<P, any, any>, props: P, selector: string): Promise<string> {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:1000px;height:700px;overflow:hidden';
  document.body.appendChild(host);
  try {
    const inst = mount(component, { target: host, props });
    await tick();
    const inner = host.querySelector(selector)?.innerHTML ?? '';
    void unmount(inst);
    return inner;
  } finally {
    host.remove();
  }
}

/** Every sheet's drawing (sheet id → SVG content), in sheet coordinates. */
export async function drawSheets(view: SchematicView, designName: string): Promise<Map<string, string>> {
  const total = view.sheets.reduce((n, s) => n + s.pages.length, 0);
  const out = new Map<string, string>();
  for (const sheet of view.sheets) {
    out.set(sheet.id, await drawOffscreen(SchematicCanvas, { sheet, designName, pageCount: total, showDiff: false, compact: true }, 'svg.sch'));
  }
  return out;
}

/** A part of a sheet's drawing (one page, or any other frame) as an SVG of its own. */
export function sheetSvg(inner: string, r: Rect, cls = '', attrs = ''): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" class="sch-p${cls ? ` ${cls}` : ''}" viewBox="${r.x} ${r.y} ${r.w} ${r.h}" preserveAspectRatio="xMidYMid meet"${attrs ? ` ${attrs}` : ''}>${inner}</svg>`;
}

export async function printSchematic(view: SchematicView, designName: string): Promise<void> {
  // draw every sheet with the real canvas, then cut each page out of it
  const sheets = await drawSheets(view, designName);
  const pages = view.sheets.flatMap((sheet) => sheet.pages.map((p) => sheetSvg(sheets.get(sheet.id)!, p.rect)));
  await printHtml(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(designName)} · schematic</title><style>${STYLE}</style></head><body>${pages.join('')}</body></html>`);
}

/** Print a document of our own through the browser's dialog (which also saves a PDF). */
export async function printHtml(html: string): Promise<void> {
  // a hidden frame of our own document: no popup, no blocker
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();
  const win = frame.contentWindow!;
  if (doc.readyState !== 'complete') await new Promise<void>((r) => win.addEventListener('load', () => r(), { once: true }));
  win.addEventListener('afterprint', () => frame.remove(), { once: true });
  win.focus();
  win.print();
}
