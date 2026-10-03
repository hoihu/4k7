/**
 * Changesets: entity-level diff between the committed design and the agent's working
 * copy, and merging of a user-selected subset of hunks.
 */
import type { Component, Design, Hunk } from '@tracewise/schema';
import { describeConstraint } from './apply.ts';
import { clone, gcNets, gcParts, natCmp, valueOf } from './doc.ts';

const netName = (d: Design, id?: string) => (id ? d.nets[id]?.name ?? '?' : '∅');

export function computeHunks(base: Design, draft: Design): Hunk[] {
  const hunks: Hunk[] = [];

  /* components */
  const ids = new Set([...Object.keys(base.components), ...Object.keys(draft.components)]);
  for (const id of ids) {
    const a = base.components[id];
    const b = draft.components[id];
    if (!a && b) {
      const conns = Object.entries(b.pins)
        .sort(([x], [y]) => natCmp(x, y))
        .map(([pin, net]) => `${pin}→${netName(draft, net)}`);
      hunks.push({
        id: `component:${id}`,
        kind: 'component',
        change: 'add',
        entityId: id,
        title: `${b.refdes} ${valueOf(draft, b)}`,
        details: [b.part, ...paramsList(b), ...(conns.length ? [conns.join(', ')] : [])],
      });
    } else if (a && !b) {
      hunks.push({ id: `component:${id}`, kind: 'component', change: 'remove', entityId: id, title: `${a.refdes} ${valueOf(base, a)}`, details: [a.part] });
    } else if (a && b) {
      const details = componentChanges(base, draft, a, b);
      if (details.length) {
        const va = valueOf(base, a);
        const vb = valueOf(draft, b);
        const title = a.refdes !== b.refdes ? `${a.refdes} → ${b.refdes}` : va !== vb ? `${b.refdes} ${va} → ${vb}` : `${b.refdes} ${details[0]}`;
        hunks.push({ id: `component:${id}`, kind: 'component', change: 'change', entityId: id, title, details });
      }
    }
  }

  /* part cards changed in the design (set_symbol, set_footprint); cards come and go with their components */
  for (const id of Object.keys(draft.parts)) {
    const a = base.parts[id];
    const b = draft.parts[id]!;
    if (!a || JSON.stringify(a) === JSON.stringify(b)) continue;
    const users = Object.values(draft.components).filter((c) => c.part === id).map((c) => c.refdes).sort(natCmp);
    const what: string[] = [];
    const details: string[] = [id];
    const ua = a.units?.length ?? 0;
    const ub = b.units?.length ?? 0;
    if (JSON.stringify(a.units ?? null) !== JSON.stringify(b.units ?? null)) {
      what.push(`symbol: ${ua ? `${ua} units` : 'single'} → ${ub ? `${ub} units` : 'single'}`);
      details.push(...(b.units?.map((u) => `${u.name}: ${u.title}`) ?? []));
    }
    if (JSON.stringify(a.packageInfo ?? null) !== JSON.stringify(b.packageInfo ?? null)) {
      const pkg = b.packageInfo;
      what.push(`footprint: ${a.packageInfo?.name ?? a.package ?? 'none'} → ${pkg?.name ?? 'none'}`);
      if (pkg?.pads) details.push(`${pkg.pads.length} pads${pkg.body_mm ? `, body ${pkg.body_mm[0]} × ${pkg.body_mm[1]} mm` : ''}${pkg.height_mm ? `, ${pkg.height_mm} mm high` : ''}`);
    }
    if ((a.mpn ?? '') !== (b.mpn ?? '')) what.push(`name: ${a.mpn ?? a.id} → ${b.mpn ?? b.id}`);
    if ((a.title ?? '') !== (b.title ?? '')) what.push(`title: ${b.title ?? 'none'}`);
    if (!what.length) what.push('part card changed');
    hunks.push({
      id: `part:${id}`,
      kind: 'part',
      change: 'change',
      entityId: id,
      title: `${users.join(', ') || id} ${what.join('; ')}`,
      details,
    });
  }

  /* package defaults for generic parts */
  if (JSON.stringify(base.packageDefaults ?? null) !== JSON.stringify(draft.packageDefaults ?? null)) {
    const pd = draft.packageDefaults ?? {};
    const set = Object.entries(pd).filter(([k]) => k !== 'autoSize').map(([k, v]) => `${k} ${v}`);
    hunks.push({
      id: 'board:packages',
      kind: 'board',
      change: base.packageDefaults ? 'change' : 'add',
      entityId: 'packages',
      title: `package defaults: ${set.join(', ') || 'library'}${pd.autoSize === false ? ', no automatic sizing' : ''}`,
      details: [],
    });
  }

  /* the description (the words of the design document) */
  if (JSON.stringify(base.description ?? null) !== JSON.stringify(draft.description ?? null)) {
    const blocks = draft.description?.blocks ?? [];
    hunks.push({
      id: 'description:description',
      kind: 'description',
      change: base.description ? 'change' : 'add',
      entityId: 'description',
      title: `design description: overview, ${blocks.length} block${blocks.length === 1 ? '' : 's'}`,
      details: blocks.map((b) => b.title),
    });
  }

  /* board settings */
  if (JSON.stringify(base.board ?? null) !== JSON.stringify(draft.board ?? null)) {
    const b = draft.board;
    hunks.push({
      id: 'board:board',
      kind: 'board',
      change: base.board ? 'change' : 'add',
      entityId: 'board',
      title: `board ${b?.width && b?.height ? `${b.width} × ${b.height} mm` : 'sized to fit'}, ${b?.layers ?? 2} layers`,
      details: b
        ? [
            `clearance ${b.rules.clearance} mm`,
            `track ${b.rules.track} / ${b.rules.powerTrack} mm`,
            ...(b.holes?.length ? [`${b.holes.length} mounting hole${b.holes.length > 1 ? 's' : ''} (${[...new Set(b.holes.map((x) => `Ø${x.d}`))].join(', ')})`] : []),
            ...(b.planes ? [`planes: ${b.planes.map((p) => `${draft.nets[p.netId]?.name ?? p.netId} on ${p.layer}`).join(', ') || 'none'}`] : []),
          ]
        : [],
    });
  }

  /* nets: attribute and name changes only (membership is carried by components) */
  for (const id of new Set([...Object.keys(base.nets), ...Object.keys(draft.nets)])) {
    const a = base.nets[id];
    const b = draft.nets[id];
    if (!b) continue;
    const details: string[] = [];
    if (a && a.name !== b.name) details.push(`renamed ${a.name} → ${b.name}`);
    const keys = new Set([...Object.keys(a?.attrs ?? {}), ...Object.keys(b.attrs)]) as Set<keyof typeof b.attrs>;
    for (const k of [...keys].sort()) {
      const va = a?.attrs[k];
      const vb = b.attrs[k];
      if (va !== vb) details.push(`${k}: ${va ?? '∅'} → ${vb ?? '∅'}`);
    }
    if (details.length) {
      hunks.push({ id: `net:${id}`, kind: 'net', change: a ? 'change' : 'add', entityId: id, title: `net ${b.name}`, details });
    }
  }

  /* ledger, waivers, sheets */
  for (const id of new Set([...Object.keys(base.ledger), ...Object.keys(draft.ledger)])) {
    const a = base.ledger[id];
    const b = draft.ledger[id];
    if (!a && b) hunks.push({ id: `constraint:${id}`, kind: 'constraint', change: 'add', entityId: id, title: describeConstraint(draft, b), details: [b.strength, ...(b.source.quote ? [`“${b.source.quote}”`] : [])] });
    if (a && !b) hunks.push({ id: `constraint:${id}`, kind: 'constraint', change: 'remove', entityId: id, title: describeConstraint(base, a), details: [] });
  }
  for (const id of new Set([...Object.keys(base.waivers), ...Object.keys(draft.waivers)])) {
    const a = base.waivers[id];
    const b = draft.waivers[id];
    if (!a && b) hunks.push({ id: `waiver:${id}`, kind: 'waiver', change: 'add', entityId: id, title: `waive ${b.code}`, details: [b.entities.join(', '), b.reason] });
    if (a && !b) hunks.push({ id: `waiver:${id}`, kind: 'waiver', change: 'remove', entityId: id, title: `waive ${a.code}`, details: [] });
  }
  for (const id of Object.keys(draft.sheets)) {
    if (!base.sheets[id]) hunks.push({ id: `sheet:${id}`, kind: 'sheet', change: 'add', entityId: id, title: `sheet ${draft.sheets[id]!.name}`, details: [] });
  }

  const order = { component: 0, part: 1, board: 2, net: 3, sheet: 4, constraint: 5, waiver: 6, description: 7 };
  const changeOrder = { add: 0, change: 1, remove: 2 };
  return hunks.sort((x, y) => order[x.kind] - order[y.kind] || changeOrder[x.change] - changeOrder[y.change] || natCmp(x.title, y.title));
}

