/**
 * Low-level design document helpers: ids, lookups, reference resolution.
 */
import { DEFAULT_BOARD, paramSpecs, type BoardSettings, type Component, type Constraint, type Design, type Net, type ParamSpec, type PartCard, type PartPin, type Rejection } from '@4k7/schema';
import { SYMBOL_PARAMS, getBuiltinPart, readsParams, seriesPaths } from '@4k7/parts';

export class RejectError extends Error {
  constructor(public rejection: Omit<Rejection, 'opIndex'>) {
    super(rejection.message);
  }
}

export function reject(r: Omit<Rejection, 'opIndex'>): never {
  throw new RejectError(r);
}

export function clone<T>(v: T): T {
  return structuredClone(v);
}

/** A copy of board settings. The copper kept with them is shared: thousands of numbers, a cache that is replaced, never changed in place. */
function copyBoard(board: BoardSettings): BoardSettings {
  if (!board.copper) return structuredClone(board);
  const b = structuredClone({ ...board, copper: null }) as unknown as BoardSettings;
  b.copper = board.copper;
  return b;
}

/** The board settings to change: a copy, which the op puts in place when it has done. */
export const boardCopy = (d: Design): BoardSettings => copyBoard(d.board ?? DEFAULT_BOARD);

/** A copy of a design to work on (see copyBoard). */
export function workCopy(d: Design): Design {
  if (!d.board?.copper) return structuredClone(d);
  const work = structuredClone({ ...d, board: null }) as unknown as Design;
  work.board = copyBoard(d.board);
  return work;
}

export function nextId(d: Design, prefix: string): string {
  const id = `${prefix}_${d.seq.toString(36)}`;
  d.seq += 1;
  return id;
}

export function cardOf(d: Design, partId: string): PartCard | undefined {
  return d.parts[partId] ?? getBuiltinPart(partId);
}

/**
 * The parameters a component of this card may carry: the card's own, the universal ones, and
 * those that change how it is drawn (any inductor's core, any diode's type: also on an imported
 * part, or a generic card a design copied before they existed).
 */
export function paramsOf(card: PartCard): Record<string, ParamSpec> {
  return { ...(readsParams(card) ? SYMBOL_PARAMS[card.category] : {}), ...paramSpecs(card) };
}

export function requireCard(d: Design, c: Component): PartCard {
  const card = cardOf(d, c.part);
  if (!card) throw new Error(`part card ${c.part} missing for ${c.refdes}`);
  return card;
}

/* -------------------------------- sorting --------------------------------- */

