/**
 * Low-level design document helpers: ids, lookups, reference resolution.
 */
import type { Component, Design, Net, PartCard, PartPin, Rejection } from '@tracewise/schema';
import { getBuiltinPart } from '@tracewise/parts';

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

export function nextId(d: Design, prefix: string): string {
  const id = `${prefix}_${d.seq.toString(36)}`;
  d.seq += 1;
  return id;
}

export function cardOf(d: Design, partId: string): PartCard | undefined {
  return d.parts[partId] ?? getBuiltinPart(partId);
}

export function requireCard(d: Design, c: Component): PartCard {
  const card = cardOf(d, c.part);
  if (!card) throw new Error(`part card ${c.part} missing for ${c.refdes}`);
  return card;
}

/* -------------------------------- sorting --------------------------------- */

/** Natural sort for reference designators and names: R2 < R10. */
export function natCmp(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);
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

/** Two-pin parts that pass power through them (for "is this net supplied" questions). */
const SERIES = new Set(['inductor', 'resistor', 'diode']);

/**
 * Nets the circuit itself supplies: reachable from a power output pin (a regulator's VOUT or
 * switch node) through series parts. External inputs are not included.
 */
export function circuitSuppliedNets(d: Design): Set<string> {
  const out = new Set<string>();
  const edges = new Map<string, string[]>();
  for (const c of Object.values(d.components)) {
    const card = cardOf(d, c.part);
    if (!card) continue;
    for (const p of card.pins) if (p.type === 'pwr_out' && c.pins[p.number]) out.add(c.pins[p.number]!);
    if (SERIES.has(card.category) && card.pins.length === 2) {
      const [a, b] = card.pins.map((p) => c.pins[p.number]);
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
export function applyWaivers(d: Design, out: { code: string; entities: string[]; waivedBy?: string }[]) {
  const ws = Object.values(d.waivers);
  for (const x of out) {
    const w = ws.find((w) => w.code === x.code && x.entities.length > 0 && x.entities.every((e) => w.entities.includes(e)));
    if (w) x.waivedBy = w.id;
  }
}
