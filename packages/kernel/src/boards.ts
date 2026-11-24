/**
 * Designs of several boards (docs/design/multi-board.md). A design keeps one netlist; each part is
 * on one board, its own `board` or else its sheet's. Everything physical works on one board at a
 * time through a focus: the design as if that board were its only one (its settings in `board`,
 * only its parts, the nets and constraints that touch them). The placer, router, DRC and production
 * files read a focus and need not know other boards exist; a board op is applied to a focus and
 * the focus is written back. A design of one board is its own focus, unchanged.
 */
import { DEFAULT_BOARD, FIRST_BOARD, MULTI_BOARD_FORMAT, DESIGN_FORMAT_VERSION, type BoardEntry, type BoardSettings, type Component, type Constraint, type Design, type Net } from '@4k7/schema';
import { closest, reject } from './doc.ts';

/** The first board's name until it is renamed, with one board or several. */
export const FIRST_BOARD_NAME = 'Main';

/** Whether the design has more than one board. */
export const multiBoard = (d: Design): boolean => !!d.boards && Object.keys(d.boards).length > 1;

/** The first board's entry as stored, or as it is until it is named. */
const firstEntry = (d: Design): BoardEntry => d.boards?.[FIRST_BOARD] ?? { id: FIRST_BOARD, name: FIRST_BOARD_NAME, order: 0 };

/** The boards, first board first; a design of one board has the one. */
export function boardList(d: Design): BoardEntry[] {
  if (!multiBoard(d)) return [{ ...firstEntry(d), order: 0 }];
  return Object.values(d.boards!).sort((a, b) => (a.id === FIRST_BOARD ? -1 : b.id === FIRST_BOARD ? 1 : a.order - b.order));
}

/** The board a component is on: its own, else its sheet's, else the first (a board that is gone counts as the first). */
export function boardOf(d: Design, c: Component): string {
  if (!multiBoard(d)) return FIRST_BOARD;
  const id = c.board ?? d.sheets[c.sheet]?.board;
  return id && d.boards![id] ? id : FIRST_BOARD;
}

/** A board by id or name (any case). */
export function findBoard(d: Design, ref: string): BoardEntry | undefined {
  const list = boardList(d);
  const want = ref.trim().toLowerCase();
  return list.find((b) => b.id === ref) ?? list.find((b) => b.name.toLowerCase() === want);
}

export function resolveBoard(d: Design, ref: string): BoardEntry {
  const b = findBoard(d, ref);
  if (!b) {
    const names = boardList(d).map((x) => x.name);
    reject({ code: 'BOARD_UNKNOWN', message: `No board "${ref}". The design's boards: ${names.join(', ')}.`, candidates: closest(ref, names) });
  }
  return b!;
}

/** The name of the board a design (or a board's focus) is about: the focus's board, else the first. */
export const boardName = (d: Design): string => d.focus?.name ?? firstEntry(d).name;

/** A board's settings as stored (absent: the defaults). */
export function settingsOf(d: Design, id: string): BoardSettings | undefined {
  return id === FIRST_BOARD ? d.board : d.boards?.[id]?.settings;
}

/**
 * A net's own track width on the board `d` is about (a focus, else the first board): set for it on
 * that board, else set for the net; absent, the rules' width. `board` says it was the board's. An
 * impedance rule goes over both (its callers check it first).
 */
export function ownTrackWidth(d: Design, net: Net | undefined): { mm: number; board?: string } | undefined {
  const id = d.focus?.id ?? FIRST_BOARD;
  const on = net?.attrs.boardTrackWidths?.[id];
  if (on !== undefined) return { mm: on, board: boardName(d) };
  return net?.attrs.trackWidth !== undefined ? { mm: net.attrs.trackWidth } : undefined;
}

/** Put a board's settings in place. */
export function putSettings(d: Design, id: string, s: BoardSettings | undefined) {
  if (id === FIRST_BOARD) {
    if (s) d.board = s;
    else delete d.board;
    return;
  }
  const e = d.boards?.[id];
  if (!e) return;
  if (s) e.settings = s;
  else delete e.settings;
}

