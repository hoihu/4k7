/**
 * Standard packages by name ("0603", "SOT-23", "SOIC-8", "HDR-1x4" …) as PackageInfo, so the
 * footprint and 3D generators treat library parts and datasheet imports the same way.
 * Dimensions are nominal (mm) from the usual JEDEC/EIA outlines.
 */
import { parseAs, type PackageDefaults, type PackageInfo, type PartCard } from '@tracewise/schema';

/** EIA chip sizes: length × width, terminal length, height. */
const CHIPS: Record<string, [number, number, number, number]> = {
  '0201': [0.6, 0.3, 0.15, 0.3],
  '0402': [1.0, 0.5, 0.25, 0.35],
  '0603': [1.6, 0.8, 0.35, 0.45],
  '0805': [2.0, 1.25, 0.45, 0.6],
  '1206': [3.2, 1.6, 0.5, 0.65],
  '1210': [3.2, 2.5, 0.5, 1.0],
  '1812': [4.5, 3.2, 0.6, 1.2],
  '2010': [5.0, 2.5, 0.6, 0.65],
  '2512': [6.3, 3.2, 0.6, 0.65],
};

/** Axial bodies (DIN resistor sizes) by lead pitch in inches: length, diameter, lead diameter. */
const AXIAL: Record<string, [number, number, number]> = {
  '0.3': [3.6, 1.6, 0.5], // DIN0204, 1/8 W
  '0.4': [6.3, 2.5, 0.6], // DIN0207, 1/4 W
  '0.5': [9.0, 3.2, 0.7], // DIN0309, 1/2 W
  '0.6': [9.9, 3.6, 0.8], // DIN0411, 1 W
  '0.8': [12.0, 4.5, 0.8], // DIN0414, 2 W
  '1.0': [17.0, 6.0, 0.8], // DIN0617, 2–3 W
};
/** Axial diode packages: pitch, length, diameter, lead diameter. */
const DIODES_AXIAL: Record<string, [number, number, number, number]> = {
  'DO-35': [7.62, 4.0, 1.9, 0.5],
  'DO-41': [10.16, 5.2, 2.7, 0.86],
  'DO-15': [12.7, 7.6, 3.6, 0.86],
  'DO-201AD': [15.24, 9.5, 5.3, 1.3],
};
const r2 = (v: number) => Math.round(v * 100) / 100;
const axial = (name: string, pitch: number, len: number, dia: number, lead: number): PackageInfo => ({ name, family: 'AXIAL', pins: 2, pitch_mm: r2(pitch), body_mm: [len, dia], lead_width_mm: lead, height_mm: dia });
/** Radial (both leads underneath): diameter, pitch, height. */
const radial = (name: string, dia: number, pitch: number, height: number, lead = dia >= 10 ? 0.8 : 0.6): PackageInfo => ({ name, family: 'RADIAL', pins: 2, pitch_mm: pitch, body_mm: [dia, dia], lead_width_mm: lead, height_mm: height });
/** Usual radial lead pitch for a can diameter. */
const radialPitch = (d: number) => (d <= 4 ? 1.5 : d <= 5 ? 2.0 : d <= 6.3 ? 2.5 : d <= 8 ? 3.5 : d <= 12.5 ? 5.0 : 7.5);

