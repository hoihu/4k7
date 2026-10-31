/**
 * A part's name and value on the schematic (docs/design/schematic-drawing.md §2e): what they run
 * into, the spots round the symbol where they can stand, and the nearest clear one. The layout keeps
 * its text clear with it; place_text lets the agent and the user decide where text goes.
 */
import type { LabelView, Prim, Rect, SheetView, SymbolView } from '@4k7/schema';
import { natCmp } from './doc.ts';
import { drawingArea } from './drawing.ts';
import { LINE, textRect } from './scene.ts';
import { labelParts, line, meets, segments, type OverlapHit } from './scope.ts';

type TextPos = SymbolView['refPos'];
export type TextSide = 'above' | 'below' | 'left' | 'right';
export type TextArrange = 'stacked' | 'side_by_side';
interface TextSpot {
  ref: TextPos;
  value: TextPos;
}
type TextDrawing = Pick<SheetView, 'symbols' | 'wires' | 'labels' | 'pages' | 'blocks'>;

/** Baselines and text ends off the body (see spotAt), and the air between a name and its value side by side. */
const ABOVE = 45;
const BELOW = 105;
const BESIDE = 30;
const APART = 50;
/** How far a spot slides along its side to keep clear. */
const SLIDE_STEP = 50;
const SLIDE_MAX = 1000;
/** Costs of a spot that is not where the text is now: the far side, a side across it, the other arrangement; a slide costs half its length. */
const FAR_SIDE = 130;
const CROSS_SIDE = 260;
const OTHER_ARRANGE = 110;
/** What a text can run into is looked for this far round its part. */
const NEAR = 2500;

const refOf = (s: SymbolView) => `${s.refdes}${s.unit ?? ''}`;
const linesOf = (s: SymbolView) => s.valueLines ?? [s.value];
const hasValue = (s: SymbolView) => linesOf(s).some((l) => l);

/** The box of a part's name and of its value; a part with no value has only the first. */
function textBoxes(s: SymbolView, at: TextSpot = { ref: s.refPos, value: s.valuePos }): { which: 'name' | 'value'; r: Rect }[] {
  return [{ which: 'name' as const, r: textRect(at.ref, [refOf(s)]) }, ...(hasValue(s) ? [{ which: 'value' as const, r: textRect(at.value, linesOf(s)) }] : [])];
}

/** The box of one of a part's texts at a spot. */
export const textBox = (s: SymbolView, which: 'name' | 'value', at: TextPos): Rect => (which === 'name' ? textRect(at, [refOf(s)]) : textRect(at, linesOf(s)));

const union = (rs: Rect[]): Rect => {
  const x = Math.min(...rs.map((r) => r.x));
  const y = Math.min(...rs.map((r) => r.y));
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
};
export const within = (a: Rect, r: Rect) => r.x >= a.x && r.y >= a.y && r.x + r.w <= a.x + a.w && r.y + r.h <= a.y + a.h;
const grow = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by });

/** What a symbol draws, as text sees it. */
interface Body {
  /** The box round all of it: what another part's text keeps off. Tighter than a bbox, which for a lying part is as high as for one standing. */
  all: Rect;
  /** The box round all of it but its leads: what its own text stands round. */
  core: Rect;
  /** Each lead with its pin number: its own text keeps off them. */
  leads: Rect[];
}

const PIN_NUMBER_W = 32;

