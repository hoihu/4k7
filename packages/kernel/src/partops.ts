/**
 * The ops on the part cards a design carries: how a part is drawn, its footprint, what it mates
 * with, its polarity, what its pins do, the name of a part, and the defaults generic parts are
 * chosen by.
 */
import { footprintFor, generatedLayout, isBoxSymbol, isTwoPin, layoutText, packageOf, planUnits, standardPackage, symbolFor } from '@4k7/parts';
import { type Component, type Design, type EditOp, type ESeries, type OpResult, type PackageInfo, type PartCard, type PartPin, type SymbolLayout, type ValueSeries } from '@4k7/schema';
import { cardOf, findComponent, natCmp, reject, resolveComponent, resolveUnitRef } from './doc.ts';
import { remakeSymbols } from './drawing.ts';
import { polarityOf } from './marks.ts';

/**
 * How a part's symbol is drawn: one symbol or units (style), or the pins where the agent wants them
 * (layout, e.g. as in a reference drawing). Changes the design's copy of the part card only.
 */
export function setSymbol(d: Design, op: Extract<EditOp, { op: 'set_symbol' }>): OpResult {
  const comp = resolveComponent(d, op.ref);
  const card = cardOf(d, comp.part)!;
  const users = Object.values(d.components).filter((c) => c.part === card.id).map((c) => c.refdes).sort(natCmp);
  if (op.layout !== undefined) return setPinLayout(d, comp, card, users, op);
  const style = op.style;
  if (!style) reject({ code: 'INVALID_OP', message: 'set_symbol needs style ("single" or "units") or layout (the pins on each side).' });
  if (style === 'units' && (isTwoPin(card) || card.pins.length < 12)) {
    reject({ code: 'SYMBOL_STYLE', message: `${comp.refdes} (${card.id}) has ${card.pins.length} pins; only large ICs can be split into units.` });
  }
  const copy: PartCard = structuredClone(card);
  if (style === 'units') copy.units = planUnits(copy.pins);
  else delete copy.units;
  d.parts[card.id] = copy;
  const what = style === 'units' ? `${copy.units!.length} units (${copy.units!.map((u) => `${u.name}: ${u.title}`).join('; ')})` : 'one symbol';
  return { op: 'set_symbol', effect: `${users.join(', ')} drawn as ${what}`, ids: [card.id] };
}

function setPinLayout(d: Design, comp: Component, card: PartCard, users: string[], op: Extract<EditOp, { op: 'set_symbol' }>): OpResult {
  if (op.style === 'units') reject({ code: 'SYMBOL_STYLE', message: 'A layout arranges one symbol: give style "units" or a layout, not both.' });
  if (!isBoxSymbol(card)) {
    reject({ code: 'SYMBOL_STYLE', message: `${comp.refdes} (${card.id}) has a symbol of its own kind (a two-pin part, transistor, crystal or bridge) whose pins cannot be moved; only ICs, connectors and modules drawn as a box take a layout. place_symbol mirror draws it the other way round.` });
  }
  const copy: PartCard = structuredClone(card);
  delete copy.units;
  if (op.layout) {
    copy.symbolLayout = resolveLayout(comp.refdes, card, op.layout);
    copy.customSymbol = true;
  } else {
    const generated = generatedLayout(copy);
    if (generated) copy.symbolLayout = generated;
    else delete copy.symbolLayout;
    delete copy.customSymbol;
  }
  d.parts[card.id] = copy;
  const sheets = remakeSymbols(d, card.id);
  const how = copy.symbolLayout ? layoutText(copy, copy.symbolLayout) : 'by pin type';
  return {
    op: 'set_symbol',
    effect:
      `${users.join(', ')}: ${op.layout ? 'pins arranged' : 'generated arrangement'} (${how})` +
      (card.units?.length ? `, one symbol instead of ${card.units.length} units` : '') +
      (sheets.length ? `. Redrawn where it stood on your drawing of ${sheets.join(', ')}: wires to pins that moved were cut back and show as labels until you wire them again` : ''),
    ids: [card.id],
  };
}

