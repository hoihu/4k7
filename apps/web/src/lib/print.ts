/**
 * Print the schematic: one A4 landscape sheet per page, black on white, through the browser's
 * print dialog (which also saves a PDF). The pages are the ones the layout derived; each is
 * drawn by the same canvas component as on screen, framed on its paper.
 */
import { mount, tick, unmount } from 'svelte';
import { PAGE, type SchematicView } from '@tracewise/schema';
import SchematicCanvas from './components/SchematicCanvas.svelte';

/* The canvas classes, restyled for paper (its own stylesheet is scoped to the app). */
const STYLE = `
@page { size: A4 landscape; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
svg { display: block; width: ${PAGE.mm.w}mm; height: ${PAGE.mm.h}mm; page-break-after: always; break-after: page; }
svg:last-child { page-break-after: auto; break-after: auto; }
text { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; fill: #000; }
.paper { fill: #fff; stroke: none; }
.frame { fill: none; stroke: #000; stroke-width: 10; }
.title { font-size: 220px; font-weight: 700; }
.title-s { font-size: 170px; fill: #333; }
.wire { stroke: #000; stroke-width: 14; fill: none; stroke-linecap: round; stroke-linejoin: round; }
.wire-hit, .hit, .ov, .selbox { display: none; }
.junction { fill: #000; }
.sym line, .sym path, .sym polyline { stroke: #000; stroke-width: 12; fill: none; stroke-linecap: round; stroke-linejoin: round; }
.sym rect, .sym polygon, .sym circle { stroke: #000; stroke-width: 12; fill: none; }
.sym .filled { fill: #f2f2f2; }
.sym polygon.filled { fill: #000; }
.ref { font-size: 88px; font-weight: 700; }
.val { font-size: 80px; }
.pin-n { font-size: 70px; }
.pin-no { font-size: 52px; fill: #555; }
.pwr line { stroke: #000; stroke-width: 14; stroke-linecap: round; }
.pwr .arrow { fill: #000; stroke: #000; stroke-width: 8; stroke-linejoin: round; }
.rail-t { font-size: 78px; font-weight: 700; }
.net-t { font-size: 72px; font-weight: 600; }
.flag { fill: #fff; stroke: #000; stroke-width: 10; }
.nc line { stroke: #000; stroke-width: 12; }
`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export async function printSchematic(view: SchematicView, designName: string): Promise<void> {
  const total = view.sheets.reduce((n, s) => n + s.pages.length, 0);
  // draw every sheet off screen with the real canvas, then cut each page out of it
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:1000px;height:700px;overflow:hidden';
  document.body.appendChild(host);
  const pages: string[] = [];
  try {
    for (const sheet of view.sheets) {
      const inst = mount(SchematicCanvas, { target: host, props: { sheet, designName, pageCount: total, showDiff: false, compact: true } });
      await tick();
      const svg = host.querySelector('svg.sch');
      const inner = svg?.innerHTML ?? '';
      unmount(inst);
      for (const p of sheet.pages) {
        pages.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${p.rect.x} ${p.rect.y} ${p.rect.w} ${p.rect.h}" preserveAspectRatio="xMidYMid meet">${inner}</svg>`);
      }
    }
  } finally {
    host.remove();
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(designName)} · schematic</title><style>${STYLE}</style></head><body>${pages.join('')}</body></html>`;

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
