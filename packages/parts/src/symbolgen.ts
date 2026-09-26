/**
 * Deterministic schematic symbol generator. Symbols are never drawn by the AI.
 *
 * Coordinates are integer mils, y down. Two kinds:
 *  - two-pin symbols (R, C, L, D, LED): drawn vertically around the origin, pin 1 at
 *    (0, -200) and pin 2 at (0, 200). `flip` mirrors them vertically (pin 1 at the bottom).
 *  - box symbols (ICs, connectors, transistors): body rectangle from (0, 0) to (w, h),
 *    pins sticking out 200 mils on each side.
 */
import type { PartCard, PartPin, PinSide, Prim, SymbolLayout } from '@tracewise/schema';

export const GRID = 100;
export const PIN_LEN = 200;
/** Approximate advance width of one character of pin/label text, in mils. */
export const CHAR_W = 50;

export interface SymbolPin {
  number: string;
  name: string;
  x: number;
  y: number;
  side: PinSide;
  showName: boolean;
  showNumber: boolean;
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
}

const TWO_PIN = new Set(['resistor', 'capacitor', 'inductor', 'diode', 'led']);

export function isTwoPin(card: PartCard): boolean {
  return TWO_PIN.has(card.category) && card.pins.length === 2;
}

export interface SymbolOptions {
  /** Pin numbers to put first (topmost / leftmost) on their side, e.g. the power path. */
  first?: string[];
  /** Swap left and right pins, e.g. for an output connector at the right edge facing the circuit. */
  mirror?: boolean;
}

export function symbolFor(card: PartCard, flip = false, opts: SymbolOptions = {}): SymbolDef {
  if (isTwoPin(card)) return twoPin(card, flip);
  if (card.category === 'diode' && card.pins.length === 4) return bridgeDiamond(card);
  return box(card, opts.first ?? [], opts.mirror ?? false);
}

/* ------------------------------- two-pin ---------------------------------- */

