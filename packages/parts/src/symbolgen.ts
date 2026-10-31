/**
 * Deterministic schematic symbol generator. Symbols are never drawn by the AI.
 *
 * Coordinates are integer mils, y down. Two kinds:
 *  - two-pin symbols (R, C, L, D, LED): drawn vertically around the origin, pin 1 at
 *    (0, -200) and pin 2 at (0, 200). `flip` mirrors them vertically (pin 1 at the bottom).
 *    What the part is refines the glyph: a polarised capacitor, an inductor's core, a Schottky,
 *    Zener or TVS diode (from the card, or the component's parameters `core` and `type`).
 *  - box symbols (ICs, connectors): body rectangle from (0, 0) to (w, h), pins sticking out
 *    200 mils on each side. Parts with a symbol of their own (transistors, bridges, crystals,
 *    relays, optocouplers, switches, protection parts …: glyphSymbol) are 'box' symbols too,
 *    drawn as that symbol.
 */
import { parseAs, type ParamSpec, type PartCard, type PartPin, type PinSide, type Prim, type QuarterTurn, type SymbolLayout, type SymbolSpec, type SymbolUnit } from '@4k7/schema';

export const GRID = 100;
export const PIN_LEN = 200;
/** Approximate advance width of one character of pin/label text, in mils. */
export const CHAR_W = 50;
/** Line height of stacked value text, in mils. */
export const TEXT_LINE = 85;
/** Length of a supply symbol's stem, in mils. */
export const RAIL_STEM = 200;

/** The box a symbol's name or value takes, from its anchor point (a rough one: what the kernel keeps clear, and what takes a press on the canvas). */
export function textRect(p: { x: number; y: number; anchor: 'start' | 'middle' | 'end' }, lines: string[]): { x: number; y: number; w: number; h: number } {
  const w = Math.max(...lines.map((l) => l.length * CHAR_W)) + 20;
  return { x: p.anchor === 'end' ? p.x - w : p.anchor === 'middle' ? p.x - w / 2 : p.x, y: p.y - 80, w, h: 100 + TEXT_LINE * (lines.length - 1) };
}

export interface SymbolPin {
  number: string;
  name: string;
  x: number;
  y: number;
  side: PinSide;
  showName: boolean;
  showNumber: boolean;
  /** Its name runs along the pin, into the body (a connector's, on top or at the bottom: its pins stay close). */
  nameAlong?: boolean;
}

export interface SymbolDef {
  kind: 'two_pin' | 'box';
  prims: Prim[];
  pins: SymbolPin[];
  /** Bounding box of the body and pins, in local coordinates. */
  bbox: { x: number; y: number; w: number; h: number };
  /** Local anchor points for refdes and value text. */
  refPos: { x: number; y: number; anchor: 'start' | 'middle' | 'end' };
  valuePos: { x: number; y: number; anchor: 'start' | 'middle' | 'end' };
  /** How it was made, so a stored drawing can make it again (symbolFromSpec). */
  spec?: SymbolSpec;
}

const TWO_PIN = new Set(['resistor', 'capacitor', 'inductor', 'diode', 'led']);

export function isTwoPin(card: PartCard): boolean {
  return TWO_PIN.has(card.category) && card.pins.length === 2;
}

export interface SymbolOptions {
  /** Pin numbers to put first (topmost / leftmost) on their side, e.g. the power path. */
  first?: string[];
  /** Swap left and right pins, e.g. for an output connector at the right edge facing the circuit; any symbol that is no two-pin part. */
  mirror?: boolean;
  /** Turned clockwise, after any mirroring; any symbol that is no two-pin part. */
  rotated?: QuarterTurn;
  /** Unit index of a split symbol (card.units); only that unit's pins are drawn. */
  unit?: number;
  /** The component's parameters, where they decide the glyph (an inductor's `core`, a diode's `type`); never stored with the spec. */
  params?: Params;
}

/** A component's parameters, as far as the symbol reads them. */
export type Params = Record<string, string | undefined>;

/** Number of symbols a part is drawn as. */
export function unitCount(card: PartCard): number {
  return card.units?.length || 1;
}

/** The unit (index) a pin is drawn in; 0 for single symbols. */
export function unitOfPin(card: PartCard, pinNumber: string): number {
  if (!card.units?.length) return 0;
  const i = card.units.findIndex((u) => Object.values(u.layout).some((side: (string[] | null)[]) => side.some((e) => e?.includes(pinNumber))));
  return Math.max(0, i);
}

export function symbolFor(card: PartCard, flip = false, opts: SymbolOptions = {}): SymbolDef {
  return { ...symbolDef(card, flip, opts), spec: specOf({ flip, ...opts, over: !!opts.mirror && turnsOver(card) }) };
}

/** Whether the part is drawn as a box (ICs, connectors, modules): the only symbols whose pins can be arranged (set_symbol layout). */
export function isBoxSymbol(card: PartCard): boolean {
  return !isTwoPin(card) && !glyphSymbol(card, false);
}

/** The parameters that change how a two-pin part of a category is drawn: any inductor's core, any diode's type. */
export const SYMBOL_PARAMS: Partial<Record<PartCard['category'], Record<string, ParamSpec>>> = {
  inductor: {
    core: {
      description: 'The core the schematic symbol shows: ferrite (dashed lines), iron (solid lines) or air (none). Default: from the part, else ferrite for a power inductor (1 µH and more, or 1 A and more), air below',
      values: ['ferrite', 'iron', 'air'],
    },
  },
  diode: {
    type: {
      description: 'What kind of diode, shown by the schematic symbol: standard (rectifier, switching), schottky, zener, tvs or tvs_bidirectional. Default: from the part or its mpn',
      values: ['standard', 'schottky', 'zener', 'tvs', 'tvs_bidirectional'],
    },
  },
};

/** Whether the component's parameters can change how the part is drawn (SYMBOL_PARAMS, see SymbolOptions.params). */
export function readsParams(card: PartCard): boolean {
  return isTwoPin(card) && !!SYMBOL_PARAMS[card.category];
}

function symbolDef(card: PartCard, flip: boolean, opts: SymbolOptions): SymbolDef {
  if (isTwoPin(card)) return twoPin(card, flip, opts.params ?? {});
  const def = glyphSymbol(card, opts.mirror ?? false) ?? box(card, opts.first ?? [], opts.mirror ?? false, opts.unit);
  return opts.rotated ? turned(def, opts.rotated) : def;
}

/**
 * The usual symbol of a part that is not drawn as a box: a bridge, a transistor, a shunt reference,
 * an optocoupler, a relay, which mirrored are drawn turned over; a crystal, a switch, a fuse,
 * thermistor, varistor or ferrite bead, a gas discharge tube, a common-mode choke, which mirrored
 * swap their terminals; else null.
 */
function glyphSymbol(card: PartCard, mirror: boolean): SymbolDef | null {
  const fixed = fixedGlyph(card);
  if (fixed) return mirror ? turnedOver(fixed) : fixed;
  return crystalSymbol(card, mirror) ?? switchSymbol(card, mirror) ?? lyingSymbol(card, mirror) ?? gdtSymbol(card, mirror) ?? chokeSymbol(card, mirror);
}

function fixedGlyph(card: PartCard): SymbolDef | null {
  if (card.category === 'diode' && card.pins.length === 4) return bridgeDiamond(card);
  return transistorSymbol(card) ?? shuntReference(card) ?? optoSymbol(card) ?? relaySymbol(card);
}

/** Whether mirroring turns the part's whole drawing over (a transistor, an optocoupler …): it then reads against its usual way, so the layout leaves it. */
export function turnsOver(card: PartCard): boolean {
  return !isTwoPin(card) && !!fixedGlyph(card);
}

/** A symbol reflected about x = 0, pins and text with it, so the pins stay on the grid. The glyphs turned over have no paths or marks. */
function turnedOver(def: SymbolDef): SymbolDef {
  const text = (t: SymbolDef['refPos']): SymbolDef['refPos'] => ({ ...t, x: -t.x, anchor: t.anchor === 'start' ? 'end' : t.anchor === 'end' ? 'start' : t.anchor });
  return {
    ...def,
    prims: def.prims.map((p): Prim => {
      if (p.t === 'line') return { ...p, x1: -p.x1, x2: -p.x2 };
      if (p.t === 'rect') return { ...p, x: -p.x - p.w };
      if (p.t === 'circle') return { ...p, x: -p.x };
      if (p.t === 'poly') return { ...p, pts: p.pts.map((v, i) => (i % 2 ? v : -v)) };
      return p;
    }),
    pins: def.pins.map((p) => ({ ...p, x: -p.x, side: p.side === 'left' ? 'right' : p.side === 'right' ? 'left' : p.side })),
    bbox: { ...def.bbox, x: -def.bbox.x - def.bbox.w },
    refPos: text(def.refPos),
    valuePos: text(def.valuePos),
  };
}

/** The middle of a symbol's box on the grid, half a step going toward zero: a crystal, whose box takes in its case's pin, then turns about its terminals' middle. */
const pivotOf = (v: number) => Math.sign(v) * Math.ceil(Math.abs(v) / GRID - 0.5) * GRID;