/** The component ids a constraint names. */
const namedBy = (k: Constraint): string[] => [k.a, k.b, k.rel].filter((x): x is string => !!x);

/** The parts of a functional block (the description), by title. */
const blockParts = (d: Design, title: string | undefined): string[] => (title ? d.description?.blocks.find((b) => b.title === title)?.components ?? [] : []);

/**
 * The design as if board `id` were its only board: a new object over the same parts (an op that
 * changes a part in place changes it in the design too); records it filters (components, nets,
 * ledger) are new, written back by commitFocus. A design of one board is returned as it is.
 */
export function focusBoard(d: Design, id: string): Design {
  if (!multiBoard(d)) return d;
  const components: Design['components'] = {};
  const wired = new Set<string>();
  for (const c of Object.values(d.components)) {
    if (boardOf(d, c) !== id) continue;
    components[c.id] = c;
    for (const n of Object.values(c.pins)) wired.add(n);
  }
  const nets: Design['nets'] = {};
  for (const n of Object.values(d.nets)) if (wired.has(n.id)) nets[n.id] = n;
  const ledger: Design['ledger'] = {};
  for (const k of Object.values(d.ledger)) {
    const refs = k.kind === 'room' ? blockParts(d, k.key) : namedBy(k);
    // a constraint between parts of two boards means nothing on either; a room is on the board of its block's parts
    if (k.kind === 'room' ? refs.some((r) => components[r]) : refs.every((r) => components[r])) ledger[k.id] = k;
  }
  // a waiver for another board's finding holds there only
  const waivers: Design['waivers'] = {};
  for (const w of Object.values(d.waivers)) if (!w.board || w.board === id) waivers[w.id] = w;
  const { boards: _b, ...rest } = d;
  const f = { ...rest, format: DESIGN_FORMAT_VERSION, board: settingsOf(d, id), components, nets, ledger, waivers, focus: { id, name: d.boards?.[id]?.name ?? id } } as Design;
  held.set(f, { components: Object.keys(components), nets: Object.keys(nets), ledger: Object.keys(ledger), waivers: Object.keys(waivers) });
  return f;
}

/** What each focus held when it was made: what commitFocus deletes when an op took it away. */
const held = new WeakMap<Design, { components: string[]; nets: string[]; ledger: string[]; waivers: string[] }>();

/** Write a focus (after an op changed it) back into the design. */
export function commitFocus(d: Design, id: string, f: Design) {
  if (f === d) return;
  const before = held.get(f);
  if (!before) throw new Error('commitFocus: not a focus');
  const merge = <T>(into: Record<string, T>, had: string[], now: Record<string, T>) => {
    for (const k of had) if (!(k in now)) delete into[k];
    for (const [k, v] of Object.entries(now)) into[k] = v;
  };
  for (const c of Object.values(f.components)) if (!d.components[c.id] && boardOf(d, c) !== id) c.board = id; // new parts (test points) on this board
  merge(d.components, before.components, f.components);
  merge(d.nets, before.nets, f.nets);
  merge(d.ledger, before.ledger, f.ledger);
  merge(d.waivers, before.waivers, f.waivers);
  for (const k of Object.keys(f) as (keyof Design)[]) {
    if (k === 'components' || k === 'nets' || k === 'ledger' || k === 'waivers' || k === 'board' || k === 'format' || k === 'focus') continue;
    (d as unknown as Record<string, unknown>)[k] = f[k];
  }
  for (const k of Object.keys(d) as (keyof Design)[]) {
    if (k === 'boards' || k === 'board' || k === 'format' || k in f) continue;
    delete (d as unknown as Record<string, unknown>)[k];
  }
  putSettings(d, id, f.board);
}

/** Run `fn` on board `id`'s focus and write it back. */
export function onBoard<T>(d: Design, id: string, fn: (f: Design) => T): T {
  const f = focusBoard(d, id);
  const r = fn(f);
  commitFocus(d, id, f);
  return r;
}

