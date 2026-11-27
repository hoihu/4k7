/**
 * The spec's ops: specify and remove_spec (docs/design/spec.md §4). The ops take nets, boards and parts
 * by name and the items store them by id, so a rename does not break a verifier. Who may change what:
 * an item of the user's is theirs; the agent changes it only with the user's words (quote), and
 * without them may only add verifiers to it. An item the agent wrote without quote is an assumption
 * until the user confirms it.
 */
import { CHECKS, checkFamily, isCheckCode, type Design, type EditOp, type OpResult, type SpecItem, type SpecVerifier } from '@4k7/schema';
import { closest, findNet, natCmp, nextId, reject } from './doc.ts';
import { boardList, findBoard } from './boards.ts';
import { stableJson } from './canonical.ts';

type SpecifyOp = Extract<EditOp, { op: 'specify' }>;
type RemoveSpecOp = Extract<EditOp, { op: 'remove_spec' }>;
type VerifierArg = NonNullable<SpecifyOp['verify']>[number];

/** Codes a check verifier may not name: worked out outside the kernel (production files, panel, enclosure), or the spec's own. */
const OUTSIDE = ['FAB', 'PANEL', 'ENC', 'SPEC'];

const invalid = (message: string): never => reject({ code: 'INVALID_OP', message });

/** A part by its refdes or id, exactly (a track id "t1" is not the part T1). */
function exactComponent(d: Design, ref: string) {
  return d.components[ref] ?? Object.values(d.components).find((c) => c.refdes === ref);
}

function netId(d: Design, name: string): string {
  const n = findNet(d, name);
  if (!n) {
    const nets = Object.values(d.nets).map((x) => x.name).sort(natCmp);
    reject({ code: 'NET_UNKNOWN', message: `No net ${name}.`, candidates: closest(name, nets) });
  }
  return n.id;
}

function boardId(d: Design, ref: string): string {
  const b = findBoard(d, ref);
  if (!b) {
    const names = boardList(d).map((x) => x.name);
    reject({ code: 'REF_UNKNOWN', message: `No board "${ref}". The design's boards: ${names.join(', ')}.`, candidates: closest(ref, names) });
  }
  return b.id;
}

/**
 * A finding's entity as a check verifier stores it: a part by id ("c_5"), a pin of it ("c_5.EN"), a
 * net as "net:<id>"; anything else (a constraint's or track's id) as given. A name that looks like a
 * refdes or a net and is not in the design is refused.
 */
function entityId(d: Design, e: string): string {
  if (e.startsWith('net:')) return `net:${netId(d, e.slice(4))}`;
  const c = exactComponent(d, e);
  if (c) return c.id;
  const dot = e.indexOf('.');
  if (dot > 0) {
    const p = exactComponent(d, e.slice(0, dot));
    if (p) return `${p.id}${e.slice(dot)}`;
  }
  if (/^[A-Z]+[0-9]+[A-Z]?(\..+)?$/.test(e)) {
    const ref = dot > 0 ? e.slice(0, dot) : e;
    reject({ code: 'REF_UNKNOWN', message: `No component ${ref}.`, candidates: closest(ref, Object.values(d.components).map((x) => x.refdes)) });
  }
  return e;
}