/**
 * A symbol turned clockwise about its pivot, on the grid, so its pins stay on the grid and a symbol
 * keeps its origin as it turns: four turns bring it back to the mil. Text stays upright: a mark moves
 * with the drawing, the name and value go beside it (nameBeside).
 */
function turned(def: SymbolDef, by: QuarterTurn): SymbolDef {
  const [cos, sin] = by === 90 ? [0, 1] : by === 180 ? [-1, 0] : [0, -1];
  const [px, py] = [pivotOf(def.bbox.x + def.bbox.w / 2), pivotOf(def.bbox.y + def.bbox.h / 2)];
  const at = (x: number, y: number): [number, number] => [px + (x - px) * cos - (y - py) * sin + 0, py + (x - px) * sin + (y - py) * cos + 0];
  const rect = (r: { x: number; y: number; w: number; h: number }) => {
    const [[x1, y1], [x2, y2]] = [at(r.x, r.y), at(r.x + r.w, r.y + r.h)];
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  };
  // a path has points (M, Q) and relative arcs, which keep their radii and flags: their ends turn about nothing
  const path = (d: string) =>
    d.replace(/([MQa])([^MQa]*)/g, (_, cmd: string, args: string) => {
      const n = args.trim().split(/[\s,]+/).map(Number);
      if (cmd === 'a') return `a${n[0]},${n[1]} ${n[2]} ${n[3]} ${n[4]} ${n[5]! * cos - n[6]! * sin + 0},${n[5]! * sin + n[6]! * cos + 0} `;
      return `${cmd}${n.flatMap((v, i) => (i % 2 ? [] : [at(v, n[i + 1]!).join(',')])).join(' ')} `;
    });
  const SIDES: PinSide[] = ['left', 'top', 'right', 'bottom'];
  const prims = def.prims.map((p): Prim => {
    if (p.t === 'line') {
      const [[x1, y1], [x2, y2]] = [at(p.x1, p.y1), at(p.x2, p.y2)];
      return { ...p, x1, y1, x2, y2 };
    }
    if (p.t === 'rect') return { ...p, ...rect(p) };
    if (p.t === 'poly') return { ...p, pts: p.pts.flatMap((v, i) => (i % 2 ? [] : at(v, p.pts[i + 1]!))) };
    if (p.t === 'path') return { ...p, d: path(p.d).trimEnd() };
    const [x, y] = at(p.x, p.y);
    return { ...p, x, y };
  });
  const pins = def.pins.map((p) => {
    const [x, y] = at(p.x, p.y);
    return { ...p, x, y, side: SIDES[(SIDES.indexOf(p.side) + by / 90) % 4]! };
  });
  const bbox = rect(def.bbox);
  return { ...def, prims, pins, bbox, ...nameBeside(prims, pins, bbox) };
}

/** Where the name and value of a turned symbol go: on a side without pins (right first, then above, below, left), else at the box's top left corner, where a box has them. */
function nameBeside(prims: Prim[], pins: SymbolPin[], bbox: SymbolDef['bbox']): Pick<SymbolDef, 'refPos' | 'valuePos'> {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of prims) {
    if (p.t === 'line') xs.push(p.x1, p.x2), ys.push(p.y1, p.y2);
    else if (p.t === 'rect') xs.push(p.x, p.x + p.w), ys.push(p.y, p.y + p.h);
    else if (p.t === 'circle') xs.push(p.x - p.r, p.x + p.r), ys.push(p.y - p.r, p.y + p.r);
    else if (p.t === 'poly') p.pts.forEach((v, i) => (i % 2 ? ys : xs).push(v));
  }
  const [left, right, top, bottom] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const [mx, my] = [(left + right) / 2, (top + bottom) / 2];
  const free = (side: PinSide) => !pins.some((p) => p.side === side);
  const two = (x: number, y1: number, y2: number, anchor: 'start' | 'middle' | 'end') => ({ refPos: { x, y: y1, anchor }, valuePos: { x, y: y2, anchor } });
  if (free('right')) return two(right + 30, my - 15, my + 70, 'start');
  if (free('top')) return two(mx, top - 130, top - 40, 'middle');
  if (free('bottom')) return two(mx, bottom + 90, bottom + 175, 'middle');
  if (free('left')) return two(left - 30, my - 15, my + 70, 'end');
  return two(bbox.x + PIN_LEN - 30, bbox.y + PIN_LEN - 115, bbox.y + PIN_LEN - 30, 'end');
}

/** The spec with only what is set, so stored drawings stay small and compare equal. */
function specOf(s: SymbolSpec): SymbolSpec {
  return {
    ...(s.upright ? { upright: true } : {}),
    ...(s.flip ? { flip: true } : {}),
    ...(s.mirror ? { mirror: true } : {}),
    ...(s.over ? { over: true } : {}),
    ...(s.rotated ? { rotated: s.rotated } : {}),
    ...(s.first?.length ? { first: [...s.first] } : {}),
    ...(s.unit !== undefined ? { unit: s.unit } : {}),
  };
}

/** The symbol a stored drawing names (DrawnSymbol.spec): the same def symbolFor or uprightSymbol made (with the component's `params`). */
export function symbolFromSpec(card: PartCard, spec: SymbolSpec, params?: Params): SymbolDef {
  if (spec.upright) return uprightSymbol(card, !!spec.flip, params);
  return symbolFor(card, !!spec.flip, { ...(spec.first ? { first: spec.first } : {}), ...(specMirrors(card, spec) ? { mirror: true } : {}), ...(spec.rotated ? { rotated: spec.rotated } : {}), ...(spec.unit !== undefined ? { unit: spec.unit } : {}), ...(params ? { params } : {}) });
}

/** Whether a stored spec draws its symbol mirrored. Drawings stored before 2026-10-30 may say `mirror` on a part that turns over, which took no notice: such a part stays as it was drawn unless it says `over`. */
export function specMirrors(card: PartCard, spec: SymbolSpec): boolean {
  return !!spec.mirror && (!!spec.over || !turnsOver(card));
}

/* ------------------------------- two-pin ---------------------------------- */

/** Where a two-pin part's name and value start, right of its axis (an LED's light arrows take more room). */
export function textOffset(card: PartCard): number {
  return isTwoPin(card) && card.category === 'led' ? 175 : 100;
}

function twoPin(card: PartCard, flip: boolean, params: Params): SymbolDef {
  const d = flip ? -1 : 1; // direction from pin 1 towards pin 2
  const Y = (y: number) => y * d;
  const prims: Prim[] = [];
  // drawn upright with pin 1 at the top; `flip` turns every y over
  const line = (x1: number, y1: number, x2: number, y2: number) => prims.push({ t: 'line', x1, y1: Y(y1), x2, y2: Y(y2) });
  const lead = (a: number, b: number) => line(0, a, 0, b);
  const ys = (pts: number[]) => pts.map((v, i) => (i % 2 ? Y(v) : v));
  const polyline = (...pts: number[]) => prims.push({ t: 'poly', pts: ys(pts) });
  const solid = (...pts: number[]) => prims.push({ t: 'poly', pts: ys(pts), closed: true, fill: true });

  switch (card.category) {
    case 'resistor':
      lead(-200, -100);
      lead(100, 200);
      prims.push({ t: 'rect', x: -40, y: -100, w: 80, h: 200, fill: true });
      break;
    case 'capacitor': {
      const plus = plusPin(card);
      if (plus === null) {
        lead(-200, -25);
        lead(25, 200);
        line(-80, -25, 80, -25);
        line(-80, 25, 80, 25);
        break;
      }
      // polarised (IEC): the plus plate hollow, the minus plate solid, a "+" beside the plus plate
      const s = plus === 0 ? 1 : -1;
      lead(-200, -50);
      lead(50, 200);
      const [a, b] = [Y(-50 * s), Y(-20 * s)];
      prims.push({ t: 'rect', x: -80, y: Math.min(a, b), w: 160, h: 30 });
      solid(-80, 20 * s, 80, 20 * s, 80, 50 * s, -80, 50 * s);
      line(-85, -95 * s, -35, -95 * s);
      line(-60, -120 * s, -60, -70 * s);
      break;
    }
    case 'inductor': {
      if (BEAD.test(ownText(card))) {
        // a ferrite bead on its wire
        lead(-200, -43);
        lead(43, 200);
        prims.push({ t: 'poly', pts: ys(BEAD_SHAPE), closed: true });
        break;
      }
      lead(-200, -100);
      lead(100, 200);
      const sweep = flip ? 0 : 1;
      const step = 50 * d;
      // the turns bulge to the right (+x) either way round
      prims.push({
        t: 'path',
        d: `M0,${Y(-100)}` + ` a25,25 0 0 ${sweep} 0,${step}`.repeat(4),
      });
      // a magnetic core: two lines beside the turns, dashed for ferrite, solid for iron
      const core = coreOf(card, params);
      for (const x of core === 'air' ? [] : [48, 72]) {
        if (core === 'iron') line(x, -100, x, 100);
        else for (let y = -85; y < 85; y += 50) line(x, y, x, y + 20);
      }
      break;
    }
    case 'diode':
    case 'led': {
      const kind = card.category === 'led' ? 'standard' : diodeKind(card, params);
      if (kind === 'tvs_bidirectional') {
        // two diodes tip to tip on one bar, the bar's ends bent both ways
        lead(-200, -100);
        lead(100, 200);
        solid(-60, -100, 60, -100, 0, 0);
        solid(-60, 100, 60, 100, 0, 0);
        polyline(-60, 25, -60, 0, 60, 0, 60, -25);
        break;
      }
      // pin 1 = cathode: the triangle points towards pin 1, the cathode bar across its tip
      lead(-200, -50);
      lead(50, 200);
      if (kind === 'schottky') polyline(35, -75, 60, -75, 60, -50, -60, -50, -60, -25, -35, -25);
      else if (kind === 'zener') polyline(-60, -50, 60, -50, 60, -25);
      else if (kind === 'tvs') polyline(-60, -25, -60, -50, 60, -50, 60, -75);
      else line(-60, -50, 60, -50);
      solid(-60, 50, 60, 50, 0, -50);
      if (card.category === 'led') {
        // the light: two arrows pointing away from the body
        for (const [x, y] of [[75, -5], [75, 35]] as const) {
          const [tx, ty] = [x + 60, y - 50];
          line(x, y, tx - 12, ty + 10);
          solid(tx, ty, tx - 32, ty + 8, tx - 13, ty + 30);
        }
      }
      break;
    }
  }

  const [p1, p2] = card.pins as [PartPin, PartPin];
  const text = textOffset(card);
  return {
    kind: 'two_pin',
    prims,
    pins: [
      { number: p1.number, name: p1.name, x: 0, y: Y(-200), side: flip ? 'bottom' : 'top', showName: false, showNumber: false },
      { number: p2.number, name: p2.name, x: 0, y: Y(200), side: flip ? 'top' : 'bottom', showName: false, showNumber: false },
    ],
    bbox: { x: -100, y: -200, w: 200, h: 400 },
    refPos: { x: text, y: -15, anchor: 'start' },
    valuePos: { x: text, y: 70, anchor: 'start' },
  };
}

