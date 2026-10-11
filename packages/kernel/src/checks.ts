/**
 * Electrical (ERC), semantic (datasheet-driven) and ledger checks.
 * Pure function of the design (+ placement status from the layout).
 */
import {
  formatQuantity,
  inSeries,
  nearestInSeries,
  parseAs,
  type Component,
  type Design,
  type Diagnostic,
  type DiagnosticCounts,
  type EditOp,
  type Net,
  type PartCard,
  type PartPin,
  type SchematicView,
  type Severity,
} from '@4k7/schema';
import { sameValue, describeConstraint } from './apply.ts';
import { allocRefdes, applyWaivers, cardOf, componentsSorted, isGroundNet, isPowerNet, natCmp, netMembers, type NetPin } from './doc.ts';

const DRIVERS = new Set(['out', 'bidir', 'tri', 'pwr_out', 'oc', 'passive']);
/** IC pin types that may stay unconnected without being an error. */
const IO = new Set(['bidir', 'out', 'tri', 'oc']);
const SERIES_CATEGORIES = new Set(['inductor', 'resistor', 'diode']);

interface Ctx {
  d: Design;
  members: Map<string, NetPin[]>;
  out: Diagnostic[];
}

export function runChecks(d: Design, placement?: SchematicView['constraintStatus']): Diagnostic[] {
  const ctx: Ctx = { d, members: netMembers(d), out: [] };
  pinChecks(ctx);
  netChecks(ctx);
  powerChecks(ctx);
  requirementChecks(ctx);
  ratingChecks(ctx);
  seriesChecks(ctx);
  ledgerChecks(ctx, placement);
  applyWaivers(d, ctx.out);
  return ctx.out.sort(
    (a, b) => sevRank(a.severity) - sevRank(b.severity) || a.code.localeCompare(b.code) || natCmp(a.entities.join(','), b.entities.join(',')),
  );
}

export function countDiagnostics(ds: Diagnostic[]): DiagnosticCounts {
  const c: DiagnosticCounts = { errors: 0, warnings: 0, infos: 0, waived: 0 };
  for (const x of ds) {
    if (x.waivedBy) c.waived++;
    else if (x.severity === 'error') c.errors++;
    else if (x.severity === 'warning') c.warnings++;
    else c.infos++;
  }
  return c;
}

export function diagKey(x: Diagnostic): string {
  return `${x.code}|${x.entities.join(',')}`;
}

const sevRank = (s: Severity) => (s === 'error' ? 0 : s === 'warning' ? 1 : 2);

function push(ctx: Ctx, severity: Severity, code: string, entities: string[], message: string, extra: Partial<Diagnostic> = {}) {
  ctx.out.push({ code, severity, entities, message, ...extra });
}

const pinRef = (c: Component, p: PartPin) => `${c.refdes}.${p.name === p.number ? p.number : p.name}`;
const netRef = (n: Net) => `net:${n.name}`;

/* ---------------------------------- pins ---------------------------------- */

function pinChecks(ctx: Ctx) {
  const { d } = ctx;
  for (const c of componentsSorted(d)) {
    const card = cardOf(d, c.part);
    if (!card) {
      push(ctx, 'error', 'LIB.PART_MISSING', [c.refdes], `${c.refdes}: part card ${c.part} is missing.`);
      continue;
    }
    // unused I/O on ICs is normal (an MCU rarely uses every GPIO): one note, not an error per pin
    const unusedIo = card.category === 'ic' ? card.pins.filter((p) => IO.has(p.type) && !c.pins[p.number] && !c.noConnect.includes(p.number)) : [];
    if (unusedIo.length) {
      push(ctx, 'info', 'ERC.IO_UNUSED', [c.refdes], `${c.refdes}: ${unusedIo.length} I/O pin${unusedIo.length === 1 ? '' : 's'} unused (${unusedIo.slice(0, 6).map((p) => p.name).join(', ')}${unusedIo.length > 6 ? ', …' : ''}).`);
    }
    for (const pin of card.pins) {
      const net = c.pins[pin.number];
      if (unusedIo.includes(pin)) continue;
      if (!net && pin.type !== 'nc' && !c.noConnect.includes(pin.number)) {
        const hint = pin.description ? ` (${pin.description})` : '';
        const fixHints: EditOp[] | undefined =
          card.category === 'ic' && (pin.type === 'in' || pin.type === 'bidir' || pin.type === 'passive')
            ? [{ op: 'no_connect', pins: [pinRef(c, pin)] }]
            : undefined;
        push(ctx, 'error', 'ERC.PIN_UNCONNECTED', [pinRef(c, pin)], `${pinRef(c, pin)} is unconnected${hint}.`, fixHints ? { fixHints } : {});
      }
      if (net && pin.type === 'nc') {
        push(ctx, 'warning', 'ERC.NC_CONNECTED', [pinRef(c, pin)], `${pinRef(c, pin)} is internally not connected but is wired to ${d.nets[net]?.name}.`);
      }
    }
    for (const [k, spec] of Object.entries(card.params)) {
      if (spec.required && !c.params[k]) {
        push(ctx, 'error', 'SEM.VALUE_MISSING', [c.refdes], `${c.refdes} has no ${k}.`);
      }
    }
  }
}

