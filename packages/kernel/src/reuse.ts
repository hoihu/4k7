/**
 * Reusing a functional block from another project: design_query list_blocks reads a project the
 * server stores and lists its blocks (the describe blocks) with their parts and the nets inside and
 * at the edge of each. Read-only; import_block (importops.ts) copies one into the open design.
 * See docs/design/ops-api.md §7 and docs/design/ai-loop.md §5.
 *
 * The app reads the file (only a project the projects folder lists) and hands it to Kernel.query
 * (its `sources`), which calls blocksOfProject; nothing here touches a file, so it runs anywhere.
 */
import type { Design } from '@4k7/schema';
import { migrate } from './canonical.ts';
import { cardOf, isPowerNet, natCmp } from './doc.ts';

export interface ListedBlock {
  /** Its number in the project's describe order, from 1. */
  block: number;
  title: string;
  text: string;
  parts: { ref: string; part: string; params?: Record<string, string>; dnp?: true }[];
  /** Nets only this block's parts are on: the import makes them anew. */
  internal_nets: string[];
  /** Nets that leave the block: each is joined to a net of the importing design. */
  boundary_nets: { net: string; why: 'parts outside' | 'off-board' | 'supply'; pins: string[]; outside?: string[] }[];
}

export interface ListBlocksAnswer {
  project: string;
  blocks: ListedBlock[];
  /** Parts no block names. */
  not_in_a_block?: string[];
  note: string;
}

/** The blocks of a project's design (its parsed file). */
export function listBlocks(project: string, file: Design): ListBlocksAnswer {
  const d = migrate(file);
  const ref = (id: string) => d.components[id]?.refdes ?? id;
  const blocks = d.description?.blocks ?? [];
  // every net's parts, to tell a net that stays inside a block from one that leaves it
  const netParts = new Map<string, Set<string>>();
  for (const c of Object.values(d.components)) for (const net of Object.values(c.pins)) (netParts.get(net) ?? netParts.set(net, new Set()).get(net)!).add(c.id);

  const listed = blocks.map((b, i): ListedBlock => {
    const comps = b.components.map((id) => d.components[id]).filter((c) => c !== undefined);
    const inside = new Set(comps.map((c) => c.id));
    const pins = new Map<string, Set<string>>();
    for (const c of comps) {
      const card = cardOf(d, c.part);
      for (const [num, net] of Object.entries(c.pins)) (pins.get(net) ?? pins.set(net, new Set()).get(net)!).add(`${c.refdes}.${card?.pins.find((p) => p.number === num)?.name ?? num}`);
    }
    const internal: string[] = [];
    const boundary: ListedBlock['boundary_nets'] = [];
    for (const [id, at] of pins) {
      const n = d.nets[id];
      if (!n) continue;
      const outside = [...(netParts.get(id) ?? [])].filter((c) => !inside.has(c)).map(ref).sort(natCmp);
      const why = outside.length ? 'parts outside' : n.attrs.external ? 'off-board' : isPowerNet(n) ? 'supply' : null;
      if (!why) internal.push(n.name);
      else boundary.push({ net: n.name, why, pins: [...at].sort(natCmp), ...(outside.length ? { outside } : {}) });
    }
    return {
      block: i + 1,
      title: b.title,
      text: b.text,
      parts: comps.map((c) => ({ ref: c.refdes, part: c.part, ...(Object.keys(c.params).length ? { params: c.params } : {}), ...(c.dnp ? { dnp: true as const } : {}) })),
      internal_nets: internal.sort(natCmp),
      boundary_nets: boundary.sort((a, b) => natCmp(a.net, b.net)),
    };
  });

  const named = new Set(blocks.flatMap((b) => b.components));
  const loose = Object.values(d.components).filter((c) => !named.has(c.id)).map((c) => c.refdes).sort(natCmp);
  return {
    project,
    blocks: listed,
    ...(loose.length ? { not_in_a_block: loose } : {}),
    note: blocks.length
      ? 'Boundary nets leave the block (to parts outside it, off the board, or a supply or ground the importing design has its own of): each must be joined to a net of the open design. Values were chosen for that project: check them against this one. design_edit import_block copies a block in, with every boundary net mapped; map an internal net too where this design already has that net (else it is made anew, NTC_2 where NTC is taken).'
      : `${project} has no functional blocks (describe blocks): there is nothing to reuse from it until it is grouped.`,
  };
}

/**
 * Project `id`'s design, migrated: `text` is its file as the server gave it, `known` the projects the
 * projects folder lists. An id it does not list is never read; an unreadable file is an error.
 */
export function readProject(id: string, text: string | undefined, known: string[]): Design | { error: string; projects?: string[] } {
  if (!known.includes(id) || text === undefined) return { error: `No project "${id}" in the projects folder.`, projects: [...known].sort(natCmp) };
  try {
    const { conversation: _c, planStep: _p, ...design } = JSON.parse(text) as Design & { conversation?: unknown; planStep?: unknown };
    if (!design.components || !design.nets) throw new Error('not a design');
    return migrate(design);
  } catch (e) {
    return { error: `${id} could not be read: ${(e as Error).message}.` };
  }
}

/** list_blocks for project `id` (readProject). */
export function blocksOfProject(id: string, text: string | undefined, known: string[]): ListBlocksAnswer | { error: string; projects?: string[] } {
  const d = readProject(id, text, known);
  return 'error' in d ? d : listBlocks(id, d);
}