/** A verifier as the item stores it, checked: names to ids, every rule of docs/design/spec.md §2 and §4. */
function storeVerifier(d: Design, v: VerifierArg): SpecVerifier {
  switch (v.kind) {
    case 'part': {
      if (!v.category && !v.pins && !v.text) invalid('A part verifier needs something to match: category, pins or text (a USB-C receptacle: category "connector", pins ["CC1", "CC2"]).');
      if (v.min !== undefined && v.max !== undefined && v.min > v.max) invalid(`A part verifier's min (${v.min}) is above its max (${v.max}).`);
      return { kind: 'part', ...(v.category ? { category: v.category } : {}), ...(v.pins ? { pins: [...v.pins] } : {}), ...(v.text ? { text: [...v.text] } : {}), ...(v.min !== undefined ? { min: v.min } : {}), ...(v.max !== undefined ? { max: v.max } : {}), ...(v.board !== undefined ? { board: boardId(d, v.board) } : {}) };
    }
    case 'measure': {
      if (v.min === undefined && v.max === undefined) invalid(`A measure of ${v.of} needs a bound: min, max or both.`);
      if (v.min !== undefined && v.max !== undefined && v.min > v.max) invalid(`A measure's min (${v.min}) is above its max (${v.max}).`);
      const ofNet = v.of.startsWith('net.');
      if (ofNet && v.net === undefined) invalid(`A measure of ${v.of} needs the net (net: its name).`);
      if (ofNet && v.board !== undefined) invalid(`A measure of ${v.of} reads the net's declared attribute, which has no board: leave board out.`);
      if (!ofNet && v.net !== undefined) invalid(`A measure of ${v.of} takes no net (only net.voltage and net.max_current do).`);
      return { kind: 'measure', of: v.of, ...(v.net !== undefined ? { net: netId(d, v.net) } : {}), ...(v.board !== undefined ? { board: boardId(d, v.board) } : {}), ...(v.min !== undefined ? { min: v.min } : {}), ...(v.max !== undefined ? { max: v.max } : {}) };
    }
    case 'check': {
      const code = v.code.trim();
      if (OUTSIDE.includes(checkFamily(code))) {
        invalid(`A check verifier cannot name ${code}: ${checkFamily(code) === 'SPEC' ? 'the spec\'s own findings follow from the items' : 'those findings are worked out outside the kernel, from the production files, the panel or the enclosure'}. Name a check of the design (ERC, SEM, XCHK, DRC, IMP …).`);
      }
      if (!isCheckCode(code)) {
        const known = Object.keys(CHECKS).filter((c) => !OUTSIDE.includes(checkFamily(c)));
        reject({ code: 'INVALID_OP', message: `No check ${code}: a verifier must name a code findings carry, exactly.`, candidates: closest(code, known) });
      }
      return { kind: 'check', code, ...(v.entities ? { entities: v.entities.map((e) => entityId(d, e)) } : {}) };
    }
    case 'manual':
      return { kind: 'manual', ...(v.done ? { done: true as const } : {}), ...(v.note !== undefined ? { note: v.note } : {}) };
  }
}

const same = (a: SpecVerifier, b: SpecVerifier) => stableJson(a) === stableJson(b);

/** How many of `of` are in `pool`, each matched once (a multiset). */
function unmatched(of: SpecVerifier[], pool: SpecVerifier[]): SpecVerifier[] {
  const left = [...pool];
  return of.filter((v) => {
    const i = left.findIndex((w) => same(v, w));
    if (i < 0) return true;
    left.splice(i, 1);
    return false;
  });
}

function unknownItem(d: Design, id: string): never {
  return reject({ code: 'REF_UNKNOWN', message: `No spec item ${id}.`, candidates: Object.keys(d.spec ?? {}).sort(natCmp) });
}

const ASK = 'Ask the user, then send it with their words in quote.';

