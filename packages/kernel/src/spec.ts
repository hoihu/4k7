/**
 * The spec's status: each item's verifiers evaluated on the design (holds, fails or unknown, with one
 * sentence why), the item's status from them, and the findings SPEC.VIOLATED, SPEC.UNVERIFIED and
 * SPEC.ASSUMED. Worked out, never stored. See docs/design/spec.md §2 and §3.
 *
 * In two steps, so the result can be remembered by what it is worked out from (derive.ts): specFacts
 * reads from the design and the kernel's results only what the verifiers need (the fitted parts, the
 * boards' outlines and open connections, the findings with the codes they name), and evaluateSpec
 * works on the items, the waivers and those facts alone.
 */
import { CHECKS, DEFAULT_BOARD, checkFamily, type BoardView, type Design, type Diagnostic, type SpecAnswer, type SpecCounts, type SpecItem, type SpecStatus, type SpecVerifier, type SpecVerifierResult, type Waiver } from '@4k7/schema';
import { packageOf } from '@4k7/parts';
import { cardOf, natCmp } from './doc.ts';
import { boardList, boardOf, multiBoard, settingsOf } from './boards.ts';

/** The checks of a board, which find something only on its copper: unknown until it is routed for its placement. */
const BOARD_FAMILIES = new Set(['DRC', 'IMP', 'DRAW', 'PLANE']);
export const boardCode = (code: string) => BOARD_FAMILIES.has(checkFamily(code));

/** A finding as a check verifier reads it. */
interface FactFinding {
  code: string;
  entities: string[];
  message: string;
  waived: boolean;
}

/** What the verifiers of a design's spec read: names, not ids, where the answer shows them. */
export interface SpecFacts {
  multi: boolean;
  /** The boards, first board first. */
  boards: { id: string; name: string; layers: number; outline?: { w: number; h: number }; routed?: { open: number; findings: FactFinding[] } | null }[];
  /** Every component: refdes and board. */
  comps: Record<string, { refdes: string; board: string }>;
  /** Every net: name, declared voltage and current, the boards its pins are on. */
  nets: Record<string, { name: string; voltage?: number; maxCurrent?: number; boards: string[] }>;
  /** The fitted parts (not DNP, not pad-only), when a verifier counts parts. */
  parts?: { refdes: string; board: string; category: string; pins: string[]; text: string }[];
  /** The design's findings with the codes the check verifiers name (and the codes that say those could not judge), the boards' aside. */
  findings?: FactFinding[];
}

/** How the kernel hands specFacts its results for one design. */
export interface SpecAccess {
  /** The design's findings, the boards' and the spec's aside (the schematic's, XCHK, and the stack's). */
  findings(): Diagnostic[];
  /** A board's placement. */
  placed(board: string): BoardView;
  /** A board routed for its placement (its stored or drawn copper), else undefined. */
  routed(board: string): BoardView | undefined;
}

/** The codes the check verifiers name, with their companions (CHECKS unknownWhen). */
function checkCodes(items: SpecItem[]): Set<string> {
  const out = new Set<string>();
  for (const it of items) for (const v of it.verify) if (v.kind === 'check') for (const c of [v.code, ...(CHECKS[v.code]?.unknownWhen ?? [])]) out.add(c);
  return out;
}

const fact = (x: Diagnostic): FactFinding => ({ code: x.code, entities: [...x.entities], message: x.message, waived: !!x.waivedBy });

/** A stored entity's part or net id, if it names one. */
function entityTarget(e: string): { comp?: string; net?: string } {
  if (e.startsWith('net:')) return { net: e.slice(4) };
  const dot = e.indexOf('.');
  return { comp: dot > 0 ? e.slice(0, dot) : e };
}

/** The boards a check verifier looks at: those of the parts and nets it names, else every board. */
function checkBoards(v: Extract<SpecVerifier, { kind: 'check' }>, facts: Pick<SpecFacts, 'comps' | 'nets' | 'boards'>): string[] {
  const all = facts.boards.map((b) => b.id);
  if (!v.entities?.length) return all;
  const on = new Set<string>();
  for (const e of v.entities) {
    const t = entityTarget(e);
    if (t.net && facts.nets[t.net]) for (const b of facts.nets[t.net]!.boards) on.add(b);
    else if (t.comp && facts.comps[t.comp]) on.add(facts.comps[t.comp]!.board);
    else return all;
  }
  return on.size ? all.filter((b) => on.has(b)) : all;
}

/** A pin's name, every way: itself and the words in it ("CC1_A5": CC1_A5, CC1, A5). */
const called = (name: string) => [name.toUpperCase(), ...name.toUpperCase().split(/[^A-Z0-9+]+/).filter(Boolean)];