/**
 * The fields of the board ops that name a part or a pin ("U1", "U1.3"; a track end can be one).
 * Only these are read: a net, a copper or graphic id ("v4", "G1"), a name or a text is no part
 * even where it looks like one.
 */
const PART_FIELDS = new Set(['ref', 'to', 'from', 'parts', 'near', 'under', 'part', 'refs']);

/** The fields that name a net, for an op that names no part. */
const NET_FIELDS = new Set(['net', 'nets', 'match', 'along']);

/** The strings under the given fields of an op (at any depth, in arrays and objects below them), with the field. */
function stringsIn(v: unknown, fields: ReadonlySet<string>, out: { s: string; field: string }[], field = '') {
  if (typeof v === 'string') {
    if (field) out.push({ s: v, field });
  } else if (Array.isArray(v)) for (const x of v) stringsIn(x, fields, out, field);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'op' && k !== 'board') stringsIn(x, fields, out, field || (fields.has(k) ? k : ''));
}

/**
 * The parts an op names: by id or refdes, a pin by the refdes before its dot. A track end
 * (from, to) is matched as written, since "v4" there is a via; elsewhere in any case, as the ops
 * take a refdes.
 */
function refsIn(d: Design, op: unknown): Component[] {
  const strs: { s: string; field: string }[] = [];
  stringsIn(op, PART_FIELDS, strs);
  const cs = Object.values(d.components);
  const out: Component[] = [];
  for (const { s, field } of strs) {
    const head = s.includes('.') ? s.slice(0, s.indexOf('.')) : s;
    const anyCase = field !== 'from' && field !== 'to';
    const c = d.components[head] ?? cs.find((x) => x.refdes === head) ?? (anyCase ? cs.find((x) => x.refdes.toUpperCase() === head.toUpperCase()) : undefined);
    if (c) out.push(c);
  }
  return out;
}

/** The boards the nets an op names have pins on. */
function netBoards(d: Design, op: unknown): string[] {
  const strs: { s: string; field: string }[] = [];
  stringsIn(op, NET_FIELDS, strs);
  const want = new Set(strs.map(({ s }) => s.toLowerCase()));
  const ids = new Set(Object.values(d.nets).filter((n) => want.has(n.name.toLowerCase()) || want.has(n.id)).map((n) => n.id));
  const on = new Set<string>();
  if (ids.size) for (const c of Object.values(d.components)) if (Object.values(c.pins).some((n) => ids.has(n))) on.add(boardOf(d, c));
  return [...on];
}

/**
 * The board a board op is for: the one it names, else the board of the parts it names, else the
 * only board. Several boards and neither said: refused, with the boards to choose from.
 */
export function boardFor(d: Design, op: { op: string; board?: string | undefined }): string {
  const named = op.board !== undefined ? resolveBoard(d, op.board).id : undefined;
  if (!multiBoard(d)) return named ?? FIRST_BOARD;
  const parts = refsIn(d, op);
  const on = [...new Set(parts.map((c) => boardOf(d, c)))];
  const name = (id: string) => d.boards![id]!.name;
  if (named) {
    const off = parts.filter((c) => boardOf(d, c) !== named);
    if (off.length) {
      reject({ code: 'BOARD_INVALID', message: `${op.op} on board "${name(named)}" names ${off.map((c) => `${c.refdes} (on "${name(boardOf(d, c))}")`).join(', ')}: a board op works on one board's parts.` });
    }
    return named;
  }
  if (on.length === 1) return on[0]!;
  // no part named: the nets it names, when they are on one board only
  const nets = on.length ? [] : netBoards(d, op);
  if (nets.length === 1) return nets[0]!;
  const names = boardList(d).map((b) => b.name);
  reject({
    code: 'BOARD_AMBIGUOUS',
    message: on.length
      ? `${op.op} names parts on several boards (${parts.map((c) => `${c.refdes}: "${name(boardOf(d, c))}"`).join(', ')}): one board per op; say which with board.`
      : nets.length
        ? `${op.op} names nets on several boards (${nets.map(name).join(', ')}): say which with board.`
        : `The design has ${names.length} boards (${names.join(', ')}): say which with board.`,
    candidates: names,
  });
}