function paramsList(c: Component): string[] {
  return Object.entries(c.params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);
}

function componentChanges(base: Design, draft: Design, a: Component, b: Component): string[] {
  const out: string[] = [];
  if (a.refdes !== b.refdes) out.push(`refdes ${a.refdes} → ${b.refdes}`);
  if (a.part !== b.part) out.push(`part ${a.part} → ${b.part}`);
  if (a.sheet !== b.sheet) out.push(`sheet ${base.sheets[a.sheet]?.name} → ${draft.sheets[b.sheet]?.name}`);
  for (const k of [...new Set([...Object.keys(a.params), ...Object.keys(b.params)])].sort()) {
    if (a.params[k] !== b.params[k]) out.push(`${k} ${a.params[k] ?? '∅'} → ${b.params[k] ?? '∅'}`);
  }
  for (const pin of [...new Set([...Object.keys(a.pins), ...Object.keys(b.pins)])].sort(natCmp)) {
    const na = netName(base, a.pins[pin]);
    const nb = netName(draft, b.pins[pin]);
    if (na !== nb) out.push(`pin ${pin}: ${na} → ${nb}`);
  }
  const ncA = [...a.noConnect].sort().join(',');
  const ncB = [...b.noConnect].sort().join(',');
  if (ncA !== ncB) out.push(`no-connect ${ncA || '∅'} → ${ncB || '∅'}`);
  return out;
}