/** name → package; `pins` is the part's pin count (headers, bridges). */
export function standardPackage(name: string, pins = 2): PackageInfo | null {
  const thru = throughHole(name.trim());
  if (thru) return thru;
  const n = name.trim().toUpperCase().replace(/^(R|C|L|D|LED)_?(?=\d)/, '').replace(/_?(METRIC|IMPERIAL)$/, '');
  const chip = CHIPS[n.replace(/[^0-9]/g, '').slice(0, 4)];
  if (chip && /^\d{4}$/.test(n)) {
    const [l, w, t, h] = chip;
    return { name: n, family: 'CHIP', pins: 2, body_mm: [l, w], lead_length_mm: t, height_mm: h };
  }
  const hdr = /^(?:HDR|HEADER|PINHEADER)[-_ ]?1X(\d+)$/.exec(n) ?? (/^HDR$/.test(n) ? [n, String(pins)] : null);
  if (hdr) return { name: `HDR-1x${hdr[1]}`, family: 'HEADER', pins: Number(hdr[1]), pitch_mm: 2.54, height_mm: 8.5 };
  // "6x6mm", "IND6X6": the usual square power-inductor sizes, as IND-6X6
  const ind = /^(?:IND[-_ ]?)?(4|6|8|10|12)X\1(?:MM)?$/.exec(n);
  switch (ind ? `IND-${ind[1]}X${ind[1]}` : n) {
    case 'SOD-123':
    case 'SOD123':
      return { name: 'SOD-123', family: 'SOD', pins: 2, body_mm: [2.7, 1.6], span_mm: [3.7, 1.6], lead_length_mm: 0.55, lead_width_mm: 0.6, height_mm: 1.1 };
    case 'SOD-323':
    case 'SOD323':
      return { name: 'SOD-323', family: 'SOD', pins: 2, body_mm: [1.7, 1.25], span_mm: [2.5, 1.25], lead_length_mm: 0.3, lead_width_mm: 0.3, height_mm: 0.9 };
    case 'SMA':
    case 'DO-214AC':
      return { name: 'SMA', family: 'SOD', pins: 2, body_mm: [4.3, 2.6], span_mm: [5.2, 2.6], lead_length_mm: 1.0, lead_width_mm: 1.4, height_mm: 2.1 };
    case 'SMB':
    case 'DO-214AA':
      return { name: 'SMB', family: 'SOD', pins: 2, body_mm: [4.4, 3.6], span_mm: [5.4, 3.6], lead_length_mm: 1.0, lead_width_mm: 2.0, height_mm: 2.2 };
    case 'SOT-23':
    case 'SOT-23-3':
    case 'SOT23':
      return { name: 'SOT-23', family: 'SOT', pins: 3, pitch_mm: 0.95, body_mm: [2.9, 1.3], span_mm: [2.9, 2.4], lead_length_mm: 0.45, lead_width_mm: 0.4, height_mm: 1.1 };
    case 'SOT-23-5':
    case 'SOT-23-6':
      return { name: n, family: 'SOT', pins: Number(n.slice(-1)), pitch_mm: 0.95, body_mm: [2.9, 1.6], span_mm: [2.9, 2.8], lead_length_mm: 0.45, lead_width_mm: 0.4, height_mm: 1.1 };
    case 'SOT-223':
      return { name: 'SOT-223', family: 'SOT', pins: 4, pitch_mm: 2.3, body_mm: [6.5, 3.5], span_mm: [6.5, 7.0], lead_length_mm: 0.9, lead_width_mm: 0.7, height_mm: 1.7 };
    case 'SOIC-8':
    case 'SO-8':
      return { name: 'SOIC-8', family: 'SOIC', pins: 8, pitch_mm: 1.27, body_mm: [3.9, 4.9], span_mm: [6.0, 4.9], lead_length_mm: 0.7, lead_width_mm: 0.42, height_mm: 1.5 };
    case 'MBS':
    case 'MBS-4':
      return { name: 'MBS-4', family: 'SOIC', pins: 4, pitch_mm: 2.6, body_mm: [3.9, 4.7], span_mm: [6.6, 4.7], lead_length_mm: 0.8, lead_width_mm: 0.6, height_mm: 2.4 };
    case 'IND-4X4':
    case '4020':
      return { name: 'IND-4x4', family: 'CHIP', pins: 2, body_mm: [4.0, 4.0], lead_length_mm: 1.2, height_mm: 2.0 };
    case 'IND-6X6':
      return { name: 'IND-6x6', family: 'CHIP', pins: 2, body_mm: [6.0, 6.0], lead_length_mm: 1.6, height_mm: 3.0 };
    case 'IND-8X8':
      return { name: 'IND-8x8', family: 'CHIP', pins: 2, body_mm: [8.0, 8.0], lead_length_mm: 2.0, height_mm: 4.0 };
    case 'IND-10X10':
      return { name: 'IND-10x10', family: 'CHIP', pins: 2, body_mm: [10.0, 10.0], lead_length_mm: 2.5, height_mm: 4.5 };
    case 'IND-12X12':
      return { name: 'IND-12x12', family: 'CHIP', pins: 2, body_mm: [12.3, 12.3], lead_length_mm: 2.8, height_mm: 6.0 };
    case 'CAP-6.3X5.4':
    case 'CAP-6.3':
      return { name: 'CAP-6.3x5.4', family: 'CHIP', pins: 2, body_mm: [6.6, 6.6], lead_length_mm: 1.8, height_mm: 5.4 };
    case 'CAP-8X10':
      return { name: 'CAP-8x10', family: 'CHIP', pins: 2, body_mm: [8.3, 8.3], lead_length_mm: 2.2, height_mm: 10 };
    case 'CAP-10X10':
      return { name: 'CAP-10x10', family: 'CHIP', pins: 2, body_mm: [10.3, 10.3], lead_length_mm: 2.6, height_mm: 10.5 };
  }
  return null;
}