/** The format a design is stored in: 3 with several boards, else 2. */
export function formatFor(d: Design): Design['format'] {
  return multiBoard(d) ? MULTI_BOARD_FORMAT : DESIGN_FORMAT_VERSION;
}

/* ---------------------------------- ops ----------------------------------- */

const nextBoardId = (d: Design) => {
  for (let i = 2; ; i++) if (!d.boards?.[`b_${i}`]) return `b_${i}`;
};

export function addBoard(d: Design, op: { name: string; sheets?: string[] | undefined }) {
  const name = op.name.trim();
  if (findBoard(d, name)) reject({ code: 'INVALID_OP', message: `There is a board "${name}" already.` });
  if (!name) reject({ code: 'INVALID_OP', message: 'A board needs a name.' });
  if (!d.boards) d.boards = { [FIRST_BOARD]: firstEntry(d) };
  const id = nextBoardId(d);
  d.boards[id] = { id, name, order: Math.max(...Object.values(d.boards).map((b) => b.order)) + 1 };
  // the new board starts with the first board's layers and rules, the fab house is shared
  const first = d.board ?? DEFAULT_BOARD;
  d.boards[id]!.settings = structuredClone({ layers: first.layers, rules: first.rules, ...(first.fab ? { fab: first.fab } : {}) });
  d.format = formatFor(d);
  const effect = [`added board "${name}"`];
  if (op.sheets?.length) effect.push(assignBoard(d, { board: id, sheets: op.sheets }).effect);
  return { op: 'add_board' as const, effect: effect.join('; '), ids: [id] };
}

export function removeBoard(d: Design, op: { board: string }) {
  const b = resolveBoard(d, op.board);
  if (b.id === FIRST_BOARD) reject({ code: 'BOARD_INVALID', message: `"${b.name}" is the first board: it stays. Remove the others, or move their parts to it (assign_board).` });
  const was = boardsNow(d);
  for (const s of Object.values(d.sheets)) if (s.board === b.id) delete s.board;
  for (const c of Object.values(d.components)) if (c.board === b.id) delete c.board;
  // its waivers hold where its parts went
  for (const w of Object.values(d.waivers)) if (w.board === b.id) delete w.board;
  // its nets' widths on it go with it
  for (const n of Object.values(d.nets)) {
    const w = n.attrs.boardTrackWidths;
    if (!w || !(b.id in w)) continue;
    delete w[b.id];
    if (!Object.keys(w).length) delete n.attrs.boardTrackWidths;
  }
  delete d.boards![b.id];
  if (!multiBoard(d)) {
    // one board again: stored as before boards were added
    const name = d.boards?.[FIRST_BOARD]?.name;
    delete d.boards;
    if (name && name !== FIRST_BOARD_NAME) d.boards = { [FIRST_BOARD]: { id: FIRST_BOARD, name, order: 0 } };
  }
  d.format = formatFor(d);
  leftBoard(d, was);
  return { op: 'remove_board' as const, effect: `removed board "${b.name}"; its parts are on the first board now`, ids: [b.id] };
}

