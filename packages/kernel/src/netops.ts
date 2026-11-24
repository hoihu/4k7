/**
 * The ops on the circuit: parts, connections, nets, sheets and the constraints of the ledger.
 */
import { closestPackages, isBoxSymbol, isTwoPin, packageChoice, packageOf, packageOptions, searchParts, standardPackage } from '@4k7/parts';
import { approxEqual, ASSEMBLY_HOUSES, type BoardSettings, type Component, type Constraint, DEFAULT_BOARD, FIRST_BOARD, type Design, type EditOp, type OpResult, parseQuantity, type PartCard, type PlaneArea, type SwapGroup } from '@4k7/schema';
import { keepPlacement } from './board.ts';
import { boardList, boardOf, onBoard, resolveBoard, settingsOf } from './boards.ts';
import { allocRefdes, cardOf, closest, createNet, findComponent, findNet, isAutoNet, mergeNet, natCmp, nextId, paramsOf, type PinHandle, pinLabel, reject, requireCard, resolveComponent, resolvePins, resolveUnitRef } from './doc.ts';
import { isDrawn } from './drawing.ts';
import { drawNet } from './netdraw.ts';

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
  const specs = paramsOf(card);
  for (const [key, value] of Object.entries(params)) {
    const spec = specs[key];
    if (!spec) {
      reject({
        code: 'PARAM_UNKNOWN',
        message: `${refdes} (${card.id}) has no parameter "${key}". Allowed: ${Object.keys(specs).join(', ')}.`,
        candidates: Object.keys(specs),
      });
    }
    // an assembly house's part number, in the house's form
    const house = value !== null ? ASSEMBLY_HOUSES.find((h) => h.param === key) : undefined;
    if (house) {
      const n = house.normalize(value!);
      if (!n) reject({ code: 'PARAM_INVALID', message: `${refdes}.${key} = "${value}" is not ${key === 'lcsc' ? 'an LCSC part number (a C followed by digits, ' : `a ${house.numberName} (`}e.g. ${house.example}).` });
      params[key] = n;
    }
    if (key === 'package' && value && !card.packageInfo && !standardPackage(value, card.pins.length)) {
      const opts = packageOptions(card);
      const near = closestPackages(value, card.pins.length);
      reject({
        code: 'PARAM_INVALID',
        message:
          `${refdes}: unknown package "${value}". Closest known: ${near.join(', ')}.` +
          (opts.length ? ` Known for this part: ${opts.join(', ')} (and KiCad names like R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm, CP_Radial_D8.0mm_P3.50mm).` : ''),
        candidates: [...new Set([...near, ...opts])],
      });
    }
    if (spec.values && value !== null && !spec.values.includes(value.trim().toLowerCase())) {
      reject({ code: 'PARAM_INVALID', message: `${refdes}.${key} = "${value}" is not one of ${spec.values.join(', ')}.`, candidates: spec.values });
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

export function addPart(d: Design, op: Extract<EditOp, { op: 'add_part' }>): OpResult {
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

export function remove(d: Design, ref: string): OpResult {
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

export function setParam(d: Design, ref: string, params: Record<string, string | null>): OpResult {
  const c = resolveComponent(d, ref);
  const card = requireCard(d, c);
  validateParams(card, params, c.refdes);
  const pkgBefore = packageOf(card, c.params, d.packageDefaults)?.name;
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
  // a value that sizes the part up (or back down) changes its footprint: say so, the board's land changes with it
  const pkgAfter = packageOf(card, c.params, d.packageDefaults)?.name;
  let moved = '';
  if (pkgBefore && pkgAfter && pkgBefore !== pkgAfter) {
    const choice = packageChoice(card, c.params, d.packageDefaults);
    const why = choice?.why === 'auto' && choice.reason ? ` (${choice.reason})` : '';
    moved = `; package ${pkgBefore} → ${pkgAfter}${why}: its footprint on the board changes with it`;
  }
  return { op: 'set_param', effect: `${c.refdes}: ${Object.entries(params).map(([k, v]) => `${k}=${v ?? '∅'}`).join(', ')}${moved}`, ids: [c.id] };
}

/** Do not populate, or fit again (docs/design/assembly.md §8): the part stays in the netlist and on the board. */
export function setDnp(d: Design, refs: string[], dnp: boolean): OpResult {
  const comps = refs.map((r) => resolveComponent(d, r));
  for (const c of comps) {
    if (dnp) c.dnp = true;
    else delete c.dnp;
  }
  return { op: 'set_dnp', effect: `${comps.map((c) => c.refdes).join(', ')}: ${dnp ? 'do not populate' : 'fitted'}`, ids: comps.map((c) => c.id) };
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

export function rename(d: Design, ref: string, refdes: string): OpResult {
  const c = resolveComponent(d, ref);
  const other = findComponent(d, refdes);
  if (other && other.id !== c.id) {
    const free = allocRefdes(d, refdes.replace(/\d+$/, ''));
    reject({
      code: 'REFDES_TAKEN',
      message: `${refdes} already exists. To swap ${c.refdes} and ${refdes}, rename one through a free name first (${refdes} → ${free}, ${c.refdes} → ${refdes}, ${free} → ${c.refdes}).`,
      candidates: [free],
    });
  }
  const old = c.refdes;
  c.refdes = refdes;
  // waivers name entities by refdes ("U1", "U1.EN"); keep them on the renamed part
  for (const w of Object.values(d.waivers)) {
    w.entities = w.entities.map((e) => (e === old ? refdes : e.startsWith(`${old}.`) ? refdes + e.slice(old.length) : e));
  }
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

export function connect(d: Design, refs: string[], netName?: string): OpResult {
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

export function disconnect(d: Design, refs: string[]): OpResult {
  const pins = flatPins(d, refs);
  for (const h of pins) delete h.comp.pins[h.pin.number];
  return { op: 'disconnect', effect: `disconnected ${pins.map(pinLabel).join(', ')}` };
}

/**
 * Swaps two pins, or the two gates they sit in, of one component: only inside a swap group of its
 * part card (a wrong swap is a dead board, so nothing is guessed). Their nets, no-connect marks and
 * the net loads naming them change places. See docs/design/ops-api.md.
 */
export function swapPins(d: Design, refA: string, refB: string): OpResult {
  const one = (ref: string): PinHandle => {
    const hs = resolvePins(d, ref);
    if (hs.length > 1) reject({ code: 'SWAP_INVALID', message: `${ref} names ${hs.length} pins; give one by number (${hs.map((h) => `${h.comp.refdes}.${h.pin.number}`).join(', ')}).` });
    return hs[0]!;
  };
  const a = one(refA);
  const b = one(refB);
  const bad = (message: string): never => reject({ code: 'SWAP_INVALID', message });
  if (a.comp.id !== b.comp.id) bad(`${pinLabel(a)} and ${pinLabel(b)} are on different components; a swap stays inside one part.`);
  if (a.pin.number === b.pin.number) bad(`${pinLabel(a)} and ${pinLabel(b)} are the same pin.`);
  const card = requireCard(d, a.comp);
  const groups = card.swapGroups ?? [];
  if (!groups.length) bad(`${card.id} declares no swappable pins: its pins stay where they are.`);
  const memberOf = (g: SwapGroup, n: string) => g.members.find((m) => m.includes(n));
  const list = groups.map((g) => `${g.name} (${g.members.map((m) => m.join('/')).join(', ')})`).join('; ');
  for (const h of [a, b]) if (!groups.some((g) => memberOf(g, h.pin.number))) bad(`${pinLabel(h)} is in no swap group of ${card.id}; groups: ${list}.`);
  // a pin may be in several groups (an array's resistor ends, and the resistors as gates): the one holding both
  const g = groups.find((x) => memberOf(x, a.pin.number) && memberOf(x, b.pin.number) && memberOf(x, a.pin.number) !== memberOf(x, b.pin.number));
  if (!g) {
    if (groups.some((x) => memberOf(x, a.pin.number) && memberOf(x, a.pin.number) === memberOf(x, b.pin.number))) bad(`${pinLabel(a)} and ${pinLabel(b)} are in the same gate; swap whole gates (pins at the same place in two gates).`);
    bad(`${pinLabel(a)} and ${pinLabel(b)} are in different swap groups of ${card.id}, so they are not interchangeable; groups: ${list}.`);
  }
  const [ga, gb] = [a, b].map((h) => {
    const m = memberOf(g!, h.pin.number)!;
    return { m, at: m.indexOf(h.pin.number) };
  }) as [{ m: string[]; at: number }, { m: string[]; at: number }];
  if (ga.m.length !== gb.m.length) bad(`The members of ${pinLabel(a)} and ${pinLabel(b)} have different shapes (${ga.m.length} and ${gb.m.length} pins); ${card.id}'s swap group ${g!.name} is malformed.`);
  if (ga.at !== gb.at) bad(`${pinLabel(a)} and ${pinLabel(b)} sit at different places in their gates (${ga.at + 1} and ${gb.at + 1} of ${ga.m.join('/')} and ${gb.m.join('/')}); name the matching pins, e.g. two IN+ pins.`);
  const c = a.comp;
  const other = new Map<string, string>();
  ga.m.forEach((n, i) => (other.set(n, gb.m[i]!), other.set(gb.m[i]!, n)));
  if (g!.functions) gpioSwapCheck(d, c, card, g!, other, bad);
  const pins = { ...c.pins };
  for (const [n, o] of other) {
    if (pins[o]) c.pins[n] = pins[o];
    else delete c.pins[n];
  }
  c.noConnect = c.noConnect.map((n) => other.get(n) ?? n);
  for (const net of Object.values(d.nets)) {
    for (const l of net.attrs.loads ?? []) if (l.componentId === c.id) l.pins = l.pins.map((n) => other.get(n) ?? n);
  }
  const name = (n: string) => card.pins.find((p) => p.number === n)!;
  const moved = [...other].map(([n]) => `${pinLabel({ comp: c, pin: name(n) })} → ${c.pins[n] ? d.nets[c.pins[n]]!.name : 'unconnected'}`);
  return { op: 'swap_pins', effect: `swapped ${moved.join(', ')}`, ids: [c.id] };
}

/** A need ("SCL", "GPIO", "ADC*") a pin function offers: the same name, or for "X*" X with a channel number. */
const offersNeed = (fns: string[], need: string) =>
  need === 'GPIO' || fns.some((f) => (need.endsWith('*') ? f.startsWith(need.slice(0, -1)) && /^\d+$/.test(f.slice(need.length - 1)) : f === need));

/**
 * A swap in a group of MCU GPIOs: each net moved needs on its new pin every function it uses
 * (set_net needs); a net whose needs are not recorded moves only to a pin offering the same
 * functions, as nothing tells which of them it uses. See docs/design/layout.md §10.
 */
function gpioSwapCheck(d: Design, c: Component, card: PartCard, g: SwapGroup, other: Map<string, string>, bad: (m: string) => never) {
  const offers = (n: string) => g.functions![n] ?? [];
  const label = (n: string) => pinLabel({ comp: c, pin: card.pins.find((p) => p.number === n)! });
  const fnText = (n: string) => (offers(n).length ? offers(n).join(', ') : 'plain I/O only');
  for (const [from, to] of other) {
    const net = c.pins[from] ? d.nets[c.pins[from]!] : undefined;
    if (!net) continue;
    const needs = net.attrs.needs;
    if (!needs) {
      const same = offers(from).length === offers(to).length && offers(from).every((f) => offers(to).includes(f));
      if (!same) bad(`${net.name} would move from ${label(from)} (${fnText(from)}) to ${label(to)} (${fnText(to)}), and nothing records which function it uses. Say it first with set_net needs (e.g. ["GPIO"] for plain digital I/O, ["SCL"], ["ADC*"]), from the circuit and the firmware.`);
      continue;
    }
    const missing = needs.filter((x) => !offersNeed(offers(to), x));
    if (missing.length) bad(`${net.name} needs ${missing.join(', ')}, which ${label(to)} does not offer (${fnText(to)}); moving it there would break it.`);
  }
}

export function noConnect(d: Design, refs: string[]): OpResult {
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

export function setNet(d: Design, op: Extract<EditOp, { op: 'set_net' }>): OpResult {
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
  if (op.loads !== undefined) {
    if (op.loads === null) delete a.loads;
    else {
      // each pin of the net (a name on several pins: those on this net), drawing more than nothing
      a.loads = op.loads.map((l) => {
        if (!(l.amps > 0)) reject({ code: 'PARAM_INVALID', message: `${l.pin} draws ${l.amps} A: give what it draws, more than 0 A (leave it out if it draws nothing).` });
        const hs = resolvePins(d, l.pin);
        const on = hs.filter((h) => h.comp.pins[h.pin.number] === net.id);
        if (!on.length) {
          const other = hs[0]!.comp.pins[hs[0]!.pin.number];
          reject({ code: 'NET_MISMATCH', message: `${l.pin} is ${other ? `on ${d.nets[other]?.name ?? other}` : 'not connected'}, not on ${net.name}: a load is a pin of the net it draws from.` });
        }
        return { componentId: on[0]!.comp.id, pins: on.map((h) => h.pin.number), amps: l.amps };
      });
    }
    changes.push(op.loads === null ? 'no loads' : `loads ${op.loads.map((l) => `${l.pin} ${l.amps} A`).join(', ')}`);
  }
  // board: track_mm on that board only (docs/design/multi-board.md)
  if (op.board !== undefined && op.track_mm === undefined) reject({ code: 'INVALID_OP', message: 'set_net board names the board a track_mm is for: give track_mm too (the other settings are the net\'s on every board).' });
  const widthOn = op.board !== undefined ? resolveBoard(d, op.board) : undefined;
  if (op.track_mm !== undefined) {
    let mm: number | undefined;
    if (op.track_mm !== null) {
      if (op.track_mm < 0.1 || op.track_mm > 10) reject({ code: 'PARAM_INVALID', message: `A track of ${op.track_mm} mm cannot be made; give 0.1–10 mm.` });
      const fab = widthOn ? settingsOf(d, widthOn.id)?.fab : d.board?.fab;
      if (fab && op.track_mm < fab.limits.track - 1e-9) reject({ code: 'FAB_LIMIT', message: `A ${op.track_mm} mm track is below ${fab.house}'s limit (${fab.limits.track} mm, ${fab.tier}).` });
      mm = Math.round(op.track_mm * 1000) / 1000;
    }
    if (widthOn) {
      const on = { ...a.boardTrackWidths };
      if (mm === undefined) delete on[widthOn.id];
      else on[widthOn.id] = mm;
      if (Object.keys(on).length) a.boardTrackWidths = on;
      else delete a.boardTrackWidths;
      changes.push(`track on ${widthOn.name} ${mm === undefined ? `as the net's (${a.trackWidth ? `${a.trackWidth} mm` : 'default'})` : `${mm} mm`}`);
    } else {
      if (mm === undefined) delete a.trackWidth;
      else a.trackWidth = mm;
      // the boards with their own width keep it
      const own = Object.entries(a.boardTrackWidths ?? {}).map(([id, w]) => `${boardList(d).find((b) => b.id === id)?.name ?? id} ${w} mm`);
      changes.push(`track ${mm === undefined ? 'default' : `${mm} mm`}${own.length ? ` (own width kept on ${own.join(', ')})` : ''}`);
    }
  }
  if (op.route_first !== undefined) {
    if (op.route_first) a.routeFirst = true;
    else delete a.routeFirst;
    changes.push(op.route_first ? 'routed first' : 'routed as any other');
  }
  if (op.layer !== undefined) {
    if (op.layer === null) delete a.layer;
    else {
      // (several boards: the fewest layers of the boards its pins are on)
      const on = new Set(Object.values(d.components).filter((c) => Object.values(c.pins).includes(net.id)).map((c) => boardOf(d, c)));
      const n = Math.min(...[...(on.size ? on : [FIRST_BOARD])].map((id) => settingsOf(d, id)?.layers ?? DEFAULT_BOARD.layers));
      const has = n === 4 ? ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] : ['F.Cu', 'B.Cu'];
      if (!has.includes(op.layer)) reject({ code: 'BOARD_INVALID', message: `${op.layer} does not exist on a ${n}-layer board.`, candidates: has });
      a.layer = op.layer;
    }
    changes.push(op.layer ? `tracks on ${op.layer} where they can` : 'tracks on any layer');
  }
  if (op.needs !== undefined) {
    if (op.needs === null) delete a.needs;
    else a.needs = [...new Set(op.needs)];
    changes.push(op.needs === null ? 'needs no recorded pin function' : `needs ${a.needs!.join(', ')}`);
  }
  if (op.draw_as !== undefined && (op.draw_as ?? undefined) !== a.drawAs) {
    if (op.draw_as === null) delete a.drawAs;
    else a.drawAs = op.draw_as;
    const left = drawNet(d, net.id, op.draw_as ?? 'auto');
    changes.push(op.draw_as === 'label' ? 'drawn by labels, no wires' : op.draw_as === 'wire' ? `drawn by wires, no labels${left ? ` (${left} left where no wire can go: another page or sheet, or no clear path)` : ''}` : 'drawn as it draws best');
  }
  return { op: 'set_net', effect: `net ${net.name}: ${changes.join(', ') || 'no change'}`, ids: [net.id] };
}

/* --------------------------------- sheets --------------------------------- */
function firstSheet(d: Design): string {
  return Object.values(d.sheets).sort((a, b) => a.order - b.order)[0]!.id;
}

function sheetByName(d: Design, name: string, hint = ' Add it with add_sheet first.'): string {
  const s = Object.values(d.sheets).find((x) => x.name.toLowerCase() === name.toLowerCase() || x.id === name);
  if (!s) reject({ code: 'SHEET_UNKNOWN', message: `No sheet "${name}".${hint}`, candidates: Object.values(d.sheets).map((x) => x.name) });
  return s.id;
}

export function addSheet(d: Design, name: string): OpResult {
  if (Object.values(d.sheets).some((s) => s.name.toLowerCase() === name.toLowerCase())) {
    return { op: 'add_sheet', effect: `sheet ${name} already exists` };
  }
  const id = nextId(d, 's');
  // (after the last one: a sheet removed leaves a gap in the order)
  d.sheets[id] = { id, name, order: Math.max(-1, ...Object.values(d.sheets).map((s) => s.order)) + 1 };
  return { op: 'add_sheet', effect: `added sheet ${name}`, ids: [id] };
}

export function moveToSheet(d: Design, refs: string[], sheet: string): OpResult {
  const sid = sheetByName(d, sheet);
  const cs = refs.map((r) => resolveComponent(d, r));
  const from = new Set(cs.map((c) => c.sheet));
  for (const c of cs) c.sheet = sid;
  const left = [...from].filter((id) => id !== sid && !partsOn(d, id).length).map((id) => d.sheets[id]!.name);
  return { op: 'move_to_sheet', effect: `moved ${cs.map((c) => c.refdes).join(', ')} to ${d.sheets[sid]!.name}${left.length ? `; nothing left on ${left.join(', ')}: an empty sheet still takes a page, remove_sheet takes it away` : ''}` };
}

const partsOn = (d: Design, sheetId: string) => Object.values(d.components).filter((c) => c.sheet === sheetId);

/** A sheet's stored drawing goes (not releaseSheet: parts that just left it are drawn where they are now, not where they stood). */
function dropDrawing(d: Design, sheetId: string): void {
  if (!d.drawing?.[sheetId]) return;
  delete d.drawing[sheetId];
  if (!Object.keys(d.drawing).length) delete d.drawing;
}

/** Take an empty sheet away. One with parts stays until they are moved or cleared, and a design keeps one sheet. */
export function removeSheet(d: Design, name: string): OpResult {
  const id = sheetByName(d, name, '');
  const sheet = d.sheets[id]!;
  if (Object.keys(d.sheets).length === 1) {
    reject({ code: 'INVALID_OP', message: `${sheet.name} is the design's only sheet, and a design keeps one. clear_sheet takes its parts off to start it over.` });
  }
  const on = partsOn(d, id).map((c) => c.refdes).sort(natCmp);
  if (on.length) {
    reject({
      code: 'SHEET_NOT_EMPTY',
      message: `Sheet ${sheet.name} has ${on.length} part${on.length === 1 ? '' : 's'} on it (${on.slice(0, 8).join(', ')}${on.length > 8 ? ', …' : ''}). Move them to another sheet (move_to_sheet), or if the user wants them gone take them off (clear_sheet), then remove the sheet.`,
    });
  }
  delete d.sheets[id];
  dropDrawing(d, id);
  const placements = Object.values(d.ledger).filter((k) => k.sheet === id).map((k) => k.id);
  for (const k of placements) delete d.ledger[k];
  return { op: 'remove_sheet', effect: `removed sheet ${sheet.name}`, ids: [id, ...placements] };
}

/**
 * Take the parts off a sheet (all but `keep`) the way remove takes one, with what only they gave a
 * reason for: the waivers naming them or a net they leave without pins (a new part or net of that
 * name must not inherit one), the description's blocks left without a part, and what stood on them
 * on the board (clearBoard). A sheet left with nothing goes back to the auto-layout, so what comes
 * next on it is drawn afresh.
 */
export function clearSheet(d: Design, op: Extract<EditOp, { op: 'clear_sheet' }>): OpResult {
  const id = sheetByName(d, op.sheet, '');
  const name = d.sheets[id]!.name;
  const keep = new Set((op.keep ?? []).map((r) => resolveComponent(d, r).id));
  const parts = partsOn(d, id).filter((c) => !keep.has(c.id));
  if (!parts.length) return { op: 'clear_sheet', effect: `${name} has no parts to take off` };
  const ids = parts.flatMap((c) => remove(d, c.refdes).ids ?? []);
  let constraints = ids.length - parts.length;

  const refs = new Set(parts.map((c) => c.refdes));
  const wired = new Set(Object.values(d.components).flatMap((c) => Object.values(c.pins)));
  const nets = new Set(Object.values(d.nets).filter((n) => !wired.has(n.id)).map((n) => n.name));
  let waivers = 0;
  for (const w of Object.values(d.waivers)) {
    w.entities = w.entities.filter((e) => !refs.has(e.split('.')[0]!) && !nets.has(e.replace(/^net:/, '')));
    if (w.entities.length) continue;
    delete d.waivers[w.id];
    waivers++;
  }

  let blocks = 0;
  if (d.description) {
    const left = d.description.blocks.map((b) => ({ ...b, components: b.components.filter((c) => d.components[c]) })).filter((b) => b.components.length);
    blocks = d.description.blocks.length - left.length;
    if (left.length || d.description.overview) d.description = { ...d.description, blocks: left };
    else delete d.description;
  }

  const titles = new Set(d.description?.blocks.map((b) => b.title));
  const emptied = !partsOn(d, id).length;
  for (const k of Object.values(d.ledger)) {
    if (k.kind !== 'sch_block' || (titles.has(k.key ?? '') && !(emptied && k.sheet === id))) continue;
    delete d.ledger[k.id];
    constraints++;
  }
  if (emptied) dropDrawing(d, id);

  const also = [...plural(constraints, 'constraint'), ...plural(waivers, 'waiver'), ...plural(blocks, 'description block'), ...clearBoard(d, wired)];
  const stay = partsOn(d, id).map((c) => c.refdes).sort(natCmp);
  return {
    op: 'clear_sheet',
    effect:
      `took ${plural(parts.length, 'part')[0]} off ${name}${also.length ? `, and ${also.join(', ')} that went with them` : ''}` +
      (stay.length ? `; ${stay.join(', ')} stay` : '') +
      (d.description?.overview ? '; the overview may no longer hold: rewrite it with describe' : ''),
    ids: [id, ...ids],
  };
}

const plural = (n: number, what: string) => (n ? [`${n} ${what}${n === 1 ? '' : 's'}`] : []);

/**
 * Take off the board what stood on nets left without pins and on parts that are gone: drawn copper,
 * via groups, planes, impedance rules, keep-outs. It has no use any more (a net of the same name is
 * a new net), and the agent could not even name those nets to erase it. A mounting hole stays, on
 * no net. With no plane left the board is back to its automatic planes. Says what went.
 */
function clearBoard(d: Design, wired: ReadonlySet<string>): string[] {
  // every board's (several boards: each keeps its own objects)
  return boardList(d).flatMap(({ id }) => clearSettings(d, settingsOf(d, id), wired));
}

function clearSettings(d: Design, b: BoardSettings | undefined, wired: ReadonlySet<string>): string[] {
  if (!b) return [];
  const said: string[] = [];
  const thin = <T>(list: T[], goes: (x: T) => boolean, what: string): T[] => {
    const left = list.filter((x) => !goes(x));
    said.push(...plural(list.length - left.length, what));
    return left;
  };
  const off = (netId: string) => !wired.has(netId);
  const gone = (id: string) => !d.components[id];
  const underNothing = (a?: PlaneArea) => !!a?.under?.length && a.under.every(gone);
  if (b.drawn) {
    b.drawn.tracks = thin(b.drawn.tracks, (t) => off(t.netId), 'track');
    b.drawn.vias = thin(b.drawn.vias, (v) => off(v.netId), 'via');
  }
  if (b.vias) b.vias = thin(b.vias, (v) => off(v.netId) || (!!v.along && off(v.along)) || (!!v.pad && gone(v.pad.componentId)) || underNothing(v.area), 'via group');
  if (b.planes) {
    b.planes = thin(b.planes, (p) => off(p.netId) || underNothing(p.area), 'plane');
    if (!b.planes.length) delete b.planes;
  }
  if (b.impedance) b.impedance = thin(b.impedance, (r) => r.nets.some(off), 'impedance rule');
  if (b.keepouts) b.keepouts = thin(b.keepouts, (k) => !!k.part && gone(k.part), 'keep-out');
  for (const h of b.holes ?? []) if (h.netId && off(h.netId)) delete h.netId;
  return said;
}

/* ------------------------------- constraints ------------------------------ */
const DIRECTIONAL = new Set(['left_of', 'right_of', 'above', 'below']);

const OPPOSITE: Record<string, string> = { left_of: 'right_of', right_of: 'left_of', above: 'below', below: 'above' };

const axis = (kind: string) => (kind === 'left_of' || kind === 'right_of' ? 'h' : 'v');

/** An arrangement value that says whether an IC or connector is drawn mirrored. */
const mirrors = (v?: string) => v === 'mirrored' || v === 'unmirrored';

export function constrain(d: Design, op: Extract<EditOp, { op: 'constrain' }>): OpResult {
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
    const card = requireCard(d, a);
    const category = card.category;
    // a two-pin part at an IC's or connector's pin: which way it stands from the pin's wire
    const standing = isTwoPin(card) ? ['up', 'down'] : [];
    // an IC or connector in a functional block: drawn with its left pins on the right, or not
    const mirror = isBoxSymbol(card) ? ['mirrored', 'unmirrored'] : [];
    const allowed = [...(category === 'diode' ? ['diamond', 'inline'] : category === 'ic' ? ['power_flow', 'compact'] : []), ...standing, ...mirror];
    if (!allowed.length) {
      reject({ code: 'CONSTRAINT_INVALID', message: `arrangement applies to diode bridges, ICs, connectors and two-pin parts; ${a.refdes} is none of them.` });
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
    // the part turns over where the user sees it: the rest of the board (its board) stays as it is
    const on = boardOf(d, d.components[k.a]!);
    if (!settingsOf(d, on)?.placement && Object.keys(d.components).length) onBoard(d, on, keepPlacement);
  } else if (op.kind === 'room') {
    need(op.block, '"block" (a functional block\'s title)');
    if (!op.rect) reject({ code: 'CONSTRAINT_INVALID', message: 'room needs "rect" (x, y, w, h in mm: the area on the board the block keeps to).' });
    const blocks = d.description?.blocks ?? [];
    const want = op.block!.trim();
    const block = blocks.find((b) => b.title === want) ?? blocks.find((b) => b.title.toLowerCase() === want.toLowerCase());
    if (!block) {
      reject({
        code: 'REF_UNKNOWN',
        message: blocks.length ? `room: no block "${op.block}".` : 'room: the design has no functional blocks yet: group its parts first (describe blocks: a title and the parts of each).',
        candidates: closest(want, blocks.map((b) => b.title)),
      });
    }
    k.key = block!.title;
    Object.assign(k, { xMm: op.rect!.x, yMm: op.rect!.y, wMm: op.rect!.w, hMm: op.rect!.h });
    // the block moves into its room where the user sees the board (its parts' board): the rest stays as it is
    const first = d.components[block!.components.find((id) => d.components[id]) ?? ''];
    const on = first ? boardOf(d, first) : FIRST_BOARD;
    if (!settingsOf(d, on)?.placement && Object.keys(d.components).length) onBoard(d, on, keepPlacement);
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
      (k.kind === 'room' && old.kind === 'room' && old.key === k.key) ||
      // (a regulator's power_flow / compact and its mirroring are two choices, kept side by side)
      (k.kind === 'arrangement' && old.kind === 'arrangement' && old.a === k.a && mirrors(old.value) === mirrors(k.value));
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
  // an order only guides the auto-layout: on a sheet the agent arranged it waits for auto_draw
  const drawn = k.domain === 'schematic' && k.a && d.components[k.a] && isDrawn(d, d.components[k.a]!.sheet) ? d.sheets[d.components[k.a]!.sheet]!.name : undefined;
  return {
    op: 'constrain',
    effect: `${describeConstraint(d, d.ledger[id]!)}` + (replaced.length ? ` (replaces ${replaced.join(', ')})` : '') + (drawn ? `; sheet ${drawn} is drawn as you arranged it, so this guides the layout only after auto_draw (place_symbol moves the part now)` : ''),
    ids: [id],
  };
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
    case 'room':
      return `room("${k.key}") = ${k.wMm} × ${k.hMm} mm at (${k.xMm}, ${k.yMm})`;
    case 'arrangement':
      return `arrangement(${n(k.a)}) = ${k.value}`;
    case 'belongs':
      return k.b ? `belongs(${n(k.a)}, ${n(k.b)}${k.key ? `.${k.key}` : ''})` : `belongs(${n(k.a)}, none)`;
    case 'position':
      return `position(${n(k.a)}) = (${k.xMm}, ${k.yMm}) mm${k.rel ? ` from ${n(k.rel)}` : ''}${k.rot !== undefined ? ` ${k.rot}°` : ''}${k.strength === 'hard' ? ', locked' : ''}`;
    case 'sch_position':
      return `${n(k.a)}${k.aUnit ?? ''} placed on page ${k.page} at (${k.x}, ${k.y}) mils${k.orient ? `, ${k.orient}` : ''}${k.mirror !== undefined ? (k.mirror ? ', mirrored' : ', not mirrored') : ''}${k.rotated ? `, rotated ${k.rotated}°` : ''}`;
    case 'sch_block':
      return `block "${k.key}" placed on page ${k.page} of sheet ${d.sheets[k.sheet ?? '']?.name ?? k.sheet} at (${k.x}, ${k.y}) mils`;
    case 'note':
      return `note${k.a ? `(${n(k.a)})` : ''}: ${k.value}`;
    default:
      return `${k.kind}(${ref(k.a)}${k.aUnit ?? ''}, ${ref(k.b)}${k.bUnit ?? ''})`;
  }
}
