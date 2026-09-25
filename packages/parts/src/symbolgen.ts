/**
 * Deterministic schematic symbol generator. Symbols are never drawn by the AI.
 *
 * Coordinates are integer mils, y down. Two kinds:
 *  - two-pin symbols (R, C, L, D, LED): drawn vertically around the origin, pin 1 at
 *    (0, -200) and pin 2 at (0, 200). `flip` mirrors them vertically (pin 1 at the bottom).
 *  - box symbols (ICs, connectors, transistors): body rectangle from (0, 0) to (w, h),
 *    pins sticking out 200 mils on each side.
 */
import type { PartCard, PartPin, PinSide, Prim } from '@tracewise/schema';

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

export function symbolFor(card: PartCard, flip = false): SymbolDef {
  return isTwoPin(card) ? twoPin(card, flip) : box(card);
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
    refPos: { x: 110, y: -15, anchor: 'start' },
    valuePos: { x: 110, y: 75, anchor: 'start' },
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

function box(card: PartCard): SymbolDef {
  const sides: Record<PinSide, PartPin[]> = { left: [], right: [], top: [], bottom: [] };
  for (const p of card.pins) sides[pinSide(p)].push(p);

  const isConn = card.category === 'connector';
  const showNames = !isConn;
  const labelLen = (ps: PartPin[]) => (showNames ? Math.max(0, ...ps.map((p) => p.name.length)) : 0);

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
  const add = (p: PartPin, side: PinSide, x: number, y: number, bx: number, by: number) => {
    prims.push({ t: 'line', x1: x, y1: y, x2: bx, y2: by });
    pins.push({ number: p.number, name: p.name, x, y, side, showName: showNames, showNumber: true });
  };

  sides.left.forEach((p, i) => add(p, 'left', -PIN_LEN, topPad + i * GRID, 0, topPad + i * GRID));
  sides.right.forEach((p, i) => add(p, 'right', w + PIN_LEN, topPad + i * GRID, w, topPad + i * GRID));
  const tbStart = (n: number) => ceilGrid((w - (n - 1) * tbPitch) / 2 - GRID / 2);
  sides.top.forEach((p, i) => {
    const x = tbStart(sides.top.length) + i * tbPitch;
    add(p, 'top', x, -PIN_LEN, x, 0);
  });
  sides.bottom.forEach((p, i) => {
    const x = tbStart(sides.bottom.length) + i * tbPitch;
    add(p, 'bottom', x, h + PIN_LEN, x, h);
  });

  return {
    kind: 'box',
    prims,
    pins,
    bbox: { x: -PIN_LEN, y: -PIN_LEN, w: w + 2 * PIN_LEN, h: h + 2 * PIN_LEN },
    refPos: { x: 0, y: -40, anchor: 'start' },
    valuePos: { x: w, y: -40, anchor: 'end' },
  };
}