export function assignBoard(d: Design, op: { board: string; sheets?: string[] | undefined; refs?: string[] | undefined }) {
  const b = resolveBoard(d, op.board);
  if (!op.sheets?.length && !op.refs?.length) reject({ code: 'INVALID_OP', message: 'assign_board needs sheets or refs.' });
  const was = boardsNow(d);
  const said: string[] = [];
  for (const ref of op.sheets ?? []) {
    const s = d.sheets[ref] ?? Object.values(d.sheets).find((x) => x.name.toLowerCase() === ref.trim().toLowerCase());
    if (!s) reject({ code: 'SHEET_UNKNOWN', message: `No sheet "${ref}".`, candidates: closest(ref, Object.values(d.sheets).map((x) => x.name)) });
    if (b.id === FIRST_BOARD) delete s!.board;
    else s!.board = b.id;
    said.push(`sheet ${s!.name}`);
  }
  for (const ref of op.refs ?? []) {
    const c = d.components[ref] ?? Object.values(d.components).find((x) => x.refdes.toUpperCase() === ref.toUpperCase());
    if (!c) reject({ code: 'REF_UNKNOWN', message: `No component "${ref}".`, candidates: closest(ref, Object.values(d.components).map((x) => x.refdes)) });
    c!.board = b.id;
    said.push(c!.refdes);
  }
  // a part's own board that is its sheet's says nothing
  for (const c of Object.values(d.components)) if (c.board && c.board === (d.sheets[c.sheet]?.board ?? FIRST_BOARD)) delete c.board;
  const moved = leftBoard(d, was);
  return { op: 'assign_board' as const, effect: `${said.join(', ')} on board "${b.name}"${moved.length ? ` (${moved.length} part${moved.length === 1 ? '' : 's'} moved)` : ''}`, ids: [b.id] };
}

/** Rename a board (set_board name). */
export function renameBoard(d: Design, id: string, name: string) {
  const want = name.trim();
  if (!want) reject({ code: 'INVALID_OP', message: 'A board needs a name.' });
  const clash = findBoard(d, want);
  if (clash && clash.id !== id) reject({ code: 'INVALID_OP', message: `There is a board "${want}" already.` });
  d.boards ??= { [FIRST_BOARD]: firstEntry(d) };
  d.boards[id]!.name = want;
  // one board named as it is unnamed: stored as if never named
  if (!multiBoard(d) && want === FIRST_BOARD_NAME) delete d.boards;
}

/** Placement entries of parts that are not on that board (a changeset accepted in part) go. */
export function tidyPlacements(d: Design) {
  if (!multiBoard(d)) return;
  for (const { id } of boardList(d)) {
    const s = settingsOf(d, id);
    const stray = Object.keys(s?.placement?.parts ?? {}).filter((x) => d.components[x] && boardOf(d, d.components[x]!) !== id);
    if (!stray.length) continue;
    const parts = { ...s!.placement!.parts };
    for (const x of stray) delete parts[x];
    putSettings(d, id, { ...s!, placement: { ...s!.placement!, parts } });
  }
}

/** The board each part is on now (before an op moves parts between boards: for leftBoard). */
export function boardsNow(d: Design): Map<string, string> {
  return new Map(Object.values(d.components).map((c) => [c.id, boardOf(d, c)]));
}

/**
 * After parts moved between boards (assign_board, remove_board, move_to_sheet, a changeset
 * accepted in part): what they had on the board they left is no use there. Their placement
 * entry on it goes, and their fixed positions (they were on the other board's frame). Returns
 * the parts that moved.
 */
export function leftBoard(d: Design, was: ReadonlyMap<string, string>): Component[] {
  const moved = Object.values(d.components).filter((c) => was.has(c.id) && was.get(c.id) !== boardOf(d, c));
  const from = new Map<string, string[]>();
  for (const c of moved) from.set(was.get(c.id)!, [...(from.get(was.get(c.id)!) ?? []), c.id]);
  for (const [id, ids] of from) {
    const s = settingsOf(d, id);
    if (!s?.placement || !ids.some((x) => s.placement!.parts[x])) continue;
    // a new settings object (the old one may be shared with the committed design), the copper as it was
    const parts = { ...s.placement.parts };
    for (const x of ids) delete parts[x];
    putSettings(d, id, { ...s, placement: { ...s.placement, parts } });
  }
  const gone = new Set(moved.map((c) => c.id));
  for (const k of Object.values(d.ledger)) if (k.kind === 'position' && k.a && gone.has(k.a)) delete d.ledger[k.id];
  return moved;
}
