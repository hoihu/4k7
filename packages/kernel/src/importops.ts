/**
 * import_block: copy one functional block of another stored project into the open design; import_board
 * (D29): a whole board of one, as a board of its own. The app
 * reads that project's file (only an id the projects folder lists) and hands it to the transaction
 * (Kernel.transact's `sources`), so the op itself touches no file and dry runs, review and undo work
 * as for any edit op. See docs/design/ops-api.md §7.
 */
import { DEFAULT_BOARD, type BoardImportReport, type BoardSettings, type Component, type Constraint, type Design, type EditOp, type ImportReport, type NetAttrs, type OpResult } from '@4k7/schema';
import { allocRefdes, cardOf, closest, createNet, findNet, isAutoNet, natCmp, nextId, reject } from './doc.ts';
import { addPart, addSheet } from './netops.ts';
import { sheetByName } from './sheets.ts';
import { addBoard, assignBoard, boardList, boardOf, findBoard, focusBoard, putSettings, resolveBoard, settingsOf } from './boards.ts';
import { listBlocks, readProject } from './reuse.ts';
import { carryCopper } from './boardimport.ts';

/** The stored projects the app read for a transaction's import_block and import_board ops: the ids the folder lists, and the files by id. */
export interface ImportSources {
  projects: string[];
  files: Record<string, string>;
}

/** The constraints that travel with a block: how it is drawn, and its notes. Positions belong to the old sheet and board. */
const TRAVELS = new Set(['left_of', 'right_of', 'above', 'below', 'arrangement', 'note']);
/** With a whole board its placement travels too: pins (position, `rel` too), side, and what belongs where. */
const BOARD_TRAVELS = new Set([...TRAVELS, 'position', 'layer', 'near', 'belongs', 'room']);
/** Pins whose part values set how an IC works (a feedback divider, a current limit, a timing resistor). */
const SETS = /^(FB|VFB|ADJ|ILIM|ISET|IPROG|PROG|RT|RT\/CLK|SS|TR|TRIM|COMP|SENSE|CS|RSET|ISNS|EN|UVLO)\b/i;
/** Params that say which part to buy, not what it does. */
const SOURCING = /^(lcsc|jlc|mpn|manufacturer|supplier|package)/i;

