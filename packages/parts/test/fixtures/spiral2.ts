/**
 * spiral2 (October 2026, 110 × 150 mm, four layers, 2 boards at JLCPCB): the parts whose JLCPCB record is
 * in easyeda.ts, as the board had them, and how the house placed them (docs/design/assembly.md §6). The
 * board itself is not in the repository; this is what the golden needs of it.
 */
import type { PackageInfo, PartCard } from '@4k7/schema';
import * as eda from './easyeda.ts';

const card = (id: string, category: PartCard['category'], refPrefix: string, names: string[], packageInfo?: PackageInfo, pkg = packageInfo?.name): PartCard => ({
  id,
  mpn: id.split(':')[1],
  description: `spiral2 ${id}`,
  category,
  refPrefix,
  ...(pkg ? { package: pkg } : {}),
  pins: names.map((name, i) => ({ number: String(i + 1), name, type: 'passive' })),
  params: {},
  provenance: { source: 'user' },
  ...(packageInfo ? { packageInfo } : {}),
});

/** The WS2812B land: VDD (pin 1) top left, as ours has pin 1. */
const plcc4: PackageInfo = {
  name: 'PLCC4-5050',
  family: 'other',
  pins: 4,
  body_mm: [5, 5],
  pads: [
    { number: '1', x: -1.95, y: -1.65, w: 1.5, h: 0.9 },
    { number: '2', x: -1.95, y: 1.65, w: 1.5, h: 0.9 },
    { number: '3', x: 1.95, y: 1.65, w: 1.5, h: 0.9 },
    { number: '4', x: 1.95, y: -1.65, w: 1.5, h: 0.9 },
  ],
};

const dfn10: PackageInfo = { name: 'DFN-10L', family: 'DFN', pins: 10, pitch_mm: 0.5, body_mm: [3, 3], lead_length_mm: 0.4, lead_width_mm: 0.25, exposed_pad_mm: [1.7, 2.4] };

/** J2's contacts (number, name, x): the pins named by their USB-C contacts, A1 and B12 on one pad. */
const usbContacts: [string, string, number][] = [
  ['1', 'GND_A1', -3.2], ['3', 'VBUS_A4', -2.4], ['6', 'SBU2_B8', -1.75], ['5', 'CC1_A5', -1.25], ['7', 'DN2_B7', -0.75], ['8', 'DP1_A6', -0.25],
  ['9', 'DN1_A7', 0.25], ['10', 'DP2_B6', 0.75], ['11', 'SBU1_A8', 1.25], ['12', 'CC2_B5', 1.75], ['13', 'VBUS_A9', 2.4], ['15', 'GND_A12', 3.2],
];
const usbC: PackageInfo = {
  name: 'USB-C-16P',
  family: 'other',
  pins: 13,
  body_mm: [8.94, 7.3],
  pads: [
    ...usbContacts.map(([number, , x]) => ({ number, x, y: -3.67, w: Math.abs(x) > 2 ? 0.6 : 0.3, h: 1.14 })),
    ...[[-4.325, -3.1], [4.325, -3.1], [-4.325, 1.08], [4.325, 1.08]].map(([x, y]) => ({ number: '17', x: x!, y: y!, w: 1, h: 2, drill: 0.6, slot: [0.6, 1.7] as [number, number] })),
  ],
};

/** The imported part cards spiral2's components use (the electrolytics are generic:CP). */
export const spiral2Cards: PartCard[] = [
  card('xinglight:WS2812B', 'led', 'D', ['VDD', 'DOUT', 'VSS', 'DIN'], plcc4),
  // the two indicator LEDs number their pins the opposite way round
  card('kento:KT-0805G', 'led', 'D', ['A', 'K'], undefined, '0805'),
  card('nationstar:NCD0805R1', 'led', 'D', ['K', 'A'], undefined, '0805'),
  // our SOT-223 has the tab as pin 2, JLCPCB's as pin 4
  card('ams:AMS1117-3.3', 'ic', 'U', ['GND', 'VOUT', 'VIN'], undefined, 'SOT-223'),
  card('aos:AO4407A', 'transistor', 'Q', ['S', 'S', 'S', 'G', 'D', 'D', 'D', 'D'], undefined, 'SOIC-8'),
  card('onsemi:MMBT3906', 'transistor', 'Q', ['B', 'E', 'C'], undefined, 'SOT-23'),
  card('hynetek:HUSB238', 'ic', 'U', Array.from({ length: 11 }, (_, i) => `P${i + 1}`), dfn10),
  { ...card('korean-hroparts:TYPE-C-31-M-12', 'connector', 'J', [], usbC), pins: [...usbContacts.map(([number, name]) => ({ number, name, type: 'passive' as const })), { number: '17', name: 'SHELL', type: 'passive' }] },
];

export interface Spiral2Part {
  refdes: string;
  part: string;
  /** JLCPCB's part number (LCSC), whose EasyEDA record is `record`. */
  sku: keyof typeof eda;
  params?: Record<string, string>;
  /** The board's rotation (clockwise, as `place` takes it); the pick-and-place had 360° minus this before §6. */
  rot: number;
  /** What the pick-and-place says in the house's frame (counter-clockwise), as JLCPCB's engineers set it. */
  house: number;
  /** Where JLCPCB's footprint origin lies from the part's centre (mm, board axes, y down), where it is not the centre. */
  at?: [number, number];
}

/** One of each: spiral2 had 48 WS2812B, D3 stands for them. U4 and U5 have no record here and are left out. */
export const spiral2Parts: Spiral2Part[] = [
  { refdes: 'C1', part: 'generic:CP', sku: 'C72505', params: { capacitance: '22uF', voltage: '50V' }, rot: 0, house: 0 },
  { refdes: 'C11', part: 'generic:CP', sku: 'C3342', params: { capacitance: '220uF', voltage: '16V', package: 'CAP-6.3x7.7' }, rot: 0, house: 0 },
  // the indicator LEDs are not named in §6: by the cathode, KT-0805G's footprint lies turned, NCD0805R1's not
  { refdes: 'D1', part: 'kento:KT-0805G', sku: 'C2297', rot: 0, house: 180 },
  { refdes: 'D2', part: 'nationstar:NCD0805R1', sku: 'C84256', rot: 0, house: 0 },
  { refdes: 'D3', part: 'xinglight:WS2812B', sku: 'C2843785', rot: 0, house: 270 },
  { refdes: 'J2', part: 'korean-hroparts:TYPE-C-31-M-12', sku: 'C165948', rot: 0, house: 0, at: [0, -1.196] },
  { refdes: 'Q1', part: 'aos:AO4407A', sku: 'C16072', rot: 0, house: 270 },
  { refdes: 'Q2', part: 'onsemi:MMBT3906', sku: 'C2143', rot: 0, house: 270 },
  // 270° in the board's frame (counter-clockwise), 180° in the house's
  { refdes: 'U2', part: 'ams:AMS1117-3.3', sku: 'C6186', rot: 90, house: 180 },
  { refdes: 'U6', part: 'hynetek:HUSB238', sku: 'C7471904', rot: 0, house: 270 },
];