/**
 * Through-hole passives: AXIAL-0.4 (lead pitch in inches, DIN body), DO-41 and friends,
 * RADIAL-D8-P3.5 / RADIAL-D8 (can diameter, pitch, mm), LED-3MM / LED-5MM, and KiCad's names
 * (R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm, CP_Radial_D8.0mm_P3.50mm …).
 */
function throughHole(name: string): PackageInfo | null {
  const n = name.toUpperCase();
  const ax = /^AXIAL[-_ ]?(\d(?:\.\d+)?)(?:IN)?$/.exec(n);
  if (ax) {
    const key = Number(ax[1]).toFixed(1);
    const [len, dia, lead] = AXIAL[key] ?? [Number(ax[1]) * 25.4 - 4, Math.max(1.6, Number(ax[1]) * 6), 0.8];
    return axial(`AXIAL-${key}`, Number(ax[1]) * 25.4, len, dia, lead);
  }
  const kiAx = /AXIAL.*_L([\d.]+)MM_D([\d.]+)MM_P([\d.]+)MM/.exec(n);
  if (kiAx) return axial(name, Number(kiAx[3]), Number(kiAx[1]), Number(kiAx[2]), Number(kiAx[2]) >= 3.5 ? 0.8 : 0.6);
  const dio = Object.keys(DIODES_AXIAL).find((k) => n === k || n.startsWith(`D_${k}`) || n === k.replace('-', ''));
  if (dio) {
    const [p, len, dia, lead] = DIODES_AXIAL[dio]!;
    return axial(dio, p, len, dia, lead);
  }
  const rad = /^RADIAL[-_ ]?D([\d.]+)(?:[-_ ]?P([\d.]+))?(?:[-_ ]?H([\d.]+))?$/.exec(n);
  if (rad) {
    const d = Number(rad[1]);
    const p = rad[2] ? Number(rad[2]) : radialPitch(d);
    return radial(`RADIAL-D${d}-P${p}`, d, p, rad[3] ? Number(rad[3]) : r2(Math.max(5, d * 1.4)));
  }
  const kiRad = /RADIAL_D([\d.]+)MM(?:_H([\d.]+)MM)?_P([\d.]+)MM/.exec(n);
  if (kiRad) {
    const d = Number(kiRad[1]);
    return radial(name, d, Number(kiRad[3]), kiRad[2] ? Number(kiRad[2]) : r2(Math.max(5, d * 1.4)));
  }
  const led = /^LED[-_ ]?(3|5)(?:MM)?$/.exec(n) ?? /^LED_D(3|5)\.0MM/.exec(n);
  if (led) return led[1] === '3' ? radial('LED-3mm', 3, 2.54, 5.3, 0.5) : radial('LED-5mm', 5, 2.54, 8.6, 0.5);
  return null;
}