export function importBlock(d: Design, op: Extract<EditOp, { op: 'import_block' }>, sources?: ImportSources): OpResult {
  if (!sources) reject({ code: 'PROJECT_UNKNOWN', message: 'import_block needs the projects folder, which the app reads from the 4k7 server: it is not connected.' });
  const src = readProject(op.project, sources.files[op.project], sources.projects);
  if ('error' in src) reject({ code: 'PROJECT_UNKNOWN', message: src.error, ...(src.projects ? { candidates: src.projects } : {}) });
  const listed = listBlocks(op.project, src).blocks;
  const want = String(op.block).trim().toLowerCase();
  const lb = typeof op.block === 'number' ? listed[op.block - 1] : listed.find((b) => b.title.toLowerCase() === want);
  if (!lb) reject({ code: 'BLOCK_UNKNOWN', message: `${op.project} has no block ${JSON.stringify(op.block)}.`, candidates: listed.map((b) => b.title) });
  const block = src.description!.blocks[lb.block - 1]!;
  const comps = block.components.map((id) => src.components[id]).filter((c) => c !== undefined);

  const boundary = lb.boundary_nets.map((n) => n.net);
  const unmapped = boundary.filter((n) => op.nets[n] === undefined);
  if (unmapped.length) reject({ code: 'NET_UNMAPPED', message: `Map every boundary net of "${lb.title}" to a net of this design: ${unmapped.join(', ')} not mapped. Nothing was imported.`, candidates: unmapped });
  const known = [...boundary, ...lb.internal_nets].sort(natCmp);
  const stray = Object.keys(op.nets).filter((n) => !known.includes(n));
  if (stray.length) reject({ code: 'NET_UNKNOWN', message: `${stray.join(', ')}: not a net of "${lb.title}" (its boundary nets are ${boundary.join(', ') || 'none'}, its internal nets ${lb.internal_nets.join(', ') || 'none'}).`, candidates: known });

  // where the parts go: a sheet and a board as move_to_sheet and assign_board name them (refused before anything is copied)
  const sheet = op.sheet !== undefined ? sheetByName(d, op.sheet) : undefined;
  const board = op.board !== undefined ? resolveBoard(d, op.board) : undefined;

  // boundary and mapped internal nets join the mapped net, the other internal ones are made anew
  const { ids, nets, renamed, cards } = copyParts(d, src, comps, { project: op.project, sheet, board: board?.id, join: (name) => op.nets[name], prefix: op.prefix });

  // its describe block, and the constraints on its parts that say how it is drawn
  const title = appendBlock(d, block.title, [...ids.values()], block.text);
  const constraints = copyConstraints(d, src, ids).length;

  // the values to look at again: every part with params, and what it sets where an IC pin says so
  const refOf = (srcId: string) => d.components[ids.get(srcId)!]!.refdes;
  const recheck: ImportReport['recheck'] = [];
  for (const c of comps) {
    const params = Object.fromEntries(Object.entries(c.params).filter(([k]) => !SOURCING.test(k)));
    if (!Object.keys(params).length) continue;
    const sets = comps.flatMap((o) => (o.id === c.id ? [] : Object.entries(o.pins).flatMap(([num, net]) => {
      const name = cardOf(d, o.part)?.pins.find((p) => p.number === num)?.name ?? num;
      return Object.values(c.pins).includes(net) && SETS.test(name) ? [`${refOf(o.id)}.${name}`] : [];
    })));
    recheck.push({ ref: refOf(c.id), params, why: sets.length ? `sets ${[...new Set(sets)].join(', ')}` : `chosen for ${op.project}` });
  }

  const imported: ImportReport = { project: op.project, block: title, renamed, cards, recheck };
  const mappedInternal = lb.internal_nets.filter((n) => op.nets[n] !== undefined);
  const list = (m: Record<string, string>) => Object.entries(m).map(([a, b]) => `${a} → ${b}`).join(', ');
  const effect =
    `imported "${title}" from ${op.project}: ${comps.length} part(s) (${comps.map((c) => refOf(c.id)).sort(natCmp).join(', ')})` +
    (sheet || board ? ` on ${[sheet ? `sheet ${d.sheets[sheet]!.name}` : '', board ? `board "${board.name}"` : ''].filter(Boolean).join(', ')}` : '') +
    `, ` +
    `boundary ${boundary.map((n) => `${n} → ${op.nets[n]}`).join(', ') || 'none'}` +
    (mappedInternal.length ? `, internal ${mappedInternal.map((n) => `${n} → ${op.nets[n]}`).join(', ')}` : '') +
    (constraints ? `, ${constraints} constraint(s)` : '') +
    (Object.keys(renamed.refdes).length ? `; renamed ${list(renamed.refdes)}` : '') +
    (Object.keys(renamed.nets).length ? `; nets renamed ${list(renamed.nets)}` : '') +
    (cards.project.length ? `; not in the library, card taken from ${op.project}: ${cards.project.join(', ')}` : '') +
    (recheck.length ? `; values to recheck (chosen for ${op.project}): ${recheck.map((x) => `${x.ref} ${Object.values(x.params).join(' ')}${x.why.startsWith('sets') ? ` (${x.why})` : ''}`).join(', ')}` : '');
  return { op: 'import_block', effect, ids: [...ids.values(), ...new Set(nets.values())], imported };
}

/** Append a describe block, ` (2)` after a title that is taken; returns its title here. */
function appendBlock(d: Design, want: string, components: string[], text: string): string {
  let title = want;
  for (let i = 2; d.description?.blocks.some((b) => b.title === title); i++) title = `${want} (${i})`;
  d.description = { overview: d.description?.overview ?? '', blocks: [...(d.description?.blocks ?? []), { title, components, text }] };
  return title;
}

/**
 * The constraints between copied parts of the kinds that travel, with their parts' new ids (a, b, rel);
 * a room follows its block's new title in `titles`. Returns them as copied.
 */
