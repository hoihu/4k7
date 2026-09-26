/**
 * Standard packages by name ("0603", "SOT-23", "SOIC-8", "HDR-1x4" …) as PackageInfo, so the
 * footprint and 3D generators treat library parts and datasheet imports the same way.
 * Dimensions are nominal (mm) from the usual JEDEC/EIA outlines.
 */
import type { PackageInfo, PartCard } from '@tracewise/schema';

/** EIA chip sizes: length × width, terminal length, height. */
const CHIPS: Record<string, [number, number, number, number]> = {
  '0201': [0.6, 0.3, 0.15, 0.3],
  '0402': [1.0, 0.5, 0.25, 0.35],
  '0603': [1.6, 0.8, 0.35, 0.45],
  '0805': [2.0, 1.25, 0.45, 0.6],
  '1206': [3.2, 1.6, 0.5, 0.65],
  '1210': [3.2, 2.5, 0.5, 1.0],
  '1812': [4.5, 3.2, 0.6, 1.2],
  '2512': [6.3, 3.2, 0.6, 0.65],
};

/** name → package; `pins` is the part's pin count (headers, bridges). */
export function standardPackage(name: string, pins = 2): PackageInfo | null {
  const n = name.trim().toUpperCase().replace(/^(R|C|L|D|LED)_?(?=\d)/, '').replace(/_?(METRIC|IMPERIAL)$/, '');
  const chip = CHIPS[n.replace(/[^0-9]/g, '').slice(0, 4)];
  if (chip && /^\d{4}$/.test(n)) {
    const [l, w, t, h] = chip;
    return { name: n, family: 'CHIP', pins: 2, body_mm: [l, w], lead_length_mm: t, height_mm: h };
  }
  const hdr = /^(?:HDR|HEADER|PINHEADER)[-_ ]?1X(\d+)$/.exec(n) ?? (/^HDR$/.test(n) ? [n, String(pins)] : null);
  if (hdr) return { name: `HDR-1x${hdr[1]}`, family: 'HEADER', pins: Number(hdr[1]), pitch_mm: 2.54, height_mm: 8.5 };
  switch (n) {
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
    case 'CAP-6.3X5.4':
    case 'CAP-6.3':
      return { name: 'CAP-6.3x5.4', family: 'CHIP', pins: 2, body_mm: [6.6, 6.6], lead_length_mm: 1.8, height_mm: 5.4 };
    case 'CAP-8X10':
      return { name: 'CAP-8x10', family: 'CHIP', pins: 2, body_mm: [8.3, 8.3], lead_length_mm: 2.2, height_mm: 10 };
  }
  return null;
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
export function packageOf(card: PartCard, params: Record<string, string> = {}): PackageInfo | null {
  if (card.packageInfo) return card.packageInfo;
  for (const name of [params.package, card.package, defaultPackageName(card)]) {
    if (!name) continue;
    const pkg = standardPackage(name, card.pins.length);
    if (pkg) return pkg;
  }
  return null;
}