/* ---------------------------------- nets ---------------------------------- */

function netChecks(ctx: Ctx) {
  const { d, members } = ctx;
  for (const net of netsSorted(d)) {
    const pins = members.get(net.id) ?? [];
    if (pins.length === 1) {
      const p = pins[0]!;
      push(ctx, 'warning', 'ERC.SINGLE_PIN_NET', [netRef(net)], `Net ${net.name} only connects ${pinRef(p.comp, p.pin)}.`);
    }
    const outs = pins.filter((p) => p.pin.type === 'out' || p.pin.type === 'pwr_out');
    if (outs.length > 1) {
      push(ctx, 'error', 'ERC.OUTPUT_CONFLICT', [netRef(net)], `Net ${net.name} is driven by ${outs.length} outputs: ${outs.map((p) => pinRef(p.comp, p.pin)).join(', ')}.`);
    }
    const ins = pins.filter((p) => p.pin.type === 'in');
    if (ins.length && !pins.some((p) => DRIVERS.has(p.pin.type)) && !net.attrs.external && !isPowerNet(net)) {
      push(ctx, 'warning', 'ERC.INPUT_UNDRIVEN', [netRef(net)], `Net ${net.name} has inputs (${ins.map((p) => pinRef(p.comp, p.pin)).join(', ')}) but nothing drives it.`);
    }
    if (net.attrs.external && net.attrs.voltage === undefined && !isGroundNet(net)) {
      push(ctx, 'warning', 'SEM.VOLTAGE_UNKNOWN', [netRef(net)], `External net ${net.name} has no voltage; set it so ratings can be checked.`);
    }
  }
}

function netsSorted(d: Design): Net[] {
  return Object.values(d.nets).sort((a, b) => natCmp(a.name, b.name));
}

/* --------------------------------- power ---------------------------------- */

function powerChecks(ctx: Ctx) {
  const { d, members } = ctx;
  const driven = new Set<string>();
  for (const net of Object.values(d.nets)) {
    const pins = members.get(net.id) ?? [];
    if (net.attrs.external || isGroundNet(net) || pins.some((p) => p.pin.type === 'pwr_out')) driven.add(net.id);
  }
  // power flows through series elements (inductors, resistors, diodes)
  const edges = new Map<string, string[]>();
  for (const c of Object.values(d.components)) {
    const card = cardOf(d, c.part);
    if (!card || !SERIES_CATEGORIES.has(card.category) || card.pins.length !== 2) continue;
    const [a, b] = card.pins.map((p) => c.pins[p.number]);
    if (!a || !b || a === b) continue;
    edges.set(a, [...(edges.get(a) ?? []), b]);
    edges.set(b, [...(edges.get(b) ?? []), a]);
  }
  const queue = [...driven];
  while (queue.length) {
    const n = queue.shift()!;
    for (const m of edges.get(n) ?? []) {
      if (!driven.has(m)) {
        driven.add(m);
        queue.push(m);
      }
    }
  }
  for (const net of netsSorted(d)) {
    const sinks = (members.get(net.id) ?? []).filter((p) => p.pin.type === 'pwr_in');
    if (sinks.length && !driven.has(net.id)) {
      push(
        ctx,
        'error',
        'ERC.POWER_UNDRIVEN',
        [netRef(net)],
        `Net ${net.name} feeds power pins (${sinks.map((p) => pinRef(p.comp, p.pin)).join(', ')}) but no source drives it. ` +
          `If it comes from a connector, mark it with set_net external: true.`,
        { fixHints: [{ op: 'set_net', net: net.name, external: true }] },
      );
    }
  }
}

/* ----------------------------- datasheet rules ----------------------------- */

function twoPinNets(d: Design, c: Component, card: PartCard): [string | undefined, string | undefined] {
  return [c.pins[card.pins[0]!.number], c.pins[card.pins[1]!.number]];
}

function capsBetween(d: Design, a: string, b: string): Component[] {
  return componentsSorted(d).filter((c) => {
    const card = cardOf(d, c.part);
    if (card?.category !== 'capacitor' || c.dnp) return false;
    const [x, y] = twoPinNets(d, c, card);
    return (x === a && y === b) || (x === b && y === a);
  });
}

