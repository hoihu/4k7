/**
 * Executes edit ops on a (cloned) design. Every op either applies fully or throws a
 * RejectError with an actionable reason. Transactions are handled by the Kernel.
 */
import {
  approxEqual,
  parseQuantity,
  type Component,
  type Constraint,
  type Design,
  type EditOp,
  type OpResult,
  type PartCard,
} from '@tracewise/schema';
import { isTwoPin, planUnits, searchParts } from '@tracewise/parts';
import {
  allocRefdes,
  cardOf,
  closest,
  createNet,
  findComponent,
  findNet,
  isAutoNet,
  mergeNet,
  natCmp,
  nextId,
  pinLabel,
  reject,
  requireCard,
  resolveComponent,
  resolvePins,
  type PinHandle,
} from './doc.ts';

export function applyOp(d: Design, op: EditOp): OpResult {
  switch (op.op) {
    case 'add_part':
      return addPart(d, op);
    case 'remove':
      return remove(d, op.ref);
    case 'set_param':
      return setParam(d, op.ref, op.params);
    case 'rename':
      return rename(d, op.ref, op.refdes);
    case 'connect':
      return connect(d, op.pins, op.net);
    case 'disconnect':
      return disconnect(d, op.pins);
    case 'no_connect':
      return noConnect(d, op.pins);
    case 'set_net':
      return setNet(d, op);
    case 'add_sheet':
      return addSheet(d, op.name);
    case 'move_to_sheet':
      return moveToSheet(d, op.refs, op.sheet);
    case 'constrain':
      return constrain(d, op);
    case 'remove_constraint': {
      if (!d.ledger[op.id]) reject({ code: 'REF_UNKNOWN', message: `No constraint ${op.id}.`, candidates: Object.keys(d.ledger) });
      delete d.ledger[op.id];
      return { op: op.op, effect: `removed constraint ${op.id}`, ids: [op.id] };
    }
    case 'add_waiver': {
      const id = nextId(d, 'w');
      d.waivers[id] = { id, code: op.code, entities: [...op.entities], reason: op.reason, by: 'agent' };
      return { op: op.op, effect: `waived ${op.code} for ${op.entities.join(', ')}`, ids: [id] };
    }
    case 'set_symbol':
      return setSymbol(d, op.ref, op.style);
    case 'remove_waiver': {
      if (!d.waivers[op.id]) reject({ code: 'WAIVER_UNKNOWN', message: `No waiver ${op.id}.`, candidates: Object.keys(d.waivers) });
      delete d.waivers[op.id];
      return { op: op.op, effect: `removed waiver ${op.id}`, ids: [op.id] };
    }
  }
}

/* --------------------------------- parts ---------------------------------- */

/** Draw a part as one symbol or as units. Changes the design's copy of the part card only. */
function setSymbol(d: Design, ref: string, style: 'single' | 'units'): OpResult {
  const comp = resolveComponent(d, ref);
  const card = cardOf(d, comp.part)!;
  if (style === 'units' && (isTwoPin(card) || card.pins.length < 12)) {
    reject({ code: 'SYMBOL_STYLE', message: `${comp.refdes} (${card.id}) has ${card.pins.length} pins; only large ICs can be split into units.` });
  }
  const users = Object.values(d.components).filter((c) => c.part === card.id).map((c) => c.refdes).sort(natCmp);
  const copy: PartCard = structuredClone(card);
  if (style === 'units') copy.units = planUnits(copy.pins);
  else delete copy.units;
  d.parts[card.id] = copy;
  const what = style === 'units' ? `${copy.units!.length} units (${copy.units!.map((u) => `${u.name}: ${u.title}`).join('; ')})` : 'one symbol';
  return { op: 'set_symbol', effect: `${users.join(', ')} drawn as ${what}`, ids: [card.id] };
}

