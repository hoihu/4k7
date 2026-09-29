/**
 * Datasheet pages in the browser (pdf.js): render one page and highlight the text a value
 * was read from (a pin row, a package dimension table).
 */
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type Doc = Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;
const docs = new Map<string, Promise<Doc>>();

/** Open (and cache) a PDF by a stable key such as its hash. */
export function openPdf(key: string, data: ArrayBuffer): Promise<Doc> {
  let d = docs.get(key);
  if (!d) {
    // pdf.js takes ownership of the buffer it is given
    d = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) }).promise;
    docs.set(key, d);
  }
  return d;
}

export interface Highlight {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Render `pageNo` into `canvas` at `width` CSS pixels. Returns rectangles (canvas CSS pixels)
 * of table rows containing all `terms` (e.g. ["15", "PC0"]); falls back to lines with the last term.
 */
export async function renderPage(doc: Doc, pageNo: number, canvas: HTMLCanvasElement, width: number, terms: string[]): Promise<Highlight[]> {
  const page = await doc.getPage(Math.min(Math.max(1, pageNo), doc.numPages));
  const base = page.getViewport({ scale: 1 });
  const scale = width / base.width;
  const viewport = page.getViewport({ scale });
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  await page.render({ canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
  if (!terms.length) return [];

  const content = await page.getTextContent();
  type Item = { str: string; transform: number[]; width: number; height: number };
  const items = (content.items as Item[]).filter((i) => i.str?.trim());
  // group items into lines by baseline, like the bridge's text extraction
  const lines = new Map<number, Item[]>();
  for (const it of items) {
    const y = Math.round(it.transform[5]! / 2) * 2;
    lines.set(y, [...(lines.get(y) ?? []), it]);
  }
  const norm = (s: string) => s.trim().toUpperCase();
  const want = terms.map(norm).filter(Boolean);
  const rectOf = (line: Item[]): Highlight => {
    const xs = line.map((i) => i.transform[4]!);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...line.map((i) => i.transform[4]! + i.width));
    const y = line[0]!.transform[5]!;
    const h = Math.max(...line.map((i) => i.height || 8));
    const [ax, ay] = viewport.convertToViewportPoint(x0, y + h);
    const [bx, by] = viewport.convertToViewportPoint(x1, y - 2);
    return { x: Math.min(ax!, bx!) - 3, y: Math.min(ay!, by!) - 2, w: Math.abs(bx! - ax!) + 6, h: Math.abs(by! - ay!) + 4 };
  };
  const has = (line: Item[], t: string) => line.some((i) => norm(i.str) === t || norm(i.str).split(/[\s,/]+/).includes(t));
  let hits = [...lines.values()].filter((line) => want.every((t) => has(line, t)));
  if (!hits.length) hits = [...lines.values()].filter((line) => has(line, want.at(-1)!));
  return hits.slice(0, 4).map(rectOf);
}


/**
 * Cut a rectangle out of a page (`box`: x0, y0, x1, y1 as fractions of the page) as a JPEG data
 * URL, rendered so that its longer side is about `px` pixels.
 */
export async function cropPage(doc: Doc, pageNo: number, box: [number, number, number, number], px = 1024): Promise<string> {
  const page = await doc.getPage(Math.min(Math.max(1, pageNo), doc.numPages));
  const base = page.getViewport({ scale: 1 });
  const [x0, y0, x1, y1] = box;
  const scale = px / Math.max((x1 - x0) * base.width, (y1 - y0) * base.height, 1);
  const viewport = page.getViewport({ scale });
  const full = document.createElement('canvas');
  full.width = Math.ceil(viewport.width);
  full.height = Math.ceil(viewport.height);
  await page.render({ canvas: full, viewport }).promise;
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round((x1 - x0) * full.width));
  out.height = Math.max(1, Math.round((y1 - y0) * full.height));
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(full, x0 * full.width, y0 * full.height, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/jpeg', 0.85);
}