/**
 * Build a new committed design from `base` plus the accepted hunks of `draft`.
 * Entity states are taken from the draft, so accepted hunks are applied exactly.
 */
export function mergeHunks(base: Design, draft: Design, accepted: Set<string>): { design: Design; notes: string[] } {
  const d = clone(base);
  const notes: string[] = [];
  d.seq = Math.max(base.seq, draft.seq);
  d.name = draft.name;

  const ensureNet = (id: string) => {
    if (!d.nets[id] && draft.nets[id]) d.nets[id] = clone(draft.nets[id]!);
  };

  for (const id of accepted) {
    const [kind, entity] = id.split(/:(.*)/s) as [string, string];
    switch (kind) {
      case 'sheet':
        if (draft.sheets[entity]) d.sheets[entity] = clone(draft.sheets[entity]!);
        break;
      case 'net':
        if (draft.nets[entity]) d.nets[entity] = clone(draft.nets[entity]!);
        break;
      case 'component': {
        const c = draft.components[entity];
        if (!c) {
          delete d.components[entity];
          break;
        }
        const copy = clone(c);
        for (const n of Object.values(copy.pins)) ensureNet(n);
        if (!d.sheets[copy.sheet]) d.sheets[copy.sheet] = clone(draft.sheets[copy.sheet]!);
        if (!d.parts[copy.part] && draft.parts[copy.part]) d.parts[copy.part] = clone(draft.parts[copy.part]!);
        d.components[entity] = copy;
        break;
      }
      case 'board':
        if (entity === 'packages') {
          if (draft.packageDefaults) d.packageDefaults = clone(draft.packageDefaults);
          else delete d.packageDefaults;
        } else if (draft.board) d.board = clone(draft.board);
        else delete d.board;
        break;
      case 'part':
        if (draft.parts[entity]) d.parts[entity] = clone(draft.parts[entity]!);
        break;
      case 'description':
        if (draft.description) d.description = clone(draft.description);
        else delete d.description;
        break;
      case 'constraint':
        if (draft.ledger[entity]) d.ledger[entity] = clone(draft.ledger[entity]!);
        else delete d.ledger[entity];
        break;
      case 'waiver':
        if (draft.waivers[entity]) d.waivers[entity] = clone(draft.waivers[entity]!);
        else delete d.waivers[entity];
        break;
    }
  }

  // refdes collisions can only arise from partially accepted renames
  const seen = new Map<string, string>();
  for (const c of Object.values(d.components).sort((a, b) => natCmp(a.id, b.id))) {
    if (seen.has(c.refdes)) {
      const prefix = c.refdes.replace(/\d+$/, '');
      let i = 1;
      while ([...Object.values(d.components)].some((x) => x.refdes === `${prefix}${i}`)) i++;
      notes.push(`${c.refdes} renamed to ${prefix}${i} to avoid a duplicate`);
      c.refdes = `${prefix}${i}`;
    }
    seen.set(c.refdes, c.id);
  }
  // constraints must not point at components that were not accepted
  for (const k of Object.values(d.ledger)) {
    if ((k.a && !d.components[k.a]) || (k.b && !d.components[k.b])) {
      delete d.ledger[k.id];
      notes.push(`dropped constraint ${k.id} (its component was not accepted)`);
    }
  }
  gcNets(d);
  gcParts(d);
  return { design: d, notes };
}