/** What a card says the part is, besides its category: the words of a part's own card (a generic card describes every part of its kind). */
const ownText = (card: PartCard): string => (card.id.startsWith('generic:') ? '' : `${card.title ?? ''} ${card.description} ${card.mpn ?? ''}`);

const PLUS = /^\+$/;
const MINUS = /^(-|−)$/;
const POLARISED = /\b(electrolytic|tantalum|polymer|supercap\w*|double[- ]layer|EDLC)\b|(?<!non[- ]?)\bpolari[sz]ed/i;

/** The plus terminal of a polarised capacitor (0: pin 1, 1: pin 2), or null for one that fits either way round. */
function plusPin(card: PartCard): 0 | 1 | null {
  const [a, b] = card.pins as [PartPin, PartPin];
  if (PLUS.test(a.name.trim()) || MINUS.test(b.name.trim())) return 0;
  if (PLUS.test(b.name.trim()) || MINUS.test(a.name.trim())) return 1;
  if (card.polarity?.mark === 'plus') return card.polarity.pin === b.number ? 1 : 0;
  if (card.polarity?.mark === 'none') return null;
  return card.id === 'generic:CP' || POLARISED.test(ownText(card)) ? 0 : null;
}

export type Core = 'air' | 'ferrite' | 'iron';

/**
 * An inductor's core: the component's `core` parameter, else what its own card says (a power
 * inductor, a ferrite or iron core, an RF or air-core coil), else by its values: a power inductor
 * (1 µH and more, or rated 1 A and more) has a ferrite core, an RF inductor (nanohenries) none.
 */
export function coreOf(card: PartCard, params: Params = {}): Core {
  const set = params.core?.trim().toLowerCase();
  if (set === 'ferrite' || set === 'iron' || set === 'air') return set;
  const text = ownText(card);
  if (/\biron\b|laminated/i.test(text) && !/powder/i.test(text)) return 'iron';
  if (/ferrite|power inductor|shielded|choke|toroid|powder/i.test(text)) return 'ferrite';
  if (/\b(air[- ]core|ceramic[- ]core|RF|multi-?layer|thin[- ]film)\b/i.test(text)) return 'air';
  const henry = parseAs(params.inductance, 'H') ?? 0;
  const amps = parseAs(params.current, 'A') ?? 0;
  return henry >= 1e-6 || amps >= 1 ? 'ferrite' : 'air';
}

export type DiodeKind = 'standard' | 'schottky' | 'zener' | 'tvs' | 'tvs_bidirectional';
const DIODE_KINDS: DiodeKind[] = ['standard', 'schottky', 'zener', 'tvs', 'tvs_bidirectional'];

/** Diode families by their part numbers, for diodes nothing else says the kind of (SS56: a Schottky). */
const SCHOTTKY_MPN = /^(SS\d|SK\d|B[1-5]\d0|BAT\d|BAS(40|70|85|125)|1N58(1[7-9]|2[0-2])|MBR|SBR|PMEG|STPS|RB\d|SB\d{3}|SR\d{3}|NSR|DFLS|PDS\d|ZHCS|CUS|CRS)/i;
const ZENER_MPN = /^(BZ[XTVDG]|MMSZ|MM[35]Z|1N47(2[89]|[3-5]\d|6[0-4])|1N52(2[1-9]|[3-7]\d|8[01])|1N53(3[3-9]|[4-7]\d|8[0-8])|ZMM|ZPD|TZM|TZX|PDZ|UDZ|SMAZ|SMBZ)/i;
const TVS_MPN = /^(SM[A-DL]J|P4SMA|P6SMB|1SMB|1\.5SMC|P4KE|P6KE|1\.5KE|[35]KP|15KP|SMF\d|SM6T|SM15T|TPSM[ABC])/i;
/** A TVS part number with C (or CA) after the voltage is bidirectional: SMAJ5.0CA, SM6T6V8CA. */
const TVS_BIDIRECTIONAL_MPN = /\d(?:[.V]\d+)?CA?(?![A-Z0-9])/i;

/** A diode's kind: the component's `type` parameter, else what its own card says, else its part number's family. */
export function diodeKind(card: PartCard, params: Params = {}): DiodeKind {
  const set = DIODE_KINDS.find((k) => k === params.type?.trim().toLowerCase());
  if (set) return set;
  const text = ownText(card);
  if (/schottky/i.test(text)) return 'schottky';
  if (/\b(TVS|ESD)\b|transient[- ]voltage|transzorb|surge suppress/i.test(text)) return /bi-?directional/i.test(text) ? 'tvs_bidirectional' : 'tvs';
  if (/zener/i.test(text)) return 'zener';
  const mpn = (params.mpn ?? card.mpn ?? '').trim();
  if (SCHOTTKY_MPN.test(mpn)) return 'schottky';
  if (ZENER_MPN.test(mpn)) return 'zener';
  if (TVS_MPN.test(mpn)) return TVS_BIDIRECTIONAL_MPN.test(mpn) ? 'tvs_bidirectional' : 'tvs';
  return 'standard';
}

/**
 * A two-pin part drawn upright like R or C, pin `flip`-wise: the usual glyph for R, C, L, D and
 * LEDs, else a small body (a buzzer, a fuse, a two-pin module), with a + mark at pin 1 when it is
 * named "+". For stacking parts in a column (a transistor's load).
 */
export function uprightSymbol(card: PartCard, flip = false, params?: Params): SymbolDef {
  return { ...uprightDef(card, flip, params ?? {}), spec: specOf({ upright: true, flip }) };
}

function uprightDef(card: PartCard, flip: boolean, params: Params): SymbolDef {
  if (isTwoPin(card)) return twoPin(card, flip, params);
  const d = flip ? -1 : 1;
  const Y = (y: number) => y * d;
  const prims: Prim[] = [
    { t: 'line', x1: 0, y1: Y(-200), x2: 0, y2: Y(-120) },
    { t: 'line', x1: 0, y1: Y(120), x2: 0, y2: Y(200) },
    { t: 'rect', x: -80, y: -120, w: 160, h: 240, fill: true },
  ];
  const sound = /buzzer|beeper|speaker|sounder|transducer/i.test(`${card.description} ${card.title ?? ''}`);
  // a sound wave beside the body (the name and value then start further right)
  if (sound) prims.push({ t: 'path', d: 'M110,-50 Q150,0 110,50' }, { t: 'path', d: 'M140,-80 Q200,0 140,80' });
  const [p1, p2] = card.pins as [PartPin, PartPin];
  if (p1.name === '+') prims.push({ t: 'line', x1: -55, y1: Y(-150), x2: -25, y2: Y(-150) }, { t: 'line', x1: -40, y1: Y(-165), x2: -40, y2: Y(-135) });
  return {
    kind: 'two_pin',
    prims,
    pins: [
      { number: p1.number, name: p1.name, x: 0, y: Y(-200), side: flip ? 'bottom' : 'top', showName: false, showNumber: false },
      { number: p2.number, name: p2.name, x: 0, y: Y(200), side: flip ? 'top' : 'bottom', showName: false, showNumber: false },
    ],
    bbox: { x: -100, y: -200, w: sound ? 330 : 300, h: 400 },
    refPos: { x: sound ? 240 : 120, y: -15, anchor: 'start' },
    valuePos: { x: sound ? 240 : 120, y: 70, anchor: 'start' },
  };
}

/* ------------------------------ transistors ------------------------------- */