/** What the verifiers of `d`'s spec read, and only that (the placement and copper only of the boards they measure). */
export function specFacts(d: Design, access: SpecAccess): SpecFacts {
  const items = Object.values(d.spec ?? {});
  const boards = boardList(d);
  const comps: SpecFacts['comps'] = {};
  for (const c of Object.values(d.components)) comps[c.id] = { refdes: c.refdes, board: boardOf(d, c) };
  const nets: SpecFacts['nets'] = {};
  for (const n of Object.values(d.nets)) nets[n.id] = { name: n.name, ...(n.attrs.voltage !== undefined ? { voltage: n.attrs.voltage } : {}), ...(n.attrs.maxCurrent !== undefined ? { maxCurrent: n.attrs.maxCurrent } : {}), boards: [] };
  for (const c of Object.values(d.components)) {
    for (const id of new Set(Object.values(c.pins))) {
      const n = nets[id];
      if (n && !n.boards.includes(comps[c.id]!.board)) n.boards.push(comps[c.id]!.board);
    }
  }
  const base = { comps, nets, boards: boards.map((b) => ({ id: b.id, name: b.name, layers: 0 })) };
  // which boards' placement and copper the verifiers read
  const placed = new Set<string>();
  const routed = new Set<string>();
  const everyOr = (b: string | undefined) => (b !== undefined ? [b] : boards.map((x) => x.id));
  const codes = checkCodes(items);
  for (const it of items) {
    for (const v of it.verify) {
      if (v.kind === 'measure' && (v.of === 'board.width_mm' || v.of === 'board.height_mm')) for (const b of everyOr(v.board)) placed.add(b);
      if (v.kind === 'measure' && v.of === 'board.open_connections') for (const b of everyOr(v.board)) routed.add(b);
      if (v.kind === 'check' && boardCode(v.code)) for (const b of checkBoards(v, base)) routed.add(b);
    }
  }
  const wantParts = items.some((it) => it.verify.some((v) => v.kind === 'part' || (v.kind === 'measure' && v.of === 'parts.fitted')));
  const facts: SpecFacts = {
    multi: multiBoard(d),
    boards: boards.map((b) => {
      const out: SpecFacts['boards'][number] = { id: b.id, name: b.name, layers: (settingsOf(d, b.id) ?? DEFAULT_BOARD).layers };
      if (placed.has(b.id)) out.outline = { ...access.placed(b.id).outline };
      if (routed.has(b.id)) {
        const r = access.routed(b.id);
        out.routed = r ? { open: r.unrouted.length, findings: r.diagnostics.filter((x) => codes.has(x.code)).map(fact) } : null;
      }
      return out;
    }),
    comps,
    nets,
  };
  if (wantParts) {
    facts.parts = Object.values(d.components)
      .flatMap((c) => {
        const card = cardOf(d, c.part);
        if (c.dnp || !card || card.padOnly) return [];
        const pkg = packageOf(card, c.params, d.packageDefaults)?.name ?? card.package;
        const text = [card.id, card.mpn, c.params.mpn, card.title, card.description, pkg].filter(Boolean).join('\n').toLowerCase();
        return [{ refdes: c.refdes, board: comps[c.id]!.board, category: card.category, pins: [...new Set(card.pins.flatMap((p) => called(p.name)))].sort(), text }];
      })
      .sort((a, b) => natCmp(a.refdes, b.refdes));
  }
  if (codes.size) facts.findings = access.findings().filter((x) => codes.has(x.code)).map(fact);
  return facts;
}

/* ------------------------------- evaluation ------------------------------- */

type Result = { result: SpecVerifierResult['result']; why: string; names?: string[] };

const num = (v: number) => String(Math.round(v * 1000) / 1000);
const range = (min?: number, max?: number, unit = '') =>
  min !== undefined && max !== undefined ? (min === max ? `exactly ${num(min)}${unit}` : `between ${num(min)} and ${num(max)}${unit}`) : min !== undefined ? `at least ${num(min)}${unit}` : `at most ${num(max!)}${unit}`;
const inside = (v: number, min?: number, max?: number) => (min === undefined || v >= min - 1e-9) && (max === undefined || v <= max + 1e-9);
const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** A verifier with names for ids, as get_spec shows it. */
function shown(v: SpecVerifier, f: SpecFacts): SpecVerifier {
  const board = (id: string) => f.boards.find((b) => b.id === id)?.name ?? id;
  switch (v.kind) {
    case 'part':
      return { ...v, ...(v.board !== undefined ? { board: board(v.board) } : {}) };
    case 'measure':
      return { ...v, ...(v.net !== undefined ? { net: f.nets[v.net]?.name ?? v.net } : {}), ...(v.board !== undefined ? { board: board(v.board) } : {}) };
    case 'check':
      return { ...v, ...(v.entities ? { entities: v.entities.map((e) => entityName(e, f) ?? e) } : {}) };
    case 'manual':
      return { ...v };
  }
}