function capToGround(d: Design, net: string): { caps: Component[]; total: number } {
  const grounds = Object.values(d.nets).filter(isGroundNet).map((n) => n.id);
  const caps = grounds.flatMap((g) => capsBetween(d, net, g));
  const total = caps.reduce((s, c) => s + (parseAs(c.params.capacitance, 'F') ?? 0), 0);
  return { caps, total };
}

function requirementChecks(ctx: Ctx) {
  const { d } = ctx;
  for (const c of componentsSorted(d)) {
    const card = cardOf(d, c.part);
    if (!card?.requirements) continue;
    const pinNet = (name: string) => {
      const p = card.pins.find((x) => x.name === name || x.number === name);
      return p ? c.pins[p.number] : undefined;
    };
    const src = card.datasheet ? `${card.id} datasheet` : card.id;

    for (const r of card.requirements) {
      if (r.kind === 'cap_between') {
        const [pa, pb] = r.pins;
        const na = pinNet(pa);
        const nb = pinNet(pb);
        if (!na || !nb) continue; // unconnected pins are reported separately
        const caps = capsBetween(d, na, nb);
        if (!caps.length) {
          const ref = allocRefdes(d, 'C');
          push(ctx, 'error', 'SEM.REQUIREMENT', [`${c.refdes}.${pa}`, `${c.refdes}.${pb}`],
            `${c.refdes} needs a ${r.value} capacitor between ${pa} and ${pb}${r.note ? ` (${r.note})` : ''}.`, {
              source: `${src}${r.src?.note ? `: ${r.src.note}` : ''}`,
              fixHints: [
                { op: 'add_part', part: 'generic:C', refdes: ref, params: { capacitance: r.value } },
                { op: 'connect', pins: [`${c.refdes}.${pa}`, `${ref}.1`] },
                { op: 'connect', pins: [`${c.refdes}.${pb}`, `${ref}.2`] },
              ],
            });
        } else {
          const want = parseAs(r.value, 'F');
          const have = caps.reduce((s, x) => s + (parseAs(x.params.capacitance, 'F') ?? 0), 0);
          if (want && (have < want * 0.5 || have > want * 2)) {
            push(ctx, 'warning', 'SEM.REQUIREMENT_VALUE', [caps[0]!.refdes],
              `${caps.map((x) => x.refdes).join('+')} between ${c.refdes}.${pa} and ${pb} is ${formatQuantity(have, 'F')}; datasheet asks for ${r.value}.`, { source: src });
          }
        }
      } else if (r.kind === 'decouple') {
        const net = pinNet(r.pin);
        if (!net) continue;
        const { total } = capToGround(d, net);
        const min = parseAs(r.min, 'F') ?? 0;
        if (total + 1e-15 < min) {
          push(ctx, 'error', 'SEM.DECOUPLING', [`${c.refdes}.${r.pin}`],
            `${c.refdes}.${r.pin} (net ${d.nets[net]!.name}) needs ≥ ${r.min} to ground; found ${formatQuantity(total, 'F')}.`, {
              source: `${src}${r.src?.note ? `: ${r.src.note}` : ''}`,
            });
        }
      } else if (r.kind === 'pull') {
        const net = pinNet(r.pin);
        if (!net) continue;
        const ok = componentsSorted(d).some((x) => {
          const xc = cardOf(d, x.part);
          if (xc?.category !== 'resistor') return false;
          const [a, b] = twoPinNets(d, x, xc);
          const other = a === net ? b : b === net ? a : undefined;
          if (!other) return false;
          const on = d.nets[other]!;
          return r.direction === 'up' ? isPowerNet(on) && !isGroundNet(on) : isGroundNet(on);
        });
        if (!ok) {
          push(ctx, 'warning', 'SEM.PULL', [`${c.refdes}.${r.pin}`],
            `${c.refdes}.${r.pin} should have a pull-${r.direction} resistor${r.note ? ` (${r.note})` : ''}.`, { source: src });
        }
      }
    }
  }
}

/* --------------------------------- ratings -------------------------------- */

function netVoltage(n: Net | undefined): number | undefined {
  if (!n) return undefined;
  if (isGroundNet(n)) return 0;
  return n.attrs.voltage;
}