/**
 * MOSFETs (pins G, D, S) and bipolar transistors (B, C, E) as their usual symbols: control pin
 * on the left, the switched path vertical on the right (N-type: drain/collector on top; P-type:
 * source/emitter on top, as they sit in a high-side switch). A power package that repeats a
 * terminal (SOIC-8: S ×3, G, D ×4) stacks those pins on it.
 */
function transistorSymbol(card: PartCard): SymbolDef | null {
  if (card.pins.length !== 3 && card.category !== 'transistor') return null;
  const role = (re: RegExp) => card.pins.filter((p) => re.test(p.name.trim()));
  // every pin is one of the three terminals
  const terminals = (...groups: PartPin[][]) => groups.every((x) => x.length) && groups.reduce((n, x) => n + x.length, 0) === card.pins.length;
  const [gs, ds, ss] = [role(/^(G|GATE)$/i), role(/^(D|DRAIN)$/i), role(/^(S|SOURCE)$/i)];
  const [bs, cs, es] = [role(/^(B|BASE)$/i), role(/^(C|COLLECTOR)$/i), role(/^(E|EMITTER)$/i)];
  const mos = terminals(gs, ds, ss);
  if (!mos && !terminals(bs, cs, es)) return null;
  const text = `${card.id} ${card.description} ${card.title ?? ''}`;
  const prims: Prim[] = [];
  const L = (x1: number, y1: number, x2: number, y2: number) => prims.push({ t: 'line', x1, y1, x2, y2 });
  const at = (ps: PartPin[], x: number, y: number, side: PinSide): SymbolPin[] => ps.map((p) => ({ number: p.number, name: p.name, x, y, side, showName: false, showNumber: false }));
  let pins: SymbolPin[];
  if (mos) {
    const pType = /p-?channel|pmos|\bp-?fet/i.test(text);
    const [top, bottom] = pType ? [ss, ds] : [ds, ss];
    // gate electrode, the channel in three pieces (enhancement), body tied to the source
    L(-100, 400, 60, 400);
    L(60, 140, 60, 460);
    for (const [y0, y1] of [[110, 190], [260, 340], [410, 490]] as const) L(100, y0, 100, y1);
    L(100, 150, 200, 150);
    L(200, 150, 200, 0);
    L(100, 450, 200, 450);
    L(200, 450, 200, 600);
    const srcY = pType ? 150 : 450;
    L(100, 300, 200, 300);
    L(200, 300, 200, srcY);
    // the body arrow: into the channel for N, out of it for P
    prims.push({ t: 'poly', pts: pType ? [160, 300, 110, 270, 110, 330] : [110, 300, 160, 270, 160, 330], closed: true, fill: true });
    pins = [...at(gs, -100, 400, 'left'), ...at(top, 200, 0, 'top'), ...at(bottom, 200, 600, 'bottom')];
  } else {
    const pnp = /pnp/i.test(text);
    const [top, bottom] = pnp ? [es, cs] : [cs, es];
    L(-100, 300, 100, 300);
    L(100, 180, 100, 420);
    L(100, 240, 200, 140);
    L(200, 140, 200, 0);
    L(100, 360, 200, 460);
    L(200, 460, 200, 600);
    // the emitter arrow: out for NPN (at the bottom lead), in for PNP (at the top lead)
    prims.push({ t: 'poly', pts: pnp ? [110, 250, 165, 210, 140, 190] : [190, 450, 135, 410, 160, 390], closed: true, fill: true });
    prims.push({ t: 'circle', x: 120, y: 300, r: 170 });
    pins = [...at(bs, -100, 300, 'left'), ...at(top, 200, 0, 'top'), ...at(bottom, 200, 600, 'bottom')];
  }
  // the name beside the body (a bipolar transistor's circle reaches further right)
  const tx = mos ? 260 : 320;
  return {
    kind: 'box',
    prims,
    pins,
    bbox: { x: -100, y: 0, w: 400, h: 600 },
    refPos: { x: tx, y: 260, anchor: 'start' },
    valuePos: { x: tx, y: 340, anchor: 'start' },
  };
}

/* ---------------------------------- box ----------------------------------- */

const TOP_NAMES = /^(VCC|VDD|VIN|V\+|VBAT|VBUS|AVCC|AVDD|VDDA|VDDIO|VS\+?)$/i;
const BOTTOM_NAMES = /^(GND|VSS|V-|AGND|PGND|DGND|VSSA|EP|PAD)$/i;

export function pinSide(pin: PartPin): PinSide {
  if (pin.side) return pin.side;
  if (pin.type === 'pwr_in' && TOP_NAMES.test(pin.name)) return 'top';
  if (BOTTOM_NAMES.test(pin.name)) return 'bottom';
  if (pin.type === 'out' || pin.type === 'pwr_out' || pin.type === 'oc') return 'right';
  return 'left';
}

const ceilGrid = (v: number) => Math.ceil(v / GRID) * GRID;

/** One position on a side: pins stacked there (repeated supplies share one), or a gap. */
type Slot = PartPin[] | null;

function slotsFor(card: PartCard, first: string[], mirror: boolean, unit?: number): Record<PinSide, Slot[]> {
  const flipSide = (s: PinSide): PinSide => (!mirror ? s : s === 'left' ? 'right' : s === 'right' ? 'left' : s);
  const out: Record<PinSide, Slot[]> = { left: [], right: [], top: [], bottom: [] };
  const units = card.units?.length ? card.units : null;
  const u = units ? Math.min(Math.max(unit ?? 0, 0), units.length - 1) : 0;
  const layout = units ? units[u]!.layout : card.symbolLayout;
  if (layout) {
    const byNumber = new Map(card.pins.map((p) => [p.number, p]));
    const placed = new Set<string>();
    for (const side of ['left', 'right', 'top', 'bottom'] as PinSide[]) {
      for (const entry of layout[side]) {
        if (entry === null) {
          out[flipSide(side)].push(null);
          continue;
        }
        const stack = entry.map((n) => byNumber.get(n)).filter((p): p is PartPin => !!p);
        stack.forEach((p) => placed.add(p.number));
        if (stack.length) out[flipSide(side)].push(stack);
      }
    }
    // pins the layout forgot still get drawn (on the first unit), so nothing becomes unconnectable
    const covered = units ? new Set(units.flatMap((x) => Object.values(x.layout).flat(2).filter((n): n is string => !!n))) : placed;
    if (u === 0) for (const p of card.pins) if (!covered.has(p.number)) out[flipSide(pinSide(p))].push([p]);
    return out;
  }
  const ordered = [...card.pins.filter((p) => first.includes(p.number)), ...card.pins.filter((p) => !first.includes(p.number))];
  for (const p of ordered) out[flipSide(pinSide(p))].push([p]);
  return out;
}

function box(card: PartCard, first: string[], mirror: boolean, unit?: number): SymbolDef {
  const sides = slotsFor(card, first, mirror, unit);
  const isConn = card.category === 'connector';
  // a connector's pins are often only numbered: a name that says no more than the number is left out, as is a lone pin's (a test point's)
  const named = (p: PartPin) => !isConn || (card.pins.length > 1 && p.name !== p.number);
  const labelLen = (slots: Slot[]) => Math.max(0, ...slots.map((s) => (s && named(s[0]!) ? s[0]!.name.length : 0)));
  // on top and at the bottom a connector keeps its close pitch: the names run along the pins, into the body, beside the names of its other pins
  const along = (slots: Slot[]) => (isConn && labelLen(slots) ? labelLen(slots) * CHAR_W + 30 : 0);
  const [alongTop, alongBottom] = [along(sides.top), along(sides.bottom)];
  const beside = (slots: Slot[]) => (alongTop + alongBottom && labelLen(slots) ? ceilGrid(labelLen(slots) * CHAR_W + 50) : 0);
  const [besideLeft, besideRight] = [beside(sides.left), beside(sides.right)];

  const topPad = sides.top.length ? 200 : 100;
  const botPad = sides.bottom.length ? 200 : 100;
  const rows = Math.max(sides.left.length, sides.right.length, 1);
  const h = Math.max(topPad + (rows - 1) * GRID + botPad, ceilGrid(alongTop + alongBottom));

  const tbLabel = isConn ? 0 : Math.max(labelLen(sides.top), labelLen(sides.bottom));
  const tbPitch = Math.max(GRID, ceilGrid(tbLabel * CHAR_W + 60));
  const tbCount = Math.max(sides.top.length, sides.bottom.length);
  const wSides = ceilGrid((labelLen(sides.left) + labelLen(sides.right)) * CHAR_W + 160);
  // generated (MCU) layouts only need the bottom stacks to fit; hand-made cards keep their spacing
  const tbWidth = card.symbolLayout || card.units?.length ? tbCount * tbPitch + GRID : (tbCount + 1) * tbPitch;
  const wBeside = besideLeft + besideRight ? (besideLeft || GRID) + (tbCount - 1) * GRID + (besideRight || GRID) : 0;
  const w = Math.max(isConn ? 200 : 400, wSides, tbWidth, wBeside);

  const prims: Prim[] = [{ t: 'rect', x: 0, y: 0, w, h, fill: true }];
  const pins: SymbolPin[] = [];
  const add = (slot: Slot, side: PinSide, x: number, y: number, bx: number, by: number) => {
    if (!slot) return;
    prims.push({ t: 'line', x1: x, y1: y, x2: bx, y2: by });
    // stacked pins share the position; only the first shows its name (numbers would collide)
    slot.forEach((p, i) =>
      pins.push({ number: p.number, name: p.name, x, y, side, showName: named(p) && i === 0, showNumber: slot.length === 1, ...(isConn && named(p) && (side === 'top' || side === 'bottom') ? { nameAlong: true } : {}) }),
    );
  };

  sides.left.forEach((slot, i) => add(slot, 'left', -PIN_LEN, topPad + i * GRID, 0, topPad + i * GRID));
  sides.right.forEach((slot, i) => add(slot, 'right', w + PIN_LEN, topPad + i * GRID, w, topPad + i * GRID));
  const tbStart = (n: number) => (wBeside ? besideLeft || GRID : ceilGrid((w - (n - 1) * tbPitch) / 2 - GRID / 2));
  sides.top.forEach((slot, i) => {
    const x = tbStart(sides.top.length) + i * tbPitch;
    add(slot, 'top', x, -PIN_LEN, x, 0);
  });
  sides.bottom.forEach((slot, i) => {
    const x = tbStart(sides.bottom.length) + i * tbPitch;
    add(slot, 'bottom', x, h + PIN_LEN, x, h);
  });

  const nameRight = mirror && !sides.right.length;
  // generated MCU symbols have supplies (and their bus symbols) at the top corners: name above the middle
  const nameAbove = !!(card.symbolLayout || card.units?.length) && !sides.top.length;
  if (nameAbove) {
    return {
      kind: 'box',
      prims,
      pins,
      bbox: { x: -PIN_LEN, y: -PIN_LEN, w: w + 2 * PIN_LEN, h: h + 2 * PIN_LEN },
      refPos: { x: w / 2, y: -115, anchor: 'middle' },
      valuePos: { x: w / 2, y: -30, anchor: 'middle' },
    };
  }
  return {
    kind: 'box',
    prims,
    pins,
    bbox: { x: -PIN_LEN, y: -PIN_LEN, w: w + 2 * PIN_LEN, h: h + 2 * PIN_LEN },
    // outside the top corner on the side without pins (top-left normally, top-right when mirrored)
    refPos: nameRight ? { x: w + 30, y: -115, anchor: 'start' } : { x: -30, y: -115, anchor: 'end' },
    valuePos: nameRight ? { x: w + 30, y: -30, anchor: 'start' } : { x: -30, y: -30, anchor: 'end' },
  };
}

