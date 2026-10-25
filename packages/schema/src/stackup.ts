/**
 * The board's layer build-up (stack-up) and the impedance rules of its nets (docs/design/impedance.md).
 * A track's impedance depends on its width, the dielectric between it and the plane it runs over,
 * the copper's thickness and the solder mask on it: the stack-up says what those are for the board
 * as ordered. Like a fab profile it is stored as a full copy (`board.stackup`), with where its
 * numbers come from; without one the board uses the default for its manufacturer and layer count.
 * Millimetres throughout.
 */
import type { CopperLayer } from './board.ts';
import type { FabProfile } from './fab.ts';

export interface StackupDielectric {
  /** Thickness, mm. */
  mm: number;
  /** Relative permittivity (εr, Dk) at the frequencies that matter (around 1 GHz). */
  er: number;
  /** What it is: "7628 prepreg", "core". */
  what?: string;
}

export interface Stackup {
  /** "jlcpcb/JLC04161H-7628", "generic/2l-1.6", or "<house>/<name>" of an imported one. */
  id: string;
  /** What the manufacturer calls it: "JLC04161H-7628". */
  name: string;
  /** Finished copper per copper layer, top to bottom (mm): 2 or 4 entries. */
  copper: number[];
  /** The dielectric between copper layer i and i + 1, top to bottom. */
  dielectric: StackupDielectric[];
  /** Solder mask: thickness over bare laminate and over copper (mm), and εr. Absent: not known (left out). */
  mask?: { overLaminate: number; overCopper: number; er: number };
  source?: { url: string; checked?: string };
  /** 'preset' ships with the app, read off a manufacturer's page; 'imported' was entered from a source; 'generic' is a typical FR-4 board, nobody's in particular. */
  origin: 'preset' | 'imported' | 'generic';
  notes?: string[];
}

const CHECKED = '2026-10-25';

/* --------------------------------- JLCPCB --------------------------------- */

const JLC_IMPEDANCE = 'https://jlcpcb.com/impedance';
const JLC_CAPABILITIES = 'https://jlcpcb.com/capabilities/pcb-capabilities';
/** JLCPCB's coating: 1.2 mil over the laminate, 0.6 mil over copper, εr 3.8. */
const JLC_MASK = { overLaminate: 0.0305, overCopper: 0.0152, er: 3.8 };

function jlc4(name: string, prepreg: StackupDielectric, core: number): Stackup {
  return {
    id: `jlcpcb/${name}`,
    name,
    copper: [0.035, 0.0152, 0.0152, 0.035],
    dielectric: [prepreg, { mm: core, er: 4.6, what: 'core' }, prepreg],
    mask: JLC_MASK,
    source: { url: JLC_IMPEDANCE, checked: CHECKED },
    origin: 'preset',
    notes: ['4 layers, 1.6 mm, 1 oz outer and 0.5 oz inner copper. Impedance control is ordered with this stack-up selected; JLCPCB holds ±10 %.'],
  };
}

/* ------------------------------- the presets ------------------------------ */

