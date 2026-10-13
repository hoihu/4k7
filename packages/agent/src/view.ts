/**
 * The user's view: what they had on screen when they sent a message, so "improve this area" or
 * "the parts here" can be resolved without asking. Unlike an Optimize scope it restricts nothing.
 */
import type { BoardView, Rect, SheetView, ViewInfo } from '@4k7/schema';

const inside = (r: Rect, b: Rect) => b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h;
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** The part of `r` on `page`, in mils from the page's top-left corner. */
function clip(r: Rect, page: Rect): Rect {
  const x0 = Math.max(r.x, page.x);
  const y0 = Math.max(r.y, page.y);
  const x1 = Math.min(r.x + r.w, page.x + page.w);
  const y1 = Math.min(r.y + r.h, page.y + page.h);
  return { x: x0 - page.x, y: y0 - page.y, w: x1 - x0, h: y1 - y0 };
}
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** Split boxes into the ones wholly in `r` and the ones its edge cuts. */
function classify(r: Rect, items: { ref: string; box: Rect }[]): { parts: string[]; partly: string[] } {
  const parts = new Set<string>();
  const partly = new Set<string>();
  for (const x of items) {
    if (inside(r, x.box)) parts.add(x.ref);
    else if (overlaps(r, x.box)) partly.add(x.ref);
  }
  return { parts: [...parts].sort(natural), partly: [...partly].filter((p) => !parts.has(p)).sort(natural) };
}

/** The schematic area `rect` (sheet mils) shown of `sheet`. */
export function schematicViewInfo(sheet: SheetView, rect: Rect): ViewInfo {
  const r = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) };
  return {
    view: 'schematic',
    sheetName: sheet.name,
    rect: r,
    whole: inside(r, sheet.bbox),
    pages: sheet.pages.filter((p) => overlaps(r, p.rect)).map((p) => ({ number: p.number, rect: clip(r, p.rect) })),
    ...classify(
      r,
      sheet.symbols.map((s) => ({ ref: `${s.refdes}${s.unit ?? ''}`, box: s.bbox })),
    ),
  };
}

/** The board area `rect` (mm) shown of `board`. */
export function boardViewInfo(board: BoardView, rect: Rect): ViewInfo {
  const mm = (v: number) => Math.round(v * 10) / 10;
  const r = { x: mm(rect.x), y: mm(rect.y), w: mm(rect.w), h: mm(rect.h) };
  return {
    view: 'board',
    rect: r,
    whole: inside(r, { x: 0, y: 0, w: board.outline.w, h: board.outline.h }),
    ...classify(
      r,
      board.parts.filter((p) => !p.componentId.startsWith('hole:')).map((p) => ({ ref: p.refdes, box: p.courtyard })),
    ),
  };
}

const MAX_LISTED = 60;
const list = (refs: string[]) => (refs.length > MAX_LISTED ? `${refs.slice(0, MAX_LISTED).join(' ')} … ${refs.length - MAX_LISTED} more` : refs.join(' '));

/** The <view> block of the design context. */
export function formatView(v: ViewInfo): string {
  const lines: string[] = [];
  if (v.view === 'schematic') {
    const pages = v.pages ?? [];
    lines.push(`<view kind="schematic" sheet="${v.sheetName}" zoomed="${v.whole ? 'no' : 'yes'}">`);
    if (v.whole) lines.push(`the whole sheet${pages.length ? ` (page${pages.length > 1 ? 's' : ''} ${pages.map((p) => p.number).join(', ')})` : ''}`);
    else {
      const on = pages.map((p) => `page ${p.number} x ${p.rect.x}–${p.rect.x + p.rect.w}, y ${p.rect.y}–${p.rect.y + p.rect.h}`).join('; ');
      lines.push(`zoomed in${on ? ` on ${on} (mils from the paper's top-left corner)` : ' between the pages'}; get_schematic_image with area: true shows it`);
    }
  } else {
    lines.push(`<view kind="board" zoomed="${v.whole ? 'no' : 'yes'}">`);
    const r = v.rect;
    const mm = (n: number) => Math.round(n * 10) / 10;
    lines.push(v.whole ? 'the whole board' : `zoomed in: x ${r.x}–${mm(r.x + r.w)}, y ${r.y}–${mm(r.y + r.h)} mm (board coordinates, as place counts); get_board_image with area: true shows it`);
  }
  if (!v.whole) {
    lines.push(v.parts.length ? `parts in view: ${list(v.parts)}` : 'no whole part in view');
    if (v.partly.length) lines.push(`cut by the edge: ${list(v.partly)}`);
  }
  lines.push('</view>');
  return lines.join('\n');
}
