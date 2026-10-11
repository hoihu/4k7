/**
 * Deterministic engineering calculators exposed to the agent as the `calc` tool.
 * The model decides *what* to compute; arithmetic and standard-value snapping happen here.
 */
import { E_SERIES, eSeriesValues, formatQuantity, nearestInSeries, parseQuantity, type CalcCall, type ESeries, type ValueSeries } from '@tracewise/schema';

export function seriesValues(name: string): number[] {
  const s = eSeriesValues(name);
  if (!s) throw new CalcError(`Unknown series ${name}; use ${E_SERIES.join(', ')}.`);
  return s;
}

/** Nearest standard value; `mode` 'up' / 'down' rounds towards that side. */
export function nearestE(value: number, series = 'E96', mode: 'nearest' | 'up' | 'down' = 'nearest'): number {
  if (!(value > 0)) throw new CalcError('value must be > 0');
  seriesValues(series);
  return nearestInSeries(value, series.toUpperCase() as ESeries, mode);
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

/**
 * `design` is the design's value series (set_value_series): it replaces each calculator's own
 * default series for that kind of part; a `series` argument wins over both.
 */
export function runCalc(call: CalcCall, design: ValueSeries = {}): Record<string, string | number> {
  const a = call.args;
  const given = a.series !== undefined ? String(a.series).toUpperCase() : undefined;
  const pick = (kind: keyof ValueSeries, fallback: ESeries): string => given ?? design[kind] ?? fallback;
  switch (call.fn) {
    case 'divider': {
      const vout = num(a, 'vout', 'V');
      const vref = num(a, 'vref', 'V');
      if (!(vout > vref)) throw new CalcError('vout must be greater than vref');
      const series = pick('resistor', 'E96');
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
      const l = nearestE(lMin, pick('inductor', 'E6'), 'up');
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
      const r = nearestE((vs - vf) / i, pick('resistor', 'E24'), 'up');
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
        return { c: formatQuantity(nearestE(c, pick('capacitor', 'E12')), 'F'), c_exact: formatQuantity(c, 'F') };
      }
      if (has('c') && has('f')) {
        const r = 1 / (2 * Math.PI * num(a, 'c', 'F') * num(a, 'f', 'Hz'));
        return { r: formatQuantity(nearestE(r, pick('resistor', 'E96')), 'Ω'), r_exact: formatQuantity(r, 'Ω') };
      }
      throw new CalcError('rc needs two of r, c, f');
    }
    case 'nearest_e': {
      const v = num(a, 'value');
      const kind = a.kind === undefined ? undefined : String(a.kind);
      if (kind !== undefined && kind !== 'resistor' && kind !== 'capacitor' && kind !== 'inductor') throw new CalcError('kind must be resistor, capacitor or inductor');
      const s = kind ? pick(kind, 'E96') : (given ?? 'E96');
      const mode = a.round === 'up' || a.round === 'down' ? a.round : 'nearest';
      return { value: formatQuantity(nearestE(v, s, mode)), series: s };
    }
  }
}