const PRESETS: Stackup[] = [
  jlc4('JLC04161H-7628', { mm: 0.2104, er: 4.4, what: '7628 prepreg' }, 1.065),
  jlc4('JLC04161H-3313', { mm: 0.0994, er: 4.1, what: '3313 prepreg' }, 1.265),
  jlc4('JLC04161H-2116', { mm: 0.1164, er: 4.16, what: '2116 prepreg' }, 1.265),
  jlc4('JLC04161H-1080', { mm: 0.0764, er: 3.91, what: '1080 prepreg' }, 1.265),
  {
    id: 'jlcpcb/2l-1.6',
    name: '2 layers, 1.6 mm FR-4',
    copper: [0.035, 0.035],
    dielectric: [{ mm: 1.53, er: 4.5, what: 'FR-4 core' }],
    mask: JLC_MASK,
    source: { url: JLC_CAPABILITIES, checked: CHECKED },
    origin: 'preset',
    notes: [
      'JLCPCB controls impedance from 4 layers only: on 2 layers the core is nominal (1.6 mm ±10 % board, εr 4.5), so a line comes out within about ±15 %.',
      'Over 1.5 mm of FR-4 a 50 Ω microstrip is about 2.8 mm wide: lines on 2 layers are coplanar (ground beside them on the same layer).',
    ],
  },
  {
    id: 'pcbway/4l-1.6',
    name: '4 layers, 1.6 mm, 1 oz',
    copper: [0.035, 0.035, 0.035, 0.035],
    dielectric: [
      { mm: 0.1855, er: 4.74, what: '7628 prepreg (RC 46 %)' },
      { mm: 1.03, er: 4.6, what: 'core' },
      { mm: 0.1855, er: 4.74, what: '7628 prepreg (RC 46 %)' },
    ],
    source: { url: 'https://www.pcbway.com/multi-layer-laminated-structure.html', checked: CHECKED },
    origin: 'preset',
    notes: [
      'Prepreg as laminated over inner layers with planes (70 % residual copper); with 50 % it is 0.1785 mm, with 30 % 0.1715 mm.',
      'PCBWay does not state its solder mask, so it is left out: a mask lowers a line by 1–3 Ω and a pair by 3–6 Ω.',
    ],
  },
  {
    id: 'generic/2l-1.6',
    name: 'generic 2 layers, 1.6 mm FR-4',
    copper: [0.035, 0.035],
    dielectric: [{ mm: 1.53, er: 4.5, what: 'FR-4 core' }],
    mask: JLC_MASK,
    origin: 'generic',
    notes: ['A typical FR-4 board, not a manufacturer\'s stack-up: get theirs (set_stackup) before relying on an impedance.'],
  },
  {
    id: 'generic/4l-1.6',
    name: 'generic 4 layers, 1.6 mm FR-4',
    copper: [0.035, 0.0175, 0.0175, 0.035],
    dielectric: [
      { mm: 0.2, er: 4.4, what: '7628 prepreg' },
      { mm: 1.1, er: 4.6, what: 'core' },
      { mm: 0.2, er: 4.4, what: '7628 prepreg' },
    ],
    mask: JLC_MASK,
    origin: 'generic',
    notes: ['A typical FR-4 board, not a manufacturer\'s stack-up: get theirs (set_stackup) before relying on an impedance.'],
  },
];

/** The stack-ups that ship with the app. */
export function stackupPresets(): Stackup[] {
  return PRESETS.map((s) => structuredClone(s));
}

/** A preset by id ("jlcpcb/JLC04161H-3313"), or by its name alone ("JLC04161H-3313"), any case. */
export function findStackupPreset(id: string): Stackup | undefined {
  const k = id.trim().toLowerCase();
  const hit = PRESETS.find((s) => s.id.toLowerCase() === k) ?? PRESETS.find((s) => s.name.toLowerCase() === k || s.id.toLowerCase().endsWith(`/${k}`));
  return hit ? structuredClone(hit) : undefined;
}

/**
 * The stack-up a board uses without one set: its manufacturer's standard build for its layer count
 * (JLCPCB's JLC04161H-7628 on 4 layers; 2 oz outer copper where the fab tier says so), else a
 * generic FR-4 board.
 */
export function defaultStackup(layers: 2 | 4, fab?: Pick<FabProfile, 'house' | 'id'>): Stackup {
  const house = fab?.house.toLowerCase();
  const id = house === 'jlcpcb' ? (layers === 2 ? 'jlcpcb/2l-1.6' : 'jlcpcb/JLC04161H-7628') : house === 'pcbway' && layers === 4 ? 'pcbway/4l-1.6' : `generic/${layers}l-1.6`;
  const s = findStackupPreset(id)!;
  if (fab && /2oz/i.test(fab.id)) {
    s.copper[0] = s.copper[s.copper.length - 1] = 0.07;
    s.notes = [...(s.notes ?? []), 'Outer copper 2 oz (0.07 mm), as the fab tier says.'];
  }
  return s;
}

/** The stack-up in effect: the one set, if it has the board's layer count, else the default. */
export function boardStackup(b: { layers: 2 | 4; stackup?: Stackup; fab?: FabProfile }): Stackup {
  return b.stackup && b.stackup.copper.length === b.layers ? b.stackup : defaultStackup(b.layers, b.fab);
}