function lookupCard(d: Design, id: string): PartCard {
  const card = cardOf(d, id);
  if (!card) {
    const hits = searchParts(id.replace(/^[a-z]+:/i, ''), Object.values(d.parts)).slice(0, 5);
    reject({
      code: 'PART_UNKNOWN',
      message: `No part "${id}" in the library. Use design_query search_parts to find one.`,
      candidates: hits.map((p) => p.id),
    });
  }
  return card;
}

function validateParams(card: PartCard, params: Record<string, string | null>, refdes: string): void {
  for (const [key, value] of Object.entries(params)) {
    const spec = card.params[key];
    if (!spec) {
      reject({
        code: 'PARAM_UNKNOWN',
        message: `${refdes} (${card.id}) has no parameter "${key}". Allowed: ${Object.keys(card.params).join(', ') || 'none'}.`,
        candidates: Object.keys(card.params),
      });
    }
    if (value === null || !spec.unit) continue;
    const q = parseQuantity(value);
    const range = PLAUSIBLE[spec.unit];
    if (!q || (q.unit !== '' && q.unit !== spec.unit) || !(q.value > 0) || (range && (q.value < range[0] || q.value > range[1]))) {
      reject({
        code: 'PARAM_INVALID',
        message: `${refdes}.${key} = "${value}" is not a valid value in ${spec.unit} (examples: ${example(spec.unit)}).`,
      });
    }
  }
}

/** Plausible magnitude per unit; catches "10k" typed for a capacitance. */
const PLAUSIBLE: Record<string, [number, number]> = {
  F: [1e-14, 10],
  H: [1e-10, 100],
  'Ω': [1e-4, 1e10],
  V: [1e-3, 1e5],
  A: [1e-9, 1e4],
  W: [1e-4, 1e4],
};

function example(unit: string): string {
  return ({ F: '100nF, 4.7uF', 'Ω': '10k, 4k7, 100R', H: '10uH', V: '25V', A: '2A', W: '0.25W' } as Record<string, string>)[unit] ?? `1${unit}`;
}

function addPart(d: Design, op: Extract<EditOp, { op: 'add_part' }>): OpResult {
  const card = lookupCard(d, op.part);
  if (op.refdes && findComponent(d, op.refdes)) {
    reject({ code: 'REFDES_TAKEN', message: `${op.refdes} already exists.`, candidates: [allocRefdes(d, card.refPrefix)] });
  }
  const refdes = op.refdes ?? allocRefdes(d, card.refPrefix);
  const params = op.params ?? {};
  validateParams(card, params, refdes);
  const missing = Object.entries(card.params)
    .filter(([k, s]) => s.required && params[k] === undefined)
    .map(([k]) => k);
  if (missing.length) {
    reject({
      code: 'PARAM_INVALID',
      message: `${card.id} requires ${missing.join(', ')}; pass them in params.`,
    });
  }
  const sheet = op.sheet ? sheetByName(d, op.sheet) : firstSheet(d);
  const id = nextId(d, 'c');
  if (!d.parts[card.id]) d.parts[card.id] = structuredClone(card);
  const comp: Component = { id, refdes, part: card.id, sheet, params: { ...params }, pins: {}, noConnect: [] };
  d.components[id] = comp;
  return { op: 'add_part', effect: `added ${refdes} (${card.id})`, ids: [id] };
}

function remove(d: Design, ref: string): OpResult {
  const c = resolveComponent(d, ref);
  delete d.components[c.id];
  const dropped: string[] = [];
  for (const k of Object.values(d.ledger)) {
    if (k.a === c.id || k.b === c.id) {
      delete d.ledger[k.id];
      dropped.push(k.id);
    }
  }
  return {
    op: 'remove',
    effect: `removed ${c.refdes}` + (dropped.length ? ` and ${dropped.length} constraint(s) on it` : ''),
    ids: [c.id, ...dropped],
  };
}

