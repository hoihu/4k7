/**
 * Deterministic engineering calculators exposed to the agent as the `calc` tool.
 * The model decides *what* to compute; arithmetic and standard-value snapping happen here.
 */
import { formatQuantity, parseQuantity, type CalcCall } from '@tracewise/schema';

const E6 = [1.0, 1.5, 2.2, 3.3, 4.7, 6.8];
const E12 = [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];
const E24 = [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1];
const E96 = [
  1.0, 1.02, 1.05, 1.07, 1.1, 1.13, 1.15, 1.18, 1.21, 1.24, 1.27, 1.3, 1.33, 1.37, 1.4, 1.43, 1.47, 1.5, 1.54, 1.58, 1.62, 1.65, 1.69, 1.74,
  1.78, 1.82, 1.87, 1.91, 1.96, 2.0, 2.05, 2.1, 2.15, 2.21, 2.26, 2.32, 2.37, 2.43, 2.49, 2.55, 2.61, 2.67, 2.74, 2.8, 2.87, 2.94, 3.01, 3.09,
  3.16, 3.24, 3.32, 3.4, 3.48, 3.57, 3.65, 3.74, 3.83, 3.92, 4.02, 4.12, 4.22, 4.32, 4.42, 4.53, 4.64, 4.75, 4.87, 4.99, 5.11, 5.23, 5.36, 5.49,
  5.62, 5.76, 5.9, 6.04, 6.19, 6.34, 6.49, 6.65, 6.81, 6.98, 7.15, 7.32, 7.5, 7.68, 7.87, 8.06, 8.25, 8.45, 8.66, 8.87, 9.09, 9.31, 9.53, 9.76,
];
const SERIES: Record<string, number[]> = { E6, E12, E24, E96 };

export function seriesValues(name: string): number[] {
  const s = SERIES[name.toUpperCase()];
  if (!s) throw new CalcError(`Unknown series ${name}; use E6, E12, E24 or E96.`);
  return s;
}

/** Nearest standard value; `mode` 'up' / 'down' rounds towards that side. */
export function nearestE(value: number, series = 'E96', mode: 'nearest' | 'up' | 'down' = 'nearest'): number {
  if (!(value > 0)) throw new CalcError('value must be > 0');
  const s = seriesValues(series);
  const decade = Math.floor(Math.log10(value));
  const candidates: number[] = [];
  for (const d of [decade - 1, decade, decade + 1]) for (const m of s) candidates.push(round(m * 10 ** d));
  const eps = value * 1e-9;
  const pool =
    mode === 'up' ? candidates.filter((c) => c >= value - eps) : mode === 'down' ? candidates.filter((c) => c <= value + eps) : candidates;
  return pool.reduce((best, c) => (Math.abs(Math.log(c / value)) < Math.abs(Math.log(best / value)) ? c : best));
}

const round = (v: number) => Number(v.toPrecision(6));

export class CalcError extends Error {}

function num(args: CalcCall['args'], key: string, unit?: string, fallback?: number): number {
  const raw = args[key];
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    throw new CalcError(`missing argument "${key}"`);
  }
  if (typeof raw === 'number') return raw;
  const q = parseQuantity(raw);
  if (!q || (unit && q.unit !== '' && q.unit !== unit)) throw new CalcError(`argument "${key}" = "${raw}" is not a number${unit ? ` in ${unit}` : ''}`);
  return q.value;
}