/* ------------------------------- MCU symbols ------------------------------- */

const SUPPLY = /^(VBAT|VDD\w*|VCC\w*|AVDD|DVDD|VDDA|VREF\+|VREFP|V\+|VIN|VCAP\w*)$/i;
const GROUND = /^(VSS\w*|GND\w*|AGND|DGND|PGND|VSSA|VREF-|VREFN|V-|EP|PAD)$/i;
const PORT = /^P([A-Z])(\d+)$/;

/** Main name without alternate-function suffixes: "PA0-WKUP" → "PA0", "PB5/RESET" → "PB5". */
function baseName(name: string): string {
  return name.split(/[-/ (]/)[0]!.toUpperCase();
}

interface PinGroups {
  /** Positive supplies, stacked by name (VDD ×5 → one position). */
  supply: string[][];
  ground: string[][];
  system: PartPin[];
  /** GPIO ports in letter order, pins in number order. */
  ports: { letter: string; pins: PartPin[] }[];
  nc: PartPin[];
}

function groupPins(pins: PartPin[]): PinGroups {
  const stacks = (ps: PartPin[]) => {
    const byName = new Map<string, string[]>();
    for (const p of ps) byName.set(p.name.toUpperCase(), [...(byName.get(p.name.toUpperCase()) ?? []), p.number]);
    return [...byName.entries()].sort(([a], [b]) => supplyRank(a) - supplyRank(b) || a.localeCompare(b, 'en', { numeric: true })).map(([, n]) => n);
  };
  const isPower = (p: PartPin) => p.type === 'pwr_in' || p.type === 'pwr_out' || SUPPLY.test(p.name) || GROUND.test(p.name);
  const ground = pins.filter((p) => GROUND.test(p.name));
  const supply = pins.filter((p) => !GROUND.test(p.name) && isPower(p) && p.type !== 'pwr_out');
  const nc = pins.filter((p) => p.type === 'nc');
  const rest = pins.filter((p) => !ground.includes(p) && !supply.includes(p) && !nc.includes(p));
  const ports = new Map<string, PartPin[]>();
  const system: PartPin[] = [];
  for (const p of rest) {
    const m = PORT.exec(baseName(p.name));
    if (m) ports.set(m[1]!, [...(ports.get(m[1]!) ?? []), p]);
    else system.push(p);
  }
  const portNo = (p: PartPin) => Number(PORT.exec(baseName(p.name))![2]);
  return {
    supply: stacks(supply),
    ground: stacks(ground),
    system: system.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true })),
    ports: [...ports.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([letter, ps]) => ({ letter, pins: ps.sort((a, b) => portNo(a) - portNo(b)) })),
    nc,
  };
}

type Side = (string[] | null)[];
const pushGroup = (side: Side, entries: string[][]) => {
  if (!entries.length) return;
  if (side.length) side.push(null);
  side.push(...entries);
};

/**
 * Arrange a large IC the conventional way (as in the usual MCU library symbols), kept as
 * narrow as the pin names allow: supplies at the top of the left side (repeated names
 * stacked), then the system pins, grounds stacked along the bottom, and the ports PA, PB, PC…
 * in groups on the left and right, balanced by height. NC pins stack at the end of the right.
 */
export function planSymbolLayout(pins: PartPin[]): SymbolLayout {
  const g = groupPins(pins);
  const left: Side = [];
  const right: Side = [];
  pushGroup(left, g.supply);
  pushGroup(left, g.system.map((p) => [p.number]));
  for (const port of g.ports) {
    // keep the letter order on each side; put each group where the side is shorter
    pushGroup(left.length <= right.length ? left : right, port.pins.map((p) => [p.number]));
  }
  if (g.nc.length) pushGroup(right, [g.nc.map((p) => p.number)]);
  return { left, right, top: [], bottom: g.ground };
}

/** The arrangement the import gives a part (large ICs: planSymbolLayout); undefined when its pins go by their type. */
export function generatedLayout(card: Pick<PartCard, 'pins' | 'provenance'>): SymbolLayout | undefined {
  return card.provenance.source === 'datasheet' && card.pins.length >= 12 ? planSymbolLayout(card.pins) : undefined;
}

/** A layout in words, side by side: "left: VIN, UVLO, EN; right: SW ×2, BST; bottom: GND ×3". */
export function layoutText(card: Pick<PartCard, 'pins'>, layout: SymbolLayout): string {
  const byNumber = new Map(card.pins.map((p) => [p.number, p]));
  const entry = (e: string[]) => {
    const names = [...new Set(e.map((n) => byNumber.get(n)?.name ?? n))];
    return names.length === 1 && e.length > 1 ? `${names[0]} ×${e.length}` : names.join('/');
  };
  return (['left', 'right', 'top', 'bottom'] as const)
    .filter((side) => layout[side].some((e) => e))
    .map((side) => `${side}: ${layout[side].filter((e): e is string[] => !!e).map(entry).join(', ')}`)
    .join('; ');
}

/**
 * Split a big IC into units: A holds power and system pins (supplies left, system pins right,
 * grounds bottom), the others two ports each (one per side), so every unit stays a readable size.
 */
export function planUnits(pins: PartPin[]): SymbolUnit[] {
  const g = groupPins(pins);
  const units: SymbolUnit[] = [];
  const letter = (i: number) => String.fromCharCode(65 + i);
  const power: SymbolLayout = { left: [], right: [], top: [], bottom: g.ground };
  pushGroup(power.left, g.supply);
  pushGroup(power.right, g.system.map((p) => [p.number]));
  if (g.nc.length) pushGroup(power.right, [g.nc.map((p) => p.number)]);
  units.push({ name: 'A', title: 'Power, system', layout: power });
  for (let i = 0; i < g.ports.length; i += 2) {
    const [a, b] = [g.ports[i]!, g.ports[i + 1]];
    units.push({
      name: letter(units.length),
      title: [a, b].filter(Boolean).map((p) => `P${p!.letter}`).join(', '),
      layout: { left: a.pins.map((p) => [p.number]), right: b ? b.pins.map((p) => [p.number]) : [], top: [], bottom: [] },
    });
  }
  return units;
}

function supplyRank(name: string): number {
  const order = ['VBAT', 'VDD', 'VDDA', 'VREF+', 'VDDUSB', 'VDDSDMMC', 'VDDIO2', 'VCAP1', 'VCAP2', 'VSS', 'VSSA', 'VREF-'];
  const i = order.indexOf(name.toUpperCase());
  return i < 0 ? order.length : i;
}

/* ------------------------------ bridge diamond ----------------------------- */

/**
 * Single-package bridge rectifier: a square turned 45° with the four diodes inside, pins on
 * the vertices (+ top, − bottom, AC left/right). The body spans (0,0)–(600,600) like a box.
 */
