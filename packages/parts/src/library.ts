/**
 * Built-in seed library for M0. Generic passives plus a handful of common ICs whose
 * pinouts are well known. Every card is marked `builtin` and must be re-verified
 * through the datasheet ingest pipeline (M1) before production use.
 */
import type { PartCard, PartPin, Provenance } from '@tracewise/schema';

const builtin = (note?: string): Provenance => ({ source: 'builtin', note: note ?? 'M0 seed, verify against datasheet' });

const passive = (n: string, name = n): PartPin => ({ number: n, name, type: 'passive' });

export const GENERIC_PARTS: PartCard[] = [
  {
    id: 'generic:R',
    title: 'Resistor',
    description: 'Resistor',
    category: 'resistor',
    refPrefix: 'R',
    pins: [passive('1'), passive('2')],
    params: {
      resistance: { unit: 'Ω', required: true },
      tolerance: { description: 'e.g. 1%' },
      power: { unit: 'W' },
      package: { description: 'e.g. 0402, 0603, 0805' },
    },
    provenance: builtin('generic'),
  },
  {
    id: 'generic:C',
    title: 'Capacitor',
    description: 'Capacitor, non-polarized (ceramic)',
    category: 'capacitor',
    refPrefix: 'C',
    pins: [passive('1'), passive('2')],
    params: {
      capacitance: { unit: 'F', required: true },
      voltage: { unit: 'V', description: 'Rated voltage' },
      dielectric: { description: 'C0G, X5R, X7R' },
      package: {},
    },
    provenance: builtin('generic'),
    notes: ['Ceramic X5R/X7R lose capacitance with DC bias; rate voltage ≥ 1.5× (better 2×) the net voltage.'],
  },
  {
    id: 'generic:CP',
    title: 'Electrolytic cap',
    description: 'Capacitor, polarized (electrolytic / tantalum / polymer)',
    category: 'capacitor',
    refPrefix: 'C',
    pins: [passive('1', '+'), passive('2', '-')],
    params: {
      capacitance: { unit: 'F', required: true },
      voltage: { unit: 'V', required: true },
      package: {},
    },
    provenance: builtin('generic'),
    notes: ['Pin 1 is +. Connect + to the higher-voltage net.'],
  },
  {
    id: 'generic:L',
    title: 'Inductor',
    description: 'Inductor',
    category: 'inductor',
    refPrefix: 'L',
    pins: [passive('1'), passive('2')],
    params: {
      inductance: { unit: 'H', required: true },
      current: { unit: 'A', description: 'Saturation current' },
      package: {},
      mpn: {},
    },
    provenance: builtin('generic'),
  },
  {
    id: 'generic:D',
    title: 'Diode',
    description: 'Diode (rectifier, Schottky, TVS). Pin 1 = cathode K, pin 2 = anode A',
    category: 'diode',
    refPrefix: 'D',
    pins: [passive('1', 'K'), passive('2', 'A')],
    notes: [
      'Four diodes wired as a full bridge are drawn automatically as the classic 45° diamond (AC left/right, + top, − bottom). Just connect them; constrain arrangement "inline" to draw them flat.',
    ],
    params: {
      mpn: { description: 'e.g. B340A, 1N4148W, SMBJ5.0A' },
      vr: { unit: 'V', description: 'Reverse voltage rating' },
      current: { unit: 'A' },
      package: {},
    },
    provenance: builtin('generic'),
  },
  {
    id: 'generic:BRIDGE',
    title: 'Bridge rectifier',
    description: 'Bridge rectifier, single package (e.g. MB6S, DB107, GBU4J). Pins AC1, AC2, +, −',
    category: 'diode',
    refPrefix: 'D',
    pins: [
      { number: '1', name: '+', type: 'pwr_out', side: 'top' },
      { number: '2', name: 'AC1', type: 'passive', side: 'left' },
      { number: '3', name: 'AC2', type: 'passive', side: 'right' },
      { number: '4', name: '-', type: 'passive', side: 'bottom' },
    ],
    params: {
      mpn: { description: 'e.g. MB6S, DB107S, GBU4J' },
      vr: { unit: 'V', description: 'Repetitive reverse voltage' },
      current: { unit: 'A', description: 'Average forward current' },
      package: {},
    },
    provenance: builtin('generic; pin numbering differs per package, map to the real part before layout'),
    notes: ['Pin numbers are generic. Use the pin names +, -, AC1, AC2.'],
  },
  {
    id: 'generic:LED',
    title: 'LED',
    description: 'LED. Pin 1 = cathode K, pin 2 = anode A',
    category: 'led',
    refPrefix: 'D',
    pins: [passive('1', 'K'), passive('2', 'A')],
    params: {
      color: {},
      vf: { unit: 'V', description: 'Forward voltage' },
      current: { unit: 'A', description: 'Operating current' },
      package: {},
    },
    provenance: builtin('generic'),
  },
  {
    id: 'generic:NMOS',
    title: 'MOSFET',
    description: 'N-channel MOSFET, 3 pins (G, S, D)',
    category: 'transistor',
    refPrefix: 'Q',
    pins: [
      { number: '1', name: 'G', type: 'in', side: 'left' },
      { number: '2', name: 'S', type: 'passive', side: 'bottom' },
      { number: '3', name: 'D', type: 'passive', side: 'top' },
    ],
    params: { mpn: {}, vds: { unit: 'V' }, id: { unit: 'A' }, package: {} },
    provenance: builtin('generic'),
  },
  ...[2, 3, 4, 5, 6, 8, 10].map(
    (n): PartCard => ({
      id: `generic:CONN_1x${n}`,
      title: `Connector 1×${n}`,
      description: `Connector, 1 row, ${n} pins (header, terminal block)`,
      category: 'connector',
      refPrefix: 'J',
      pins: Array.from({ length: n }, (_, i) => ({
        number: String(i + 1),
        name: String(i + 1),
        type: 'passive' as const,
        side: 'right' as const,
      })),
      params: { mpn: {}, pitch: {}, package: {} },
      provenance: builtin('generic'),
      notes: ['Mark supply inputs with set_net(external: true, voltage).'],
    }),
  ),
];