export function runCalc(call: CalcCall): Record<string, string | number> {
  const a = call.args;
  switch (call.fn) {
    case 'divider': {
      const vout = num(a, 'vout', 'V');
      const vref = num(a, 'vref', 'V');
      if (!(vout > vref)) throw new CalcError('vout must be greater than vref');
      const series = String(a.series ?? 'E96');
      const ratio = vout / vref - 1;
      const fixedBottom = a.r_bottom !== undefined ? num(a, 'r_bottom', 'Ω') : undefined;
      const bottoms = fixedBottom ? [fixedBottom] : seriesValues(series).map((m) => round(m * 1e4)); // 10k–97.6k decade
      let best = { rt: 0, rb: 0, err: Infinity };
      for (const rb of bottoms) {
        const rt = nearestE(rb * ratio, series);
        const err = Math.abs(vref * (1 + rt / rb) - vout) / vout;
        if (err < best.err - 1e-12 || (Math.abs(err - best.err) < 1e-12 && Math.abs(Math.log(rb / 1e4)) < Math.abs(Math.log(best.rb / 1e4)))) {
          best = { rt, rb, err };
        }
      }
      const actual = vref * (1 + best.rt / best.rb);
      return {
        r_top: formatQuantity(best.rt),
        r_bottom: formatQuantity(best.rb),
        vout_actual: Number(actual.toFixed(4)),
        error_pct: Number((best.err * 100).toFixed(3)),
        series,
        note: 'Vout = Vref × (1 + Rtop/Rbottom); Rtop between Vout and FB, Rbottom between FB and GND.',
      };
    }
    case 'buck': {
      const vin = num(a, 'vin', 'V');
      const vout = num(a, 'vout', 'V');
      const iout = num(a, 'iout', 'A');
      const fsw = num(a, 'fsw', 'Hz');
      const k = num(a, 'ripple_ratio', undefined, 0.3);
      if (!(vin > vout)) throw new CalcError('vin must be greater than vout');
      const duty = vout / vin;
      const lMin = ((vin - vout) * duty) / (fsw * k * iout);
      const l = nearestE(lMin, 'E6', 'up');
      const ripple = ((vin - vout) * duty) / (fsw * l);
      return {
        duty: Number(duty.toFixed(3)),
        l_min: formatQuantity(lMin, 'H'),
        l_suggested: formatQuantity(l, 'H'),
        ripple_current: formatQuantity(ripple, 'A'),
        i_peak: formatQuantity(iout + ripple / 2, 'A'),
        inductor_sat_current_min: formatQuantity((iout + ripple / 2) * 1.2, 'A'),
        note: 'Choose an inductor with saturation current ≥ inductor_sat_current_min.',
      };
    }
    case 'led_resistor': {
      const vs = num(a, 'vsupply', 'V');
      const vf = num(a, 'vf', 'V');
      const i = num(a, 'i', 'A');
      if (!(vs > vf)) throw new CalcError('vsupply must exceed vf');
      const r = nearestE((vs - vf) / i, 'E24', 'up');
      const iActual = (vs - vf) / r;
      return {
        r: formatQuantity(r, 'Ω'),
        i_actual: formatQuantity(iActual, 'A'),
        power: formatQuantity(iActual * iActual * r, 'W'),
      };
    }
    case 'rc': {
      const has = (k: string) => a[k] !== undefined;
      if (has('r') && has('c')) {
        const f = 1 / (2 * Math.PI * num(a, 'r', 'Ω') * num(a, 'c', 'F'));
        return { f: formatQuantity(f, 'Hz') };
      }
      if (has('r') && has('f')) {
        const c = 1 / (2 * Math.PI * num(a, 'r', 'Ω') * num(a, 'f', 'Hz'));
        return { c: formatQuantity(nearestE(c, 'E12'), 'F'), c_exact: formatQuantity(c, 'F') };
      }
      if (has('c') && has('f')) {
        const r = 1 / (2 * Math.PI * num(a, 'c', 'F') * num(a, 'f', 'Hz'));
        return { r: formatQuantity(nearestE(r, 'E96'), 'Ω'), r_exact: formatQuantity(r, 'Ω') };
      }
      throw new CalcError('rc needs two of r, c, f');
    }
    case 'nearest_e': {
      const v = num(a, 'value');
      const s = String(a.series ?? 'E96');
      return { value: formatQuantity(nearestE(v, s)), series: s };
    }
  }
}