function bridgeDiamond(card: PartCard): SymbolDef {
  const S = 600;
  const c = S / 2;
  // the outline only: a filled polygon is drawn solid, which would hide the diodes
  const prims: Prim[] = [{ t: 'poly', pts: [c, 0, S, c, c, S, 0, c], closed: true }];
  // four small diodes, cathodes towards the + (top) vertex
  const diode = (x: number, y: number, dx: number, dy: number) => {
    // centred on (x, y), pointing along (dx, dy) (unit, 45°)
    const px = -dy;
    const py = dx;
    const t = 34;
    const tip = { x: x + dx * t, y: y + dy * t };
    const b1 = { x: x - dx * t + px * t, y: y - dy * t + py * t };
    const b2 = { x: x - dx * t - px * t, y: y - dy * t - py * t };
    prims.push({ t: 'poly', pts: [tip.x, tip.y, b1.x, b1.y, b2.x, b2.y].map(Math.round), closed: true, fill: true });
    prims.push({ t: 'line', x1: Math.round(tip.x + px * t), y1: Math.round(tip.y + py * t), x2: Math.round(tip.x - px * t), y2: Math.round(tip.y - py * t) });
  };
  const r = Math.SQRT1_2;
  diode(c / 2, c / 2, r, -r); // left → top
  diode(c + c / 2, c / 2, -r, -r); // right → top
  diode(c / 2, c + c / 2, -r, -r); // bottom → left
  diode(c + c / 2, c + c / 2, r, -r); // bottom → right

  const pins: SymbolPin[] = [];
  const at: Record<string, [number, number, number, number, PinSide]> = {
    top: [c, -PIN_LEN, c, 0, 'top'],
    bottom: [c, S + PIN_LEN, c, S, 'bottom'],
    left: [-PIN_LEN, c, 0, c, 'left'],
    right: [S + PIN_LEN, c, S, c, 'right'],
  };
  for (const p of card.pins) {
    const [x, y, bx, by, side] = at[pinSide(p)]!;
    prims.push({ t: 'line', x1: x, y1: y, x2: bx, y2: by });
    pins.push({ number: p.number, name: p.name, x, y, side, showName: false, showNumber: true });
  }
  return {
    kind: 'box',
    prims,
    pins,
    bbox: { x: -PIN_LEN, y: -PIN_LEN, w: S + 2 * PIN_LEN, h: S + 2 * PIN_LEN },
    refPos: { x: -30, y: -115, anchor: 'end' },
    valuePos: { x: -30, y: -30, anchor: 'end' },
  };
}

/* ------------------------- crystals, switches, fuses ------------------------ */

const pinAt = (p: PartPin, x: number, y: number, side: PinSide): SymbolPin => ({ number: p.number, name: p.name, x, y, side, showName: false, showNumber: false });
const lineTo = (prims: Prim[]) => (x1: number, y1: number, x2: number, y2: number) => prims.push({ t: 'line', x1, y1, x2, y2 });
/** Name and value above a lying symbol whose pins leave left, right and down. */
const TEXT_ABOVE = { refPos: { x: 0, y: -230, anchor: 'middle' as const }, valuePos: { x: 0, y: -140, anchor: 'middle' as const } };

/** Pins of a crystal that are not its two terminals: the lid or case (on GND) and NC pins. */
const CASE_PIN = /^(GND\w*|VSS|CASE|SHIELD|EP|PAD|NC|N\.C\.?)$/i;

/**
 * A quartz crystal or ceramic resonator, lying: the quartz between its two electrodes, one
 * terminal left and one right. Its other pins (a lid on GND, or NC) hang from a bracket under
 * it, its case, on a pin at the bottom (pins of one name stacked); a resonator's ground pin joins
 * the two capacitors built into it. Null for a part of the category that is no crystal (an
 * oscillator, with supply, output and enable pins, is a box).
 */
function crystalSymbol(card: PartCard, mirror: boolean): SymbolDef | null {
  if (card.category !== 'crystal') return null;
  const isCase = (p: PartPin) => p.type === 'nc' || CASE_PIN.test(p.name.trim());
  const terms = card.pins.filter((p) => !isCase(p));
  const cases = card.pins.filter(isCase);
  // an oscillator's supply, output and enable are no crystal terminals (by type, or by name where all pins are passive)
  if (terms.length !== 2 || terms.some((p) => (p.type !== 'passive' && p.type !== 'bidir') || /^(V(DD|CC)|EN|OE|ST)/i.test(p.name.trim()))) return null;
  const [left, right] = mirror ? [terms[1]!, terms[0]!] : [terms[0]!, terms[1]!];
  const resonator = cases.length > 0 && (/resonator/i.test(ownText(card)) || (card.pins.length === 3 && cases.every((p) => p.type !== 'nc' && !/^N\.?C/i.test(p.name.trim()))));
  const X = resonator ? 300 : 200;
  const prims: Prim[] = [];
  const L = lineTo(prims);
  L(-X, 0, -70, 0);
  L(70, 0, X, 0);
  L(-70, -100, -70, 100);
  L(70, -100, 70, 100);
  prims.push({ t: 'rect', x: -35, y: -80, w: 70, h: 160 });
  const pins = [pinAt(left, -X, 0, 'left'), pinAt(right, X, 0, 'right')];
  const byName = new Map<string, PartPin[]>();
  for (const p of cases) byName.set(p.name.trim().toUpperCase(), [...(byName.get(p.name.trim().toUpperCase()) ?? []), p]);
  const stacks = [...byName.values()];
  if (stacks.length) {
    const xs = stacks.map((_, i) => (i - (stacks.length - 1) / 2) * 200);
    if (resonator) {
      // the two capacitors built in, from the terminals to the ground pin
      for (const x of [-170, 170]) {
        L(x, 0, x, 50);
        L(x - 40, 50, x + 40, 50);
        L(x - 40, 80, x + 40, 80);
        L(x, 80, x, 140);
      }
      L(-170, 140, 170, 140);
    } else {
      const w = Math.max(120, ...xs.map((x) => Math.abs(x) + 30));
      prims.push({ t: 'poly', pts: [-w, 110, -w, 140, w, 140, w, 110] });
    }
    stacks.forEach((ps, i) => {
      L(xs[i]!, 140, xs[i]!, 200);
      pins.push(...ps.map((p) => pinAt(p, xs[i]!, 200, 'bottom')));
    });
  }
  return { kind: 'box', prims, pins, bbox: { x: -X, y: -100, w: 2 * X, h: stacks.length ? 300 : 200 }, ...TEXT_ABOVE };
}

/**
 * A shunt voltage reference (the TL431 and its kind: cathode, anode, reference) as a Zener-like
 * diode, cathode on top, the reference coming in from the left to the diode's side.
 */
function shuntReference(card: PartCard): SymbolDef | null {
  if (card.category !== 'ic' || card.pins.length !== 3) return null;
  const find = (re: RegExp) => card.pins.find((p) => re.test(p.name.trim()));
  const [k, a, r] = [find(/^(K|CATHODE|KATHODE)$/i), find(/^(A|ANODE)$/i), find(/^(R|REF|VREF)$/i)];
  if (!k || !a || !r) return null;
  const prims: Prim[] = [];
  const L = lineTo(prims);
  L(0, -200, 0, -50);
  L(0, 50, 0, 200);
  prims.push({ t: 'poly', pts: [-60, -50, 60, -50, 60, -25] }, { t: 'poly', pts: [-60, 50, 60, 50, 0, -50], closed: true, fill: true });
  L(-200, 0, -30, 0);
  return {
    kind: 'box',
    prims,
    pins: [pinAt(k, 0, -200, 'top'), pinAt(a, 0, 200, 'bottom'), pinAt(r, -200, 0, 'left')],
    bbox: { x: -200, y: -200, w: 300, h: 400 },
    refPos: { x: 100, y: -15, anchor: 'start' },
    valuePos: { x: 100, y: 70, anchor: 'start' },
  };
}

const SWITCH = /\b(switch|button|tact(ile)?|push-?button|SPST|momentary)\b/i;
const NOT_A_PUSH_BUTTON = /\b(slide|toggle|rotary|DIP|SPDT|DPDT|reed|load|analog|USB|power)\b/i;

/**
 * A push button (a tactile switch, a key), lying: its contacts left and right, the bridge above
 * them pushed down by the button. A switch with four pins (most tactile switches) has them joined
 * inside in pairs: each pair is one terminal, its pins stacked on one spot.
 */
function switchSymbol(card: PartCard, mirror: boolean): SymbolDef | null {
  const text = ownText(card);
  if (card.category !== 'other' || !SWITCH.test(text) || NOT_A_PUSH_BUTTON.test(text)) return null;
  const sides = switchSides(card.pins);
  if (!sides) return null;
  const [left, right] = mirror ? [sides[1], sides[0]] : sides;
  const prims: Prim[] = [
    { t: 'circle', x: -65, y: 0, r: 15 },
    { t: 'circle', x: 65, y: 0, r: 15 },
  ];
  const L = lineTo(prims);
  L(-200, 0, -80, 0);
  L(80, 0, 200, 0);
  L(-100, -50, 100, -50);
  L(0, -50, 0, -120);
  L(-40, -120, 40, -120);
  const pins = [...left.map((p) => pinAt(p, -200, 0, 'left')), ...right.map((p) => pinAt(p, 200, 0, 'right'))];
  return { kind: 'box', prims, pins, bbox: { x: -200, y: -150, w: 400, h: 200 }, ...TEXT_ABOVE };
}