function copyConstraints(d: Design, src: Design, ids: ReadonlyMap<string, string>, kinds = TRAVELS, titles?: ReadonlyMap<string, string>): Constraint[] {
  const made: Constraint[] = [];
  for (const k of Object.values(src.ledger)) {
    if (!kinds.has(k.kind)) continue;
    const room = k.kind === 'room' ? titles?.get(k.key ?? '') : undefined;
    if (k.kind === 'room' ? room === undefined : !k.a || !ids.has(k.a)) continue;
    if ((k.b && !ids.has(k.b)) || (k.rel && !ids.has(k.rel))) continue;
    const id = nextId(d, 'k');
    const c: Constraint = { ...structuredClone(k), id };
    if (k.a) c.a = ids.get(k.a)!;
    if (k.b) c.b = ids.get(k.b)!;
    if (k.rel) c.rel = ids.get(k.rel)!;
    if (room !== undefined) c.key = room;
    d.ledger[id] = c;
    made.push(c);
  }
  return made;
}

/** The net attributes a joined net is rechecked for when the source's differ. */
const RECHECK_ATTRS = ['voltage', 'maxCurrent', 'external', 'power', 'trackWidth'] as const;

/**
 * import_board (D29): copy a whole board of another stored project in as a board of this design: every
 * part (copyParts), nets joined by name unless `nets` says otherwise, its describe blocks and travelling
 * constraints, the board's outline, build, fab tier and holes, and its layout: the stored placement,
 * the pins and sides (ledger), keep-outs, graphics and panel, and its copper (carryCopper: drawn as
 * drawn, the router's as locked copper where it is current, else left behind: route the board).
 * See docs/design/ops-api.md §7 and docs/design/multi-board.md.
 */