/** Turned with the symbol. */
export function bodyOf(s: SymbolView): Body {
  const rad = ((s.rotation ?? 0) * Math.PI) / 180;
  const [c, sn] = [Math.cos(rad), Math.sin(rad)];
  const o = s.origin ?? { x: 0, y: 0 };
  const turn = (x: number, y: number): [number, number] => (s.rotation ? [o.x + (x - o.x) * c - (y - o.y) * sn, o.y + (x - o.x) * sn + (y - o.y) * c] : [x, y]);
  const atPin = (x: number, y: number) => {
    const [tx, ty] = turn(x, y);
    return s.pins.some((p) => Math.abs(p.x - tx) < 1 && Math.abs(p.y - ty) < 1);
  };
  const xs: number[] = [];
  const ys: number[] = [];
  const add = (x: number, y: number, r = 0) => {
    const [tx, ty] = turn(x, y);
    xs.push(tx - r, tx + r);
    ys.push(ty - r, ty + r);
  };
  for (const p of s.prims as Prim[]) {
    if (p.t === 'rect') (add(p.x, p.y), add(p.x + p.w, p.y + p.h));
    else if (p.t === 'line') {
      if (!atPin(p.x1, p.y1) && !atPin(p.x2, p.y2)) (add(p.x1, p.y1), add(p.x2, p.y2));
    } else if (p.t === 'circle') add(p.x, p.y, p.r);
    else if (p.t === 'text') add(p.x, p.y, 40);
    else if (p.t === 'poly') p.pts.forEach((v, i) => i % 2 && add(p.pts[i - 1]!, v));
    else addPath(p.d, add);
  }
  const box = (x0: number, y0: number, x1: number, y1: number): Rect => ({ x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) });
  const px = s.pins.map((p) => p.x);
  const py = s.pins.map((p) => p.y);
  const core = xs.length ? box(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)) : s.bbox;
  const all = box(Math.min(core.x, ...px), Math.min(core.y, ...py), Math.max(core.x + core.w, ...px), Math.max(core.y + core.h, ...py));
  const leads = s.pins.map((p): Rect => {
    const n = p.showNumber ? p.number.length * PIN_NUMBER_W : 0;
    if (p.side === 'left' || p.side === 'right') {
      const end = p.side === 'left' ? core.x : core.x + core.w;
      return { x: Math.min(p.x, end), y: p.y - (n ? 65 : 5), w: Math.abs(p.x - end), h: n ? 70 : 10 };
    }
    const end = p.side === 'top' ? core.y : core.y + core.h;
    return { x: p.x - 5, y: Math.min(p.y, end), w: n ? 27 + n : 10, h: Math.abs(p.y - end) };
  });
  return { all, core, leads };
}

/** What a path draws: its points, and for an arc (relative, as the symbols write them) its ends with the radius round them. */
function addPath(d: string, add: (x: number, y: number, r?: number) => void): void {
  let [x, y] = [0, 0];
  for (const [, cmd, args] of d.matchAll(/([MQa])([^MQa]*)/g)) {
    const n = args!.trim().split(/[\s,]+/).map(Number);
    if (cmd === 'a') {
      add(x, y, n[0]);
      x += n[5]!;
      y += n[6]!;
      add(x, y, n[0]);
    } else {
      for (let i = 0; i + 1 < n.length; i += 2) {
        x = n[i]!;
        y = n[i + 1]!;
        add(x, y);
      }
    }
  }
}

/* ------------------------------ what it runs into --------------------------- */

interface Field {
  wires: { net: string; r: Rect }[];
  labels: { label: LabelView; rs: Rect[] }[];
  bodies: { sym: SymbolView; r: Rect; leads: Rect[] }[];
  texts: { sym: SymbolView; which: 'name' | 'value'; r: Rect }[];
  /** The titles of the block frames. */
  titles: Rect[];
}

function fieldOf(sheet: TextDrawing): Field {
  return {
    wires: sheet.wires.flatMap((w) => segments(w.pts).map(([x1, y1, x2, y2]) => ({ net: w.netId, r: line(x1, y1, x2, y2) }))),
    labels: sheet.labels.map((label) => ({ label, rs: labelParts(label).map((p) => p.r) })),
    bodies: sheet.symbols.map((sym) => {
      const b = bodyOf(sym);
      return { sym, r: b.all, leads: b.leads };
    }),
    texts: sheet.symbols.flatMap((sym) => textBoxes(sym).map((t) => ({ sym, ...t }))),
    titles: (sheet.blocks ?? []).map((b) => ({ x: b.rect.x + 80, y: b.rect.y + 70, w: b.title.length * 66, h: 100 })),
  };
}

/** The first thing a box of `me`'s text runs into; of its own part only the leads are in the way (text may stand close to the rest). */
function hitOf(f: Field, me: SymbolView, r: Rect): OverlapHit | undefined {
  const w = f.wires.find((x) => meets(r, x.r));
  if (w) return { on: 'wire', net: w.net };
  const b = f.bodies.find((x) => (x.sym === me ? x.leads.some((q) => meets(r, q)) : meets(r, x.r)));
  if (b) return { on: 'symbol', sym: b.sym };
  const t = f.texts.find((x) => x.sym !== me && meets(r, x.r));
  if (t) return { on: 'text', sym: t.sym, which: t.which };
  const l = f.labels.find((x) => x.rs.some((q) => meets(r, q)));
  return l ? { on: 'label', label: l.label } : undefined;
}

