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