export const IC_PARTS: PartCard[] = [
  {
    id: 'ti:TPS54331DR',
    mpn: 'TPS54331DR',
    manufacturer: 'Texas Instruments',
    description: 'Buck converter, 3.5–28 V in, 3 A, 570 kHz, SOIC-8, Vref 0.8 V',
    category: 'ic',
    refPrefix: 'U',
    package: 'SOIC-8',
    datasheet: 'https://www.ti.com/lit/ds/symlink/tps54331.pdf',
    pins: [
      { number: '1', name: 'BOOT', type: 'passive', side: 'right', description: '0.1 µF bootstrap cap to PH' },
      { number: '2', name: 'VIN', type: 'pwr_in', side: 'left', maxVoltage: 28 },
      { number: '3', name: 'EN', type: 'in', side: 'left', maxVoltage: 6, description: 'Float to enable (internal pull-up); UVLO divider optional' },
      { number: '4', name: 'SS', type: 'passive', side: 'left', description: 'Soft-start capacitor to GND' },
      { number: '5', name: 'VSNS', type: 'in', side: 'right', description: 'Feedback, Vref = 0.8 V' },
      { number: '6', name: 'COMP', type: 'passive', side: 'right', description: 'Compensation network to GND' },
      { number: '7', name: 'GND', type: 'pwr_in', side: 'bottom' },
      { number: '8', name: 'PH', type: 'pwr_out', side: 'right', description: 'Switch node' },
    ],
    params: {},
    requirements: [
      { kind: 'cap_between', pins: ['BOOT', 'PH'], value: '100nF', src: builtin('datasheet: BOOT pin description') },
      { kind: 'decouple', pin: 'VIN', min: '4.7uF', src: builtin('datasheet: input capacitor section') },
    ],
    provenance: builtin(),
    notes: [
      'PH is the switch node: connect to the inductor and to the catch diode cathode (asynchronous converter).',
      'Vout = 0.8 V × (1 + Rtop/Rbottom); use calc divider with vref 0.8.',
      'COMP needs a type-II compensation network (R + C in series to GND, optional small C to GND).',
      'PH is a switching node, not a power output; it counts as a driver for ERC.',
    ],
  },
  {
    id: 'ams:AMS1117-3.3',
    mpn: 'AMS1117-3.3',
    manufacturer: 'Advanced Monolithic Systems',
    description: 'LDO regulator, fixed 3.3 V, 1 A, SOT-223',
    category: 'ic',
    refPrefix: 'U',
    package: 'SOT-223',
    pins: [
      { number: '1', name: 'GND', type: 'pwr_in', side: 'bottom' },
      { number: '2', name: 'VOUT', type: 'pwr_out', side: 'right' },
      { number: '3', name: 'VIN', type: 'pwr_in', side: 'left', maxVoltage: 15 },
    ],
    params: {},
    requirements: [
      { kind: 'decouple', pin: 'VIN', min: '10uF', src: builtin('datasheet: input capacitor') },
      { kind: 'decouple', pin: 'VOUT', min: '10uF', src: builtin('datasheet: output capacitor, stability') },
    ],
    provenance: builtin(),
    notes: ['The tab is internally connected to VOUT.'],
  },
  {
    id: 'microchip:MCP1700T-3302E/TT',
    mpn: 'MCP1700T-3302E/TT',
    manufacturer: 'Microchip',
    description: 'LDO regulator, fixed 3.3 V, 250 mA, low Iq, SOT-23-3',
    category: 'ic',
    refPrefix: 'U',
    package: 'SOT-23-3',
    pins: [
      { number: '1', name: 'GND', type: 'pwr_in', side: 'bottom' },
      { number: '2', name: 'VOUT', type: 'pwr_out', side: 'right' },
      { number: '3', name: 'VIN', type: 'pwr_in', side: 'left', maxVoltage: 6 },
    ],
    params: {},
    requirements: [
      { kind: 'decouple', pin: 'VIN', min: '1uF', src: builtin() },
      { kind: 'decouple', pin: 'VOUT', min: '1uF', src: builtin() },
    ],
    provenance: builtin(),
  },
  {
    id: 'ti:NE555DR',
    mpn: 'NE555DR',
    manufacturer: 'Texas Instruments',
    description: '555 timer, SOIC-8, 4.5–16 V',
    category: 'ic',
    refPrefix: 'U',
    package: 'SOIC-8',
    pins: [
      { number: '1', name: 'GND', type: 'pwr_in', side: 'bottom' },
      { number: '2', name: 'TRIG', type: 'in', side: 'left' },
      { number: '3', name: 'OUT', type: 'out', side: 'right' },
      { number: '4', name: 'RESET', type: 'in', side: 'left' },
      { number: '5', name: 'CONT', type: 'passive', side: 'left' },
      { number: '6', name: 'THRES', type: 'in', side: 'left' },
      { number: '7', name: 'DISCH', type: 'oc', side: 'right' },
      { number: '8', name: 'VCC', type: 'pwr_in', side: 'top', maxVoltage: 18 },
    ],
    params: {},
    requirements: [{ kind: 'decouple', pin: 'VCC', min: '100nF', src: builtin() }],
    provenance: builtin(),
    notes: ['Tie RESET to VCC when unused. Decouple CONT with 10 nF to GND.'],
  },
  {
    id: 'ti:LM358DR',
    mpn: 'LM358DR',
    manufacturer: 'Texas Instruments',
    description: 'Dual op-amp, 3–32 V single supply, SOIC-8',
    category: 'ic',
    refPrefix: 'U',
    package: 'SOIC-8',
    pins: [
      { number: '1', name: 'OUTA', type: 'out', side: 'right' },
      { number: '2', name: 'INA-', type: 'in', side: 'left' },
      { number: '3', name: 'INA+', type: 'in', side: 'left' },
      { number: '4', name: 'GND', type: 'pwr_in', side: 'bottom' },
      { number: '5', name: 'INB+', type: 'in', side: 'left' },
      { number: '6', name: 'INB-', type: 'in', side: 'left' },
      { number: '7', name: 'OUTB', type: 'out', side: 'right' },
      { number: '8', name: 'V+', type: 'pwr_in', side: 'top', maxVoltage: 32 },
    ],
    params: {},
    requirements: [{ kind: 'decouple', pin: 'V+', min: '100nF', src: builtin() }],
    provenance: builtin(),
    notes: ['Unused op-amp: connect as follower with + input to a defined voltage.'],
  },
  {
    id: 'microchip:ATTINY85-20SU',
    mpn: 'ATTINY85-20SU',
    manufacturer: 'Microchip',
    description: '8-bit AVR MCU, 8 KB flash, 1.8–5.5 V, SOIC-8',
    category: 'ic',
    refPrefix: 'U',
    package: 'SOIC-8',
    pins: [
      { number: '1', name: 'PB5/RESET', type: 'bidir', side: 'left' },
      { number: '2', name: 'PB3', type: 'bidir', side: 'left' },
      { number: '3', name: 'PB4', type: 'bidir', side: 'left' },
      { number: '4', name: 'GND', type: 'pwr_in', side: 'bottom' },
      { number: '5', name: 'PB0', type: 'bidir', side: 'right' },
      { number: '6', name: 'PB1', type: 'bidir', side: 'right' },
      { number: '7', name: 'PB2', type: 'bidir', side: 'right' },
      { number: '8', name: 'VCC', type: 'pwr_in', side: 'top', maxVoltage: 6 },
    ],
    params: {},
    requirements: [
      { kind: 'decouple', pin: 'VCC', min: '100nF', src: builtin() },
      { kind: 'pull', pin: 'PB5/RESET', direction: 'up', note: '10k to VCC recommended', src: builtin() },
    ],
    provenance: builtin(),
  },
];

