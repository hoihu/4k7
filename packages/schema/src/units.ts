/**
 * Engineering value parsing and formatting ("4k7", "100nF", "2.2 µH", "25V", "1R5").
 */

const PREFIX: Record<string, number> = {
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  µ: 1e-6,
  μ: 1e-6,
  m: 1e-3,
  '': 1,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
};

const UNIT_ALIASES: Record<string, string> = {
  f: 'F',
  F: 'F',
  h: 'H',
  H: 'H',
  v: 'V',
  V: 'V',
  a: 'A',
  A: 'A',
  w: 'W',
  W: 'W',
  hz: 'Hz',
  Hz: 'Hz',
  ohm: 'Ω',
  ohms: 'Ω',
  Ω: 'Ω',
  r: 'Ω',
  R: 'Ω',
};

export interface Quantity {
  value: number;
  /** Normalised unit, or '' if none was given. */
  unit: string;
}

/**
 * Parse an engineering value. Returns null if the text is not a number with optional
 * SI prefix and unit. Supports RKM notation ("4k7" = 4.7k, "1R5" = 1.5 Ω, "2u2" = 2.2µ).
 */
export function parseQuantity(input: string): Quantity | null {
  const s = input.trim().replace(/\s+/g, '').replace(/,/g, '.');
  if (!s) return null;

  // RKM: digits, a prefix letter or R used as decimal point, digits, optional unit
  const rkm = /^(\d+)([pnuµμmkKMGR])(\d+)([a-zA-ZΩ]*)$/.exec(s);
  if (rkm) {
    const [, int, mid, frac, unitRaw] = rkm as unknown as [string, string, string, string, string];
    const mult = mid === 'R' ? 1 : PREFIX[mid];
    const unit = normaliseUnit(unitRaw) ?? (mid === 'R' ? 'Ω' : null);
    if (mult === undefined || unit === null) return null;
    return { value: Number(`${int}.${frac}`) * mult, unit: unit || (mid === 'R' ? 'Ω' : '') };
  }

  const m = /^([+-]?\d*\.?\d+(?:e[+-]?\d+)?)([pnuµμmkKMG]?)([a-zA-ZΩ]*)$/.exec(s);
  if (!m) return null;
  const [, num, prefix, unitRaw] = m as unknown as [string, string, string, string];
  let mult = PREFIX[prefix] ?? 1;
  let unit = normaliseUnit(unitRaw);
  // "10m" alone is milli; "1M" is mega; a lone "m" unit is not supported
  if (unit === null) {
    // e.g. "10mA" parsed as prefix m + unit A already; anything else unknown
    return null;
  }
  // "100R" → 100 Ω handled by alias; "4.7" → unitless
  if (prefix === '' && unitRaw === '') mult = 1;
  return { value: Number(num) * mult, unit };
}

function normaliseUnit(u: string): string | null {
  if (u === '') return '';
  return UNIT_ALIASES[u] ?? UNIT_ALIASES[u.toLowerCase()] ?? null;
}

/** Parse and require a specific unit (unitless input is accepted as that unit). */
export function parseAs(input: string | undefined, unit: string): number | null {
  if (input === undefined) return null;
  const q = parseQuantity(input);
  if (!q) return null;
  if (q.unit !== '' && q.unit !== unit) return null;
  return q.value;
}

const ENG: [number, string][] = [
  [1e9, 'G'],
  [1e6, 'M'],
  [1e3, 'k'],
  [1, ''],
  [1e-3, 'm'],
  [1e-6, 'µ'],
  [1e-9, 'n'],
  [1e-12, 'p'],
];

/** Format with SI prefix and up to 3 significant digits: 0.0001 F → "100µF". */
export function formatQuantity(value: number, unit = ''): string {
  if (value === 0) return `0${unit}`;
  const abs = Math.abs(value);
  for (const [mult, p] of ENG) {
    if (abs >= mult * 0.9995) {
      const v = value / mult;
      return `${trimNum(v)}${p}${unit}`;
    }
  }
  return `${trimNum(value / 1e-12)}p${unit}`;
}

