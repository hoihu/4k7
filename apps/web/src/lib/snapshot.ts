import type { Rect } from '@4k7/schema';

/**
 * Render a live canvas SVG (the schematic, the board) to a PNG (base64), framed on `frame`. Styles
 * come from CSS (theme variables, scoped classes), so the computed paint of every element is
 * inlined into a clone before rasterising.
 */
const PROPS = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'visibility',
  'display',
  'text-anchor',
  'dominant-baseline',
] as const;

/** The schematic, framed on the whole sheet or on `frame` (a page, an area). */
export async function renderSchematicPng(width: number, frame?: Rect): Promise<{ data: string; mimeType: string }> {
  const live = document.querySelector<SVGSVGElement>('svg.sch');
  if (!live) throw new Error('The schematic view is not open.');
  const sheet = live.dataset.bbox?.split(',').map(Number);
  if (!sheet || sheet.length !== 4) throw new Error('No sheet to render.');
  const [x, y, w, h] = sheet as [number, number, number, number];
  return renderSvgPng(live, width, frame ?? { x, y, w, h });
}

/** The 2D board view (as shown: the layers and overlays switched on), framed on `frame` (mm). */
export async function renderBoardPng(width: number, frame: Rect): Promise<{ data: string; mimeType: string }> {
  const live = document.querySelector<SVGSVGElement>('svg.board');
  if (!live) throw new Error('The 2D board view is not open.');
  return renderSvgPng(live, width, frame);
}

async function renderSvgPng(live: SVGSVGElement, width: number, frame: Rect): Promise<{ data: string; mimeType: string }> {
  const { x, y, w, h } = frame;
  const height = Math.round((width * h) / w);

  const clone = live.cloneNode(true) as SVGSVGElement;
  const src = [live, ...live.querySelectorAll('*')];
  const dst = [clone, ...clone.querySelectorAll('*')];
  src.forEach((el, i) => {
    const cs = getComputedStyle(el);
    const target = dst[i] as SVGElement;
    target.removeAttribute('class');
    target.setAttribute('style', PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';'));
  });
  clone.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.style.position = 'static';
  const bg = getComputedStyle(live.parentElement ?? live).backgroundColor;

  const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : '#f1f5fa';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const dataUrl = canvas.toDataURL('image/png');
    return { data: dataUrl.slice(dataUrl.indexOf(',') + 1), mimeType: 'image/png' };
  } finally {
    URL.revokeObjectURL(url);
  }
}
