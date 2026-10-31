/**
 * What the SVG canvases (schematic, board, panel) have in common: the view box with its zoom and
 * pan, when a press becomes a drag, which keys are theirs, what stays shown after a drop, and the
 * path strings they draw with.
 */

/** How far the pointer goes (screen pixels) before a press is a drag and no longer a click: the same at any zoom. */
export const DRAG_PX = 3;

type At = { clientX: number; clientY: number };

export const pastDrag = (from: { x: number; y: number }, e: At) => Math.abs(e.clientX - from.x) + Math.abs(e.clientY - from.y) > DRAG_PX;

/** A key for the canvas, not a shortcut of the browser's (⌘R reloads) or a character being composed. */
export const plainKey = (e: KeyboardEvent) => !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A pan under way (the canvas keeps what else it needs to know about the press with it). */
export interface Pan {
  x: number;
  y: number;
  vx: number;
  vy: number;
  moved: boolean;
}

/** An `<svg>`'s view box, in the canvas's coordinates: wheel zooms round the pointer, a drag pans. */
export class SvgView {
  svg = $state<SVGSVGElement | undefined>();
  vb = $state<Box>({ x: 0, y: 0, w: 1000, h: 1000 });
  /** The user has panned or zoomed: the view stops following the design. */
  userMoved = false;
  readonly #minW: number;
  readonly #maxW: number;
  readonly #onmove: (() => void) | undefined;

  constructor(vb: Box, minW: number, maxW: number, onmove?: () => void) {
    this.vb = vb;
    this.#minW = minW;
    this.#maxW = maxW;
    this.#onmove = onmove;
  }

  toSvg(e: At) {
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(this.svg!.getScreenCTM()!.inverse());
    return { x: p.x, y: p.y };
  }

  onwheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = this.toSvg(e);
    const vb = this.vb;
    const f = Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 60) * 0.004);
    const w = Math.min(Math.max(vb.w * f, this.#minW), this.#maxW);
    const k = w / vb.w;
    this.vb = { x: p.x - (p.x - vb.x) * k, y: p.y - (p.y - vb.y) * k, w, h: vb.h * k };
    this.userMoved = true;
    this.#onmove?.();
  };

  panStart(e: At): Pan {
    return { x: e.clientX, y: e.clientY, vx: this.vb.x, vy: this.vb.y, moved: false };
  }

  panTo(pan: Pan, e: At) {
    const dx = e.clientX - pan.x;
    const dy = e.clientY - pan.y;
    if (pastDrag(pan, e)) pan.moved = this.userMoved = true;
    const r = this.svg!.getBoundingClientRect();
    const s = Math.max(this.vb.w / r.width, this.vb.h / r.height);
    this.vb = { ...this.vb, x: pan.vx - dx * s, y: pan.vy - dy * s };
    this.#onmove?.();
  }

  /** The element's width over height; the view box's before it has a size. */
  aspect() {
    const r = this.svg?.getBoundingClientRect();
    return r && r.height > 0 ? r.width / r.height : this.vb.w / this.vb.h;
  }

  /** The area on screen (the view box is fitted into the element, so one side shows more). */
  visibleRect(): Box | null {
    const r = this.svg?.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return null;
    const vb = this.vb;
    const aspect = r.width / r.height;
    const w = aspect > vb.w / vb.h ? vb.h * aspect : vb.w;
    const h = aspect > vb.w / vb.h ? vb.h : vb.w / aspect;
    return { x: vb.x + vb.w / 2 - w / 2, y: vb.y + vb.h / 2 - h / 2, w, h };
  }
}

/** How long something dropped stays shown when the design never comes to show it, ms. */
const DROP_MS = 5000;

/**
 * What was just dropped, shown where it was dropped until the design shows it there (the edit and
 * the redraw take a moment; without this it would flash back to its old place meanwhile). An edit
 * refused lets it go at once; if nothing comes of it, it goes after a while.
 */
export class Dropped<T> {
  value = $state.raw<T | null>(null);
  #timer: ReturnType<typeof setTimeout> | undefined;

  show(v: T, edit?: Promise<boolean>) {
    this.value = v;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.clear(), DROP_MS);
    void edit?.then((went) => {
      if (!went && this.value === v) this.clear();
    });
  }

  clear() {
    this.value = null;
    clearTimeout(this.#timer);
  }
}

/** A closed polygon (flat x, y list) as SVG path data. */
export const polyPath = (pts: number[]) => pts.reduce((d, v, i) => (i % 2 ? `${d} ${v}` : `${d}${i ? ' L' : 'M'} ${v}`), '') + ' Z';
/** An open polyline (flat x, y list) as SVG path data. */
export const linePath = (pts: number[]) => pts.reduce((s, v, i) => s + (i % 2 ? `,${v}` : `${i ? ' L' : 'M'}${v}`), '');
/** A flat x, y list as SVG points. */
export const points = (pts: number[]) => pts.reduce((d, v, i) => (i % 2 ? `${d},${v}` : `${d}${i ? ' ' : ''}${v}`), '');
/** A pour's cells (x, y, w, h each) as one path. */
export const zonePath = (r: number[]) => {
  let d = '';
  for (let i = 0; i + 3 < r.length; i += 4) d += `M${r[i]},${r[i + 1]}h${r[i + 2]}v${r[i + 3]}h${-r[i + 2]!}z`;
  return d;
};