/** specify: a new item (no id) or a change to one. See docs/design/spec.md §4. */
export function specify(d: Design, op: SpecifyOp, by: 'user' | 'agent'): OpResult {
  // the user's own edit, or the agent passing on the user's words
  const theirs = by === 'user' || !!op.quote;
  const verify = op.verify?.map((v) => storeVerifier(d, v));
  if (op.id === undefined) {
    if (op.text === undefined) return invalid('A new spec item needs its text: what the product must do, one statement that can be true or false.');
    const list = verify ?? [];
    if (op.done !== undefined) {
      if (!list.some((v) => v.kind === 'manual')) invalid('done ticks the item\'s manual verifier: give it one (verify: [{ kind: "manual" }]).');
      if (op.done) for (const v of list) if (v.kind === 'manual') v.done = true;
    }
    if (!theirs && list.some((v) => v.kind === 'manual' && v.done)) invalid(`Only the user ticks a manual verifier. ${ASK}`);
    const id = nextId(d, 'q');
    const source: SpecItem['source'] = by === 'user' ? { type: 'user', ...(op.quote ? { quote: op.quote } : {}) } : op.quote ? { type: 'user', quote: op.quote } : { type: 'agent' };
    d.spec = { ...d.spec, [id]: { id, text: op.text.trim(), source, verify: list } };
    return { op: op.op, effect: `added spec item ${id} "${op.text.trim()}"${source.type === 'agent' ? ' (assumed: yours until the user confirms it)' : ''}`, ids: [id] };
  }
  const old = d.spec?.[op.id];
  if (!old) unknownItem(d, op.id);
  const item: SpecItem = structuredClone(old);
  const text = op.text?.trim();
  const userItem = old.source.type === 'user';
  if (!theirs && userItem) {
    if (text !== undefined && text !== old.text) invalid(`${old.id} "${old.text}" is the user's: its text is theirs to change. ${ASK}`);
    if (verify) {
      const dropped = unmatched(old.verify, verify);
      if (dropped.length) invalid(`${old.id} "${old.text}" is the user's: without their words you may only add verifiers to it, keeping each it has unchanged (${dropped.length} would change or go). ${ASK}`);
    }
  }
  if (text !== undefined) item.text = text;
  if (verify) {
    if (!theirs && unmatched(verify, old.verify).some((v) => v.kind === 'manual' && v.done)) invalid(`Only the user ticks a manual verifier. ${ASK}`);
    item.verify = verify;
  }
  if (op.done !== undefined) {
    if (!theirs) invalid(`Only the user says a manual verifier holds (done). ${ASK}`);
    const manual = item.verify.filter((v): v is Extract<SpecVerifier, { kind: 'manual' }> => v.kind === 'manual');
    if (!manual.length) invalid(`${old.id} has no manual verifier for done to tick: give it one (verify, with every verifier it keeps, and { kind: "manual" }).`);
    for (const v of manual) {
      if (op.done) v.done = true;
      else delete v.done;
    }
  }
  // confirmed: the user's own edit, or the user's words for it
  if (by === 'user') item.source = { type: 'user', ...(op.quote ? { quote: op.quote } : old.source.quote ? { quote: old.source.quote } : {}) };
  else if (op.quote) item.source = { type: 'user', quote: op.quote };
  d.spec = { ...d.spec, [item.id]: item };
  const confirmed = old.source.type === 'agent' && item.source.type === 'user';
  const what = [text !== undefined && text !== old.text && 'text', verify && 'verifiers', op.done !== undefined && (op.done ? 'ticked' : 'tick taken back'), confirmed && 'confirmed by the user'].filter(Boolean);
  return { op: op.op, effect: `changed spec item ${item.id} "${item.text}"${what.length ? ` (${what.join(', ')})` : ' (nothing changed)'}`, ids: [item.id] };
}

/** remove_spec: the item and the waivers that name it. */
export function removeSpec(d: Design, op: RemoveSpecOp, by: 'user' | 'agent'): OpResult {
  const item = d.spec?.[op.id];
  if (!item) unknownItem(d, op.id);
  if (by === 'agent' && !op.quote && item.source.type === 'user') invalid(`${item.id} "${item.text}" is the user's: it goes only when they say so. ${ASK}`);
  const spec = { ...d.spec };
  delete spec[item.id];
  if (Object.keys(spec).length) d.spec = spec;
  else delete d.spec;
  const waivers = Object.values(d.waivers).filter((w) => w.entities.includes(item.id));
  for (const w of waivers) delete d.waivers[w.id];
  return { op: op.op, effect: `removed spec item ${item.id} "${item.text}"${waivers.length ? ` and its waiver${waivers.length === 1 ? '' : 's'} ${waivers.map((w) => w.id).join(', ')}` : ''}`, ids: [item.id, ...waivers.map((w) => w.id)] };
}