/** The agent's layout (pin names or numbers per side) as pin numbers; every pin exactly once, only like pins stacked. */
function resolveLayout(refdes: string, card: PartCard, given: NonNullable<Extract<EditOp, { op: 'set_symbol' }>['layout']>): SymbolLayout {
  const label = (p: PartPin) => (p.name === p.number ? p.number : `${p.number} ${p.name}`);
  const byNumber = new Map(card.pins.map((p) => [p.number, p]));
  const byName = new Map<string, PartPin[]>();
  for (const p of card.pins) byName.set(p.name.toUpperCase(), [...(byName.get(p.name.toUpperCase()) ?? []), p]);
  const problems: string[] = [];
  const seen = new Set<string>();
  const out: SymbolLayout = { left: [], right: [], top: [], bottom: [] };
  for (const side of ['left', 'right', 'top', 'bottom'] as const) {
    for (const entry of given[side] ?? []) {
      if (entry === null) {
        out[side].push(null);
        continue;
      }
      const stack = (Array.isArray(entry) ? entry : [entry]).flatMap((key) => {
        const pins = byNumber.has(key) ? [byNumber.get(key)!] : byName.get(key.toUpperCase());
        if (!pins) problems.push(`no pin "${key}"`);
        return pins ?? [];
      });
      if (!stack.length) continue;
      for (const p of stack) {
        if (seen.has(p.number)) problems.push(`pin ${label(p)} is given twice`);
        seen.add(p.number);
      }
      if (new Set(stack.map((p) => p.name.toUpperCase())).size > 1 && !stack.every((p) => p.type === 'nc')) {
        problems.push(`${stack.map(label).join(', ')} cannot share one position (only pins of one name, or NC pins, stack)`);
      }
      out[side].push(stack.map((p) => p.number));
    }
  }
  const missing = card.pins.filter((p) => !seen.has(p.number));
  if (missing.length) problems.push(`missing ${missing.map(label).join(', ')} (every pin is drawn)`);
  if (problems.length) {
    reject({ code: 'SYMBOL_LAYOUT', message: `Pin layout for ${refdes} (${card.id}): ${[...new Set(problems)].join('; ')}.`, candidates: card.pins.map(label) });
  }
  return out;
}

/**
 * Give a part an explicit land pattern (read off its datasheet drawing). Changes the design's copy
 * of the part card, so every component of that part gets it; a library part shared by components
 * that differ (generic resistors, caps …) is refused.
 */
export function setFootprint(d: Design, op: Extract<EditOp, { op: 'set_footprint' }>): OpResult {
  const comp = resolveComponent(d, op.ref);
  const card = cardOf(d, comp.part)!;
  const users = Object.values(d.components).filter((c) => c.part === card.id).map((c) => c.refdes).sort(natCmp);
  if (card.id.startsWith('generic:') && users.length > 1) {
    reject({ code: 'FOOTPRINT_INVALID', message: `${card.id} is a generic part used by ${users.join(', ')}; its footprint follows each component's package parameter (set_param package).` });
  }
  const pkg: PackageInfo = {
    name: op.name,
    family: 'other',
    pins: card.pins.length,
    pads: op.pads,
    ...(op.body_mm ? { body_mm: op.body_mm } : {}),
    ...(op.round ? { body_shape: 'round' as const } : {}),
    ...(op.height_mm ? { height_mm: op.height_mm } : {}),
    ...(op.page ? { page: op.page } : {}),
    ...(op.mating ? { mating: op.mating } : card.packageInfo?.mating ? { mating: card.packageInfo.mating } : {}),
  };
  const fp = footprintFor(pkg, card.pins.map((p) => p.number));
  if (!fp.ok) reject({ code: 'FOOTPRINT_INVALID', message: `${op.name} for ${comp.refdes}: ${fp.reason}.`, candidates: card.pins.map((p) => `${p.number} ${p.name}`) });
  const copy: PartCard = structuredClone(card);
  copy.packageInfo = pkg;
  copy.package = op.name;
  d.parts[card.id] = copy;
  const f = fp.footprint;
  return { op: 'set_footprint', effect: `${users.join(', ')}: footprint ${op.name}, ${f.pads.length} pads, ${f.courtyard.w} × ${f.courtyard.h} mm courtyard`, ids: [card.id] };
}

