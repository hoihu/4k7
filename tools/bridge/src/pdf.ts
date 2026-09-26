/**
 * PDF → text, one file per page, with table rows kept on one line ("cell | cell | cell").
 * Reading text is far cheaper for the model than page images, and tables stay greppable.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

interface TextItem {
  str: string;
  transform: number[];
  width: number;
}

type PdfJs = {
  getDocument(src: { data: Uint8Array; isEvalSupported?: boolean; verbosity?: number }): {
    promise: Promise<{ numPages: number; getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }> }>;
  };
};

let pdfjs: PdfJs | null = null;
async function loadPdfJs(): Promise<PdfJs> {
  if (!pdfjs) {
    const require = createRequire(import.meta.url);
    pdfjs = (await import(require.resolve('pdfjs-dist/legacy/build/pdf.mjs'))) as PdfJs;
  }
  return pdfjs;
}

/** Text of every page; lines rebuilt from text positions, distant cells separated by " | ". */
export async function pdfPages(data: Uint8Array): Promise<string[]> {
  const lib = await loadPdfJs();
  // pdf.js takes ownership of (detaches) the buffer it is given: hand it a copy
  const doc = await lib.getDocument({ data: data.slice(), isEvalSupported: false, verbosity: 0 }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    const rows = new Map<number, { x: number; w: number; s: string }[]>();
    for (const raw of content.items as TextItem[]) {
      if (!raw.str?.trim()) continue;
      const y = Math.round(raw.transform[5]! / 2) * 2;
      rows.set(y, [...(rows.get(y) ?? []), { x: raw.transform[4]!, w: raw.width, s: raw.str }]);
    }
    const lines = [...rows.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, items]) => {
        items.sort((a, b) => a.x - b.x);
        let line = '';
        let end: number | null = null;
        for (const it of items) {
          line += end === null ? it.s : (it.x - end > 6 ? ' | ' : '') + it.s;
          end = it.x + it.w;
        }
        return line;
      });
    pages.push(lines.join('\n'));
  }
  return pages;
}

/**
 * Write datasheet.pdf, pages/page-NNN.txt and index.txt (page → first heading-like line)
 * into `dir`. Returns the page count.
 */
export async function prepareDatasheet(dir: string, data: Uint8Array): Promise<number> {
  mkdirSync(join(dir, 'pages'), { recursive: true });
  writeFileSync(join(dir, 'datasheet.pdf'), data);
  const pages = await pdfPages(data);
  const index: string[] = [];
  pages.forEach((text, i) => {
    const n = String(i + 1).padStart(3, '0');
    writeFileSync(join(dir, 'pages', `page-${n}.txt`), `[page ${i + 1} of ${pages.length}]\n${text}\n`);
    const heading = text.split('\n').map((l) => l.trim()).find((l) => /^(\d+(\.\d+)*\s+\S|Table \d+|Figure \d+)/.test(l)) ?? text.split('\n')[1] ?? '';
    index.push(`${i + 1}: ${heading.slice(0, 100)}`);
  });
  writeFileSync(join(dir, 'index.txt'), index.join('\n') + '\n');
  return pages.length;
}