/**
 * A switch's two terminals: one pin each, or its four pins joined inside in pairs, which pins
 * sharing a name or descriptions saying what each is connected to tell ("internally connected to
 * B"). Null when the pairs are not known.
 */
function switchSides(pins: PartPin[]): [PartPin[], PartPin[]] | null {
  if (pins.length === 2) return [[pins[0]!], [pins[1]!]];
  if (pins.length !== 4) return null;
  const key = (s: string) => s.trim().toUpperCase();
  const partner = (p: PartPin): PartPin | undefined => {
    const same = pins.find((q) => q !== p && key(q.name) === key(p.name));
    if (same) return same;
    const m = /connected (?:internally )?(?:to|with) (?:pins? |pads? |terminals? )?([A-Z0-9]+)/i.exec(p.description ?? '');
    return m ? pins.find((q) => q !== p && (key(q.number) === key(m[1]!) || key(q.name) === key(m[1]!))) : undefined;
  };
  const first = pins[0]!;
  const mate = partner(first);
  if (!mate) return null;
  const rest = pins.filter((p) => p !== first && p !== mate);
  const other = partner(rest[0]!);
  if (other && other !== rest[1]) return null;
  return [[first, mate], rest];
}

/* ---------------------- protection, EMC, relays, couplers ---------------------- */

const FUSE = /\bfuses?\b|polyfuse|PPTC|resettable/i;
const THERMISTOR = /thermistor|\bNTC\b|\bPTC\b/i;
const VARISTOR = /varistor|\bMOV\b|\bVDR\b/i;
const BEAD = /\bbeads?\b/i;
const GDT = /gas[- ]discharge|\bGDT\b|surge arrester|spark gap/i;
const CHOKE = /common[- ]mode|\bCMC\b/i;
const RELAY = /\brelays?\b/i;
/** Relays without a coil (solid state, photo-MOSFET) and the ICs that drive relays. */
const NOT_A_COIL = /solid[- ]state|\bSSR\b|photo|optical|MOSFET|driver/i;

/** A ferrite bead across its wire: a block turned 45°, the leads ending at its sides (y = ±43 or x = ±43 on the axis). */
const BEAD_SHAPE = [35, -78, 78, -35, -35, 78, -78, 35];

type Lying = 'fuse' | 'resettable' | 'thermistor' | 'varistor' | 'bead';

/** What a two-pin part of its own (category other) is, by what its card says: a fuse, a thermistor, a varistor, a ferrite bead. */
function lyingKind(card: PartCard): Lying | null {
  if (card.category !== 'other' || card.pins.length !== 2) return null;
  const text = ownText(card);
  if (FUSE.test(text)) return /polyfuse|PPTC|\bPTC\b|resettable/i.test(text) ? 'resettable' : 'fuse';
  if (THERMISTOR.test(text)) return 'thermistor';
  if (VARISTOR.test(text)) return 'varistor';
  if (BEAD.test(text)) return 'bead';
  return null;
}

/**
 * A two-pin part of its own drawn lying, pin 1 left: a fuse (its body with the wire through it), a
 * resettable fuse, a thermistor or a varistor (a resistor's body crossed by the slanted line of
 * what makes it vary, with its mark: −θ an NTC, +θ a PTC, U a varistor), a ferrite bead on its wire.
 */
function lyingSymbol(card: PartCard, mirror: boolean): SymbolDef | null {
  const kind = lyingKind(card);
  if (!kind) return null;
  const prims: Prim[] = [];
  const L = lineTo(prims);
  if (kind === 'bead') {
    L(-200, 0, -43, 0);
    L(43, 0, 200, 0);
    prims.push({ t: 'poly', pts: [...BEAD_SHAPE], closed: true });
  } else {
    prims.push({ t: 'rect', x: -100, y: -40, w: 200, h: 80 });
    if (kind === 'fuse') L(-200, 0, 200, 0);
    else {
      L(-200, 0, -100, 0);
      L(100, 0, 200, 0);
      prims.push({ t: 'poly', pts: [-130, 70, -90, 70, 90, -70] });
      const text = ownText(card);
      const mark = kind === 'varistor' ? 'U' : kind === 'thermistor' ? (/\bPTC\b|positive temperature/i.test(text) ? '+θ' : /\bNTC\b|negative temperature/i.test(text) ? '−θ' : 'θ') : null;
      if (mark) prims.push({ t: 'text', x: -185, y: 95, text: mark });
    }
  }
  const [left, right] = mirror ? [card.pins[1]!, card.pins[0]!] : [card.pins[0]!, card.pins[1]!];
  return { kind: 'box', prims, pins: [pinAt(left, -200, 0, 'left'), pinAt(right, 200, 0, 'right')], bbox: { x: -200, y: -100, w: 400, h: 200 }, ...TEXT_ABOVE };
}

/**
 * A gas discharge tube, lying: two electrodes facing each other in its envelope, the dot of its gas
 * filling; a three-electrode tube's middle electrode goes to a pin at the bottom (its ground).
 */
function gdtSymbol(card: PartCard, mirror: boolean): SymbolDef | null {
  if (card.category !== 'other' || (card.pins.length !== 2 && card.pins.length !== 3) || !GDT.test(ownText(card))) return null;
  let mid: PartPin | undefined;
  if (card.pins.length === 3) {
    const names = card.pins.map((p) => p.name.trim());
    mid = card.pins.find((p) => /^(GND|G|PE|E|EARTH|COM|C|CENTER|CENTRE|M)$/i.test(p.name.trim())) ?? (names.sort().join() === '1,2,3' ? card.pins.find((p) => p.name.trim() === '2') : undefined);
    if (!mid) return null;
  }
  const ends = card.pins.filter((p) => p !== mid);
  const [left, right] = mirror ? [ends[1]!, ends[0]!] : [ends[0]!, ends[1]!];
  const prims: Prim[] = [{ t: 'circle', x: 0, y: 0, r: 100 }];
  const L = lineTo(prims);
  L(-200, 0, -35, 0);
  L(35, 0, 200, 0);
  const [top, bottom, dot] = mid ? [-50, 20, -70] : [-45, 45, 65];
  L(-35, top, -35, bottom);
  L(35, top, 35, bottom);
  prims.push({ t: 'poly', pts: [0, dot - 12, 12, dot, 0, dot + 12, -12, dot], closed: true, fill: true });
  const pins = [pinAt(left, -200, 0, 'left'), pinAt(right, 200, 0, 'right')];
  if (mid) {
    L(-40, 55, 40, 55);
    L(0, 55, 0, 200);
    pins.push(pinAt(mid, 0, 200, 'bottom'));
  }
  return { kind: 'box', prims, pins, bbox: { x: -200, y: -100, w: 400, h: mid ? 300 : 200 }, ...TEXT_ABOVE };
}

/** The windings of a common-mode choke, each [start, end]: pins named alike but for their number (1A and 1B, IN1 and OUT1); null when the names do not say. */
function chokeWindings(pins: PartPin[]): [PartPin, PartPin][] | null {
  const byNumber = new Map<string, PartPin[]>();
  for (const p of pins) {
    const n = p.name.replace(/\D/g, '');
    if (!n) return null;
    byNumber.set(n, [...(byNumber.get(n) ?? []), p]);
  }
  if (byNumber.size !== 2 || [...byNumber.values()].some((w) => w.length !== 2)) return null;
  return [...byNumber.entries()]
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, w]) => w.sort((a, b) => a.name.localeCompare(b.name)) as [PartPin, PartPin]);
}

/** A common-mode choke: its two windings one above the other on one ferrite core (dashed), turned towards it, their starts dotted on the left. */
function chokeSymbol(card: PartCard, mirror: boolean): SymbolDef | null {
  if ((card.category !== 'other' && card.category !== 'inductor') || card.pins.length !== 4 || !CHOKE.test(ownText(card))) return null;
  const windings = chokeWindings(card.pins);
  if (!windings) return null;
  const prims: Prim[] = [];
  const L = lineTo(prims);
  const pins: SymbolPin[] = [];
  windings.forEach(([start, end], i) => {
    const y = i ? 100 : -100;
    L(-300, y, -100, y);
    L(100, y, 300, y);
    prims.push({ t: 'path', d: `M-100,${y}` + ` a25,25 0 0 ${i} 50,0`.repeat(4) });
    const [l, r] = mirror ? [end, start] : [start, end];
    pins.push(pinAt(l, -300, y, 'left'), pinAt(r, 300, y, 'right'));
    const dy = i ? 135 : -135;
    prims.push({ t: 'poly', pts: [mirror ? 120 : -120, dy - 12, (mirror ? 120 : -120) + 12, dy, mirror ? 120 : -120, dy + 12, (mirror ? 120 : -120) - 12, dy], closed: true, fill: true });
  });
  for (const y of [-15, 15]) for (let x = -85; x < 85; x += 50) L(x, y, x + 20, y);
  return { kind: 'box', prims, pins, bbox: { x: -300, y: -150, w: 600, h: 300 }, refPos: { x: 0, y: -275, anchor: 'middle' }, valuePos: { x: 0, y: -190, anchor: 'middle' } };
}

type Contact = { pole: number; role: 'COM' | 'NO' | 'NC' };