/**
 * Where a part is plugged from (its package's mating face), kept with the part card like its
 * footprint. A generic card shared by several components follows each one's package, so it cannot
 * take one.
 */
export function setMating(d: Design, op: Extract<EditOp, { op: 'set_mating' }>): OpResult {
  const comp = resolveComponent(d, op.ref);
  const card = cardOf(d, comp.part)!;
  const users = Object.values(d.components).filter((c) => c.part === card.id).map((c) => c.refdes).sort(natCmp);
  const pkg = packageOf(card, comp.params, d.packageDefaults);
  if (!pkg) reject({ code: 'FOOTPRINT_INVALID', message: `${comp.refdes} has no footprint yet: give it one with set_footprint (with mating) first.` });
  if (card.id.startsWith('generic:') && users.length > 1) {
    reject({ code: 'FOOTPRINT_INVALID', message: `${card.id} is a generic part used by ${users.join(', ')}; give ${comp.refdes} its own footprint with set_footprint (with mating) instead.` });
  }
  const copy: PartCard = structuredClone(card);
  const info: PackageInfo = { ...structuredClone(pkg) };
  if (op.face === null) delete info.mating;
  else {
    info.mating = {
      face: op.face,
      ...(op.plug_mm ? { plug_mm: op.plug_mm } : {}),
      ...(op.axis_mm !== undefined ? { axis_mm: op.axis_mm } : {}),
      ...(op.along_mm !== undefined ? { along_mm: op.along_mm } : {}),
    };
  }
  copy.packageInfo = info;
  copy.package ??= info.name;
  d.parts[card.id] = copy;
  const m = info.mating;
  return {
    op: 'set_mating',
    effect: m ? `${users.join(', ')}: plugged from ${m.face === 'up' ? 'above' : `the ${m.face} of the footprint`}${m.plug_mm ? `, plug ${m.plug_mm[0]} × ${m.plug_mm[1]} mm` : ''}` : `${users.join(', ')}: not plugged`,
    ids: [card.id],
  };
}

/** Which way round a part goes (set_polarity): what its silkscreen marks, on the design's copy of its card. */
export function setPolarity(d: Design, op: Extract<EditOp, { op: 'set_polarity' }>): OpResult {
  const comp = resolveComponent(d, op.ref);
  const card = cardOf(d, comp.part)!;
  const users = Object.values(d.components).filter((c) => c.part === card.id).map((c) => c.refdes).sort(natCmp);
  if (card.id.startsWith('generic:')) {
    const said = polarityOf(card);
    reject({ code: 'PARAM_INVALID', message: `${card.id} is a generic part: its pins' names say ${said === null ? 'it fits either way round' : said === 'unknown' ? 'nothing' : `which pin to mark (${said.kind === 'pin1' ? 'pin 1' : `the ${said.kind === 'plus' ? 'plus terminal' : 'cathode'}, pin ${said.pin}`})`}, for ${users.join(', ')} alike. Connect the pins the other way round instead, or use a part of its own.` });
  }
  if (op.pin !== undefined && !card.pins.some((p) => p.number.toUpperCase() === op.pin!.toUpperCase())) {
    reject({ code: 'PARAM_INVALID', message: `${comp.refdes} has no pin "${op.pin}" (pins: ${card.pins.map((p) => p.number).join(', ')}).` });
  }
  const copy: PartCard = structuredClone(card);
  if (op.mark === 'auto') delete copy.polarity;
  else copy.polarity = { mark: op.mark, ...(op.pin !== undefined && op.mark !== 'none' ? { pin: card.pins.find((p) => p.number.toUpperCase() === op.pin!.toUpperCase())!.number } : {}) };
  d.parts[card.id] = copy;
  const now = polarityOf(copy);
  const said = now === null ? 'no mark (it fits either way round)' : now === 'unknown' ? 'no mark: its pins do not say which is the cathode' : now.kind === 'pin1' ? `a dot by pin ${now.pin}` : now.kind === 'cathode' ? `a band at the cathode, pin ${now.pin}` : `a "+" by the plus terminal, pin ${now.pin}`;
  return { op: 'set_polarity', effect: `${users.join(', ')}: ${said}`, ids: [card.id] };
}

