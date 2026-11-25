/**
 * import_board (D29 step 5): the copper of the source board, every id remapped through the parts'
 * (`ids`) and nets' (`nets`) maps of copyParts. Drawn copper, laid connections, locked copper, planes,
 * via groups and impedance rules are carried as they are. The router's copper is a cache keyed on the
 * source's ids, so it is never copied: where it is current for the source (the test lock_copper makes),
 * its tracks and vias become locked copper, which the first route lays as it lies and keeps locked.
 * See docs/design/ops-api.md §7 and docs/design/multi-board.md.
 */
import type { BoardSettings, Design, LockedCopper, PadAnchor, PlaneArea, Track, Via } from '@4k7/schema';
import { copperKey, placedOf } from './board.ts';

/** What came over: the board-setting phrases for the effect, what stayed behind, and what to do next. */
export interface CarriedCopper {
  took: string[];
  left: string[];
  /** The advice for the effect ('' when the board is routed as it comes). */
  next: string;
}

/**
 * Put the copper of `from` (the source board's settings; `f` its focus) on `s` (the new board's),
 * replacing what `s` had. Copper on a net no part of the board is on is dropped (it has no net here).
 */
export function carryCopper(f: Design, from: BoardSettings, s: BoardSettings, ids: ReadonlyMap<string, string>, nets: ReadonlyMap<string, string>): CarriedCopper {
  const took: string[] = [];
  const net = (id: string) => nets.get(id);
  const pad = <T extends PadAnchor>(a: T): T => ({ ...a, componentId: ids.get(a.componentId) ?? a.componentId });
  const area = (a: PlaneArea): PlaneArea => (a.under ? { ...a, under: a.under.flatMap((c) => (ids.has(c) ? [ids.get(c)!] : [])) } : { ...a });
  const onNet = <T extends { netId: string }>(xs: readonly T[]): T[] => xs.flatMap((x) => (net(x.netId) ? [{ ...structuredClone(x), netId: net(x.netId)! }] : []));
  const set = <K extends keyof BoardSettings>(k: K, v: BoardSettings[K] | undefined, said?: string) => {
    if (v === undefined || (Array.isArray(v) && !v.length)) delete s[k];
    else {
      s[k] = v;
      if (said) took.push(said);
    }
  };

  // what fills and what is routed how: planes, via groups, impedance rules (absent: the automatic ones)
  // (an empty list is no planes at all, not the automatic ones: kept)
  const planes = from.planes && onNet(from.planes).map((p) => (p.area ? { ...p, area: area(p.area) } : p));
  if (planes) {
    s.planes = planes;
    took.push(planes.length ? `${planes.length} plane(s)` : 'no planes');
  } else delete s.planes;
  const vias = from.vias && onNet(from.vias).map((g) => ({ ...g, ...(g.pad ? { pad: { ...g.pad, componentId: ids.get(g.pad.componentId) ?? g.pad.componentId } } : {}), ...(g.area ? { area: area(g.area) } : {}), ...(g.along ? { along: net(g.along) ?? g.along } : {}) }));
  set('vias', vias, vias && `${vias.length} via group(s)`);
  const impedance = from.impedance?.filter((z) => z.nets.every((n) => net(n))).map((z) => ({ ...structuredClone(z), nets: z.nets.map((n) => net(n)!) }));
  set('impedance', impedance, impedance && `${impedance.length} impedance rule(s)`);

  // drawn copper: the board's copper as it is, ids and numbering kept; routed at once
  delete s.drawn;
  delete s.laid;
  delete s.locked;
  if (from.drawn) {
    const ends = <T extends { from?: PadAnchor; to?: PadAnchor }>(t: T): T => ({ ...t, ...(t.from ? { from: pad(t.from) } : {}), ...(t.to ? { to: pad(t.to) } : {}) });
    const drawn = { tracks: onNet(from.drawn.tracks).map(ends), vias: onNet(from.drawn.vias), next: from.drawn.next };
    s.drawn = drawn;
    took.push(`drawn copper (${drawn.tracks.length} tracks, ${drawn.vias.length} vias): routed as drawn`);
    return { took, left: [], next: '' };
  }

  // the router's: the connections laid by hand, the locked copper (one entry per net here, merged nets together)
  const laid = from.laid && onNet(from.laid).map((t) => ({ ...t, from: pad(t.from), to: pad(t.to) }));
  set('laid', laid, laid && `${laid.length} laid connection(s)`);
  const locked = new Map<string, LockedCopper>();
  const lock = (netId: string, tracks: Track[], vias: Via[]) => {
    const to = net(netId);
    if (!to) return;
    const l = locked.get(to) ?? { netId: to, tracks: [], vias: [] };
    l.tracks.push(...onNet(tracks));
    l.vias.push(...onNet(vias));
    locked.set(to, l);
  };
  for (const l of from.locked ?? []) lock(l.netId, l.tracks, l.vias);
  const had = locked.size;

  // the routed copper, if current: what lock_copper would lock, of every net (not laid, not locked, not a group's)
  const copper = from.copper;
  const left: string[] = [];
  let routed = '';
  if (copper && !copper.stopped && copper.key === copperKey(f)) {
    const stubs = new Set(placedOf(f).tracks.map((t) => JSON.stringify(t)));
    const bare = <T extends { laid?: string; locked?: boolean }>({ laid: _l, locked: _k, ...x }: T) => x;
    const tracks = copper.tracks.filter((t) => !t.laid && !t.locked && !stubs.has(JSON.stringify(t))).map(bare);
    const vs = copper.vias.filter((v) => !v.laid && !v.locked && !v.group).map(bare);
    for (const id of new Set([...tracks, ...vs].map((x) => x.netId))) lock(id, tracks.filter((t) => t.netId === id), vs.filter((v) => v.netId === id));
    routed = '; from its routing';
  } else if (copper || from.routed) left.push('copper');
  const all = [...locked.values()];
  set('locked', all, all.length ? `locked copper of ${all.length} net(s) (${all.reduce((n, l) => n + l.tracks.length, 0)} tracks, ${all.reduce((n, l) => n + l.vias.length, 0)} vias${routed}${had && routed ? `, ${had} locked there already` : ''})` : undefined);
  const why = copper?.stopped ? 'stopped before it finished' : 'stale: the board changed since it was routed';
  const next = left.length
    ? `; not brought over: copper (${why}): route the board`
    : all.length
      ? '; route the board: it lays the locked copper first, as it lies, and routes the rest'
      : '; no copper in the source: route the board';
  return { took, left, next };
}
