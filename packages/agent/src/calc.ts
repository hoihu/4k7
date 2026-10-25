/**
 * Deterministic engineering calculators exposed to the agent as the `calc` tool.
 * The model decides *what* to compute; arithmetic and standard-value snapping happen here.
 */
import { E_SERIES, eSeriesValues, formatQuantity, nearestInSeries, parseQuantity, type CalcCall, type DesignSummary, type ESeries, type ValueSeries } from '@4k7/schema';
import { analyseLine, gapForLine, widthForLine, type LineSection } from '@4k7/kernel';

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

/** The board's stack-up as the design summary gives it (calc impedance works on it by default). */
export type CalcStackup = NonNullable<DesignSummary['stackup']>;

/**
 * `design` is the design's value series (set_value_series): it replaces each calculator's own
 * default series for that kind of part; a `series` argument wins over both. `stackup`: the board's,
 * what impedance works on unless given h and er.
 */
export function runCalc(call: CalcCall, design: ValueSeries = {}, stackup?: CalcStackup): Record<string, string | number> {
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
    case 'impedance':
      return impedance(a, stackup);
  }
}

const mm = (v: number) => Number(v.toFixed(4));

/**
 * A track's impedance with the field solver: the width that gives `ohms`, or what `width` gives;
 * with `gap` a differential pair (`diff` with `width` and `ohms`: the gap that gives it), with
 * `coplanar_gap` ground beside it on its layer. On the board's stack-up (the layer over the plane
 * next to it, with its solder mask) unless h and er are given.
 */
function impedance(a: CalcCall['args'], stackup?: CalcStackup): Record<string, string | number> {
  const has = (k: string) => a[k] !== undefined;
  const len = (k: string) => {
    const v = num(a, k);
    if (!(v > 0)) throw new CalcError(`${k} must be a positive length in mm`);
    return v;
  };
  const layer = has('layer') ? String(a.layer) : 'F.Cu';
  if (layer !== 'F.Cu' && layer !== 'B.Cu') throw new CalcError('layer is F.Cu or B.Cu (the inner layers are planes)');
  let over: string;
  let base: Omit<LineSection, 'w'>;
  if (has('h') || has('er')) {
    if (!has('h') || !has('er')) throw new CalcError('give h (mm to the plane) and er together');
    const er = num(a, 'er');
    if (!(er >= 1)) throw new CalcError('er must be ≥ 1');
    base = { t: has('t') ? len('t') : 0.035, below: [{ h: len('h'), er }] };
    over = `${base.below[0]!.h} mm to the plane, εr ${er}`;
  } else {
    if (!stackup) throw new CalcError('no stack-up known: give h (mm to the plane) and er');
    const top = layer === 'F.Cu';
    const d = stackup.dielectric[top ? 0 : stackup.dielectric.length - 1]!;
    base = { t: has('t') ? len('t') : stackup.copper[top ? 0 : stackup.copper.length - 1]!, below: [{ h: d.mm, er: d.er }] };
    if (stackup.mask && !(has('mask') && Number(a.mask) === 0)) base.mask = { base: stackup.mask.overLaminate, copper: stackup.mask.overCopper, er: stackup.mask.er };
    over = `${stackup.name}: ${layer}, ${d.mm} mm to the plane, εr ${d.er}`;
  }
  if (has('coplanar_gap')) base.g = len('coplanar_gap');
  const pair = has('gap') || has('diff');
  let w: number;
  if (has('width')) {
    w = len('width');
    if (has('gap')) base.s = len('gap');
    else if (pair) {
      if (!has('ohms')) throw new CalcError('a pair needs gap, or ohms to find the gap for the width');
      const s = gapForLine(num(a, 'ohms'), { ...base, w });
      if (s === null) throw new CalcError(`no gap makes ${num(a, 'ohms')} Ω differential with ${w} mm tracks`);
      base.s = s;
    }
  } else {
    if (!has('ohms')) throw new CalcError('give ohms (for the width) or width (for the impedance)');
    if (pair && !has('gap')) throw new CalcError('a pair needs gap (to find the width) or width (to find the gap)');
    if (has('gap')) base.s = len('gap');
    const z = num(a, 'ohms');
    const found = widthForLine(z, base);
    if (found === null) throw new CalcError(`no width makes ${z} Ω${pair ? ' differential' : ''} here`);
    w = found;
  }
  const r = analyseLine({ ...base, w });
  const out: Record<string, string | number> = {
    width_mm: mm(w),
    ...(base.s !== undefined ? { gap_mm: mm(base.s) } : {}),
    ...(base.g !== undefined ? { coplanar_gap_mm: mm(base.g) } : {}),
    [pair ? 'differential_ohm' : 'impedance_ohm']: Number(r.z.toFixed(2)),
    ...(pair ? { odd_ohm: Number(r.odd!.toFixed(2)), even_ohm: Number(r.even!.toFixed(2)), common_ohm: Number(r.common!.toFixed(2)) } : {}),
    eeff: Number(r.eeff.toFixed(3)),
    delay_ps_per_mm: Number(r.delay.toFixed(3)),
    over,
    mask: base.mask ? `${base.mask.copper} mm over copper, εr ${base.mask.er}` : 'none',
  };
  if (has('f')) {
    // the wavelength on this line: v / f, v = 1 / delay
    const lambda = 1e12 / (r.delay * num(a, 'f', 'Hz'));
    out.wavelength_mm = Number(lambda.toFixed(2));
    out.tenth_wavelength_mm = Number((lambda / 10).toFixed(2));
  }
  out.note = 'Quasi-static field solver, solder mask included; within about 1 % of the stack-up as given (the fab holds ±10 %).' + (pair ? ' A pair: its differential impedance (2 × odd mode); keep the gap all the way.' : '');
  return out;
}