/** Only what stands round a part, as a search there tries many spots. */
function nearBy(f: Field, sym: SymbolView): Field {
  const area = grow(bodyOf(sym).all, NEAR);
  const near = (r: Rect) => meets(area, r);
  return {
    wires: f.wires.filter((x) => near(x.r)),
    labels: f.labels.filter((x) => x.rs.some(near)),
    bodies: f.bodies.filter((x) => x.sym === sym || near(x.r)),
    texts: f.texts.filter((x) => near(x.r)),
    titles: f.titles,
  };
}

export interface TextClash {
  sym: SymbolView;
  which: 'name' | 'value';
  hit: OverlapHit;
}

/** What the name and value of one part run into, each once. */
function clashesOf(f: Field, sym: SymbolView): TextClash[] {
  return textBoxes(sym).flatMap(({ which, r }) => {
    const hit = hitOf(f, sym, r);
    return hit ? [{ sym, which, hit }] : [];
  });
}

/**
 * Names and values on a sheet that run into a wire, another part or another part's text (two texts
 * in each other's way count once). A label running into text is the label's finding (labelOverlaps).
 * With `parts`, of those components alone.
 */
export function textOverlaps(sheet: TextDrawing, parts?: ReadonlySet<string>): TextClash[] {
  const f = fieldOf(sheet);
  const noLabels: Field = { ...f, labels: [] };
  const out: TextClash[] = [];
  for (const sym of sheet.symbols) {
    if (parts && !parts.has(sym.componentId)) continue;
    for (const c of clashesOf(noLabels, sym)) {
      const seen = c.hit.on === 'text' && out.some((o) => o.sym === (c.hit as { sym: SymbolView }).sym && o.hit.on === 'text' && o.hit.sym === sym);
      if (!seen) out.push(c);
    }
  }
  return out;
}

/** In words: "R7's name runs through a wire of USB_DP". */
export function clashWords({ sym, which, hit }: TextClash, netName: (id: string) => string): string {
  return `${refOf(sym)}'s ${which} ${hitWords(sym, hit, netName)}`;
}

function hitWords(me: SymbolView, hit: OverlapHit, netName: (id: string) => string): string {
  switch (hit.on) {
    case 'wire':
      return `runs through a wire of ${netName(hit.net)}`;
    case 'symbol':
      return hit.sym === me ? 'runs through its own pin' : `runs into ${refOf(hit.sym)}`;
    case 'text':
      return `runs into ${refOf(hit.sym)}'s ${hit.which}`;
    case 'label':
      return `runs into the ${netName(hit.label.netId)} ${hit.label.kind === 'net' ? 'label' : 'symbol'}`;
  }
}

/* ----------------------------------- spots ---------------------------------- */

/** The side of its body a part's text is on (above a corner counts as above), and how it stands. */
function textPlaceOf(sym: SymbolView, core = bodyOf(sym).core): { side: TextSide; arrange: TextArrange } {
  const u = union(textBoxes(sym).map((t) => t.r));
  const beside = u.x + u.w / 2 < core.x + core.w / 2 ? 'left' : 'right';
  const side: TextSide = u.y + u.h / 2 < core.y ? 'above' : u.y + u.h / 2 > core.y + core.h ? 'below' : beside;
  return { side, arrange: hasValue(sym) && sym.refPos.y === sym.valuePos.y ? 'side_by_side' : 'stacked' };
}

/**
 * Name and value on one side of the body, `along` that side from its middle. y is a text's
 * baseline: its box reaches 80 up and 20 down (textRect). Side by side the name comes first, and
 * each grows away from the other when it changes (a part renamed, a new value).
 */