/** Package names to offer for a part (a menu): the usual SMD sizes first, then through-hole. */
export function packageOptions(card: PartCard): string[] {
  if (!card.id.startsWith('generic:')) return [];
  switch (card.id) {
    case 'generic:R':
      return ['0402', '0603', '0805', '1206', '2010', '2512', 'AXIAL-0.3', 'AXIAL-0.4', 'AXIAL-0.5', 'AXIAL-0.6', 'AXIAL-0.8', 'AXIAL-1.0'];
    case 'generic:C':
      return ['0402', '0603', '0805', '1206', '1210', '1812', 'RADIAL-D4-P2.5', 'RADIAL-D5-P5'];
    case 'generic:CP':
      return ['CAP-6.3x5.4', 'CAP-8x10', 'CAP-10x10', 'RADIAL-D5', 'RADIAL-D6.3', 'RADIAL-D8', 'RADIAL-D10', 'RADIAL-D12.5', 'RADIAL-D16'];
    case 'generic:L':
      return ['0603', '0805', '1206', 'IND-4x4', 'IND-6x6', 'IND-8x8', 'IND-10x10', 'IND-12x12', 'RADIAL-D8-P5', 'RADIAL-D10-P5', 'AXIAL-0.4', 'AXIAL-0.5'];
    case 'generic:D':
      return ['SOD-323', 'SOD-123', 'SMA', 'SMB', 'DO-35', 'DO-41', 'DO-15', 'DO-201AD'];
    case 'generic:LED':
      return ['0402', '0603', '0805', '1206', 'LED-3mm', 'LED-5mm'];
    default:
      return [];
  }
}

/** The default-package slot of a generic part, if it has one. */
function defaultSlot(card: PartCard): keyof Omit<PackageDefaults, 'autoSize'> | null {
  if (card.id === 'generic:CP') return 'electrolytic';
  if (!card.id.startsWith('generic:')) return null;
  switch (card.category) {
    case 'resistor':
      return 'resistor';
    case 'capacitor':
      return 'capacitor';
    case 'inductor':
      return 'inductor';
    case 'diode':
      return card.id === 'generic:D' ? 'diode' : null;
    case 'led':
      return 'led';
    default:
      return null;
  }
}

/** Size steps, smallest first, per kind of part (auto sizing only ever goes up these). */
const STEPS: Record<string, string[]> = {
  chip: ['0201', '0402', '0603', '0805', '1206', '1210', '1812', '2010', '2512'],
  ind: ['IND-4X4', 'IND-6X6', 'IND-8X8', 'IND-10X10', 'IND-12X12'],
  cap: ['CAP-6.3X5.4', 'CAP-8X10', 'CAP-10X10'],
  diode: ['SOD-323', 'SOD-123', 'SMA', 'SMB'],
};

