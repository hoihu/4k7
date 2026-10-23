/**
 * Changesets: entity-level diff between the committed design and the agent's working
 * copy, and merging of a user-selected subset of hunks.
 */
import { openQuestions, planeStyleText, scriptPieces, type Component, type Design, type Hunk } from '@4k7/schema';
import { layoutText } from '@4k7/parts';
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
    if (JSON.stringify(a.symbolLayout ?? null) !== JSON.stringify(b.symbolLayout ?? null) && !b.units?.length) {
      what.push(b.customSymbol ? 'symbol: pins arranged' : 'symbol: generated arrangement');
      if (b.symbolLayout) details.push(layoutText(b, b.symbolLayout));
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

  /* standard-value series of generic passives */
  if (JSON.stringify(base.valueSeries ?? null) !== JSON.stringify(draft.valueSeries ?? null)) {
    const set = Object.entries(draft.valueSeries ?? {}).map(([k, v]) => `${k}s ${v}`);
    hunks.push({
      id: 'board:series',
      kind: 'board',
      change: base.valueSeries ? 'change' : 'add',
      entityId: 'series',
      title: `value series: ${set.join(', ') || 'any value'}`,
      details: [],
    });
  }

  /* the paper of the schematic pages */
  if ((base.paper ?? null) !== (draft.paper ?? null)) {
    hunks.push({
      id: 'board:paper',
      kind: 'board',
      change: base.paper ? 'change' : 'add',
      entityId: 'paper',
      title: `schematic paper: ${draft.paper ?? 'A4'}`,
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
  // (the routed copper is a cache kept with the board, not a change: see BoardSettings.copper)
  const bare = (b: Design['board']) => (b ? { ...b, copper: undefined } : null);
  if (JSON.stringify(bare(base.board)) !== JSON.stringify(bare(draft.board))) {
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
            ...(b.fab ? [`made by ${b.fab.house}, ${b.fab.tier}${b.fab.origin === 'imported' ? ` (limits imported from ${b.fab.source.url})` : ''}`] : []),
            ...(b.holes?.length ? [`${b.holes.length} mounting hole${b.holes.length > 1 ? 's' : ''} (${[...new Set(b.holes.map((x) => `Ø${x.d}`))].join(', ')})`] : []),
            ...(b.tracks?.length ? [`tracks laid by the agent: ${b.tracks.map((t) => `${t.id} ${draft.components[t.from.componentId]?.refdes ?? '?'}.${t.from.number} → ${draft.components[t.to.componentId]?.refdes ?? '?'}.${t.to.number}`).join(', ')}`] : []),
            ...(b.keepouts?.length ? [`keep-outs: ${b.keepouts.map((k) => `${k.id} ${k.area.under ? `under ${k.area.under.map((id) => draft.components[id]?.refdes ?? id).join(', ')}` : 'an area'}${k.layers ? ` on ${k.layers.join(', ')}` : ''}`).join('; ')}`] : []),
            ...(b.locked?.length ? [`copper locked: ${b.locked.map((l) => `${draft.nets[l.netId]?.name ?? l.netId} (${l.tracks.length} tracks)`).join(', ')}`] : []),
            ...(b.planes ? [`planes: ${b.planes.map((p) => `${draft.nets[p.netId]?.name ?? p.netId} on ${p.layer}${p.area ? (p.area.under ? ` under ${p.area.under.map((id) => draft.components[id]?.refdes ?? id).join(', ')}` : ' (an area)') : ''}${p.style ? ` (${planeStyleText(p.style)})` : ''}`).join(', ') || 'none'}`] : []),
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
    if (a && b && a.entities.join(',') !== b.entities.join(',')) {
      hunks.push({ id: `waiver:${id}`, kind: 'waiver', change: 'change', entityId: id, title: `waive ${b.code}`, details: [`${a.entities.join(', ')} → ${b.entities.join(', ')}`] });
    }
  }
  for (const id of Object.keys(draft.sheets)) {
    if (!base.sheets[id]) hunks.push({ id: `sheet:${id}`, kind: 'sheet', change: 'add', entityId: id, title: `sheet ${draft.sheets[id]!.name}`, details: [] });
  }

  /* stored schematic drawings (drawing.ts), one hunk per sheet */
  for (const id of new Set([...Object.keys(base.drawing ?? {}), ...Object.keys(draft.drawing ?? {})])) {
    const a = base.drawing?.[id];
    const b = draft.drawing?.[id];
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue;
    const sheet = (draft.sheets[id] ?? base.sheets[id])?.name ?? id;
    const where = (x: typeof a) => new Map((x?.symbols ?? []).map((s) => [`${s.comp}#${s.unit ?? ''}`, `${s.x},${s.y},${s.rot ?? 0},${JSON.stringify(s.spec)}`]));
    const [wa, wb] = [where(a), where(b)];
    const ref = (k: string) => {
      const [comp, unit] = k.split('#') as [string, string];
      return `${(draft.components[comp] ?? base.components[comp])?.refdes ?? comp}${unit}`;
    };
    const moved = [...wb].filter(([k, v]) => wa.has(k) && wa.get(k) !== v).map(([k]) => ref(k)).sort(natCmp);
    const added = [...wb.keys()].filter((k) => !wa.has(k)).map(ref).sort(natCmp);
    const details = [moved.length ? `moved: ${moved.join(', ')}` : '', a && added.length ? `drawn in free space: ${added.join(', ')}` : ''].filter(Boolean);
    const title = !a ? `schematic ${sheet}: arranged by the agent from here on` : !b ? `schematic ${sheet}: drawn by the auto-layout again` : `schematic ${sheet}: drawing`;
    hunks.push({ id: `drawing:${id}`, kind: 'drawing', change: 'change', entityId: id, title, details: details.length ? details : ['wires and labels'] });
  }

  /* the enclosure: its brief and its script, each a hunk of its own */
  const encBrief = (d: Design) => JSON.stringify(d.enclosure?.brief ?? null);
  if (encBrief(base) !== encBrief(draft)) {
    const b = draft.enclosure?.brief;
    const open = openQuestions(b).length;
    hunks.push({
      id: 'enclosure:brief',
      kind: 'enclosure',
      change: !b ? 'remove' : base.enclosure?.brief ? 'change' : 'add',
      entityId: 'brief',
      title: b ? `enclosure brief: ${b.items.length} item${b.items.length === 1 ? '' : 's'}${open ? `, ${open} question${open === 1 ? '' : 's'} open` : ''}` : 'enclosure brief removed',
      details: (b?.items ?? []).map((i) => `${i.topic}: ${i.decision ?? `? ${i.question}`}`),
    });
  }
  if ((base.enclosure?.script ?? null) !== (draft.enclosure?.script ?? null)) {
    const sc = draft.enclosure?.script;
    hunks.push({
      id: 'enclosure:script',
      kind: 'enclosure',
      change: !sc ? 'remove' : base.enclosure?.script ? 'change' : 'add',
      entityId: 'script',
      title: sc ? `enclosure script: ${scriptPieces(sc)?.join(', ') ?? 'pieces'} (${sc.split('\n').length} lines)` : 'enclosure script removed',
      details: [],
    });
  }

  const encGraphics = (d: Design) => JSON.stringify(d.enclosure?.graphics ?? []);
  if (encGraphics(base) !== encGraphics(draft)) {
    const before = new Map((base.enclosure?.graphics ?? []).map((g) => [g.name, JSON.stringify(g)]));
    const after = draft.enclosure?.graphics ?? [];
    const changed = after.filter((g) => before.get(g.name) !== JSON.stringify(g));
    const gone = [...before.keys()].filter((n) => !after.some((g) => g.name === n));
    hunks.push({
      id: 'enclosure:graphics',
      kind: 'enclosure',
      change: !after.length ? 'remove' : before.size ? 'change' : 'add',
      entityId: 'graphics',
      title: after.length ? `enclosure graphics: ${after.map((g) => g.name).join(', ')}` : 'enclosure graphics removed',
      details: [...changed.map((g) => `${g.name}: ${g.source ?? 'graphic'}, ${g.w} × ${g.h}`), ...gone.map((n) => `${n}: removed`)],
    });
  }

  const order = { component: 0, part: 1, board: 2, net: 3, sheet: 4, constraint: 5, waiver: 6, description: 7, drawing: 8, enclosure: 9 };
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
        } else if (entity === 'series') {
          if (draft.valueSeries) d.valueSeries = clone(draft.valueSeries);
          else delete d.valueSeries;
        } else if (entity === 'paper') {
          if (draft.paper) d.paper = draft.paper;
          else delete d.paper;
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
      case 'enclosure': {
        const key = entity as 'brief' | 'script' | 'graphics';
        const value = draft.enclosure?.[key];
        const next = { ...d.enclosure };
        if (value === undefined) delete next[key];
        else (next as Record<string, unknown>)[key] = clone(value);
        if (!next.graphics?.length) delete next.graphics;
        if (next.brief || next.script || next.graphics) d.enclosure = next;
        else delete d.enclosure;
        break;
      }
      case 'constraint':
        if (draft.ledger[entity]) d.ledger[entity] = clone(draft.ledger[entity]!);
        else delete d.ledger[entity];
        break;
      case 'waiver':
        if (draft.waivers[entity]) d.waivers[entity] = clone(draft.waivers[entity]!);
        else delete d.waivers[entity];
        break;
      case 'drawing': {
        // the caller brings it in step with what else was accepted (syncDrawing)
        const sd = draft.drawing?.[entity];
        if (sd) d.drawing = { ...d.drawing, [entity]: clone(sd) };
        else if (d.drawing) {
          delete d.drawing[entity];
          if (!Object.keys(d.drawing).length) delete d.drawing;
        }
        break;
      }
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
