/**
 * Deterministic engineering calculators exposed to the agent as the `calc` tool.
 * The model decides *what* to compute; arithmetic and standard-value snapping happen here.
 */
import { COPPER_ORDER, E_SERIES, eSeriesValues, formatQuantity, nearestInSeries, parseQuantity, trackCurrentFor, trackRiseFor, trackWidthFor, viaCurrentFor, type CalcCall, type DesignSummary, type ESeries, type ValueSeries } from '@4k7/schema';
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
 * The stack-up and heating calc works on for `board` (name or id), from the design summary: the
 * only board's; on several boards the named board's. Several boards and none named: theirs if they
 * all have the same, else `ask` (what to tell the agent if the calculation needs them). An unknown
 * board is an error. See docs/design/multi-board.md.
 */
export function calcBoard(summary: Pick<DesignSummary, 'stackup' | 'currentRise' | 'boards'>, board?: string): { stackup?: CalcStackup; currentRise?: number; ask?: string } {
  const boards = summary.boards;
  if (!boards?.length) return { stackup: summary.stackup, currentRise: summary.currentRise };
  const names = boards.map((b) => b.name).join(', ');
  if (board !== undefined) {
    const key = board.trim().toLowerCase();
    const b = boards.find((x) => x.id === board || x.name.toLowerCase() === key);
    if (!b) throw new CalcError(`No board "${board}": the design's boards are ${names}.`);
    return { stackup: b.stackup, currentRise: b.currentRise };
  }
  const same = (x: (typeof boards)[number]) => JSON.stringify([x.stackup, x.currentRise ?? 10]);
  if (boards.every((b) => same(b) === same(boards[0]!))) return { stackup: boards[0]!.stackup, currentRise: boards[0]!.currentRise };
  return { ask: `the design has ${boards.length} boards with different stack-ups or heating (${names}): say which with board` };
}

/**
 * `design` is the design's value series (set_value_series): it replaces each calculator's own
 * default series for that kind of part; a `series` argument wins over both. `stackup`: the board's,
 * what impedance works on unless given h and er; `currentRise`: the board's allowed heating, what
 * track_current works at unless given rise_c; `ask`: why neither is known (several boards, none named),
 * said when the calculation needs them.
 */
export function runCalc(call: CalcCall, design: ValueSeries = {}, stackup?: CalcStackup, currentRise = 10, ask?: string): Record<string, string | number> {
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
      return impedance(a, stackup, ask);
    case 'track_current':
      return trackCurrent(a, stackup, ask ? undefined : currentRise, ask);
  }
}

/**
 * A track's current, width and heating on one layer's copper: give two of width_mm, amps and rise_c
 * (rise_c defaults to the board's current_rise_c) and get the third; with via_drill_mm also one
 * via's capacity and the vias the current needs. The same functions as the current check
 * (get_current_map), so the answer is what the check will say. See docs/design/layout.md §14.
 */
function trackCurrent(a: CalcCall['args'], stackup: CalcStackup | undefined, known: number | undefined, ask?: string): Record<string, string | number> {
  // the board's heating, only where it is used
  const boardRise = (): number => {
    if (known === undefined) throw new CalcError(`${ask}, or give rise_c`);
    return known;
  };
  const has = (k: string) => a[k] !== undefined;
  const pos = (k: string, what: string) => {
    const v = num(a, k);
    if (!(v > 0)) throw new CalcError(`${k} must be a positive ${what}`);
    return v;
  };
  if (has('layer') && has('copper_um')) throw new CalcError('give layer (its copper from the stack-up) or copper_um, not both');
  let copper: number;
  let layer: string;
  if (has('copper_um')) {
    copper = pos('copper_um', 'copper thickness in µm (35 for 1 oz)');
    layer = 'as given';
  } else {
    layer = has('layer') ? String(a.layer) : 'F.Cu';
    const order = stackup ? COPPER_ORDER[stackup.copper.length as 2 | 4] : undefined;
    if (!stackup || !order) throw new CalcError(ask ? `${ask}, or give copper_um` : 'no stack-up known: give copper_um');
    const i = order.indexOf(layer as (typeof order)[number]);
    if (i < 0) throw new CalcError(`layer is one of this board's copper layers: ${order.join(', ')}`);
    copper = Math.round(stackup.copper[i]! * 1000 * 10) / 10;
  }
  const n = [has('width_mm'), has('amps'), has('rise_c')].filter(Boolean).length;
  if (n === 3) throw new CalcError('give two of width_mm, amps and rise_c (rise_c defaults to the board\'s current_rise_c), and get the third');
  if (n === 0 && !has('via_drill_mm')) throw new CalcError('give width_mm (for the current it carries), amps (for the width it needs) or both (for the heating), or via_drill_mm');
  const solveRise = has('width_mm') && has('amps');
  const rise = solveRise ? undefined : has('rise_c') ? pos('rise_c', 'heating in °C') : boardRise();
  if (rise !== undefined && rise > 100) throw new CalcError('rise_c must be at most 100 °C (the curve\'s range)');
  const out: Record<string, string | number> = {};
  let amps = has('amps') ? pos('amps', 'current in A') : undefined;
  if (has('width_mm') || amps !== undefined) {
    const width = has('width_mm') ? pos('width_mm', 'width in mm') : trackWidthFor(amps!, rise, copper);
    if (amps === undefined) amps = trackCurrentFor(width, copper, rise);
    out.width_mm = mm(width);
    out.amps = Number(amps.toFixed(3));
    out.rise_c = Number((rise ?? trackRiseFor(amps, width, copper)).toFixed(1));
  } else out.rise_c = rise!;
  out.copper_um = copper;
  out.layer = layer;
  out.curve = 'IPC-2221 external';
  if (has('via_drill_mm')) {
    const perVia = viaCurrentFor(pos('via_drill_mm', 'drill in mm'), rise ?? boardRise());
    out.via_drill_mm = num(a, 'via_drill_mm');
    out.per_via_a = Number(perVia.toFixed(3));
    if (amps !== undefined) out.vias_needed = Math.max(1, Math.ceil(amps / perVia - 1e-6));
  }
  out.note =
    'The curve the current check uses, on every layer with its copper: conservative near a plane or pour (they carry heat away), about right for a long isolated outer track.' +
    (has('amps') && !has('width_mm') ? ' The width is rounded up to 0.05 mm, at least 0.15 mm.' : '') +
    (has('via_drill_mm') ? ' Vias: the plated barrel (25 µm), at the board\'s heating unless rise_c is given; vias within 1 mm of each other add up.' : '');
  return out;
}

const mm = (v: number) => Number(v.toFixed(4));

/**
 * A track's impedance with the field solver: the width that gives `ohms`, or what `width` gives;
 * with `gap` a differential pair (`diff` with `width` and `ohms`: the gap that gives it), with
 * `coplanar_gap` ground beside it on its layer. On the board's stack-up (the layer over the plane
 * next to it, with its solder mask) unless h and er are given.
 */
function impedance(a: CalcCall['args'], stackup?: CalcStackup, ask?: string): Record<string, string | number> {
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
    if (!stackup) throw new CalcError(ask ? `${ask}, or give h (mm to the plane) and er` : 'no stack-up known: give h (mm to the plane) and er');
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