/** The smallest package the value needs, with why ("≥ 10 µF"), or null. */
function sizeNeeded(card: PartCard, params: Record<string, string>): { min: string; why: string } | null {
  const num = (k: string, unit: string) => (params[k] ? parseAs(params[k]!, unit) : null);
  if (card.id === 'generic:R') {
    const w = num('power', 'W');
    if (w === null || w === undefined) return null;
    const min = w > 0.5 ? '2512' : w > 0.25 ? '2010' : w > 0.125 ? '1206' : w > 0.1 ? '0805' : null;
    return min ? { min, why: `${params.power} power` } : null;
  }
  if (card.id === 'generic:C') {
    const c = num('capacitance', 'F') ?? 0;
    const v = num('voltage', 'V') ?? 0;
    const byC = c >= 22e-6 ? '1206' : c >= 4.7e-6 ? '0805' : null;
    const byV = v > 50 ? '1206' : v > 25 ? '0805' : null;
    const min = [byC, byV].filter(Boolean).sort((a, b) => STEPS.chip!.indexOf(b!) - STEPS.chip!.indexOf(a!))[0];
    return min ? { min, why: min === byC ? `≥ ${c >= 22e-6 ? '22' : '4.7'} µF` : `${params.voltage} rating` } : null;
  }
  if (card.id === 'generic:CP') {
    const c = num('capacitance', 'F') ?? 0;
    const v = num('voltage', 'V') ?? 0;
    const cv = c * 1e6 * v; // µF·V: roughly the can volume
    const min = cv > 8000 ? 'CAP-10X10' : cv > 2500 ? 'CAP-8X10' : null;
    return min ? { min, why: `${params.capacitance} ${params.voltage}` } : null;
  }
  if (card.id === 'generic:L') {
    const a = num('current', 'A');
    if (!a) return null;
    const min = a > 8 ? 'IND-12X12' : a > 6 ? 'IND-10X10' : a > 4.5 ? 'IND-8X8' : a > 3 ? 'IND-6X6' : null;
    return min ? { min, why: `${params.current} current` } : null;
  }
  if (card.id === 'generic:D') {
    const a = num('current', 'A');
    if (!a) return null;
    const min = a > 2 ? 'SMB' : a > 1 ? 'SMA' : null;
    return min ? { min, why: `${params.current} current` } : null;
  }
  return null;
}

/** How a part's package was chosen: its own parameter, the design's default, sized up, or the library's. */
export interface PackageChoice {
  name: string;
  why: 'set' | 'default' | 'auto' | 'library';
  /** auto: what demanded it ("≥ 22 µF", "0.5W power"). */
  reason?: string;
}

export function packageChoice(card: PartCard, params: Record<string, string> = {}, defaults: PackageDefaults = {}): PackageChoice | null {
  if (params.package) return { name: params.package, why: 'set' };
  const slot = defaultSlot(card);
  const base = (slot && defaults[slot]) || card.package || defaultPackageName(card);
  if (!base) return null;
  const why: PackageChoice['why'] = slot && defaults[slot] ? 'default' : 'library';
  if (defaults.autoSize !== false) {
    const need = sizeNeeded(card, params);
    const steps = Object.values(STEPS).find((s) => s.includes(base.toUpperCase()));
    if (need && steps && steps.indexOf(need.min) > steps.indexOf(base.toUpperCase())) {
      const pretty = standardPackage(need.min, card.pins.length)?.name ?? need.min;
      return { name: pretty, why: 'auto', reason: need.why };
    }
  }
  return { name: base, why };
}

/** Package a part uses when nothing says otherwise. */
function defaultPackageName(card: PartCard): string | null {
  if (card.id === 'generic:CP') return 'CAP-6.3x5.4';
  if (card.id === 'generic:BRIDGE') return 'MBS-4';
  switch (card.category) {
    case 'resistor':
    case 'capacitor':
    case 'led':
      return '0603';
    case 'inductor':
      return 'IND-4x4';
    case 'diode':
      return 'SOD-123';
    case 'transistor':
      return 'SOT-23';
    case 'connector':
      return `HDR-1x${card.pins.length}`;
    default:
      return null;
  }
}

/**
 * The package a placed part is built with: extracted package data first, then the
 * component's "package" parameter, the card's package name, and a default per category.
 */
export function packageOf(card: PartCard, params: Record<string, string> = {}, defaults: PackageDefaults = {}): PackageInfo | null {
  if (card.packageInfo) return card.packageInfo;
  for (const name of [packageChoice(card, params, defaults)?.name, card.package, defaultPackageName(card)]) {
    if (!name) continue;
    const pkg = standardPackage(name, card.pins.length);
    if (pkg) return pkg;
  }
  return null;
}