function spotAt(sym: SymbolView, body: Rect, side: TextSide, arrange: TextArrange, along: number): TextSpot {
  const extra = LINE * (linesOf(sym).length - 1);
  const wName = textRect({ x: 0, y: 0, anchor: 'start' }, [refOf(sym)]).w;
  const wValue = hasValue(sym) ? textRect({ x: 0, y: 0, anchor: 'start' }, linesOf(sym)).w : 0;
  const inline = arrange === 'side_by_side' && hasValue(sym);
  const cx = body.x + body.w / 2 + along;
  const cy = body.y + body.h / 2 + along;
  const sbs = (x: number, y: number): TextSpot => ({ ref: { x: x + wName, y, anchor: 'end' }, value: { x: x + wName + APART, y, anchor: 'start' } });
  const pos = (x: number, y: number, anchor: TextPos['anchor']): TextPos => ({ x, y, anchor });
  switch (side) {
    case 'above': {
      const y = body.y - ABOVE - extra;
      return inline ? sbs(cx - (wName + APART + wValue) / 2, y) : { ref: pos(cx, y - (hasValue(sym) ? LINE : 0), 'middle'), value: pos(cx, y, 'middle') };
    }
    case 'below': {
      const y = body.y + body.h + BELOW;
      return inline ? sbs(cx - (wName + APART + wValue) / 2, y) : { ref: pos(cx, y, 'middle'), value: pos(cx, y + LINE, 'middle') };
    }
    case 'right': {
      const x = body.x + body.w + BESIDE;
      return inline ? sbs(x, cy + 30 - extra / 2) : { ref: pos(x, cy - 15 - extra / 2, 'start'), value: pos(x, cy + 70 - extra / 2, 'start') };
    }
    case 'left': {
      const x = body.x - BESIDE;
      return inline ? sbs(x - wName - APART - wValue, cy + 30 - extra / 2) : { ref: pos(x, cy - 15 - extra / 2, 'end'), value: pos(x, cy + 70 - extra / 2, 'end') };
    }
  }
}

/** A text's box with the air between it and the body: nothing may stand between a part and its text. */
function toBody(r: Rect, body: Rect, side: TextSide): Rect {
  switch (side) {
    case 'above':
      return { ...r, h: Math.max(r.h, body.y - r.y) };
    case 'below': {
      const y = Math.min(r.y, body.y + body.h);
      return { ...r, y, h: r.y + r.h - y };
    }
    case 'left':
      return { ...r, w: Math.max(r.w, body.x - r.x) };
    case 'right': {
      const x = Math.min(r.x, body.x + body.w);
      return { ...r, x, w: r.x + r.w - x };
    }
  }
}

const FAR: Record<TextSide, TextSide> = { above: 'below', below: 'above', left: 'right', right: 'left' };

/**
 * The nearest clear spot for a part's text: cheapest first by the side it is on, how it stands and
 * how far it slides, inside `area`. `ask` keeps to a side or an arrangement. Undefined when none is clear.
 */
function clearSpot(f: Field, sym: SymbolView, area: Rect, ask: { side?: TextSide; arrange?: TextArrange } = {}): { spot: TextSpot; side: TextSide; arrange: TextArrange } | undefined {
  const body = bodyOf(sym).core;
  const now = textPlaceOf(sym, body);
  const near = nearBy(f, sym);
  const sides: TextSide[] = ask.side ? [ask.side] : ['above', 'below', 'left', 'right'];
  const arranges: TextArrange[] = ask.arrange ? [ask.arrange] : hasValue(sym) ? ['stacked', 'side_by_side'] : ['stacked'];
  let best: { spot: TextSpot; side: TextSide; arrange: TextArrange; cost: number } | undefined;
  for (const side of sides) {
    for (const arrange of arranges) {
      const base = (side === now.side ? 0 : side === FAR[now.side] ? FAR_SIDE : CROSS_SIDE) + (arrange === now.arrange ? 0 : OTHER_ARRANGE);
      const block = union(textBoxes(sym, spotAt(sym, body, side, arrange, 0)).map((t) => t.r));
      // far enough to clear a lead in the middle of that side, beyond the end of the part if need be
      const room = Math.min(SLIDE_MAX, (side === 'above' || side === 'below' ? body.w + block.w : body.h + block.h) / 2 + SLIDE_STEP);
      const steps = Math.floor(room / SLIDE_STEP);
      // to the right, or beside a part up, first of two slides as long
      const first = side === 'left' || side === 'right' ? -1 : 1;
      for (let i = 0; i <= 2 * steps; i++) {
        const along = (i % 2 ? first : -first) * Math.ceil(i / 2) * SLIDE_STEP + 0;
        const cost = base + Math.abs(along) / 2;
        if (best && cost >= best.cost) break;
        const spot = spotAt(sym, body, side, arrange, along);
        const boxes = textBoxes(sym, spot).map((t) => t.r);
        if (!boxes.every((r) => within(area, r))) continue;
        if (boxes.some((r) => hitOf(near, sym, toBody(r, body, side)) || near.titles.some((t) => meets(r, t)))) continue;
        best = { spot, side, arrange, cost };
        break;
      }
    }
  }
  return best && { spot: best.spot, side: best.side, arrange: best.arrange };
}