export function importBoard(d: Design, op: Extract<EditOp, { op: 'import_board' }>, sources?: ImportSources): OpResult {
  if (!sources) reject({ code: 'PROJECT_UNKNOWN', message: 'import_board needs the projects folder, which the app reads from the 4k7 server: it is not connected.' });
  const src = readProject(op.project, sources.files[op.project], sources.projects);
  if ('error' in src) reject({ code: 'PROJECT_UNKNOWN', message: src.error, ...(src.projects ? { candidates: src.projects } : {}) });
  const srcBoards = boardList(src).map((b) => b.name);
  const entry = op.board === undefined ? boardList(src)[0]! : findBoard(src, op.board);
  if (!entry) reject({ code: 'BOARD_UNKNOWN', message: `No board "${op.board}" in ${op.project}. Its boards: ${srcBoards.join(', ')}.`, candidates: closest(op.board!, srcBoards) });
  const f = focusBoard(src, entry.id);
  const comps = Object.values(f.components).sort((a, b) => natCmp(a.refdes, b.refdes));
  const srcNets = Object.values(f.nets);
  const stray = Object.keys(op.nets ?? {}).filter((n) => !srcNets.some((x) => x.name === n));
  if (stray.length) reject({ code: 'NET_UNKNOWN', message: `${stray.join(', ')}: not a net of ${op.project}'s board "${entry.name}". Nothing was imported.`, candidates: srcNets.map((n) => n.name).sort(natCmp) });

  // the target board: new, or one with no parts yet (import_board never replaces parts)
  const here = findBoard(d, op.as);
  if (here) {
    const on = Object.values(d.components).filter((c) => boardOf(d, c) === here.id);
    if (on.length) reject({ code: 'BOARD_INVALID', message: `Board "${here.name}" has parts (${on.map((c) => c.refdes).sort(natCmp).slice(0, 6).join(', ')}${on.length > 6 ? ', …' : ''}): import_board copies onto a new or empty board only. Name a new board with as, or remove its parts first.` });
  }
  const boardId = here?.id ?? addBoard(d, { name: op.as }).ids[0]!;
  const boardName = d.boards?.[boardId]?.name ?? here!.name;

  // the sheet: the one of that name, else a new one; a sheet with no parts yet is put on the board
  const sheetName = op.sheet ?? boardName;
  const existing = Object.values(d.sheets).find((x) => x.name.toLowerCase() === sheetName.toLowerCase() || x.id === sheetName);
  const sheet = existing?.id ?? addSheet(d, sheetName).ids![0]!;
  if (!Object.values(d.components).some((c) => c.sheet === sheet)) assignBoard(d, { board: boardId, sheets: [sheet] });

  // the nets: by name (joined where this design has one), an override's name, or made anew ("fresh", automatic N$)
  const before = new Set(Object.keys(d.nets));
  const auto = new Set(srcNets.filter(isAutoNet).map((n) => n.name));
  const join = (name: string) => {
    const o = op.nets?.[name];
    if (o === 'fresh' || (o === undefined && auto.has(name))) return undefined;
    if (o !== undefined) return o;
    return findNet(d, name) ? name : undefined;
  };
  const { ids, nets, renamed, cards } = copyParts(d, f, comps, { project: op.project, sheet, board: boardId, join, prefix: op.prefix });

  const report: BoardImportReport['nets'] = { joined: {}, made: [], merged: [], recheck: [] };
  const onto = new Map<string, string[]>();
  for (const [srcId, id] of nets) {
    const s = f.nets[srcId]!;
    const n = d.nets[id]!;
    onto.set(id, [...(onto.get(id) ?? []), s.name]);
    if (!before.has(id)) {
      // a width the source set for its own board is this board's width here; other boards' ids mean nothing here
      const w = s.attrs.boardTrackWidths?.[entry.id];
      delete n.attrs.boardTrackWidths;
      if (w !== undefined) n.attrs.boardTrackWidths = { [boardId]: w };
      continue;
    }
    report.joined[s.name] = n.name;
    const differ = Object.fromEntries(RECHECK_ATTRS.filter((a) => s.attrs[a] !== undefined && s.attrs[a] !== n.attrs[a]).map((a) => [a, { here: n.attrs[a], source: s.attrs[a] }]));
    if (Object.keys(differ).length) report.recheck.push({ net: n.name, attrs: differ });
  }
  report.made = [...onto.keys()].filter((id) => !before.has(id)).map((id) => d.nets[id]!.name).sort(natCmp);
  report.merged = [...onto].filter(([, from]) => from.length > 1).map(([id, from]) => ({ net: d.nets[id]!.name, from: from.sort(natCmp) }));

  // its describe blocks (the parts of each on this board) and the constraints that say how they are drawn
  // and the placement intent (pins, sides, near, belongs, rooms under the block's title here)
  const blocks: string[] = [];
  const titles = new Map<string, string>();
  for (const b of src.description?.blocks ?? []) {
    const mine = b.components.filter((c) => ids.has(c)).map((c) => ids.get(c)!);
    if (!mine.length) continue;
    titles.set(b.title, appendBlock(d, b.title, mine, b.text));
    blocks.push(titles.get(b.title)!);
  }
  const copied = copyConstraints(d, f, ids, BOARD_TRAVELS, titles);
  const constraints = copied.length;

  // the board: outline, build and holes as the source has them; the fab tier where it is of this design's house
  const from: BoardSettings = settingsOf(src, entry.id) ?? DEFAULT_BOARD;
  const s: BoardSettings = { ...structuredClone(settingsOf(d, boardId) ?? DEFAULT_BOARD), layers: from.layers, rules: structuredClone(from.rules) };
  const took = ['layers', 'rules'];
  for (const k of ['width', 'height', 'cornerRadius', 'shape', 'cutouts', 'stackup'] as const) {
    if (from[k] === undefined) delete s[k];
    else {
      (s as unknown as Record<string, unknown>)[k] = structuredClone(from[k]);
      took.push(k === 'cornerRadius' ? 'corner radius' : k);
    }
  }
  const lost: string[] = [];
  const holes = (from.holes ?? []).map((h) => {
    const { netId, ...rest } = structuredClone(h);
    if (netId && !nets.has(netId)) lost.push(h.id);
    return netId && nets.has(netId) ? { ...rest, netId: nets.get(netId)! } : rest;
  });
  if (holes.length) {
    s.holes = holes;
    took.push(`${holes.length} hole(s)${lost.length ? ` (${lost.join(', ')} on a net no part of the board is on: left on none)` : ''}`);
  } else delete s.holes;
  const house = boardList(d).map((b) => (b.id === boardId ? undefined : settingsOf(d, b.id)?.fab?.house)).find(Boolean);
  let fab = '';
  if (from.fab && (!house || house.toLowerCase() === from.fab.house.toLowerCase())) {
    s.fab = structuredClone(from.fab);
    took.push(`fab ${from.fab.house} ${from.fab.tier}`);
  } else if (from.fab) fab = `; ${op.project} is made by ${from.fab.house}, this design by ${house}: the board keeps ${house}${s.fab ? ` ${s.fab.tier}` : ''} (one house per design), check its limits`;
  // the layout: the stored placement (on the source's frame, which is this board's), its keep-outs and graphics
  const at = Object.entries(from.placement?.parts ?? {}).filter(([id]) => ids.has(id));
  if (from.placement && at.length) {
    s.placement = { outline: { ...from.placement.outline }, parts: Object.fromEntries(at.map(([id, p]) => [ids.get(id)!, { ...p }])) };
    const locked = copied.filter((k) => k.kind === 'position' && k.strength === 'hard').length;
    took.push(`placement of ${at.length} part(s)${locked ? ` (${locked} locked)` : ''}`);
  } else delete s.placement;
  const keepouts = (from.keepouts ?? []).flatMap((k) => (!k.part ? [structuredClone(k)] : ids.has(k.part) ? [{ ...structuredClone(k), part: ids.get(k.part)! }] : []));
  if (keepouts.length) {
    s.keepouts = keepouts;
    took.push(`${keepouts.length} keep-out(s)`);
  } else delete s.keepouts;
  if (from.graphics?.length) {
    s.graphics = structuredClone(from.graphics);
    took.push(`${from.graphics.length} graphic(s)`);
  } else delete s.graphics;
  if (from.panel) {
    s.panel = structuredClone(from.panel);
    took.push('panel');
  } else delete s.panel;
  // the copper, remapped; the router's cache never (its key hashes the source's ids)
  const copper = carryCopper(f, from, s, ids, nets);
  took.push(...copper.took);
  delete s.routed;
  delete s.copper;
  putSettings(d, boardId, s);

  const left = copper.left;
  const parts = comps.map((c) => d.components[ids.get(c.id)!]!.refdes);
  const importedBoard: BoardImportReport = {
    project: op.project, from: entry.name, board: boardName, made: !here, sheet: d.sheets[sheet]!.name, parts, renamed, cards,
    nets: report, blocks, constraints, board_settings: took, left_behind: left,
  };
  const list = (m: Record<string, string>) => Object.entries(m).map(([a, b]) => `${a} → ${b}`).join(', ');
  const joinedText = Object.entries(report.joined).map(([a, b]) => (a === b ? a : `${a} → ${b}`)).join(', ');
  const effect =
    `imported board "${entry.name}" of ${op.project} as ${here ? 'the empty' : 'new'} board "${boardName}" (sheet ${d.sheets[sheet]!.name}): ${parts.length} part(s) (${parts.join(', ')})` +
    `; nets joined ${joinedText || 'none'}; made ${report.made.join(', ') || 'none'}` +
    (report.merged.length ? `; MERGED (several source nets on one net here): ${report.merged.map((m) => `${m.from.join(' + ')} → ${m.net}`).join(', ')}` : '') +
    (report.recheck.length ? `; joined nets to recheck (attributes differ): ${report.recheck.map((r) => `${r.net} (${Object.entries(r.attrs).map(([a, v]) => `${a} ${String(v.here ?? 'unset')} here, ${String(v.source)} in ${op.project}`).join(', ')})`).join('; ')}` : '') +
    (Object.keys(renamed.refdes).length ? `; renamed ${list(renamed.refdes)} (silkscreen changes: export that board's files again)` : '') +
    (Object.keys(renamed.nets).length ? `; nets renamed ${list(renamed.nets)}` : '') +
    (cards.project.length ? `; not in the library, card taken from ${op.project}: ${cards.project.join(', ')}` : '') +
    (blocks.length ? `; blocks ${blocks.join(', ')}` : '') +
    (constraints ? `, ${constraints} constraint(s)` : '') +
    `; board: ${took.join(', ')}${fab}` +
    copper.next +
    (Object.keys(report.joined).length ? `. Nets joined across boards need a mated connector pair (ERC.BOARD_CROSSING until then): add mate` : '');
  return { op: 'import_board', effect, ids: [boardId, ...ids.values(), ...new Set(nets.values())], importedBoard };
}