/** The alternate functions an import noted behind a pin's text ("GPIO · alt: SPI0_RX, UART0_TX"). */
const altOf = (text: string | undefined) => /(?:^| · )(alt: .*)$/.exec(text ?? '')?.[1];

/**
 * What a part's pins do (the pin table in Parts, unconnected-pin errors), on the design's copy of
 * its card; marked, so it goes back to the library part once committed. A generic card is shared by
 * components that differ, so its pins take no text.
 */
export function setPinDescriptions(d: Design, op: Extract<EditOp, { op: 'set_pin_descriptions' }>): OpResult {
  const comp = resolveUnitRef(d, op.ref).comp;
  const card = cardOf(d, comp.part)!;
  const users = Object.values(d.components).filter((c) => c.part === card.id).map((c) => c.refdes).sort(natCmp);
  if (card.id.startsWith('generic:')) {
    reject({ code: 'PARAM_INVALID', message: `${card.id} is a generic part, one card for ${users.join(', ')} alike, so its pins take no text: their nets say what each does here. Give ${comp.refdes} a part of its own (import_part, sourcing) to describe its pins.` });
  }
  const copy: PartCard = structuredClone(card);
  const changed = new Set<string>();
  const unknown: string[] = [];
  for (const { pin, description } of op.pins) {
    const key = pin.trim().toUpperCase();
    const numbered = copy.pins.filter((p) => p.number.toUpperCase() === key);
    const pins = numbered.length ? numbered : copy.pins.filter((p) => p.name.toUpperCase() === key);
    if (!pins.length) unknown.push(`"${pin}"`);
    for (const p of pins) {
      const alt = altOf(description) ? undefined : altOf(p.description);
      const text = alt ? `${description} · ${alt}` : description;
      if (text === p.description) continue;
      p.description = text;
      changed.add(p.number);
    }
  }
  if (unknown.length) reject({ code: 'PIN_UNKNOWN', message: `${comp.refdes} (${card.id}) has no pin ${unknown.join(', ')}.`, candidates: card.pins.map((p) => `${p.number} ${p.name}`) });
  if (!changed.size) return { op: 'set_pin_descriptions', effect: `${users.join(', ')}: the pins already say this`, ids: [] };
  copy.customPinText = true;
  d.parts[card.id] = copy;
  // a switch is drawn from what its pins say is joined inside
  const redrawn = JSON.stringify(symbolFor(card)) !== JSON.stringify(symbolFor(copy));
  const sheets = redrawn ? remakeSymbols(d, card.id) : [];
  return {
    op: 'set_pin_descriptions',
    effect:
      `${users.join(', ')}: ${changed.size} pin description${changed.size === 1 ? '' : 's'}` +
      (redrawn ? '. Its symbol is drawn differently now: its pins\' texts say which of them are joined inside' : '') +
      (sheets.length ? `. Redrawn where it stood on your drawing of ${sheets.join(', ')}: wires to pins that moved were cut back and show as labels until you wire them again` : ''),
    ids: [card.id],
  };
}