function twoPin(card: PartCard, flip: boolean): SymbolDef {
  const d = flip ? -1 : 1; // direction from pin 1 towards pin 2
  const Y = (y: number) => y * d;
  const prims: Prim[] = [];
  const lead = (a: number, b: number) => prims.push({ t: 'line', x1: 0, y1: Y(a), x2: 0, y2: Y(b) });

  switch (card.category) {
    case 'resistor':
      lead(-200, -100);
      lead(100, 200);
      prims.push({ t: 'rect', x: -40, y: -100, w: 80, h: 200, fill: true });
      break;
    case 'capacitor': {
      const polarized = card.id === 'generic:CP' || card.pins[0]?.name === '+';
      lead(-200, -25);
      lead(25, 200);
      prims.push({ t: 'line', x1: -80, y1: Y(-25), x2: 80, y2: Y(-25) });
      if (polarized) {
        prims.push({ t: 'path', d: `M-80,${Y(45)} Q0,${Y(10)} 80,${Y(45)}` });
        prims.push({ t: 'line', x1: -70, y1: Y(-75), x2: -30, y2: Y(-75) });
        prims.push({ t: 'line', x1: -50, y1: Y(-95), x2: -50, y2: Y(-55) });
      } else {
        prims.push({ t: 'line', x1: -80, y1: Y(25), x2: 80, y2: Y(25) });
      }
      break;
    }
    case 'inductor': {
      lead(-200, -100);
      lead(100, 200);
      const sweep = flip ? 0 : 1;
      const step = 50 * d;
      prims.push({
        t: 'path',
        d: `M0,${Y(-100)}` + ` a25,25 0 0 ${sweep} 0,${step}`.repeat(4),
      });
      break;
    }
    case 'diode':
    case 'led': {
      // pin 1 = cathode: the triangle points towards pin 1
      lead(-200, -50);
      lead(50, 200);
      prims.push({ t: 'line', x1: -60, y1: Y(-50), x2: 60, y2: Y(-50) });
      prims.push({ t: 'poly', pts: [-60, Y(50), 60, Y(50), 0, Y(-50)], closed: true, fill: true });
      if (card.category === 'led') {
        prims.push({ t: 'line', x1: 80, y1: Y(0), x2: 140, y2: Y(-50) });
        prims.push({ t: 'line', x1: 80, y1: Y(40), x2: 140, y2: Y(-10) });
      }
      break;
    }
  }

  const [p1, p2] = card.pins as [PartPin, PartPin];
  return {
    kind: 'two_pin',
    prims,
    pins: [
      { number: p1.number, name: p1.name, x: 0, y: Y(-200), side: flip ? 'bottom' : 'top', showName: false, showNumber: false },
      { number: p2.number, name: p2.name, x: 0, y: Y(200), side: flip ? 'top' : 'bottom', showName: false, showNumber: false },
    ],
    bbox: { x: -100, y: -200, w: 200, h: 400 },
    refPos: { x: 100, y: -15, anchor: 'start' },
    valuePos: { x: 100, y: 70, anchor: 'start' },
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

function slotsFor(card: PartCard, first: string[], mirror: boolean): Record<PinSide, Slot[]> {
  const flipSide = (s: PinSide): PinSide => (!mirror ? s : s === 'left' ? 'right' : s === 'right' ? 'left' : s);
  const out: Record<PinSide, Slot[]> = { left: [], right: [], top: [], bottom: [] };
  const layout = card.symbolLayout;
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
    // pins the layout forgot still get drawn, so that nothing becomes unconnectable
    for (const p of card.pins) if (!placed.has(p.number)) out[flipSide(pinSide(p))].push([p]);
    return out;
  }
  const ordered = [...card.pins.filter((p) => first.includes(p.number)), ...card.pins.filter((p) => !first.includes(p.number))];
  for (const p of ordered) out[flipSide(pinSide(p))].push([p]);
  return out;
}

function box(card: PartCard, first: string[], mirror: boolean): SymbolDef {
  const sides = slotsFor(card, first, mirror);
  const isConn = card.category === 'connector';
  const showNames = !isConn;
  const labelLen = (slots: Slot[]) => (showNames ? Math.max(0, ...slots.map((s) => (s ? s[0]!.name.length : 0))) : 0);

  const topPad = sides.top.length ? 200 : 100;
  const botPad = sides.bottom.length ? 200 : 100;
  const rows = Math.max(sides.left.length, sides.right.length, 1);
  const h = topPad + (rows - 1) * GRID + botPad;

  const tbLabel = Math.max(labelLen(sides.top), labelLen(sides.bottom));
  const tbPitch = Math.max(GRID, ceilGrid(tbLabel * CHAR_W + 60));
  const tbCount = Math.max(sides.top.length, sides.bottom.length);
  const wSides = ceilGrid((labelLen(sides.left) + labelLen(sides.right)) * CHAR_W + 160);
  const w = Math.max(isConn ? 200 : 400, wSides, (tbCount + 1) * tbPitch);

  const prims: Prim[] = [{ t: 'rect', x: 0, y: 0, w, h, fill: true }];
  const pins: SymbolPin[] = [];
  const add = (slot: Slot, side: PinSide, x: number, y: number, bx: number, by: number) => {
    if (!slot) return;
    prims.push({ t: 'line', x1: x, y1: y, x2: bx, y2: by });
    // stacked pins share the position; only the first shows its name (numbers would collide)
    slot.forEach((p, i) =>
      pins.push({ number: p.number, name: p.name, x, y, side, showName: showNames && i === 0, showNumber: slot.length === 1 }),
    );
  };

  sides.left.forEach((slot, i) => add(slot, 'left', -PIN_LEN, topPad + i * GRID, 0, topPad + i * GRID));
  sides.right.forEach((slot, i) => add(slot, 'right', w + PIN_LEN, topPad + i * GRID, w, topPad + i * GRID));
  const tbStart = (n: number) => ceilGrid((w - (n - 1) * tbPitch) / 2 - GRID / 2);
  sides.top.forEach((slot, i) => {
    const x = tbStart(sides.top.length) + i * tbPitch;
    add(slot, 'top', x, -PIN_LEN, x, 0);
  });
  sides.bottom.forEach((slot, i) => {
    const x = tbStart(sides.bottom.length) + i * tbPitch;
    add(slot, 'bottom', x, h + PIN_LEN, x, h);
  });

  const nameRight = mirror && !sides.right.length;
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

/**
 * Arrange a large IC the conventional way (as in the usual MCU library symbols): supplies on
 * top and grounds at the bottom (repeated names stacked), system pins at the top left, then
 * the ports PA, PB, PC… in groups on the left and right, balanced by height. NC pins stack
 * at the end of the right side.
 */
export function planSymbolLayout(pins: PartPin[]): SymbolLayout {
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
  const groups = [...ports.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, ps]) => ps.sort((a, b) => portNo(a) - portNo(b)));

  const left: (string[] | null)[] = system.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true })).map((p) => [p.number]);
  const right: (string[] | null)[] = [];
  const height = (side: (string[] | null)[]) => side.length;
  for (const g of groups) {
    // keep the letter order on each side; put each group where the side is shorter
    const target = height(left) <= height(right) ? left : right;
    if (target.length) target.push(null);
    target.push(...g.map((p) => [p.number]));
  }
  if (nc.length) {
    if (right.length) right.push(null);
    right.push(nc.map((p) => p.number));
  }
  return { left, right, top: stacks(supply), bottom: stacks(ground) };
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
  const prims: Prim[] = [{ t: 'poly', pts: [c, 0, S, c, c, S, 0, c], closed: true, fill: true }];
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