function setParam(d: Design, ref: string, params: Record<string, string | null>): OpResult {
  const c = resolveComponent(d, ref);
  const card = requireCard(d, c);
  validateParams(card, params, c.refdes);
  for (const [key, value] of Object.entries(params)) {
    for (const k of hardParamConstraints(d, c.id, key)) {
      if (value === null || !sameValue(value, k.value ?? '')) {
        reject({
          code: 'CONSTRAINT_CONFLICT',
          message: `${c.refdes}.${key} is fixed to ${k.value} by hard constraint ${k.id}` +
            (k.source.quote ? ` ("${k.source.quote}")` : '') + '. Ask the user before changing it.',
        });
      }
    }
    if (value === null) delete c.params[key];
    else c.params[key] = value;
  }
  return { op: 'set_param', effect: `${c.refdes}: ${Object.entries(params).map(([k, v]) => `${k}=${v ?? '∅'}`).join(', ')}`, ids: [c.id] };
}

function hardParamConstraints(d: Design, compId: string, key: string): Constraint[] {
  return Object.values(d.ledger).filter((k) => k.kind === 'param' && k.strength === 'hard' && k.a === compId && k.key === key);
}

export function sameValue(a: string, b: string): boolean {
  const qa = parseQuantity(a);
  const qb = parseQuantity(b);
  if (qa && qb) return approxEqual(qa.value, qb.value, 1e-3) && (qa.unit === qb.unit || qa.unit === '' || qb.unit === '');
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function rename(d: Design, ref: string, refdes: string): OpResult {
  const c = resolveComponent(d, ref);
  const other = findComponent(d, refdes);
  if (other && other.id !== c.id) reject({ code: 'REFDES_TAKEN', message: `${refdes} already exists.` });
  const old = c.refdes;
  c.refdes = refdes;
  return { op: 'rename', effect: `renamed ${old} → ${refdes}`, ids: [c.id] };
}

/* ------------------------------- connectivity ----------------------------- */

function flatPins(d: Design, refs: string[]): PinHandle[] {
  const out: PinHandle[] = [];
  const seen = new Set<string>();
  for (const r of refs) {
    for (const h of resolvePins(d, r)) {
      const key = `${h.comp.id}.${h.pin.number}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(h);
      }
    }
  }
  return out;
}

function connect(d: Design, refs: string[], netName?: string): OpResult {
  const pins = flatPins(d, refs);
  let target = netName ? findNet(d, netName) : undefined;

  const current = [...new Set(pins.map((h) => h.comp.pins[h.pin.number]).filter((n): n is string => !!n))].map((id) => d.nets[id]!);

  if (!target) {
    if (netName) {
      target = createNet(d, netName);
    } else {
      const named = current.filter((n) => !isAutoNet(n));
      if (named.length > 1) {
        reject({
          code: 'NET_MERGE_AMBIGUOUS',
          message: `These pins are on different nets (${named.map((n) => n.name).join(', ')}). Name the target net explicitly, or disconnect first.`,
        });
      }
      target = named[0] ?? current[0] ?? createNet(d);
    }
  }

  const merged: string[] = [];
  for (const h of pins) {
    const curId = h.comp.pins[h.pin.number];
    if (curId === target.id) continue;
    if (curId) {
      const cur = d.nets[curId]!;
      if (isAutoNet(cur)) {
        mergeNet(d, cur, target);
        merged.push(cur.name);
        continue;
      }
      reject({
        code: 'PIN_ALREADY_CONNECTED',
        message: `${pinLabel(h)} is already on net ${cur.name}. Disconnect it first, or connect to ${cur.name} instead.`,
        fixHints: [{ op: 'disconnect', pins: [pinLabel(h)] }],
      });
    }
    h.comp.pins[h.pin.number] = target.id;
    h.comp.noConnect = h.comp.noConnect.filter((n) => n !== h.pin.number);
  }
  return {
    op: 'connect',
    effect: `${pins.map(pinLabel).join(', ')} → ${target.name}` + (merged.length ? ` (merged ${merged.join(', ')})` : ''),
    ids: [target.id],
  };
}

function disconnect(d: Design, refs: string[]): OpResult {
  const pins = flatPins(d, refs);
  for (const h of pins) delete h.comp.pins[h.pin.number];
  return { op: 'disconnect', effect: `disconnected ${pins.map(pinLabel).join(', ')}` };
}

function noConnect(d: Design, refs: string[]): OpResult {
  const pins = flatPins(d, refs);
  for (const h of pins) {
    const cur = h.comp.pins[h.pin.number];
    if (cur) {
      reject({
        code: 'PIN_ALREADY_CONNECTED',
        message: `${pinLabel(h)} is connected to ${d.nets[cur]!.name}; disconnect it before marking it no-connect.`,
        fixHints: [{ op: 'disconnect', pins: [pinLabel(h)] }],
      });
    }
    if (!h.comp.noConnect.includes(h.pin.number)) h.comp.noConnect.push(h.pin.number);
  }
  return { op: 'no_connect', effect: `no-connect ${pins.map(pinLabel).join(', ')}` };
}

function setNet(d: Design, op: Extract<EditOp, { op: 'set_net' }>): OpResult {
  let net = findNet(d, op.net) ?? createNet(d, op.net);
  const changes: string[] = [];
  if (op.rename && op.rename !== net.name) {
    const other = findNet(d, op.rename);
    if (other && other.id !== net.id) {
      if (!isAutoNet(net)) {
        reject({ code: 'NET_NAME_TAKEN', message: `Net ${op.rename} already exists. Connect the pins to it instead of renaming.` });
      }
      mergeNet(d, net, other);
      changes.push(`merged into ${other.name}`);
      net = other;
    } else {
      changes.push(`renamed ${net.name} → ${op.rename}`);
      net.name = op.rename;
    }
  }
  const a = net.attrs;
  if (op.voltage !== undefined) {
    if (op.voltage === null) delete a.voltage;
    else a.voltage = op.voltage;
    changes.push(`voltage=${op.voltage ?? '∅'}`);
  }
  if (op.external !== undefined) {
    if (op.external) a.external = true;
    else delete a.external;
    changes.push(`external=${op.external}`);
  }
  if (op.power !== undefined) {
    if (op.power) a.power = true;
    else delete a.power;
    changes.push(`power=${op.power}`);
  }
  if (op.max_current !== undefined) {
    if (op.max_current === null) delete a.maxCurrent;
    else a.maxCurrent = op.max_current;
    changes.push(`max_current=${op.max_current ?? '∅'}`);
  }
  return { op: 'set_net', effect: `net ${net.name}: ${changes.join(', ') || 'no change'}`, ids: [net.id] };
}

/* --------------------------------- sheets --------------------------------- */

function firstSheet(d: Design): string {
  return Object.values(d.sheets).sort((a, b) => a.order - b.order)[0]!.id;
}

function sheetByName(d: Design, name: string): string {
  const s = Object.values(d.sheets).find((x) => x.name.toLowerCase() === name.toLowerCase() || x.id === name);
  if (!s) reject({ code: 'SHEET_UNKNOWN', message: `No sheet "${name}". Add it with add_sheet first.`, candidates: Object.values(d.sheets).map((x) => x.name) });
  return s.id;
}

function addSheet(d: Design, name: string): OpResult {
  if (Object.values(d.sheets).some((s) => s.name.toLowerCase() === name.toLowerCase())) {
    return { op: 'add_sheet', effect: `sheet ${name} already exists` };
  }
  const id = nextId(d, 's');
  d.sheets[id] = { id, name, order: Object.keys(d.sheets).length };
  return { op: 'add_sheet', effect: `added sheet ${name}`, ids: [id] };
}

function moveToSheet(d: Design, refs: string[], sheet: string): OpResult {
  const sid = sheetByName(d, sheet);
  const cs = refs.map((r) => resolveComponent(d, r));
  for (const c of cs) c.sheet = sid;
  return { op: 'move_to_sheet', effect: `moved ${cs.map((c) => c.refdes).join(', ')} to ${d.sheets[sid]!.name}` };
}

/* ------------------------------- constraints ------------------------------ */

const DIRECTIONAL = new Set(['left_of', 'right_of', 'above', 'below']);
const OPPOSITE: Record<string, string> = { left_of: 'right_of', right_of: 'left_of', above: 'below', below: 'above' };
const axis = (kind: string) => (kind === 'left_of' || kind === 'right_of' ? 'h' : 'v');

function constrain(d: Design, op: Extract<EditOp, { op: 'constrain' }>): OpResult {
  const need = (v: unknown, what: string): void => {
    if (v === undefined || v === '') reject({ code: 'CONSTRAINT_INVALID', message: `${op.kind} needs ${what}.` });
  };
  const k: Omit<Constraint, 'id'> = {
    kind: op.kind,
    domain: 'placement',
    strength: op.strength ?? 'soft',
    source: { type: 'user', ...(op.quote ? { quote: op.quote } : {}) },
  };

  if (DIRECTIONAL.has(op.kind) || op.kind === 'near') {
    need(op.a, '"a"');
    need(op.b, '"b"');
    // placement on the schematic may address single units of a split symbol ("U3B")
    const units = DIRECTIONAL.has(op.kind);
    const a = units ? resolveUnitRef(d, op.a!) : { comp: resolveComponent(d, op.a!) };
    const b = units ? resolveUnitRef(d, op.b!) : { comp: resolveComponent(d, op.b!) };
    if (a.comp.id === b.comp.id && (!a.unit || !b.unit || a.unit === b.unit)) {
      reject({ code: 'CONSTRAINT_INVALID', message: `${op.kind}: a and b are the same ${a.unit && a.unit === b.unit ? 'unit' : 'component'}.` });
    }
    k.a = a.comp.id;
    k.b = b.comp.id;
    if (a.unit) k.aUnit = a.unit;
    if (b.unit) k.bUnit = b.unit;
    if (op.kind === 'near') {
      k.maxMm = op.max_mm ?? 3;
    }
  } else if (op.kind === 'param') {
    need(op.a, '"a"');
    need(op.key, '"key"');
    need(op.value, '"value"');
    const a = resolveComponent(d, op.a!);
    const card = requireCard(d, a);
    validateParams(card, { [op.key!]: op.value! }, a.refdes);
    k.a = a.id;
    k.key = op.key!;
    k.value = op.value!;
    k.domain = 'param';
  } else if (op.kind === 'arrangement') {
    need(op.a, '"a" (one of the parts of the sub-circuit)');
    const a = resolveComponent(d, op.a!);
    const category = requireCard(d, a).category;
    const allowed = category === 'diode' ? ['diamond', 'inline'] : category === 'ic' ? ['power_flow', 'compact'] : [];
    if (!allowed.length) {
      reject({ code: 'CONSTRAINT_INVALID', message: `arrangement applies to diode bridges and regulator ICs; ${a.refdes} is neither.` });
    }
    if (!allowed.includes(op.value ?? '')) {
      reject({ code: 'CONSTRAINT_INVALID', message: `arrangement for ${a.refdes}: value must be ${allowed.map((v) => `"${v}"`).join(' or ')}.` });
    }
    k.a = a.id;
    k.value = op.value;
    k.domain = 'schematic';
  } else if (op.kind === 'layer') {
    need(op.a, '"a"');
    if (op.value !== 'top' && op.value !== 'bottom') reject({ code: 'CONSTRAINT_INVALID', message: 'layer: value must be "top" or "bottom".' });
    k.a = resolveComponent(d, op.a!).id;
    k.value = op.value;
  } else {
    need(op.value, '"value" (the note text)');
    if (op.a) k.a = resolveComponent(d, op.a).id;
    k.value = op.value!;
    k.domain = 'schematic';
  }

  // Replace an older constraint on the same subject instead of stacking contradictions.
  const replaced: string[] = [];
  for (const old of Object.values(d.ledger)) {
    const samePair = old.a !== undefined && k.b !== undefined && ((old.a === k.a && old.b === k.b) || (old.a === k.b && old.b === k.a));
    const clash =
      (DIRECTIONAL.has(k.kind) && DIRECTIONAL.has(old.kind) && samePair && axis(k.kind) === axis(old.kind)) ||
      (k.kind === 'near' && old.kind === 'near' && samePair) ||
      (k.kind === 'param' && old.kind === 'param' && old.a === k.a && old.key === k.key) ||
      (k.kind === 'layer' && old.kind === 'layer' && old.a === k.a) ||
      (k.kind === 'arrangement' && old.kind === 'arrangement' && old.a === k.a);
    if (!clash) continue;
    const contradicts =
      DIRECTIONAL.has(k.kind) &&
      !((old.a === k.a && old.kind === k.kind) || (old.a === k.b && old.kind === OPPOSITE[k.kind]));
    const valueChange = (k.kind === 'param' || k.kind === 'layer' || k.kind === 'arrangement') && !sameValue(old.value ?? '', k.value ?? '');
    if (old.strength === 'hard' && (contradicts || valueChange)) {
      reject({
        code: 'CONSTRAINT_CONFLICT',
        message: `Conflicts with hard constraint ${old.id} (${describeConstraint(d, old)}). Ask the user, then remove_constraint ${old.id} first.`,
        fixHints: [{ op: 'remove_constraint', id: old.id }],
      });
    }
    delete d.ledger[old.id];
    replaced.push(old.id);
  }

  const id = nextId(d, 'k');
  d.ledger[id] = { id, ...k };
  return {
    op: 'constrain',
    effect: `${describeConstraint(d, d.ledger[id]!)}` + (replaced.length ? ` (replaces ${replaced.join(', ')})` : ''),
    ids: [id],
  };
}

/** "U3" or one unit of a split symbol, "U3B". */
function resolveUnitRef(d: Design, ref: string): { comp: Component; unit?: string } {
  const direct = findComponent(d, ref);
  if (direct) return { comp: direct };
  const m = /^(.*\d)([A-Z])$/i.exec(ref.trim());
  const comp = m ? findComponent(d, m[1]!) : undefined;
  const units = comp ? cardOf(d, comp.part)?.units ?? [] : [];
  const unit = m ? units.find((u) => u.name === m[2]!.toUpperCase()) : undefined;
  if (comp && unit) return { comp, unit: unit.name };
  if (comp) {
    reject({
      code: 'REF_UNKNOWN',
      message: units.length ? `${comp.refdes} has units ${units.map((u) => u.name).join(', ')}, not "${m![2]}".` : `${comp.refdes} is drawn as one symbol; split it first (set_symbol style "units") to place units separately.`,
      candidates: units.map((u) => `${comp.refdes}${u.name}`),
    });
  }
  return { comp: resolveComponent(d, ref) };
}

export function describeConstraint(d: Design, k: Constraint): string {
  const ref = (id?: string) => (id ? d.components[id]?.refdes ?? id : '?');
  const n = ref;
  switch (k.kind) {
    case 'param':
      return `${n(k.a)}.${k.key} = ${k.value}`;
    case 'near':
      return `near(${n(k.a)}, ${n(k.b)}, ≤${k.maxMm}mm)`;
    case 'layer':
      return `layer(${n(k.a)}) = ${k.value}`;
    case 'arrangement':
      return `arrangement(${n(k.a)}) = ${k.value}`;
    case 'note':
      return `note${k.a ? `(${n(k.a)})` : ''}: ${k.value}`;
    default:
      return `${k.kind}(${ref(k.a)}${k.aUnit ?? ''}, ${ref(k.b)}${k.bUnit ?? ''})`;
  }
}

export { closest };