/** Where copyParts puts the parts and how it treats their nets. */
export interface CopyTarget {
  /** The source project's id, for messages. */
  project: string;
  /** The sheet id the parts go on (else add_part's default). */
  sheet?: string;
  /** The board id the parts are assigned to (else the one their sheet gives). */
  board?: string;
  /** The net of this design a source net (by name) joins, made if there is none; undefined: made anew under a free name. */
  join: (srcNet: string) => string | undefined;
  /** Put before the name of a net made anew (an automatic N$ name stays automatic without it). */
  prefix?: string;
}

/** What copyParts did: the new component and net id of each source id, what it renamed, where the cards came from. */
export interface Copied {
  ids: Map<string, string>;
  nets: Map<string, string>;
  renamed: ImportReport['renamed'];
  cards: ImportReport['cards'];
}

/**
 * Copy parts of `src` into `d` with their cards, params, no-connects and nets: what import_block does for
 * one block and import_board for a whole board (D29). Refuses (PART_UNKNOWN) before copying a part when a
 * card is missing or differs. Describe blocks and constraints are left to the caller.
 */
export function copyParts(d: Design, src: Design, comps: Component[], to: CopyTarget): Copied {
  // the cards: this design's or the library's by id, else the one stored in the source project
  const cards: ImportReport['cards'] = { library: [], project: [] };
  for (const id of new Set(comps.map((c) => c.part))) {
    const here = cardOf(d, id);
    const card = here ?? src.parts[id];
    if (!card) reject({ code: 'PART_UNKNOWN', message: `${to.project} uses ${id}, which is neither in the library nor stored in its file. Nothing was imported.` });
    for (const c of comps.filter((x) => x.part === id)) {
      const gone = [...Object.keys(c.pins), ...c.noConnect].filter((n) => !card.pins.some((p) => p.number === n));
      if (gone.length) reject({ code: 'PART_UNKNOWN', message: `${c.refdes}: the card of ${id} here has no pin ${gone.join(', ')}; it differs from ${to.project}'s. Nothing was imported.` });
    }
    if (!here) d.parts[id] = structuredClone(card);
    (here ? cards.library : cards.project).push(id);
  }

  // the parts, keeping their refdes where it is free here, else the next free number of its letters
  const renamed: ImportReport['renamed'] = { refdes: {}, nets: {} };
  const ids = new Map<string, string>();
  for (const c of comps) {
    const taken = Object.values(d.components).some((x) => x.refdes === c.refdes);
    const refdes = taken ? allocRefdes(d, c.refdes.match(/^[A-Za-z_]+/)?.[0] ?? cardOf(d, c.part)!.refPrefix) : c.refdes;
    if (taken) renamed.refdes[c.refdes] = refdes;
    const r = addPart(d, { op: 'add_part', part: c.part, refdes, params: { ...c.params }, ...(to.sheet ? { sheet: to.sheet } : {}) });
    const nc = d.components[r.ids![0]!]!;
    nc.noConnect = [...c.noConnect];
    if (c.dnp) nc.dnp = true;
    ids.set(c.id, nc.id);
  }

  if (to.board && ids.size) assignBoard(d, { board: to.board, refs: [...ids.values()] });

  // the nets: one `join` names joins the net of that name here (made if missing), the others are made anew
  const nets = new Map<string, string>();
  for (const srcNet of new Set(comps.flatMap((c) => Object.values(c.pins)))) {
    const n = src.nets[srcNet];
    if (!n) continue;
    const loads = (n.attrs.loads ?? []).flatMap((l) => (ids.has(l.componentId) ? [{ ...l, componentId: ids.get(l.componentId)! }] : []));
    const joined = to.join(n.name);
    let net = joined === undefined ? undefined : findNet(d, joined);
    if (!net) {
      const name = joined === undefined ? freeNet(d, isAutoNet(n) && !to.prefix ? undefined : (to.prefix ?? '') + n.name) : joined;
      net = createNet(d, name);
      const { loads: _l, ...attrs } = n.attrs;
      net.attrs = structuredClone(attrs) as NetAttrs;
      if (joined === undefined && !isAutoNet(n) && net.name !== n.name) renamed.nets[n.name] = net.name;
    }
    if (loads.length) net.attrs.loads = [...(net.attrs.loads ?? []), ...loads];
    nets.set(srcNet, net.id);
  }
  for (const c of comps) for (const [pin, net] of Object.entries(c.pins)) if (nets.has(net)) d.components[ids.get(c.id)!]!.pins[pin] = nets.get(net)!;
  return { ids, nets, renamed, cards };
}

/** `name`, or name_2, name_3 … where it is taken here (undefined: an automatic name). */
function freeNet(d: Design, name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const taken = (n: string) => !!findNet(d, n);
  if (!taken(name)) return name;
  for (let i = 2; ; i++) if (!taken(`${name}_${i}`)) return `${name}_${i}`;
}