function ratingChecks(ctx: Ctx) {
  const { d } = ctx;
  for (const c of componentsSorted(d)) {
    const card = cardOf(d, c.part);
    if (!card) continue;

    for (const pin of card.pins) {
      const v = netVoltage(d.nets[c.pins[pin.number] ?? '']);
      if (pin.maxVoltage !== undefined && v !== undefined && v > pin.maxVoltage) {
        push(ctx, 'error', 'SEM.ABS_MAX', [pinRef(c, pin)],
          `${pinRef(c, pin)} sees ${v} V; absolute maximum is ${pin.maxVoltage} V.`, { source: card.id });
      }
    }

    if (card.category === 'capacitor' && card.pins.length === 2) {
      const [a, b] = twoPinNets(d, c, card);
      const va = netVoltage(d.nets[a ?? '']);
      const vb = netVoltage(d.nets[b ?? '']);
      if (va === undefined || vb === undefined) continue;
      const across = Math.abs(va - vb);
      const rated = parseAs(c.params.voltage, 'V');
      if (rated === null) {
        if (across > 0) {
          push(ctx, 'warning', 'SEM.RATING_MISSING', [c.refdes], `${c.refdes} sits across ${across} V but has no voltage rating.`, {
            fixHints: [{ op: 'set_param', ref: c.refdes, params: { voltage: `${suggestRating(across)}V` } }],
          });
        }
      } else if (rated < across) {
        push(ctx, 'error', 'SEM.CAP_VOLTAGE', [c.refdes], `${c.refdes} is rated ${rated} V but sees ${across} V.`, {
          fixHints: [{ op: 'set_param', ref: c.refdes, params: { voltage: `${suggestRating(across)}V` } }],
        });
      } else if (rated < across * 1.5) {
        push(ctx, 'warning', 'SEM.CAP_DERATING', [c.refdes], `${c.refdes} is rated ${rated} V for ${across} V; keep ≥ 1.5× margin (ceramics lose capacitance under DC bias).`, {
          fixHints: [{ op: 'set_param', ref: c.refdes, params: { voltage: `${suggestRating(across)}V` } }],
        });
      }
      if (card.id === 'generic:CP' && va < vb) {
        push(ctx, 'error', 'SEM.POLARITY', [c.refdes], `${c.refdes} is polarized but its + pin is on the lower-voltage net.`);
      }
    }
  }
}

const RATINGS = [6.3, 10, 16, 25, 35, 50, 63, 100];
function suggestRating(v: number): number {
  return RATINGS.find((r) => r >= v * 1.5) ?? Math.ceil(v * 2);
}

/* ------------------------------ value series ------------------------------ */

const SERIES_PARAM = { resistor: ['resistance', 'Ω'], capacitor: ['capacitance', 'F'], inductor: ['inductance', 'H'] } as const;

/** Values of generic passives outside the design's E-series. A value the user fixed in the ledger is theirs to keep. */
function seriesChecks(ctx: Ctx) {
  const { d } = ctx;
  if (!d.valueSeries) return;
  const fixed = new Set(Object.values(d.ledger).filter((k) => k.kind === 'param' && k.a).map((k) => `${k.a}|${k.key}`));
  for (const c of componentsSorted(d)) {
    const card = cardOf(d, c.part);
    const kind = card?.category as keyof typeof SERIES_PARAM | undefined;
    const series = kind && d.valueSeries[kind];
    if (!kind || !series) continue;
    const [key, unit] = SERIES_PARAM[kind];
    const v = parseAs(c.params[key], unit);
    if (v === null || !(v > 0) || fixed.has(`${c.id}|${key}`) || inSeries(v, series)) continue;
    const near = formatQuantity(nearestInSeries(v, series), unit);
    const down = formatQuantity(nearestInSeries(v, series, 'down'), unit);
    const up = formatQuantity(nearestInSeries(v, series, 'up'), unit);
    push(ctx, 'warning', 'SEM.VALUE_SERIES', [c.refdes], `${c.refdes} = ${c.params[key]} is not an ${series} value (${down} or ${up}; nearest ${near}).`, {
      fixHints: [{ op: 'set_param', ref: c.refdes, params: { [key]: near } }],
    });
  }
}

/* ---------------------------------- ledger -------------------------------- */

function ledgerChecks(ctx: Ctx, placement?: SchematicView['constraintStatus']) {
  const { d } = ctx;
  for (const k of Object.values(d.ledger).sort((a, b) => natCmp(a.id, b.id))) {
    if (k.kind === 'param' && k.a && k.key) {
      const c = d.components[k.a];
      if (!c) continue;
      const cur = c.params[k.key];
      if (cur === undefined || !sameValue(cur, k.value ?? '')) {
        push(ctx, k.strength === 'hard' ? 'error' : 'warning', 'LEDGER.PARAM', [c.refdes, k.id],
          `${c.refdes}.${k.key} is ${cur ?? 'unset'} but the ledger says ${k.value}` + (k.source.quote ? ` ("${k.source.quote}")` : '') + '.', {
            fixHints: [{ op: 'set_param', ref: c.refdes, params: { [k.key]: k.value ?? null } }],
          });
      }
    } else if (placement?.[k.id] === 'violated') {
      push(ctx, k.strength === 'hard' ? 'error' : 'warning', 'LEDGER.PLACEMENT', [k.id],
        `Schematic placement does not satisfy ${describeConstraint(d, k)}.`);
    }
  }
}