function trimNum(v: number): string {
  const r = Number(v.toPrecision(3));
  return String(r);
}

/** Relative comparison for engineering values. */
export function approxEqual(a: number, b: number, rel = 1e-6): boolean {
  return Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b));
}

/* ------------------------- standard values (IEC 60063) ------------------------- */

export const E_SERIES = ['E3', 'E6', 'E12', 'E24', 'E48', 'E96', 'E192'] as const;
export type ESeries = (typeof E_SERIES)[number];

const E24 = [10, 11, 12, 13, 15, 16, 18, 20, 22, 24, 27, 30, 33, 36, 39, 43, 47, 51, 56, 62, 68, 75, 82, 91];
const E192 = [
  100, 101, 102, 104, 105, 106, 107, 109, 110, 111, 113, 114, 115, 117, 118, 120, 121, 123, 124, 126, 127, 129, 130, 132, 133, 135, 137, 138,
  140, 142, 143, 145, 147, 149, 150, 152, 154, 156, 158, 160, 162, 164, 165, 167, 169, 172, 174, 176, 178, 180, 182, 184, 187, 189, 191, 193,
  196, 198, 200, 203, 205, 208, 210, 213, 215, 218, 221, 223, 226, 229, 232, 234, 237, 240, 243, 246, 249, 252, 255, 258, 261, 264, 267, 271,
  274, 277, 280, 284, 287, 291, 294, 298, 301, 305, 309, 312, 316, 320, 324, 328, 332, 336, 340, 344, 348, 352, 357, 361, 365, 370, 374, 379,
  383, 388, 392, 397, 402, 407, 412, 417, 422, 427, 432, 437, 442, 448, 453, 459, 464, 470, 475, 481, 487, 493, 499, 505, 511, 517, 523, 530,
  536, 542, 549, 556, 562, 569, 576, 583, 590, 597, 604, 612, 619, 626, 634, 642, 649, 657, 665, 673, 681, 690, 698, 706, 715, 723, 732, 741,
  750, 759, 768, 777, 787, 796, 806, 816, 825, 835, 845, 856, 866, 876, 887, 898, 909, 920, 931, 942, 953, 965, 976, 988,
];
const every = (s: number[], n: number) => s.filter((_, i) => i % n === 0);
/** Mantissas in [1, 10) per series. E3–E24 have their own (historic) values; E48–E192 are one table thinned out. */
const MANTISSAS: Record<ESeries, number[]> = {
  E3: every(E24, 8).map((v) => v / 10),
  E6: every(E24, 4).map((v) => v / 10),
  E12: every(E24, 2).map((v) => v / 10),
  E24: E24.map((v) => v / 10),
  E48: every(E192, 4).map((v) => v / 100),
  E96: every(E192, 2).map((v) => v / 100),
  E192: E192.map((v) => v / 100),
};

/** The series' mantissas (1.0 … 9.x), or null for an unknown name ("e12" is fine). */
export function eSeriesValues(name: string): number[] | null {
  return MANTISSAS[name.toUpperCase() as ESeries] ?? null;
}

const sig = (v: number) => Number(v.toPrecision(6));

/** Nearest value of the series; 'up' / 'down' round towards that side. */
export function nearestInSeries(value: number, series: ESeries, mode: 'nearest' | 'up' | 'down' = 'nearest'): number {
  const decade = Math.floor(Math.log10(value));
  const candidates: number[] = [];
  for (const d of [decade - 1, decade, decade + 1]) for (const m of MANTISSAS[series]) candidates.push(sig(m * 10 ** d));
  const eps = value * 1e-9;
  const pool = mode === 'up' ? candidates.filter((c) => c >= value - eps) : mode === 'down' ? candidates.filter((c) => c <= value + eps) : candidates;
  return pool.reduce((best, c) => (Math.abs(Math.log(c / value)) < Math.abs(Math.log(best / value)) ? c : best));
}

/** Whether the value is one of the series' standard values (any decade). */
export function inSeries(value: number, series: ESeries): boolean {
  return value > 0 && approxEqual(nearestInSeries(value, series), value, 1e-4);
}