/** A stored entity by name ("U1", "U1.EN", "net:+3V3"); undefined when the part or net it named is gone. */
function entityName(e: string, f: SpecFacts): string | undefined {
  if (e.startsWith('net:')) return f.nets[e.slice(4)] ? `net:${f.nets[e.slice(4)]!.name}` : undefined;
  if (f.comps[e]) return f.comps[e]!.refdes;
  const dot = e.indexOf('.');
  if (dot > 0 && f.comps[e.slice(0, dot)]) return `${f.comps[e.slice(0, dot)]!.refdes}${e.slice(dot)}`;
  // a part's id the op stored, of a part that is gone (refdes are refused unless they exist)
  if (/^c_[0-9a-z]+(\..+)?$/.test(e)) return undefined;
  return e;
}

function partResult(v: Extract<SpecVerifier, { kind: 'part' }>, f: SpecFacts): Result {
  const board = v.board !== undefined ? f.boards.find((b) => b.id === v.board) : undefined;
  if (v.board !== undefined && !board) return { result: 'unknown', why: 'the board it counts on is no longer in the design' };
  const pins = (v.pins ?? []).map((p) => p.toUpperCase());
  const text = (v.text ?? []).map((t) => t.toLowerCase());
  const found = (f.parts ?? []).filter((p) => (!board || p.board === board.id) && (!v.category || p.category === v.category) && pins.every((x) => p.pins.includes(x)) && (!text.length || text.some((t) => p.text.includes(t))));
  const min = v.min ?? 1;
  const n = found.length;
  const refs = found.map((p) => p.refdes);
  const noun = v.category ?? 'part';
  const what = [pins.length ? `has pin${pins.length === 1 ? '' : 's'} ${list(v.pins!)}` : '', text.length ? `matches ${text.map((t) => `"${t}"`).join(' or ')}` : ''].filter(Boolean).join(' and ');
  const on = board && f.multi ? ` on board "${board.name}"` : '';
  const desc = `fitted ${noun}${what ? ` that ${what}` : ''}${on}`;
  if (n < min) return { result: 'fails', why: n === 0 ? `no fitted ${noun}${on}${what ? ` ${what}` : ''}` : `${n} ${desc} (${list(refs)}), at least ${min} needed` };
  if (v.max !== undefined && n > v.max) return { result: 'fails', why: v.max === 0 ? `${list(refs)} ${n === 1 ? 'is a' : 'are'} ${desc}: none may be` : `${n} ${desc} (${list(refs)}), at most ${v.max}`, names: refs };
  return { result: 'holds', why: n === 0 ? `no ${desc}` : `${list(refs)}: ${n} ${desc}` };
}