const NATURAL = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Natural sort for reference designators and names: R2 < R10. (One collator: localeCompare with options makes one per call, and this runs tens of thousands of times per edit.) */
export function natCmp(a: string, b: string): number {
  return NATURAL.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

export function componentsSorted(d: Design): Component[] {
  return Object.values(d.components).sort((a, b) => natCmp(a.refdes, b.refdes));
}

/* ------------------------------ components -------------------------------- */

export function findComponent(d: Design, ref: string): Component | undefined {
  if (d.components[ref]) return d.components[ref];
  const all = Object.values(d.components);
  return all.find((c) => c.refdes === ref) ?? all.find((c) => c.refdes.toUpperCase() === ref.toUpperCase());
}

export function resolveComponent(d: Design, ref: string): Component {
  const c = findComponent(d, ref);
  if (!c) {
    reject({
      code: 'REF_UNKNOWN',
      message: `No component "${ref}".`,
      candidates: closest(ref, Object.values(d.components).map((x) => x.refdes)),
    });
  }
  return c;
}

/** "U3" or one unit of a split symbol, "U3B". */
export function resolveUnitRef(d: Design, ref: string): { comp: Component; unit?: string } {
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

export function allocRefdes(d: Design, prefix: string): string {
  const used = new Set(Object.values(d.components).map((c) => c.refdes));
  for (let i = 1; ; i++) if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

/* ---------------------------------- pins ---------------------------------- */

export interface PinHandle {
  comp: Component;
  pin: PartPin;
}

export function pinLabel(h: PinHandle): string {
  return `${h.comp.refdes}.${h.pin.name === h.pin.number ? h.pin.number : h.pin.name}`;
}

/**
 * Resolve "U1.VIN" / "U1.2" / "U1.PB5" (matches "PB5/RESET"). A name shared by several
 * pins (e.g. GND) resolves to all of them.
 */
export function resolvePins(d: Design, ref: string): PinHandle[] {
  const dot = ref.indexOf('.');
  if (dot <= 0 || dot === ref.length - 1) {
    reject({ code: 'PIN_UNKNOWN', message: `"${ref}" is not a pin reference; use "<refdes>.<pin>", e.g. "U1.VIN".` });
  }
  const comp = resolveComponent(d, ref.slice(0, dot));
  const key = ref.slice(dot + 1);
  const card = requireCard(d, comp);

  const byNumber = card.pins.filter((p) => p.number === key);
  if (byNumber.length) return byNumber.map((pin) => ({ comp, pin }));
  const byName = card.pins.filter((p) => p.name === key);
  if (byName.length) return byName.map((pin) => ({ comp, pin }));
  const ci = key.toUpperCase();
  const loose = card.pins.filter(
    (p) => p.name.toUpperCase() === ci || p.name.toUpperCase().split('/').includes(ci),
  );
  if (loose.length) return loose.map((pin) => ({ comp, pin }));

  reject({
    code: 'PIN_UNKNOWN',
    message: `${comp.refdes} (${card.id}) has no pin "${key}".`,
    candidates: card.pins.map((p) => (p.name === p.number ? `${comp.refdes}.${p.number}` : `${comp.refdes}.${p.name}`)),
  });
}

/* ---------------------------------- nets ---------------------------------- */

export function findNet(d: Design, name: string): Net | undefined {
  if (d.nets[name]) return d.nets[name];
  const all = Object.values(d.nets);
  return all.find((n) => n.name === name) ?? all.find((n) => n.name.toUpperCase() === name.toUpperCase());
}

export function isAutoNet(n: Net): boolean {
  return /^N\$\d+$/.test(n.name);
}

export function createNet(d: Design, name?: string): Net {
  const id = nextId(d, 'n');
  const net: Net = { id, name: name ?? autoNetName(d), attrs: {} };
  d.nets[id] = net;
  return net;
}

function autoNetName(d: Design): string {
  const used = new Set(Object.values(d.nets).map((n) => n.name));
  for (let i = 1; ; i++) if (!used.has(`N$${i}`)) return `N$${i}`;
}

/** Move every pin of `from` onto `to` and delete `from`. */
export function mergeNet(d: Design, from: Net, to: Net): void {
  for (const c of Object.values(d.components)) {
    for (const [pin, net] of Object.entries(c.pins)) if (net === from.id) c.pins[pin] = to.id;
  }
  to.attrs = { ...from.attrs, ...to.attrs };
  // (an impedance rule of the net goes with it)
  for (const r of d.board?.impedance ?? []) r.nets = r.nets.map((id) => (id === from.id ? to.id : id));
  delete d.nets[from.id];
}

export interface NetPin {
  comp: Component;
  pin: PartPin;
}

/** Net id → connected pins, deterministic order. */
export function netMembers(d: Design): Map<string, NetPin[]> {
  const m = new Map<string, NetPin[]>();
  for (const n of Object.keys(d.nets)) m.set(n, []);
  for (const comp of componentsSorted(d)) {
    const card = cardOf(d, comp.part);
    if (!card) continue;
    for (const pin of card.pins) {
      const net = comp.pins[pin.number];
      if (net) m.get(net)?.push({ comp, pin });
    }
  }
  return m;
}

export function gcNets(d: Design): string[] {
  const used = new Set<string>();
  for (const c of Object.values(d.components)) for (const n of Object.values(c.pins)) used.add(n);
  const removed: string[] = [];
  for (const id of Object.keys(d.nets)) {
    if (!used.has(id)) {
      removed.push(d.nets[id]!.name);
      delete d.nets[id];
    }
  }
  return removed;
}

export function gcParts(d: Design): void {
  const used = new Set(Object.values(d.components).map((c) => c.part));
  for (const id of Object.keys(d.parts)) if (!used.has(id)) delete d.parts[id];
}

/* --------------------------------- names ---------------------------------- */

const GROUND = /^(GND|0V|VSS|AGND|DGND|PGND|GNDA|GNDD|GND_\w+)$/i;
const RAIL = /^(\+|VCC|VDD|VBUS|VBAT|VIN|V\d)/i;

export function isGroundNet(n: Net): boolean {
  return GROUND.test(n.name);
}

export function isPowerNet(n: Net): boolean {
  return isGroundNet(n) || n.attrs.power === true || n.attrs.external === true || RAIL.test(n.name) || n.attrs.voltage !== undefined;
}

/* ------------------------------- suggestions ------------------------------ */

export function closest(needle: string, hay: string[], max = 5): string[] {
  const n = needle.toUpperCase();
  return hay
    .map((h) => ({ h, s: levenshtein(n, h.toUpperCase()) - (h.toUpperCase().includes(n) ? 2 : 0) }))
    .sort((a, b) => a.s - b.s || natCmp(a.h, b.h))
    .slice(0, max)
    .map((x) => x.h);
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

/**
 * Value as displayed on the schematic, one item per line: the main value, then a rating
 * that matters for the part (a capacitor's voltage): "10nF" / "25V".
 */
export function valueLinesOf(d: Design, c: Component): string[] {
  const card = cardOf(d, c.part);
  const p = c.params;
  const main = p.resistance ?? p.capacitance ?? p.inductance ?? p.mpn ?? p.color;
  if (main && card?.category === 'capacitor' && p.voltage) return [main, p.voltage];
  return [valueOf(d, c)];
}

/** Display value of a component: its main parameter, or MPN / part name. */
export function valueOf(d: Design, c: Component): string {
  const card = cardOf(d, c.part);
  const p = c.params;
  const main = p.resistance ?? p.capacitance ?? p.inductance ?? p.mpn ?? p.color;
  if (main) {
    const extra = card?.category === 'capacitor' && p.voltage ? ` ${p.voltage}` : '';
    return main + extra;
  }
  return card?.mpn ?? card?.id.split(':')[1] ?? c.part;
}

/**
 * Nets the circuit itself supplies: reachable from a power output pin (a regulator's VOUT or
 * switch node) through series parts (seriesPaths: resistors, inductors, diodes, fuses, ferrite
 * beads …). External inputs are not included.
 */
export function circuitSuppliedNets(d: Design): Set<string> {
  const out = new Set<string>();
  const edges = new Map<string, string[]>();
  for (const c of Object.values(d.components)) {
    const card = cardOf(d, c.part);
    if (!card) continue;
    for (const p of card.pins) if (p.type === 'pwr_out' && c.pins[p.number]) out.add(c.pins[p.number]!);
    for (const [x, y] of seriesPaths(card)) {
      const [a, b] = [c.pins[x], c.pins[y]];
      if (a && b && a !== b) {
        edges.set(a, [...(edges.get(a) ?? []), b]);
        edges.set(b, [...(edges.get(b) ?? []), a]);
      }
    }
  }
  const queue = [...out];
  while (queue.length) {
    const n = queue.shift()!;
    for (const m of edges.get(n) ?? []) {
      if (!out.has(m) && !d.nets[m]?.attrs.external) {
        out.add(m);
        queue.push(m);
      }
    }
  }
  return out;
}

/**
 * Connector role by the supplies on its pins: 'input' brings a supply into the circuit
 * (external, or one nothing on the board produces); 'output' only carries supplies the
 * circuit produces; anything else (signals, ground only) is 'neutral'.
 */
export function connectorRole(d: Design, c: Component, supplied: Set<string>): 'input' | 'output' | 'neutral' {
  let feeds = false;
  let takes = false;
  for (const id of Object.values(c.pins)) {
    const net = d.nets[id];
    if (!net || isGroundNet(net) || !isPowerNet(net)) continue;
    if (net.attrs.external || !supplied.has(id)) feeds = true;
    else takes = true;
  }
  return feeds ? 'input' : takes ? 'output' : 'neutral';
}

/** Mark the diagnostics a waiver covers (same code, every entity listed in the waiver). */
/** Who made a ledger entry, as the board tells it: the user (their drag, button or words) or the agent on its own. */
export function madeBy(k: Constraint): 'user' | 'agent' {
  return k.source.type === 'agent' || k.source.type === 'recipe' ? 'agent' : 'user';
}

export function applyWaivers(d: Design, out: { code: string; entities: string[]; waivedBy?: string }[]) {
  const ws = Object.values(d.waivers);
  for (const x of out) {
    const w = ws.find((w) => w.code === x.code && x.entities.length > 0 && x.entities.every((e) => w.entities.includes(e)));
    if (w) x.waivedBy = w.id;
  }
}