/** The copper layers top to bottom for a layer count. */
export const COPPER_ORDER: Record<2 | 4, CopperLayer[]> = { 2: ['F.Cu', 'B.Cu'], 4: ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] };

const um = (mm: number) => `${Math.round(mm * 1000 * 10) / 10} µm`;

/** The stack-up in one line: "F.Cu 35 µm | 0.21 mm 7628 prepreg εr 4.4 | In1.Cu 15.2 µm | …; mask 15.2 µm εr 3.8". */
export function stackupText(s: Stackup): string {
  const layers = COPPER_ORDER[s.copper.length as 2 | 4] ?? s.copper.map((_, i) => `L${i + 1}`);
  const parts: string[] = [];
  s.copper.forEach((cu, i) => {
    parts.push(`${layers[i]} ${um(cu)}`);
    const d = s.dielectric[i];
    if (d) parts.push(`${d.mm} mm ${d.what ?? 'dielectric'} εr ${d.er}`);
  });
  const total = s.copper.reduce((a, b) => a + b, 0) + s.dielectric.reduce((a, d) => a + d.mm, 0);
  return `${parts.join(' | ')} (${Math.round(total * 100) / 100} mm)${s.mask ? `; mask ${um(s.mask.overCopper)} over copper, ${um(s.mask.overLaminate)} over laminate, εr ${s.mask.er}` : '; no solder mask data'}`;
}

/* ---------------------------- impedance rules ----------------------------- */

/** How far a line may stray from its target unless the rule says otherwise, %. */
export const IMPEDANCE_TOLERANCE = 10;

/** How a line is built: over its plane alone, or with ground copper beside it on its layer too. */
export type LineStyle = 'microstrip' | 'coplanar';

/** A net, or a differential pair of nets, routed at a set impedance (set_impedance). */
export interface ImpedanceRule {
  /** "Z1", "Z2" … */
  id: string;
  /** Net ids: one (single-ended), or a differential pair's two, positive first. */
  nets: string[];
  /** Ω: a single line's impedance, or the pair's differential impedance. */
  ohms: number;
  /** ± % (default IMPEDANCE_TOLERANCE). */
  tolerance?: number;
  /** Default: microstrip on 4 layers, coplanar on 2. */
  style?: LineStyle;
  /** Fixed instead of found: the track width, a pair's gap between its tracks, the gap to the ground beside a coplanar line (mm). */
  width?: number;
  gap?: number;
  side?: number;
  /** A pair: the most its two lengths may differ (mm). */
  skew?: number;
  /** The longest it may run (mm). */
  maxLength?: number;
  /** Other copper keeps at least this far from it (edge to edge, mm); default twice its width. */
  keep?: number;
  /** What it is: "USB 2.0", "2.4 GHz antenna feed". */
  label?: string;
}

/** A rule worked out for one layer of the board: the geometry that gives its impedance there. */
export interface ImpedanceLayer {
  layer: CopperLayer;
  /** The plane it runs over, and the dielectric between them. */
  over: CopperLayer;
  h: number;
  er: number;
  width: number;
  /** A pair: the gap between its tracks. */
  gap?: number;
  /** Coplanar: the gap to the ground copper beside it. */
  side?: number;
  /** What that geometry gives (Ω), and the delay (ps per mm). */
  ohms: number;
  delay: number;
  /** Microstrip: ground copper on its layer keeps this far from it, so it changes the impedance by under 2 %. */
  pourGap?: number;
}

/** A rule as the board works it out (BoardView.impedance). */
export interface ImpedanceView {
  id: string;
  nets: string[];
  ohms: number;
  tolerance: number;
  style: LineStyle;
  pair: boolean;
  /** The layers it can be built on, with their geometry. */
  layers: ImpedanceLayer[];
  /** The layers it cannot be built on, and why (no plane under it, a width the fab cannot make …). */
  unusable: { layer: CopperLayer; why: string }[];
  skew?: number;
  maxLength?: number;
  keep?: number;
  label?: string;
}