function measureResult(v: Extract<SpecVerifier, { kind: 'measure' }>, f: SpecFacts): Result {
  const want = range(v.min, v.max);
  if (v.of === 'net.voltage' || v.of === 'net.max_current') {
    const net = v.net !== undefined ? f.nets[v.net] : undefined;
    if (!net) return { result: 'unknown', why: 'the net it reads is no longer in the design' };
    const value = v.of === 'net.voltage' ? net.voltage : net.maxCurrent;
    const unit = v.of === 'net.voltage' ? ' V' : ' A';
    const attr = v.of === 'net.voltage' ? 'voltage' : 'max_current';
    if (value === undefined) return { result: 'unknown', why: `${net.name} has no ${attr} set (set_net ${attr})` };
    const ok = inside(value, v.min, v.max);
    return { result: ok ? 'holds' : 'fails', why: `${net.name}'s ${attr} is ${num(value)}${unit}${ok ? '' : `, wanted ${range(v.min, v.max, unit)}`}`, ...(ok ? {} : { names: [`net:${net.name}`] }) };
  }
  const on = v.board !== undefined ? f.boards.filter((b) => b.id === v.board) : f.boards;
  if (!on.length) return { result: 'unknown', why: 'the board it measures is no longer in the design' };
  const label = (b: SpecFacts['boards'][number]) => (f.multi ? `board "${b.name}"` : 'the board');
  if (v.of === 'parts.fitted') {
    const n = (f.parts ?? []).filter((p) => on.some((b) => b.id === p.board)).length;
    const ok = inside(n, v.min, v.max);
    return { result: ok ? 'holds' : 'fails', why: `${n} fitted part${n === 1 ? '' : 's'}${v.board !== undefined && f.multi ? ` on ${label(on[0]!)}` : ''}${ok ? '' : `, wanted ${want}`}` };
  }
  const parts: { b: SpecFacts['boards'][number]; value?: number; why?: string }[] = on.map((b) => {
    switch (v.of) {
      case 'board.width_mm':
        return { b, value: b.outline?.w };
      case 'board.height_mm':
        return { b, value: b.outline?.h };
      case 'board.layers':
        return { b, value: b.layers };
      default:
        return b.routed ? { b, value: b.routed.open } : { b, why: `${label(b)} is not routed for its placement` };
    }
  });
  const what = v.of === 'board.width_mm' ? 'width' : v.of === 'board.height_mm' ? 'height' : v.of === 'board.layers' ? 'layers' : 'open connections';
  const unit = v.of === 'board.width_mm' || v.of === 'board.height_mm' ? ' mm' : '';
  const say = (p: (typeof parts)[number]) => (v.of === 'board.layers' ? `${label(p.b)} has ${num(p.value!)} layers` : v.of === 'board.open_connections' ? `${label(p.b)} has ${num(p.value!)} open connection${p.value === 1 ? '' : 's'}` : `${label(p.b)} is ${num(p.value!)}${unit} in ${what}`);
  const failing = parts.filter((p) => p.value !== undefined && !inside(p.value, v.min, v.max));
  if (failing.length) return { result: 'fails', why: `${failing.map(say).join('; ')}, wanted ${range(v.min, v.max, unit)}`, ...(f.multi ? { names: failing.map((p) => p.b.name) } : {}) };
  const unknown = parts.find((p) => p.value === undefined);
  if (unknown) return { result: 'unknown', why: unknown.why ?? `${label(unknown.b)}: no ${what} known` };
  return { result: 'holds', why: parts.map(say).join('; ') };
}

function checkResult(v: Extract<SpecVerifier, { kind: 'check' }>, f: SpecFacts): Result {
  const names: string[] = [];
  for (const e of v.entities ?? []) {
    const n = entityName(e, f);
    if (n === undefined) return { result: 'unknown', why: `a part or net it names is no longer in the design` };
    names.push(n);
  }
  const at = names.length ? ` on ${list(names)}` : '';
  // a finding names an entity: exactly, or a pin of the part ("U1.EN" for "U1")
  const names1 = (x: FactFinding) => !names.length || x.entities.some((e) => names.some((n) => e === n || e.startsWith(`${n}.`)));
  let pool = f.findings ?? [];
  if (boardCode(v.code)) {
    const on = checkBoards(v, f).map((id) => f.boards.find((b) => b.id === id)!);
    const unrouted = on.find((b) => !b.routed);
    if (unrouted) return { result: 'unknown', why: `${f.multi ? `board "${unrouted.name}"` : 'the board'} is not routed for its placement: ${v.code} is a check of its copper` };
    pool = [...pool, ...on.flatMap((b) => b.routed!.findings)];
  }
  const open = pool.filter((x) => x.code === v.code && !x.waived && names1(x));
  if (open.length) {
    const named = [...new Set(open.flatMap((x) => x.entities))].slice(0, 8);
    return { result: 'fails', why: open.length === 1 ? `${v.code}: ${open[0]!.message}` : `${open.length} ${v.code} findings${at}, the first: ${open[0]!.message}`, names: named };
  }
  const companion = pool.find((x) => (CHECKS[v.code]?.unknownWhen ?? []).includes(x.code) && !x.waived && names1(x));
  if (companion) return { result: 'unknown', why: `${companion.code} is open${at}: ${v.code} could not judge (${companion.message})` };
  return { result: 'holds', why: `no open ${v.code} finding${at}` };
}

function verifierResult(v: SpecVerifier, f: SpecFacts): Result {
  switch (v.kind) {
    case 'part':
      return partResult(v, f);
    case 'measure':
      return measureResult(v, f);
    case 'check':
      return checkResult(v, f);
    case 'manual':
      return v.done ? { result: 'holds', why: 'ticked by the user' } : { result: 'unknown', why: `waiting for the user's tick${v.note ? `: ${v.note}` : ''}` };
  }
}

/** The spec's answer and its findings. */
export interface SpecResult {
  answer: SpecAnswer;
  findings: Diagnostic[];
}

/** The waiver of a spec finding: one for its code that names the item. */
const waiverOf = (waivers: Record<string, Waiver>, code: string, item: string) => Object.values(waivers).find((w) => w.code === code && w.entities.includes(item));