/* ----------------------------------- moving ---------------------------------- */

const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const onRect = (r: Rect, p: { x: number; y: number }) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
const OFF_PAGE: Rect = { x: -1e9, y: -1e9, w: 2e9, h: 2e9 };

/** Where a part's text may stand: the drawing area of its page and, kept to it, the frame of its block. */
function areaOf(sheet: TextDrawing, sym: SymbolView, inFrame: boolean): Rect {
  const c = centre(sym.bbox);
  const page = (sheet.pages.find((p) => onRect(p.rect, c)) ?? sheet.pages[0])?.rect;
  const area = page ? drawingArea(page) : OFF_PAGE;
  const frame = inFrame ? sheet.blocks?.find((b) => onRect(b.rect, c))?.rect : undefined;
  if (!frame) return area;
  const [x, y] = [Math.max(area.x, frame.x), Math.max(area.y, frame.y)];
  return { x, y, w: Math.min(area.x + area.w, frame.x + frame.w) - x, h: Math.min(area.y + area.h, frame.y + frame.h) - y };
}

function setSpot(f: Field, sym: SymbolView, spot: TextSpot): void {
  sym.refPos = { ...spot.ref, x: Math.round(spot.ref.x), y: Math.round(spot.ref.y) };
  sym.valuePos = { ...spot.value, x: Math.round(spot.value.x), y: Math.round(spot.value.y) };
  f.texts = [...f.texts.filter((t) => t.sym !== sym), ...textBoxes(sym).map((t) => ({ sym, ...t }))];
}

interface TextsCleared {
  moved: { sym: SymbolView; side: TextSide; arrange: TextArrange }[];
  stuck: TextClash[];
}

/**
 * Every part's text that runs into something goes to the nearest clear spot round its part, inside
 * its block's frame; text with no clear spot stays. With `only`, of those parts alone. Nothing else moves.
 */
export function clearTexts(sheet: TextDrawing, only?: (s: SymbolView) => boolean): TextsCleared {
  const f = fieldOf(sheet);
  const out: TextsCleared = { moved: [], stuck: [] };
  for (const sym of [...sheet.symbols].sort((a, b) => natCmp(refOf(a), refOf(b)))) {
    if (only && !only(sym)) continue;
    const clashes = clashesOf(f, sym);
    if (!clashes.length) continue;
    const to = clearSpot(f, sym, areaOf(sheet, sym, true));
    if (!to) {
      out.stuck.push(...clashes);
      continue;
    }
    setSpot(f, sym, to.spot);
    out.moved.push({ sym, side: to.side, arrange: to.arrange });
  }
  return out;
}

/**
 * Name and value of one part to a side, or stacked or side by side (what is not asked stays as it
 * is): the nearest clear spot on that side if it has one, else its middle, with what the text runs
 * into there. It may leave its block's frame, which then takes it in.
 */
export function placeTexts(sheet: TextDrawing, sym: SymbolView, ask: { side?: TextSide; arrange?: TextArrange }): { side: TextSide; arrange: TextArrange; clashes: TextClash[] } {
  const f = fieldOf(sheet);
  const now = textPlaceOf(sym);
  const want = { side: ask.side ?? now.side, arrange: ask.arrange ?? now.arrange };
  const to = clearSpot(f, sym, areaOf(sheet, sym, false), want);
  setSpot(f, sym, to?.spot ?? spotAt(sym, bodyOf(sym).core, want.side, want.arrange, 0));
  return { ...want, clashes: clashesOf(f, sym) };
}

/** What a part's text runs into where it stands. */
export function textClashes(sheet: TextDrawing, sym: SymbolView): TextClash[] {
  return clashesOf(fieldOf(sheet), sym);
}