export const BUILTIN_PARTS: PartCard[] = [...GENERIC_PARTS, ...IC_PARTS];

const byId = new Map(BUILTIN_PARTS.map((p) => [p.id, p]));

/** Parts the user imported (e.g. from datasheets); registered at startup from local storage. */
/**
 * What a person calls a part, short: its title; else the part's own name, not a description of
 * it: a word of the description the part number starts with ("STM32F777 Arm Cortex-M7 MCU" →
 * STM32F777), a product name ("Raspberry Pi Pico - RP2040-based module" → Raspberry Pi Pico),
 * else the part number without its ordering suffix (ADIN2111BCPZ → ADIN2111).
 */
export function partTitle(card: PartCard): string {
  if (card.title) return card.title;
  const first = card.description.split(/\s[-–—]\s|[,.;(]|\swith\s/)[0]!.trim();
  if (!card.mpn) return first || card.id;
  const words = first.split(/\s+/).filter(Boolean);
  const own = words.find((w) => w.length >= 4 && card.mpn!.toUpperCase().startsWith(w.toUpperCase()));
  if (own) return own;
  if (words.length >= 2 && words.length <= 4 && words.every((w) => /^[A-Z]/.test(w))) return first;
  return mpnBase(card.mpn);
}

/** A part number without its ordering suffix (package, grade, reel): TPS54331DR → TPS54331, AMS1117-3.3 → AMS1117. */
export function mpnBase(mpn: string): string {
  const m = /^(.*?\d)(?:[A-Z]{1,5}\d?[A-Z]*|-\S+)(?:[-/]\S*)*$/.exec(mpn.trim());
  return m ? m[1]! : mpn.trim();
}

const userParts = new Map<string, PartCard>();

export function registerUserParts(cards: PartCard[]): void {
  for (const c of cards) userParts.set(c.id, c);
}

export function unregisterUserPart(id: string): void {
  userParts.delete(id);
}

export function listUserParts(): PartCard[] {
  return [...userParts.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Look up a library part: the user's own parts first, then the built-in ones. */
export function getBuiltinPart(id: string): PartCard | undefined {
  return userParts.get(id) ?? byId.get(id);
}

/** Simple ranked text search over the library (user parts and built-in parts). */
export function searchParts(text: string, extra: PartCard[] = []): PartCard[] {
  const known = new Set([...byId.keys(), ...userParts.keys()]);
  const all = [...extra.filter((p) => !known.has(p.id)), ...userParts.values(), ...BUILTIN_PARTS];
  const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return all;
  const scored = all
    .map((p) => {
      const hay = [p.id, p.mpn, p.title, p.manufacturer, p.description, p.category, p.package, ...(p.notes ?? [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (p.id.toLowerCase().includes(t) || p.mpn?.toLowerCase().includes(t) || p.title?.toLowerCase().includes(t)) score += 3;
        else if (hay.includes(t)) score += 1;
        else if (t.length > 3 && hay.includes(t.slice(0, -1))) score += 0.5; // plural "capacitors"
      }
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.p.id.localeCompare(b.p.id));
  return scored.map((x) => x.p);
}