/** Packages for generic parts without their own: per kind, and automatic sizing. */
export function setPackageDefaults(d: Design, op: Extract<EditOp, { op: 'set_package_defaults' }>): OpResult {
  const next = { ...(d.packageDefaults ?? {}) };
  const slots = ['resistor', 'capacitor', 'electrolytic', 'inductor', 'diode', 'led'] as const;
  const given: Partial<Record<(typeof slots)[number], string | null>> = {};
  if (op.passives) Object.assign(given, { resistor: op.passives, capacitor: op.passives, led: op.passives });
  for (const s of slots) if (op[s] !== undefined) given[s] = op[s];
  const changes: string[] = [];
  for (const [slot, name] of Object.entries(given) as [(typeof slots)[number], string | null][]) {
    if (name === null || name === '') {
      delete next[slot];
      changes.push(`${slot}: library default`);
      continue;
    }
    const pkg = standardPackage(name);
    if (!pkg) reject({ code: 'PARAM_INVALID', message: `Unknown package "${name}" for ${slot}s. Known e.g.: 0402, 0603, 0805, 1206, 2512, AXIAL-0.4, RADIAL-D8, CAP-8x10, IND-6x6, SOD-123, SMA, DO-41, LED-5mm.` });
    next[slot] = pkg.name;
    changes.push(`${slot}: ${pkg.name}`);
  }
  if (op.auto_size !== undefined) {
    if (op.auto_size) delete next.autoSize;
    else next.autoSize = false;
    changes.push(`automatic sizing ${op.auto_size ? 'on' : 'off'}`);
  }
  if (Object.keys(next).length) d.packageDefaults = next;
  else delete d.packageDefaults;
  return { op: 'set_package_defaults', effect: `package defaults: ${changes.join(', ') || 'unchanged'}`, ids: ['packages'] };
}

/** Standard-value series per kind of generic passive; null clears one (any value). */
export function setValueSeries(d: Design, op: Extract<EditOp, { op: 'set_value_series' }>): OpResult {
  const next = { ...(d.valueSeries ?? {}) };
  const pick = (one: ESeries | null | undefined) => (one !== undefined ? one : op.all);
  const given: [keyof ValueSeries, ESeries | null | undefined][] = [
    ['resistor', pick(op.resistors)],
    ['capacitor', pick(op.capacitors)],
    ['inductor', pick(op.inductors)],
  ];
  const changes: string[] = [];
  for (const [kind, series] of given) {
    if (series === undefined) continue;
    if (series === null) delete next[kind];
    else next[kind] = series;
    changes.push(`${kind}s ${series ?? 'any value'}`);
  }
  if (Object.keys(next).length) d.valueSeries = next;
  else delete d.valueSeries;
  return { op: 'set_value_series', effect: `value series: ${changes.join(', ') || 'unchanged'}`, ids: ['series'] };
}

/** A part's shown name (part number); its id, which components refer to, stays. Changes the design's copy. */
export function renamePart(d: Design, op: Extract<EditOp, { op: 'rename_part' }>): OpResult {
  const byRef = findComponent(d, op.part);
  const card = cardOf(d, byRef?.part ?? op.part);
  if (!card) reject({ code: 'PART_UNKNOWN', message: `No part or component "${op.part}".`, candidates: Object.keys(d.parts).slice(0, 8) });
  if (card.id.startsWith('generic:')) reject({ code: 'PART_UNKNOWN', message: `${card.id} is a generic part; give a component its part number with set_param mpn instead.` });
  if (op.mpn === undefined && op.title === undefined) reject({ code: 'PART_UNKNOWN', message: 'rename_part needs mpn or title.' });
  const copy: PartCard = structuredClone(card);
  const changes: string[] = [];
  if (op.mpn !== undefined && op.mpn.trim()) {
    changes.push(`${card.mpn ?? card.id} → ${op.mpn.trim()}`);
    copy.mpn = op.mpn.trim();
  }
  if (op.title !== undefined) {
    changes.push(`title "${op.title.trim()}"`);
    if (op.title.trim()) copy.title = op.title.trim();
    else delete copy.title;
  }
  d.parts[card.id] = copy;
  const users = Object.values(d.components).filter((c) => c.part === card.id).map((c) => c.refdes).sort(natCmp);
  return { op: 'rename_part', effect: `${card.id}: ${changes.join(', ')}${users.length ? ` (${users.join(', ')})` : ''}`, ids: [card.id] };
}