/** Which contact of which pole a relay pin is: COM, NO, NC (numbered per pole: NO2), or IEC numbers (11 common, 12 break, 14 make; 21, 22, 24 …). */
function contactOf(p: PartPin): Contact | null {
  const n = p.name.trim().toUpperCase().replace(/[\s_.]/g, '');
  const m = /^(COM|COMMON|C|NO|NC)(\d?)$/.exec(n);
  if (m) {
    if (m[1] === 'NC' && p.type === 'nc') return null; // not connected, no contact
    return { pole: Number(m[2] || 1), role: m[1] === 'NO' ? 'NO' : m[1] === 'NC' ? 'NC' : 'COM' };
  }
  const iec = /^([1-9])([124])$/.exec(n);
  return iec ? { pole: Number(iec[1]), role: iec[2] === '1' ? 'COM' : iec[2] === '2' ? 'NC' : 'NO' } : null;
}

/**
 * A relay: its coil (a box, its leads on its long sides, top and bottom; the + end on top) and beside it each
 * pole's contacts (the common at the bottom, the blade resting on the normally closed contact,
 * the normally open one beside it, both at the top), joined to the coil by its armature (dashed).
 */
function relaySymbol(card: PartCard): SymbolDef | null {
  const text = ownText(card);
  if ((card.category !== 'other' && card.category !== 'ic') || !RELAY.test(text) || NOT_A_COIL.test(text)) return null;
  const coil = card.pins.filter((p) => /^(COIL\W?\w?|A1|A2|\+|-|−)$/i.test(p.name.trim()));
  const poles = new Map<number, Partial<Record<Contact['role'], PartPin[]>>>();
  for (const p of card.pins) {
    if (coil.includes(p)) continue;
    const c = contactOf(p);
    if (!c) return null;
    const pole = poles.get(c.pole) ?? {};
    pole[c.role] = [...(pole[c.role] ?? []), p];
    poles.set(c.pole, pole);
  }
  if (coil.length !== 2 || !poles.size || [...poles.values()].some((x) => !x.COM || (!x.NO && !x.NC))) return null;
  const plus = (p: PartPin) => /^(\+|COIL\W?\+|COIL\W?1|A1)$/i.test(p.name.trim());
  const [top, bottom] = plus(coil[1]!) && !plus(coil[0]!) ? [coil[1]!, coil[0]!] : [coil[0]!, coil[1]!];
  const prims: Prim[] = [{ t: 'rect', x: -100, y: -50, w: 200, h: 100 }];
  const L = lineTo(prims);
  L(0, -300, 0, -50);
  L(0, 50, 0, 300);
  if (top.name.includes('+')) {
    L(-50, -110, -20, -110);
    L(-35, -125, -35, -95);
  }
  const pins = [pinAt(top, 0, -300, 'top'), pinAt(bottom, 0, 300, 'bottom')];
  const sets = [...poles.entries()].sort(([a], [b]) => a - b).map(([, pole]) => pole);
  sets.forEach((pole, i) => {
    const x = 400 + i * 400;
    L(x, 300, x, 120);
    pins.push(...pole.COM!.map((p) => pinAt(p, x, 300, 'bottom')));
    for (const [role, s] of [['NC', -1], ['NO', 1]] as const) {
      const ps = pole[role];
      if (!ps) continue;
      L(x + s * 100, -300, x + s * 100, -100);
      L(x + s * 100, -100, x + s * 50, -100);
      pins.push(...ps.map((p) => pinAt(p, x + s * 100, -300, 'top')));
    }
    // the blade, resting on the normally closed contact (else open)
    if (pole.NC) L(x, 120, x - 50, -100);
    else L(x, 120, x - 40, -80);
  });
  const last = 400 + (sets.length - 1) * 400;
  for (let x = 115; x < last - 25; x += 60) L(x, 10, Math.min(x + 30, last - 25), 10);
  return { kind: 'box', prims, pins, bbox: { x: -100, y: -300, w: last + 300, h: 600 }, refPos: { x: -130, y: -15, anchor: 'end' }, valuePos: { x: -130, y: 70, anchor: 'end' } };
}

/** The head of an arrow at (x2, y2), pointing along (x1, y1) → (x2, y2). */
function head(prims: Prim[], x1: number, y1: number, x2: number, y2: number): void {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const [ux, uy] = [(x2 - x1) / len, (y2 - y1) / len];
  const [bx, by] = [x2 - 28 * ux, y2 - 28 * uy];
  prims.push({ t: 'poly', pts: [x2, y2, bx - 12 * uy, by + 12 * ux, bx + 12 * uy, by - 12 * ux].map(Math.round), closed: true, fill: true });
}

/**
 * An optocoupler in its package's box: the LED on the left (anode on top), the light's arrows
 * across to its phototransistor (collector on top, the base where it has one) or photo-triac on
 * the right. Known by its pins: A and K, then C and E (B) or MT1 and MT2; NC pins at the bottom.
 */
function optoSymbol(card: PartCard): SymbolDef | null {
  if (card.category !== 'ic' && card.category !== 'other') return null;
  const named = (re: RegExp) => card.pins.filter((p) => re.test(p.name.trim()));
  const [a, k] = [named(/^(A|AN|ANODE)$/i), named(/^(K|CATH|CATHODE|KATHODE)$/i)];
  const [c, e, b] = [named(/^(C|COL|COLLECTOR)$/i), named(/^(E|EM|EMITTER)$/i), named(/^(B|BASE)$/i)];
  const [t2, t1] = [named(/^(MT2|T2|A2)$/i), named(/^(MT1|T1|A1)$/i)];
  const nc = card.pins.filter((p) => p.type === 'nc' || /^N\.?C\.?$/i.test(p.name.trim()));
  const triac = !c.length && !e.length && !b.length && t1.length === 1 && t2.length === 1;
  const used = [...a, ...k, ...c, ...e, ...b, ...t1, ...t2, ...nc];
  if (a.length !== 1 || k.length !== 1 || used.length !== card.pins.length || new Set(used).size !== used.length) return null;
  if (!triac && (c.length !== 1 || e.length !== 1 || b.length > 1 || t1.length || t2.length)) return null;
  const prims: Prim[] = [{ t: 'rect', x: -300, y: -200, w: 600, h: 400, fill: true }];
  const L = lineTo(prims);
  // the LED, anode on top
  L(-500, -100, -150, -100);
  L(-150, -100, -150, -45);
  prims.push({ t: 'poly', pts: [-200, -45, -100, -45, -150, 45], closed: true, fill: true });
  L(-200, 45, -100, 45);
  L(-150, 45, -150, 100);
  L(-150, 100, -500, 100);
  for (const y of [-25, 25]) {
    L(-90, y, -40, y);
    head(prims, -90, y, -15, y);
  }
  const pins = [pinAt(a[0]!, -500, -100, 'left'), pinAt(k[0]!, -500, 100, 'left')];
  if (triac) {
    // two thyristors back to back between the main terminals
    L(500, -100, 150, -100);
    L(150, -100, 150, -40);
    L(80, -40, 220, -40);
    prims.push({ t: 'poly', pts: [90, -40, 150, -40, 120, 40], closed: true, fill: true }, { t: 'poly', pts: [150, 40, 210, 40, 180, -40], closed: true, fill: true });
    L(80, 40, 220, 40);
    L(150, 40, 150, 100);
    L(150, 100, 500, 100);
    pins.push(pinAt(t2[0]!, 500, -100, 'right'), pinAt(t1[0]!, 500, 100, 'right'));
  } else {
    // an NPN phototransistor: its base the bar the light falls on
    L(40, -80, 40, 80);
    L(40, -35, 120, -100);
    L(120, -100, 500, -100);
    L(40, 35, 120, 100);
    L(120, 100, 500, 100);
    head(prims, 40, 35, 112, 94);
    pins.push(pinAt(c[0]!, 500, -100, 'right'), pinAt(e[0]!, 500, 100, 'right'));
    if (b[0]) {
      L(500, 0, 40, 0);
      pins.push(pinAt(b[0], 500, 0, 'right'));
    }
  }
  if (nc.length) {
    L(0, 200, 0, 400);
    pins.push(...nc.map((p) => pinAt(p, 0, 400, 'bottom')));
  }
  return { kind: 'box', prims, pins, bbox: { x: -500, y: -200, w: 1000, h: nc.length ? 600 : 400 }, refPos: { x: 0, y: -310, anchor: 'middle' }, valuePos: { x: 0, y: -225, anchor: 'middle' } };
}

/**
 * The pairs of pins a part carries a supply through, for the power checks to follow it: a two-pin
 * resistor, inductor or diode, a fuse, thermistor or ferrite bead, each winding of a common-mode
 * choke.
 */
export function seriesPaths(card: PartCard): [string, string][] {
  const [a, b] = card.pins;
  const lying = lyingKind(card);
  if (a && b && card.pins.length === 2 && (['inductor', 'resistor', 'diode'].includes(card.category) || (lying && lying !== 'varistor'))) return [[a.number, b.number]];
  const choke = (card.category === 'other' || card.category === 'inductor') && card.pins.length === 4 && CHOKE.test(ownText(card)) ? chokeWindings(card.pins) : null;
  return choke ? choke.map(([x, y]) => [x.number, y.number]) : [];
}
