/**
 * import_block: copy one functional block of another stored project into the open design. The app
 * reads that project's file (only an id the projects folder lists) and hands it to the transaction
 * (Kernel.transact's `sources`), so the op itself touches no file and dry runs, review and undo work
 * as for any edit op. See docs/design/ops-api.md §7.
 */
import type { Design, EditOp, ImportReport, NetAttrs, OpResult } from '@4k7/schema';
import { allocRefdes, cardOf, createNet, findNet, isAutoNet, natCmp, nextId, reject } from './doc.ts';
import { addPart } from './netops.ts';
import { sheetByName } from './sheets.ts';
import { assignBoard, resolveBoard } from './boards.ts';
import { listBlocks, readProject } from './reuse.ts';

/** The stored projects the app read for a transaction's import_block ops: the ids the folder lists, and the files by id. */
export interface ImportSources {
  projects: string[];
  files: Record<string, string>;
}

/** The constraints that travel with a block: how it is drawn, and its notes. Positions belong to the old sheet and board. */
const TRAVELS = new Set(['left_of', 'right_of', 'above', 'below', 'arrangement', 'note']);
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

  // the cards: this design's or the library's by id, else the one stored in the source project
  const cards: ImportReport['cards'] = { library: [], project: [] };
  for (const id of new Set(comps.map((c) => c.part))) {
    const here = cardOf(d, id);
    const card = here ?? src.parts[id];
    if (!card) reject({ code: 'PART_UNKNOWN', message: `${op.project} uses ${id}, which is neither in the library nor stored in its file. Nothing was imported.` });
    for (const c of comps.filter((x) => x.part === id)) {
      const gone = [...Object.keys(c.pins), ...c.noConnect].filter((n) => !card.pins.some((p) => p.number === n));
      if (gone.length) reject({ code: 'PART_UNKNOWN', message: `${c.refdes}: the card of ${id} here has no pin ${gone.join(', ')}; it differs from ${op.project}'s. Nothing was imported.` });
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
    const r = addPart(d, { op: 'add_part', part: c.part, refdes, params: { ...c.params }, ...(sheet ? { sheet } : {}) });
    const nc = d.components[r.ids![0]!]!;
    nc.noConnect = [...c.noConnect];
    if (c.dnp) nc.dnp = true;
    ids.set(c.id, nc.id);
  }

  if (board && ids.size) assignBoard(d, { board: board.id, refs: [...ids.values()] });

  // the nets: boundary ones and mapped internal ones join the mapped net, the other internal ones are made anew
  const internal = new Set(lb.internal_nets.filter((n) => op.nets[n] === undefined));
  const nets = new Map<string, string>();
  for (const srcNet of new Set(comps.flatMap((c) => Object.values(c.pins)))) {
    const n = src.nets[srcNet];
    if (!n) continue;
    const loads = (n.attrs.loads ?? []).flatMap((l) => (ids.has(l.componentId) ? [{ ...l, componentId: ids.get(l.componentId)! }] : []));
    let net = internal.has(n.name) ? undefined : findNet(d, op.nets[n.name]!);
    if (!net) {
      const name = internal.has(n.name) ? freeNet(d, isAutoNet(n) && !op.prefix ? undefined : (op.prefix ?? '') + n.name) : op.nets[n.name]!;
      net = createNet(d, name);
      const { loads: _l, ...attrs } = n.attrs;
      net.attrs = structuredClone(attrs) as NetAttrs;
      if (internal.has(n.name) && !isAutoNet(n) && net.name !== n.name) renamed.nets[n.name] = net.name;
    }
    if (loads.length) net.attrs.loads = [...(net.attrs.loads ?? []), ...loads];
    nets.set(srcNet, net.id);
  }
  for (const c of comps) for (const [pin, net] of Object.entries(c.pins)) if (nets.has(net)) d.components[ids.get(c.id)!]!.pins[pin] = nets.get(net)!;

  // its describe block, and the constraints on its parts that say how it is drawn
  let title = block.title;
  for (let i = 2; d.description?.blocks.some((b) => b.title === title); i++) title = `${block.title} (${i})`;
  d.description = { overview: d.description?.overview ?? '', blocks: [...(d.description?.blocks ?? []), { title, components: [...ids.values()], text: block.text }] };
  let constraints = 0;
  for (const k of Object.values(src.ledger)) {
    if (!TRAVELS.has(k.kind) || !k.a || !ids.has(k.a) || (k.b && !ids.has(k.b))) continue;
    const id = nextId(d, 'k');
    d.ledger[id] = { ...structuredClone(k), id, a: ids.get(k.a)!, ...(k.b ? { b: ids.get(k.b)! } : {}) };
    constraints++;
  }

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

/** `name`, or name_2, name_3 … where it is taken here (undefined: an automatic name). */
function freeNet(d: Design, name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const taken = (n: string) => !!findNet(d, n);
  if (!taken(name)) return name;
  for (let i = 2; ; i++) if (!taken(`${name}_${i}`)) return `${name}_${i}`;
}