/** Every item's verifiers evaluated on the facts, the status and the findings. Reads nothing but its arguments. */
export function evaluateSpec(spec: Record<string, SpecItem>, waivers: Record<string, Waiver>, f: SpecFacts): SpecResult {
  const counts: SpecCounts = { verified: 0, violated: 0, unverified: 0, waived: 0, assumed: 0 };
  const items: SpecAnswer['items'] = [];
  const findings: Diagnostic[] = [];
  for (const it of Object.values(spec).sort((a, b) => natCmp(a.id, b.id))) {
    const results = it.verify.map((v) => ({ v, r: verifierResult(v, f) }));
    const fail = results.find((x) => x.r.result === 'fails');
    const unknown = results.find((x) => x.r.result === 'unknown');
    const violated = fail ? waiverOf(waivers, 'SPEC.VIOLATED', it.id) : undefined;
    const status: SpecStatus = fail ? (violated ? 'waived' : 'violated') : results.length && !unknown ? 'verified' : 'unverified';
    const assumed = it.source.type === 'agent';
    counts[status]++;
    if (assumed) counts.assumed++;
    items.push({ id: it.id, text: it.text, source: { ...it.source }, assumed, status, verify: results.map(({ v, r }) => ({ ...shown(v, f), result: r.result, why: r.why })) });
    const mark = (code: string) => {
      const w = waiverOf(waivers, code, it.id);
      return w ? { waivedBy: w.id } : {};
    };
    if (fail) findings.push({ code: 'SPEC.VIOLATED', severity: 'error', entities: [it.id, ...(fail.r.names ?? [])], message: `"${it.text}": ${fail.r.why}`, ...mark('SPEC.VIOLATED') });
    else if (status === 'unverified') findings.push({ code: 'SPEC.UNVERIFIED', severity: 'info', entities: [it.id], message: `"${it.text}": ${unknown ? unknown.r.why : 'nothing verifies it'}`, ...mark('SPEC.UNVERIFIED') });
    if (assumed) findings.push({ code: 'SPEC.ASSUMED', severity: 'info', entities: [it.id], message: `"${it.text}": assumed, not confirmed by the user`, ...mark('SPEC.ASSUMED') });
  }
  return { answer: { counts, items }, findings };
}

/** The status the result of a specify op reports: "violated: …", "verified", "unverified: …". */
export function statusLine(r: SpecResult, id: string): string | undefined {
  const it = r.answer.items.find((x) => x.id === id);
  if (!it) return undefined;
  const why = it.verify.find((v) => v.result === 'fails') ?? it.verify.find((v) => v.result === 'unknown');
  return `${it.status}${it.status === 'unverified' && !it.verify.length ? ': nothing verifies it yet' : why && it.status !== 'verified' ? `: ${why.why}` : ''}${it.assumed ? ' (assumed)' : ''}`;
}

/** A verifier in words, with the design's names, for the changeset's details: "a fitted connector with pins CC1 and CC2". */
export function describeVerifier(d: Design, v: SpecVerifier): string {
  const board = (id?: string) => (id === undefined ? '' : ` on board "${boardList(d).find((b) => b.id === id)?.name ?? '(gone)'}"`);
  switch (v.kind) {
    case 'part': {
      const what = [v.pins ? `with pins ${list(v.pins)}` : '', v.text ? `matching ${v.text.map((t) => `"${t}"`).join(' or ')}` : ''].filter(Boolean).join(' ');
      const n = v.max === 0 ? 'no' : v.min !== undefined || v.max !== undefined ? range(v.min ?? 1, v.max) : 'a';
      return `${n} fitted ${v.category ?? 'part'}${what ? ` ${what}` : ''}${board(v.board)}`;
    }
    case 'measure':
      return `${v.of}${v.net !== undefined ? ` of ${d.nets[v.net]?.name ?? '(gone)'}` : ''}${board(v.board)} ${range(v.min, v.max)}`;
    case 'check': {
      const names = (v.entities ?? []).map((e) => {
        if (e.startsWith('net:')) return `net:${d.nets[e.slice(4)]?.name ?? '(gone)'}`;
        const dot = e.indexOf('.');
        const c = d.components[dot > 0 ? e.slice(0, dot) : e];
        return c ? `${c.refdes}${dot > 0 ? e.slice(dot) : ''}` : e;
      });
      return `no open ${v.code}${names.length ? ` on ${list(names)}` : ''}`;
    }
    case 'manual':
      return `the user's tick${v.note ? ` (${v.note})` : ''}${v.done ? ': done' : ''}`;
  }
}
