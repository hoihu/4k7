/**
 * The board's view: where the parts stand (placer.ts), then the ratsnest, the planes and the
 * placement checks. Routing (router.ts) runs on the result, and layoutBoard adds its copper and the
 * copper checks.
 */
import { type BoardCutout, type BoardPad, type BoardPart, type BoardRules, boardStackup, type BoardView, type CopperLayer, cutoutDistance, cutoutPolygon, type Design, type Diagnostic, type DrawnCopper, type DrawnTrack, type DrawnVia, figureDepths, insideBoard, type PadAnchor, padCapsule, padPins, placeCutout, placeGraphic, placeKeepout, PLANE_AREA_MARGIN, type PlaneArea, type RatsLine, type SchematicView, type StoredCopper, type StoredPlacement, type Track, type UnroutedConnection, type Via, VIA_PITCH, viaCurrentFor, type ViaGroup, viasForCurrent } from '@4k7/schema';
import { stableJson } from './canonical.ts';
import { type Board as CongestionBoard, congestion } from './congestion.ts';
import { boardInputs, Memo } from './derive.ts';
import { applyWaivers, boardCopy, cardOf, clone, isGroundNet, isPowerNet, natCmp, valueOf } from './doc.ts';
import { viewOf } from './drawing.ts';
import { acidDrc, copperDrc, deadCopperDrc, drawnDrc, edgeDrc, neckDrc, planeViaDrc, splitDrc, thermalDrc } from './drc.ts';
import { fabCopperDrc, fabPlacementDrc } from './fabdrc.ts';
import { polyLength, r3 } from './geom.ts';
import { keepoutDrc } from './keepout.ts';
import { impedanceDrc, pourGaps, resolveImpedance, ruleWidth } from './lines.ts';
import { padOfPin, pin1Chamfer, placeMarks, polarityOf } from './marks.ts';
import { panelTabDrc, panelView } from './panel.ts';
import { CORNER, cornerAt, type Item, padNet, placeParts, rotate, settingsPlanes, swapped } from './placer.ts';
import { route, type RouteInput, type RouteProgress } from './router.ts';

/**
 * A drop via's spot on the board, from its offset to the pad's centre in the footprint's own frame
 * (add_vias drop): mirrored on the bottom side, turned with the part.
 */
export function dropSpot(part: Pick<BoardPart, 'rot' | 'side'>, pad: Pick<BoardPad, 'x' | 'y'>, [dx, dy]: [number, number]): [number, number] {
  const [x, y] = rotate(part.side === 'bottom' ? -dx : dx, dy, part.rot);
  return [r3(pad.x + x), r3(pad.y + y)];
}

/** The offset dropSpot takes for a spot on the board, as the part stands now. */
export function dropOffset(part: Pick<BoardPart, 'rot' | 'side'>, pad: Pick<BoardPad, 'x' | 'y'>, x: number, y: number): [number, number] {
  const [dx, dy] = rotate(x - pad.x, y - pad.y, -part.rot);
  return [r3(part.side === 'bottom' ? -dx : dx) || 0, r3(dy) || 0];
}

/** Placements by what they are worked out from: an edit asks several times for the same one, and for the one before it. */
const placements = new Memo<BoardView>('placement', 4);

/** How much of a silkscreen graphic is off the board, and how deep its figures lie in each other. */
const silkFacts = new Memo<{ off: number; depth: number[] }>('silkscreen graphic', 8);

/** The panel: of the outline and the panel's settings, not of where the parts stand. */
const panels = new Memo<ReturnType<typeof panelView>>('panel', 4);

/**
 * The board as placed now. Shared with whoever else asks (derive.ts): read it, and take a copy to
 * write into it. (Worked out from a copy of the design: the view holds on to the rules, the drawn
 * copper and more, and ops go on to change those in place.)
 */
export function placedOf(d: Design): BoardView {
  return placements.get(boardInputs(d), () => {
    const { enclosure: _e, board, ...rest } = d;
    const { copper: _c, ...settings } = board ?? {};
    const own = clone({ ...rest, ...(board ? { board: settings } : {}) }) as Design;
    return placeBoard(own, viewOf(own));
  });
}

export function placeBoard(d: Design, sch: SchematicView): BoardView {
  const { settings, rules, layers, missing, items, declared, springs, parent, userSize, shape, satellites, w, h, cutouts, cornerR, holeParts } = placeParts(d, sch);
  /* ---- result ---- */
  const boardCutouts = cutouts.map((c) => placeCutout(c, w, h));
  const boardGraphics = (settings.graphics ?? []).map((g) => placeGraphic(g, w, h));
  const parts: BoardPart[] = [
    ...items.map((it) => {
      const pa = parent.get(it);
      const at = springs.find((x) => x.it === it && x.to === pa) ?? satellites.find((x) => x.it === it && x.to === pa);
      const said = declared.get(it);
      return {
        ...toPart(d, it, layers),
        ...(pa ? { follows: pa.comp.refdes, ...(at ? { followsPin: at.pin } : {}) } : {}),
        ...(said ? { belongsDeclared: true } : {}),
      };
    }),
    ...holeParts,
  ];
  // keep-outs where they stand now (those attached to a part follow it; one whose part is gone is inert)
  const boardKeepouts = (settings.keepouts ?? []).flatMap((k) => {
    const host = k.part ? parts.find((p) => p.componentId === k.part) : undefined;
    return k.part && !host ? [] : [placeKeepout(k, layers, host)];
  });
  const diagnostics = placementChecks(parts, w, h, rules.edgeClearance, { outline: { w, h }, cornerRadius: cornerR, shape }, boardCutouts);
  // silkscreen graphics: wholly on the board (the real outline, not its box), and clear of parts?
  const outlineOf = { outline: { w, h }, cornerRadius: cornerR, shape };
  const outlineKey = JSON.stringify([w, h, cornerR, shape, boardCutouts]);
  for (const g of boardGraphics) {
    const label = `Silkscreen graphic ${g.id}${g.name ? ` (${g.name})` : ''}`;
    const pts = g.polys.flatMap((p) => p.map((_, i) => i).filter((i) => i % 2 === 0).map((i) => [p[i]!, p[i + 1]!] as const));
    // (a traced picture has tens of thousands of points, and neither changes when a part moves)
    const { off, depth } = silkFacts.get(`${outlineKey}|${JSON.stringify(g.polys)}`, () => ({
      off: pts.filter(([x, y]) => insideBoard(outlineOf, x, y) < 0 || boardCutouts.some((c) => cutoutDistance(c, x, y) < 0)).length,
      depth: figureDepths(g.polys),
    }));
    g.inside = off === 0;
    if (!g.inside) diagnostics.push({ code: 'DRC.SILK_OUTSIDE', severity: 'warning', message: `${label} reaches past the board outline${boardCutouts.length ? ' or into a cutout' : ''} (${Math.round((100 * off) / pts.length)} % of its contour); that part is not printed. Move or shrink it (edit_graphic).`, entities: [g.id] });
    const inInk = (x: number, y: number) => g.polys.reduce((n, p, k) => n + (pointInPolygon(p, x, y) ? 1 : 0) * (depth[k]! % 2 === 0 ? 1 : -1), 0) > 0;
    g.over = parts
      .filter((p) => {
        // ink meets the parts on its own side (and the pads of through-hole parts)
        if (p.side !== g.side && !p.pads.some((q) => q.drill)) return false;
        const c = p.courtyard;
        if (c.x > g.bounds[2] || c.x + c.w < g.bounds[0] || c.y > g.bounds[3] || c.y + c.h < g.bounds[1]) return false;
        if (pts.some(([x, y]) => x > c.x && x < c.x + c.w && y > c.y && y < c.y + c.h)) return true;
        return g.mode === 'fill' && [[c.x, c.y], [c.x + c.w, c.y], [c.x, c.y + c.h], [c.x + c.w, c.y + c.h], [c.x + c.w / 2, c.y + c.h / 2]].some(([x, y]) => inInk(x!, y!));
      })
      .map((p) => p.refdes);
    if (g.over.length) diagnostics.push({ code: 'DRC.SILK_OVER_PARTS', severity: 'warning', message: `${label} lies over ${g.over.join(', ')}; ink is kept off pads but covers the rest. Move it to a free spot (edit_graphic).`, entities: [g.id, ...g.over] });
  }
  // pins sharing one pad are one piece of copper: on two nets they short
  for (const it of items) {
    for (const pad of it.fp.pads) {
      if (!pad.also) continue;
      const on = padPins(pad).filter((n) => it.comp.pins[n]);
      if (new Set(on.map((n) => it.comp.pins[n])).size < 2) continue;
      const which = on.map((n) => `${n} on ${d.nets[it.comp.pins[n]!]?.name ?? '?'}`).join(', ');
      diagnostics.push({ code: 'DRC.SHARED_PAD_NETS', severity: 'error', message: `${it.comp.refdes}: pins ${padPins(pad).join(', ')} share one pad but are on different nets (${which}); that shorts them. Connect them to the same net.`, entities: [it.comp.refdes] });
    }
  }
  for (const ref of missing) {
    diagnostics.push({ code: 'DRC.NO_FOOTPRINT', severity: 'warning', message: `${ref} has no footprint (no package data); it is left off the board. Give it one from its datasheet drawing with set_footprint.`, entities: [ref] });
  }
  // a diode or LED whose pins do not say which is the cathode: the board cannot mark it
  for (const it of items) {
    if (polarityOf(it.card) !== 'unknown') continue;
    diagnostics.push({
      code: 'DRC.POLARITY_UNKNOWN',
      severity: 'warning',
      message: `${it.comp.refdes} is a${it.card.category === 'led' ? 'n LED' : ' diode'}, but the names of its pins (${it.card.pins.map((p) => `${p.number} "${p.name}"`).join(', ')}) do not say which is the cathode, so the silkscreen cannot mark it and the assembler will have to ask. Read it off the datasheet and say it with set_polarity (mark cathode, pin).`,
      entities: [it.comp.refdes],
    });
  }
  const planes = placePlanes(settingsPlanes(d, layers.length as 2 | 4), parts, w, h);
  const viaPlan = planVias(settings.vias ?? [], parts, w, h, rules, (id) => d.nets[id]?.attrs.maxCurrent);
  // the stack-up, and the impedance rules worked out for it (each layer's width and gaps)
  const stackup = boardStackup(settings);
  const impedance = resolveImpedance(d, { layers, planes, rules, ...(settings.fab ? { fab: settings.fab } : {}), stackup });
  // (keys sorted: a design read back from its file has them in another order than one just edited)
  const placementKey = hash(stableJson([w, h, cornerR, shape, boardCutouts, ...(boardKeepouts.length ? [boardKeepouts] : []), layers, rules, planes, ...(viaPlan.groups.length ? [viaPlan.fixed, viaPlan.fill, ...(viaPlan.drops ? [viaPlan.drops] : []), ...(viaPlan.along ? [viaPlan.along] : [])] : []), parts.map((p) => [p.componentId, p.x, p.y, p.rot, p.side, p.pads.map((q) => q.netId ?? '')])]));
  const drawn = settings.drawn ? drawnCopper(settings.drawn, parts) : null;
  const view: BoardView = {
    outline: { w, h },
    layers,
    rules,
    ...(settings.fab ? { fab: settings.fab } : {}),
    stackup,
    ...(impedance.length ? { impedance } : {}),
    parts,
    tracks: [...(viaPlan.stubs ?? []), ...(drawn?.tracks ?? [])],
    vias: [...viaPlan.fixed, ...(drawn?.vias ?? [])],
    zones: [],
    planes,
    viaGroups: viaPlan.groups,
    ratsnest: ratsnest(parts),
    diagnostics,
    stats: { nets: 0, routed: 0, unrouted: 0, trackLength: 0, vias: 0 },
    unrouted: [],
    measures: placementMeasures(parts, new Set(planes.filter((pl) => pl.layer !== 'F.Cu' && pl.layer !== 'B.Cu' && !pl.area).map((pl) => pl.netId)), {
      w,
      h,
      rules,
      signal: layers.filter((l) => !planes.some((pl) => pl.layer === l && l !== 'F.Cu' && l !== 'B.Cu' && !pl.area)),
    }),
    missing,
    netNames: Object.fromEntries(Object.values(d.nets).map((n) => [n.id, n.name])),
    routing: drawn ? 'done' : settings.routed ? (settings.routed === placementKey ? 'done' : 'stale') : 'none',
    ...(drawn ? { drawn } : {}),
    placementKey,
    sizeBy: userSize ? 'user' : 'proposal',
    cornerRadius: cornerR,
    shape,
    cutouts: boardCutouts,
    keepouts: boardKeepouts,
    graphics: boardGraphics,
  };
  // the polarity marks, once every pad and via is where it stays
  const marked = placeMarks(view);
  view.parts = marked.parts;
  view.diagnostics.push(...marked.diagnostics);
  if (settings.panel && parts.length) {
    const panel = panels.get(JSON.stringify([view.outline, view.cornerRadius, view.shape, settings.panel]), () => panelView(view, settings.panel!));
    view.panel = panel.view;
    view.diagnostics.push(...panel.diagnostics);
    view.diagnostics.push(...panelTabDrc(view));
  }
  view.diagnostics.push(...fabPlacementDrc(view), ...keepoutDrc(view));
  applyWaivers(d, view.diagnostics);
  return view;
}

/** The placement to store (propose_placement, place, route): where every part is now. */
export function storedPlacement(b: BoardView): StoredPlacement {
  return {
    outline: { ...b.outline },
    parts: Object.fromEntries(b.parts.filter((p) => !p.componentId.startsWith('hole:')).map((p) => [p.componentId, { x: p.x, y: p.y, rot: p.rot }])),
  };
}

/** Store the current placement, so later layouts start from it. */
export function keepPlacement(d: Design) {
  const b = boardCopy(d);
  d.board = b;
  const now = placedOf(d);
  b.placement = storedPlacement(now);
  if (!b.drawn) choicesWhereTheyStand(d, now); // (drawn copper: the placement is frozen, nothing is nudged)
}

/**
 * Each placement choice (soft position) where its part ended up: the placer may have nudged it
 * clear of a neighbour or the edge, and a choice that still says the old spot would be applied
 * again, and the nudge with it, every time the board is laid out from the stored placement.
 */
function choicesWhereTheyStand(d: Design, now: BoardView) {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  for (const k of Object.values(d.ledger)) {
    if (k.kind !== 'position' || k.strength !== 'soft' || !k.a) continue;
    const part = now.parts.find((p) => p.componentId === k.a);
    const anchor = k.rel ? now.parts.find((p) => p.componentId === k.rel) : undefined;
    if (!part || (k.rel && !anchor)) continue;
    // (a two-pin part turned round by 180° to face what it connects to keeps the direction chosen)
    const turned = (was: number, to: number) => (((to - was) % 360) + 360) % 360 === 180 && part.pads.length === 2 ? was : to;
    if (!anchor) {
      if (k.xMm !== undefined) k.xMm = part.x;
      if (k.yMm !== undefined) k.yMm = part.y;
      if (k.rot !== undefined) k.rot = turned(k.rot, part.rot);
      continue;
    }
    const dx = part.x - anchor.x;
    const dy = part.y - anchor.y;
    const back = (360 - anchor.rot) % 360;
    const [ox, oy] = back === 90 ? [-dy, dx] : back === 180 ? [-dx, -dy] : back === 270 ? [dy, -dx] : [dx, dy];
    if (k.xMm !== undefined) k.xMm = r(ox);
    if (k.yMm !== undefined) k.yMm = r(oy);
    if (k.rot !== undefined) k.rot = turned(k.rot, (((part.rot - anchor.rot) % 360) + 360) % 360);
  }
}

/** Whether a point lies inside a closed polygon (flat x, y list), even-odd. */
function pointInPolygon(p: number[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const [xi, yi, xj, yj] = [p[i]!, p[i + 1]!, p[j]!, p[j + 1]!];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** FNV-1a, as 8 hex digits. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Bump when what StoredCopper holds changes meaning: copper kept by an older version is routed again. */
const COPPER_FORMAT = 1;

/**
 * The board as placed (`b`): routed and its copper checked when the route step was taken for this placement (or `route`).
 * Copper the design keeps for this placement (`board.copper`) is used as it is; otherwise the
 * board is routed (to completion if it can be: that may take a while) and the result comes back
 * as `newCopper` for the app to keep.
 */
export function layoutBoard(d: Design, b: BoardView, opts: { budgetMs?: number; route?: boolean; onProgress?: (p: RouteProgress) => void; onBest?: (c: StoredCopper) => void } = {}): BoardView {
  if (!b.parts.length || (b.routing !== 'done' && !opts.route)) return b;
  const { powerNets, planes, netWidths, key, basis } = routeSetup(d, b);
  const pads = b.parts.flatMap((p) => p.pads);
  const kept = d.board?.copper?.key === key ? d.board.copper : null;
  // routed before for another placement on the same board: the router keeps what still holds of
  // it (incremental routing), but not the copper of a net whose width, current or planes changed
  // (drawn copper is the agent's: nothing to keep)
  const before = !kept && !b.drawn && d.board?.copper?.basis?.board === basis.board ? d.board.copper : null;
  const same = (netId: string) => before?.basis?.nets[netId] === basis.nets[netId];
  // (copper kept while the copper was drawn carries ids, anchors and the helper mark: the router's has none)
  const plain = <T extends object>(x: T): T => {
    const { id: _i, from: _f, to: _t, by: _b, ...rest } = x as T & { id?: string; from?: unknown; to?: unknown; by?: string };
    return rest as T;
  };
  const keep = before ? { tracks: before.tracks.filter((t) => same(t.netId)).map(plain), vias: before.vias.filter((v) => same(v.netId)).map(plain) } : null;
  const index = new Map(pads.map((p, i) => [p, i]));
  const toCopper = (r: ReturnType<typeof route>): StoredCopper => ({
    key,
    tracks: r.tracks,
    vias: r.vias,
    zones: r.zones,
    groups: r.groups,
    open: r.failed.map(({ netId, a, b: pb, ...why }) => ({ netId, a: index.get(a)!, b: index.get(pb)!, ...why })),
    nets: r.netsTotal,
    netsDone: r.netsDone,
    timedOut: r.timedOut,
    passes: r.passes,
    basis,
    ...(r.reused ? { reused: r.reused } : {}),
    ...(r.lines?.length ? { lines: r.lines } : {}),
  });
  const copper =
    kept ??
    toCopper(
      route(
        boardRouteInput(d, b, {
          ...(keep ? { keep } : {}),
          ...(opts.budgetMs ? { budgetMs: opts.budgetMs } : {}),
          ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
          // what a stop keeps: the best pass so far, marked as stopped
          ...(opts.onBest ? { onBest: (r: ReturnType<typeof route>) => opts.onBest!({ ...toCopper(r), stopped: true }) } : {}),
        }),
        b.drawn ? 1 : undefined,
      ),
    );
  const connected = (netId: string, a: BoardPad, pb: BoardPad) => {
    const ia = index.get(a);
    const ib = index.get(pb);
    return ia !== undefined && ib !== undefined && copper.groups[ia] === copper.groups[ib] && a.netId === netId;
  };
  const midpoint = (o: { a: number; b: number }) => ({ x: (pads[o.a]!.x + pads[o.b]!.x) / 2, y: (pads[o.a]!.y + pads[o.b]!.y) / 2 });
  const owner = b.parts.flatMap((p) => p.pads.map(() => p));
  const label = (i: number) => `${owner[i]?.refdes ?? '?'}.${pads[i]?.number ?? '?'}`;
  const unrouted: UnroutedConnection[] = copper.open.map(({ netId, a, b: pb, ...why }) => {
    const spot = why.at ?? midpoint({ a, b: pb });
    const near = b.parts
      .filter((p) => !p.componentId.startsWith('hole:'))
      .map((p) => ({ p, d: Math.hypot(Math.max(p.courtyard.x - spot.x, 0, spot.x - p.courtyard.x - p.courtyard.w), Math.max(p.courtyard.y - spot.y, 0, spot.y - p.courtyard.y - p.courtyard.h)) }))
      .filter((x) => x.d <= NEAR_MM)
      .sort((x, y) => x.d - y.d)
      .slice(0, 6)
      .map((x) => x.p.refdes);
    return { netId, from: label(a), to: label(pb), ...why, near };
  });
  const routed: BoardView = {
    ...b,
    routing: 'done',
    tracks: copper.tracks,
    vias: copper.vias,
    zones: copper.zones,
    planes,
    ratsnest: ratsnest(b.parts, connected),
    stats: {
      nets: copper.nets,
      routed: copper.netsDone,
      unrouted: copper.open.length,
      trackLength: Math.round(copper.tracks.reduce((s, t) => s + polyLength(t.pts), 0) * 10) / 10,
      vias: copper.vias.length,
    },
    unrouted,
    ...(kept ? {} : { newCopper: copper }),
    ...(copper.stopped ? { stopped: true } : {}),
    ...(copper.reused ? { reused: copper.reused } : {}),
  };
  // the polarity marks again, clear of the vias the routing put down
  const marked = placeMarks(routed);
  routed.parts = marked.parts;
  const name = (id: string) => d.nets[id]?.name ?? id;
  const diags = [...b.diagnostics.filter((x) => x.code !== 'DRC.SILK_POLARITY' && x.code !== 'DRC.KEEPOUT' && !x.code.startsWith('PANEL.TAB_')), ...marked.diagnostics, ...panelTabDrc(routed), ...keepoutDrc(routed), ...copperDrc(routed), ...edgeDrc(routed, !!b.drawn), ...fabCopperDrc(routed), ...splitDrc(routed, (id) => !powerNets.has(id)), ...planeViaDrc(routed), ...acidDrc(routed), ...neckDrc(routed, (id, layer) => ruleWidth(b.impedance, id, layer) ?? netWidths[id] ?? (powerNets.has(id) ? b.rules.powerTrack : b.rules.track)), ...thermalDrc(routed), ...deadCopperDrc(routed), ...(b.drawn ? drawnDrc(routed) : []), ...impedanceDrc(routed, undefined, powerNets)].map((x) => (b.drawn ? softened(x) : x));
  // a pair the router could not keep together: recorded, so it is not silently two lines
  for (const l of copper.lines ?? []) {
    if (l.nets.length === 2 && l.why) diags.push({ code: 'IMP.PAIR', severity: 'info', message: `${l.nets.map(name).join('/')} (${l.id}) ${l.coupled ? 'kept together' : 'routed apart (open pair)'}: ${l.why}.`, entities: [l.id] });
  }
  const byNet = new Map<string, UnroutedConnection[]>();
  for (const u of unrouted) byNet.set(u.netId, [...(byNet.get(u.netId) ?? []), u]);
  for (const [netId, list] of byNet) {
    const u = list[0]!;
    const n = list.length;
    const why = u.enclosed
      ? `; ${u.from} is closed off by pads or the edge`
      : u.plane
        ? `; no room for a via down to the ${u.plane} plane`
        : u.blockedBy?.length
          ? `; ${u.blockedBy.map(name).join(', ')} ${u.blockedBy.length > 1 ? 'are' : 'is'} in the way${u.near.length ? ` near ${u.near.slice(0, 3).join(', ')}` : ''}`
          : '';
    diags.push({
      code: 'DRC.UNROUTED',
      severity: 'error',
      message: b.drawn
        ? `${n} connection${n > 1 ? 's' : ''} of ${name(netId)} not drawn yet (${u.from} → ${u.to}${n > 1 ? ', …' : ''})${why}.`
        : `${n} connection${n > 1 ? 's' : ''} of ${name(netId)} could not be routed (${u.from} → ${u.to}${n > 1 ? ', …' : ''})${why}.`,
      at: u.at ? { x: u.at.x, y: u.at.y } : midpoint(copper.open.find((o) => o.netId === netId)!),
      entities: [...new Set([u.from.split('.')[0]!, u.to.split('.')[0]!])],
    });
  }
  if (copper.stopped) {
    diags.unshift({
      code: 'DRC.ROUTING_INCOMPLETE',
      severity: 'warning',
      message: copper.passes
        ? `Routing was stopped after ${copper.passes} pass${copper.passes === 1 ? '' : 'es'}; the best is kept, with ${copper.open.length} connection${copper.open.length === 1 ? '' : 's'} left. Route runs it again from the start.`
        : 'Routing was stopped before its first pass finished: nothing is routed. Route runs it again.',
      entities: [],
    });
  } else if (copper.timedOut) {
    diags.unshift({
      code: 'DRC.ROUTING_INCOMPLETE',
      severity: 'warning',
      message: `Routing stopped at its time budget with ${copper.open.length} connection${copper.open.length === 1 ? '' : 's'} left. Moving or turning the parts round the open connections, a bigger board or 4 layers usually helps.`,
      entities: [],
    });
  }
  applyWaivers(d, diags);
  return { ...routed, diagnostics: diags };
}

/**
 * The router's input for the board as placed (`b`, from placeBoard): parts, outline, planes, the
 * vias placed on purpose and, with drawn copper, that copper; `extra` adds to it.
 */
export function boardRouteInput(d: Design, b: BoardView, extra: Partial<RouteInput> = {}): RouteInput {
  const { powerNets, planes, netWidths, gaps } = routeSetup(d, b);
  // the lines at a set impedance and the planes under them (the router keeps those planes whole)
  const lines: NonNullable<RouteInput['lines']> = [];
  for (const v of b.impedance ?? []) {
    for (const lay of v.layers) {
      const plane = b.planes.find((p) => p.layer === lay.over && !p.area) ?? b.planes.find((p) => p.layer === lay.over);
      if (plane) for (const netId of v.nets) lines.push({ netId, layer: lay.layer, over: lay.over, plane: plane.netId, h: lay.h });
    }
  }
  return {
    outline: b.outline,
    layers: b.layers,
    rules: b.rules,
    parts: b.parts,
    powerNets,
    netWidths,
    ...(Object.keys(gaps).length ? { pourGaps: gaps } : {}),
    ...(lines.length ? { lines } : {}),
    ...(b.impedance?.some((v) => v.layers.length) ? { controlled: b.impedance.filter((v) => v.layers.length).map((v) => ({ id: v.id, nets: v.nets, layers: v.layers.map((l) => ({ layer: l.layer, width: l.width, ...(l.gap !== undefined ? { gap: l.gap } : {}) })) })), netNames: b.netNames } : {}),
    planes: planes.map(({ netId, layer, area, style }) => ({ netId, layer, ...(area ? { area } : {}), ...(style ? { style } : {}) })),
    ...(b.viaGroups.length ? { vias: withGaps(planVias(d.board?.vias ?? [], b.parts, b.outline.w, b.outline.h, b.rules, (id) => d.nets[id]?.attrs.maxCurrent), gaps, b.rules.clearance) } : {}),
    cornerRadius: b.cornerRadius,
    ...(b.shape ? { shape: b.shape } : {}),
    cutouts: b.cutouts,
    ...(b.keepouts?.length ? { keepouts: b.keepouts } : {}),
    ...(b.drawn ? { drawn: { tracks: b.drawn.tracks, vias: b.drawn.vias } } : {}),
    ...extra,
  };
}

/** The router's via plan, a fence along a line told the line's gap to the ground (its pour gap, else the clearance). */
function withGaps(plan: ViaPlan, gaps: Record<string, number>, clearance: number): NonNullable<RouteInput['vias']> {
  const { groups: _g, along, ...rest } = plan;
  return { ...rest, ...(along?.length ? { along: along.map((a) => ({ ...a, gap: Math.max(clearance, gaps[a.line] ?? 0) })) } : {}) };
}

/**
 * The agent's drawn copper on the board as placed: a track end anchored on a pad lies on the pad's
 * centre wherever the part is now (a part moved or turned stretches the track's end piece).
 */
export function drawnCopper(dc: DrawnCopper, parts: BoardPart[]): { tracks: DrawnTrack[]; vias: DrawnVia[] } {
  const padAt = (a: PadAnchor | undefined) => (a ? parts.find((p) => p.componentId === a.componentId)?.pads.find((q) => q.number === a.pad) : undefined);
  const tracks = dc.tracks.map((t) => {
    const pts = t.pts.slice();
    const f = padAt(t.from);
    const e = padAt(t.to);
    if (f) [pts[0], pts[1]] = [f.x, f.y];
    if (e) [pts[pts.length - 2], pts[pts.length - 1]] = [e.x, e.y];
    return { ...t, pts: pts.map((v) => Math.round(v * 1000) / 1000) };
  });
  return { tracks, vias: dc.vias };
}

/**
 * Drawn copper: the hard rules stay errors (shorts, clearance, the edge, the fab's limits, open
 * connections); the rest is the agent's judgement and only warns. A via in a small part's land
 * pattern (no other net's pad under it: that is a short) is soft.
 */
export function softened(x: Diagnostic): Diagnostic {
  return x.code === 'DRC.VIA_IN_PAD' && x.severity === 'error' ? { ...x, severity: 'warning', message: `${x.message} (soft rule: fine where you mean it, e.g. a drop right beside a pad)` } : x;
}

/** What the router is given besides the placement, and the key copper routed with it is kept under. */
function routeSetup(d: Design, b: BoardView) {
  const powerNets = new Set(Object.values(d.nets).filter((n) => isPowerNet(n)).map((n) => n.id));
  const planes = b.planes;
  // a net's own width, or the one its impedance rule gives (on its first layer)
  const netWidths: Record<string, number> = Object.fromEntries(Object.values(d.nets).filter((n) => n.attrs.trackWidth).map((n) => [n.id, n.attrs.trackWidth!]));
  for (const v of b.impedance ?? []) if (v.layers[0]) for (const id of v.nets) netWidths[id] = v.layers[0].width;
  // how far the pours keep from a line at a set impedance
  const gaps = pourGaps(b.impedance);
  const key = hash(stableJson([COPPER_FORMAT, b.placementKey, [...powerNets].sort(), Object.entries(netWidths).sort(), ...(b.drawn ? ['drawn', b.drawn] : []), ...(Object.keys(gaps).length ? ['gaps', Object.entries(gaps).sort()] : [])]));
  // the pads dropping through vias the agent placed (add_vias drop), per net
  const drops = (d.board?.vias ?? []).filter((g) => g.kind === 'drop');
  // what copper routed now holds under (StoredCopper.basis): the board, and per net what decides its
  // copper. (Not the outline: an auto-sized board grows as parts move; the copper is checked
  // against the edge as it is now.)
  const basis = {
    board: hash(stableJson([COPPER_FORMAT, b.layers, b.rules])),
    nets: Object.fromEntries(
      Object.keys(d.nets)
        .sort()
        .map((id) => [id, hash(stableJson([powerNets.has(id), netWidths[id] ?? null, drops.filter((g) => g.netId === id).map((g) => [g.pad, g.offsets ?? g.count ?? null, g.drill ?? null, g.size ?? null]), planes.filter((pl) => pl.netId === id).map((pl) => [pl.layer, !!pl.area, pl.style ?? null]), ...(gaps[id] !== undefined ? [gaps[id]] : [])]))]),
    ),
  };
  return { powerNets, planes, netWidths, gaps, key, basis };
}

/** The key copper routed for this design's board now would be kept under (see BoardSettings.copper). */
export function copperKey(d: Design): string {
  return routeSetup(d, placedOf(d)).key;
}

/** Parts this close (mm) to where a connection is blocked are named with it. */
const NEAR_MM = 3;

/** The ratsnest of the nets routed as tracks: its length and where lines of different nets cross. */
function placementMeasures(parts: BoardPart[], planeNets: Set<string>, board: Omit<CongestionBoard, 'pads'>): BoardView['measures'] {
  const lines = ratsnest(parts).filter((l) => !planeNets.has(l.netId));
  const len = lines.reduce((s, l) => s + Math.hypot(l.x2 - l.x1, l.y2 - l.y1), 0);
  const o = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
  let crossings = 0;
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i]!;
    for (let j = i + 1; j < lines.length; j++) {
      const c = lines[j]!;
      if (c.netId === a.netId) continue;
      if (Math.max(a.x1, a.x2) < Math.min(c.x1, c.x2) || Math.max(c.x1, c.x2) < Math.min(a.x1, a.x2) || Math.max(a.y1, a.y2) < Math.min(c.y1, c.y2) || Math.max(c.y1, c.y2) < Math.min(a.y1, a.y2)) continue;
      if (o(a.x1, a.y1, a.x2, a.y2, c.x1, c.y1) * o(a.x1, a.y1, a.x2, a.y2, c.x2, c.y2) < 0 && o(c.x1, c.y1, c.x2, c.y2, a.x1, a.y1) * o(c.x1, c.y1, c.x2, c.y2, a.x2, a.y2) < 0) crossings++;
    }
  }
  return { ratsnestMm: Math.round(len * 10) / 10, crossings, congestion: congestion({ ...board, pads: parts.flatMap((p) => p.pads) }, lines) };
}

function toPart(d: Design, it: Item, layers: CopperLayer[]): BoardPart {
  const pads: BoardPad[] = it.fp.pads.map((p) => {
    const [x, y] = rotate(p.x, p.y, it.rot);
    const net = padNet(it.comp, p);
    return {
      number: p.number,
      ...(p.also ? { also: p.also } : {}),
      x: r3(it.x + x),
      y: r3(it.y + y),
      w: swapped(it.rot) ? p.h : p.w,
      h: swapped(it.rot) ? p.w : p.h,
      shape: p.shape,
      ...(p.drill ? { drill: p.drill } : {}),
      ...(p.slot ? { slot: swapped(it.rot) ? { w: p.slot.h, h: p.slot.w } : p.slot } : {}),
      ...(net ? { netId: net } : {}),
      layers: p.drill ? [...layers] : [it.side === 'bottom' ? 'B.Cu' : 'F.Cu'],
    };
  });
  const rect = (w: number, h: number) => {
    const [rw, rh] = swapped(it.rot) ? [h, w] : [w, h];
    return { x: r3(it.x - rw / 2), y: r3(it.y - rh / 2), w: rw, h: rh };
  };
  // which way round it goes, and the pad its mark is for (the mark is placed once the whole board is)
  const polarity = polarityOf(it.card);
  const marked = polarity && polarity !== 'unknown' ? padOfPin(pads, polarity.pin) : undefined;
  const body = { ...rect(it.fp.body.w, it.fp.body.h), ...(it.fp.body.round ? { round: true } : {}) };
  // the footprint's own chamfered corners (an electrolytic's + side), turned with the part; else pin 1's corner
  const own = it.fp.body.chamfer && !it.fp.body.round ? { size: it.fp.body.chamfer.size, corners: it.fp.body.chamfer.corners.map((c) => cornerAt(...rotate(...CORNER[c], it.rot))) } : null;
  const chamfer = own ?? (marked && polarity !== 'unknown' && polarity?.kind === 'pin1' ? pin1Chamfer(body, marked) : null);
  return {
    componentId: it.comp.id,
    refdes: it.comp.refdes,
    value: valueOf(d, it.comp),
    part: it.card.id,
    category: it.card.category,
    ...((it.comp.params.mpn ?? it.card.mpn) ? { mpn: it.comp.params.mpn ?? it.card.mpn } : {}),
    ...(it.card.manufacturer ? { manufacturer: it.card.manufacturer } : {}),
    ...(it.comp.params.lcsc ? { lcsc: it.comp.params.lcsc } : {}),
    ...(it.comp.params.eurocircuits ? { eurocircuits: it.comp.params.eurocircuits } : {}),
    pkg: it.pkg,
    pkgInfo: it.info,
    x: r3(it.x),
    y: r3(it.y),
    rot: it.rot,
    side: it.side,
    pads,
    body: { ...body, ...(chamfer ? { chamfer } : {}) },
    courtyard: rect(it.cw, it.ch),
    polarized: polarity !== null,
    ...(marked && polarity && polarity !== 'unknown' ? { mark: { kind: polarity.kind, pad: marked.number, strokes: [], dots: [] } } : {}),
    ...(it.card.topImage ? { topImage: { src: it.card.topImage.src, rot: it.card.topImage.rot } } : {}),
    locked: it.fixed,
    ...(it.intent ? { intent: it.intent.rel ? { anchor: anchorRef(d, it.intent.rel) } : {} } : {}),
    ...(it.by && (it.fixed || it.intent) ? { by: it.by } : {}),
  };
}

const anchorRef = (d: Design, compId: string) => d.components[compId]?.refdes ?? compId;

/** Minimum spanning tree of each net's pads (Prim), as straight lines. */
export function ratsnest(parts: BoardPart[], connected?: (netId: string, a: BoardPad, b: BoardPad) => boolean): RatsLine[] {
  const byNet = new Map<string, BoardPad[]>();
  for (const part of parts) for (const p of part.pads) if (p.netId) byNet.set(p.netId, [...(byNet.get(p.netId) ?? []), p]);
  const out: RatsLine[] = [];
  for (const [netId, pads] of [...byNet.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (pads.length < 2) continue;
    const inTree = [0];
    const dist = pads.map((p) => Math.hypot(p.x - pads[0]!.x, p.y - pads[0]!.y));
    const from = pads.map(() => 0);
    const done = new Set([0]);
    while (inTree.length < pads.length) {
      let best = -1;
      for (let i = 0; i < pads.length; i++) if (!done.has(i) && (best < 0 || dist[i]! < dist[best]!)) best = i;
      done.add(best);
      inTree.push(best);
      const a = pads[from[best]!]!;
      const b = pads[best]!;
      if (!connected?.(netId, a, b)) out.push({ netId, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      for (let i = 0; i < pads.length; i++) {
        if (done.has(i)) continue;
        const dd = Math.hypot(pads[i]!.x - b.x, pads[i]!.y - b.y);
        if (dd < dist[i]!) {
          dist[i] = dd;
          from[i] = best;
        }
      }
    }
  }
  return out;
}

function placementChecks(parts: BoardPart[], w: number, h: number, edge: number, outline: { outline: { w: number; h: number }; cornerRadius: number; shape: number[] | null }, cutouts: BoardCutout[] = []): Diagnostic[] {
  const shaped = outline.cornerRadius > 0 || !!outline.shape;
  const out: Diagnostic[] = [];
  // a pad's corners (and centre): how far inside the outline / outside every cutout
  const padPoints = (p: BoardPad) => [[p.x - p.w / 2, p.y - p.h / 2], [p.x + p.w / 2, p.y - p.h / 2], [p.x - p.w / 2, p.y + p.h / 2], [p.x + p.w / 2, p.y + p.h / 2], [p.x, p.y]] as const;
  // through-hole parts (and holes) take their place on both sides
  const through = parts.map((p) => p.pads.some((q) => q.drill));
  for (let i = 0; i < parts.length; i++) {
    const a = parts[i]!;
    const A = a.courtyard;
    const hole = a.componentId.startsWith('hole:');
    // on the board: the body and the pads (the courtyard may reach past the edge: a connector flush with it)
    const Y = a.body;
    const corners = [[Y.x, Y.y], [Y.x + Y.w, Y.y], [Y.x, Y.y + Y.h], [Y.x + Y.w, Y.y + Y.h]] as const;
    const x0 = Math.min(Y.x, ...a.pads.map((p) => p.x - p.w / 2));
    const y0 = Math.min(Y.y, ...a.pads.map((p) => p.y - p.h / 2));
    const x1 = Math.max(Y.x + Y.w, ...a.pads.map((p) => p.x + p.w / 2));
    const y1 = Math.max(Y.y + Y.h, ...a.pads.map((p) => p.y + p.h / 2));
    if (x0 < -1e-6 || y0 < -1e-6 || x1 > w + 1e-6 || y1 > h + 1e-6 || (outline.shape && !hole && corners.some(([x, y]) => insideBoard(outline, x, y) < -1e-6))) {
      out.push({ code: 'DRC.OFF_BOARD', severity: 'error', message: `${a.refdes} is outside the board outline.`, at: { x: a.x, y: a.y }, entities: [a.refdes] });
    } else if (a.pads.some((p) => p.x - p.w / 2 < edge || p.y - p.h / 2 < edge || p.x + p.w / 2 > w - edge || p.y + p.h / 2 > h - edge || (shaped && padPoints(p).some(([x, y]) => insideBoard(outline, x, y) < edge)))) {
      out.push({ code: 'DRC.EDGE_CLEARANCE', severity: 'error', message: `${a.refdes} has copper closer than ${edge} mm to the board edge.`, at: { x: a.x, y: a.y }, entities: [a.refdes] });
    }
    for (const c of hole ? [] : cutouts) {
      // the courtyard over the cutout, or copper within the edge clearance of it
      const cy = { x0: A.x, y0: A.y, x1: A.x + A.w, y1: A.y + A.h };
      const over = cutoutDistance(c, Math.min(Math.max(c.x, cy.x0), cy.x1), Math.min(Math.max(c.y, cy.y0), cy.y1)) < 0 || cutoutPolygon(c).some((v, k, pts) => k % 2 === 0 && v > cy.x0 && v < cy.x1 && pts[k + 1]! > cy.y0 && pts[k + 1]! < cy.y1);
      if (over) out.push({ code: 'DRC.CUTOUT_OVERLAP', severity: 'error', message: `${a.refdes} lies over cutout ${c.id}.`, at: { x: a.x, y: a.y }, entities: [a.refdes] });
      else if (a.pads.some((p) => padPoints(p).some(([x, y]) => cutoutDistance(c, x, y) < edge))) out.push({ code: 'DRC.EDGE_CLEARANCE', severity: 'error', message: `${a.refdes} has copper closer than ${edge} mm to cutout ${c.id}.`, at: { x: a.x, y: a.y }, entities: [a.refdes] });
    }
    for (let j = i + 1; j < parts.length; j++) {
      const b = parts[j]!;
      const B = b.courtyard;
      if (a.side !== b.side && !through[i] && !through[j]) continue; // SMD parts on opposite sides share the area
      if (A.x < B.x + B.w - 1e-6 && B.x < A.x + A.w - 1e-6 && A.y < B.y + B.h - 1e-6 && B.y < A.y + A.h - 1e-6) {
        out.push({ code: 'DRC.COURTYARD_OVERLAP', severity: 'error', message: `${a.refdes} and ${b.refdes} overlap (courtyards).`, at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, entities: [a.refdes, b.refdes] });
      }
    }
  }
  return out;
}

/** Parts of one supply this close (mm, courtyard to courtyard) are one group in the plane plan. */
const PLAN_GROUP_MM = 6;

/**
 * What the agent decides the planes from (get_board plane_plan): per supply and ground net, its
 * pins, the ICs drawing from it, where its parts stand (groups of parts close together), and what
 * carries it now; and which layer each outer layer's tracks run over.
 */
export function planePlan(d: Design, b: BoardView) {
  const four = b.layers.length === 4;
  const supplies = Object.values(d.nets)
    .filter((n) => isPowerNet(n))
    .map((n) => {
      const parts = b.parts.filter((p) => p.pads.some((q) => q.netId === n.id));
      const pins = parts.reduce((sum, p) => sum + p.pads.filter((q) => q.netId === n.id).length, 0);
      return { n, parts, pins };
    })
    .filter((x) => x.pins >= 2)
    .sort((x, y) => y.pins - x.pins || natCmp(x.n.name, y.n.name));
  const box = (ps: BoardPart[]) => {
    const r = (v: number) => Math.round(v * 10) / 10;
    return [r(Math.min(...ps.map((p) => p.courtyard.x))), r(Math.min(...ps.map((p) => p.courtyard.y))), r(Math.max(...ps.map((p) => p.courtyard.x + p.courtyard.w))), r(Math.max(...ps.map((p) => p.courtyard.y + p.courtyard.h)))];
  };
  const apart = (p: BoardPart, q: BoardPart) =>
    Math.max(p.courtyard.x - (q.courtyard.x + q.courtyard.w), q.courtyard.x - (p.courtyard.x + p.courtyard.w), p.courtyard.y - (q.courtyard.y + q.courtyard.h), q.courtyard.y - (p.courtyard.y + p.courtyard.h), 0);
  return {
    stackup: four
      ? 'F.Cu tracks run over In1.Cu, B.Cu tracks over In2.Cu: their return current flows in that plane, right under them. An area plane (set_plane under or rect) splits its layer; a signal track over it that crosses the area\'s edge makes its return current detour round the gap (PLANE.SPLIT_CROSSING), so the router crosses splits on the other outer layer where it can. Put an area where its net\'s pins are, with few signals leaving it on the layer over it.'
      : 'F.Cu tracks run over the B.Cu pour: it is their return path. Every track on B.Cu cuts the pour, so keep those short and few under fast signals.',
    supplies: supplies.map(({ n, parts, pins }) => {
      const feeds = parts
        .map((p) => {
          const comp = d.components[p.componentId];
          const card = comp && cardOf(d, comp.part);
          const supplyPins = card && card.pins.length > 3 ? card.pins.filter((q) => q.type === 'pwr_in' && comp.pins[q.number] === n.id).length : 0;
          return { p, supplyPins };
        })
        .filter((x) => x.supplyPins > 0)
        .sort((x, y) => y.supplyPins - x.supplyPins || natCmp(x.p.refdes, y.p.refdes))
        .map((x) => `${x.p.refdes} (${x.supplyPins} pin${x.supplyPins > 1 ? 's' : ''})`);
      // groups: parts within PLAN_GROUP_MM of each other (single linkage)
      const group = parts.map((_, i) => i);
      const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i]!)));
      for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) if (apart(parts[i]!, parts[j]!) <= PLAN_GROUP_MM) group[find(i)] = find(j);
      const byRoot = new Map<number, BoardPart[]>();
      parts.forEach((p, i) => byRoot.set(find(i), [...(byRoot.get(find(i)) ?? []), p]));
      const groups = [...byRoot.values()].sort((x, y) => y.length - x.length);
      const on = b.planes
        .filter((pl) => pl.netId === n.id)
        .map((pl) => `${pl.layer} ${pl.area ? (pl.under ? `under ${pl.under.join(', ')}` : `area ${pl.area.join(', ')}`) : pl.layer === 'F.Cu' || pl.layer === 'B.Cu' ? 'pour' : 'whole layer'}${pl.auto ? ' (automatic)' : ''}`);
      return {
        net: n.name,
        ...(n.attrs.voltage !== undefined ? { voltage: n.attrs.voltage } : {}),
        ...(isGroundNet(n) ? { ground: true } : {}),
        pins,
        ...(feeds.length ? { feeds } : {}),
        carried_by: on.length ? on : ['tracks'],
        box_mm: box(parts),
        ...(groups.length > 1 ? { groups: groups.map((g) => ({ parts: g.map((p) => p.refdes).sort(natCmp), box_mm: box(g) })) } : {}),
      };
    }),
  };
}

/**
 * Where each plane lies on the board as placed: an area plane's rectangle (under parts: their
 * courtyards' box plus the margin, so it follows them), within the board. An area under parts
 * that are all gone, or one off the board, is left out.
 */
/**
 * The vias placed on purpose, where they go now: copper from the start (fixed), or spots the
 * router fills where a via fits, in order, at most `limits` of a group (a tie: its spots round the
 * one it is centred on, more than it wants, so a blocked one is made up for).
 */
export interface ViaPlan {
  fixed: Via[];
  fill: Via[];
  limits?: Record<string, number>;
  /**
   * Pads dropping onto their plane through vias the agent placed (add_vias drop): those vias are
   * in `fixed`, `stubs` join each to its pad.
   */
  drops?: { group: string; componentId: string; number: string; vias: { x: number; y: number }[] }[];
  /** A drop via's stub: a short track from inside its pad to the via, power width (narrower where the via or the pad is). */
  stubs?: Track[];
  /** Fences along a line (a net's tracks), laid by the router along both sides of them once they are routed. */
  along?: { group: string; netId: string; line: string; pitch: number; drill: number; pad: number }[];
  groups: BoardView['viaGroups'];
}

/** Ties: never fewer vias than this (one may be bad), nor more than this many. */
const TIE_MIN = 2;

const TIE_MAX = 16;

/**
 * Where each via group's vias go on this placement (a pad group follows its part). `amps`: a
 * net's max_current, for ties without their own (and to judge a grid's).
 */
export function planVias(groups: ViaGroup[], parts: BoardPart[], w: number, h: number, rules: BoardRules, amps: (netId: string) => number | undefined = () => undefined): ViaPlan {
  const out: ViaPlan = { fixed: [], fill: [], groups: [] };
  for (const g of groups) {
    const via = (x: number, y: number, extra: Partial<Via> = {}): Via => ({ netId: g.netId, x: r3(x), y: r3(y), drill: g.drill ?? rules.viaDrill, pad: g.size ?? Math.max(rules.viaPad, (g.drill ?? rules.viaDrill) + 0.2), group: g.id, ...extra });
    const size = g.size ?? Math.max(rules.viaPad, (g.drill ?? rules.viaDrill) + 0.2);
    const pitch = g.pitch ?? VIA_PITCH[g.kind];
    // centres spread evenly across a span, as many as fit `pitch` apart
    const spread = (a: number, b: number) => {
      const n = Math.max(1, Math.floor((b - a) / pitch + 1e-6) + 1);
      const s0 = a + (b - a - (n - 1) * pitch) / 2;
      return Array.from({ length: n }, (_, i) => s0 + i * pitch);
    };
    const entry = (wanted: number, note?: string) => out.groups.push({ id: g.id, netId: g.netId, kind: g.kind, wanted, ...(note ? { note } : {}) });
    if (g.kind === 'pad') {
      const part = parts.find((p) => p.componentId === g.pad?.componentId);
      const pad = part?.pads.filter((p) => p.number === g.pad?.number).sort((a, b) => b.w * b.h - a.w * a.h)[0];
      if (!part || !pad) {
        entry(0, part ? `${part.refdes} has no pad ${g.pad?.number} any more` : 'its part is not on the board');
        continue;
      }
      if (pad.netId !== g.netId) {
        entry(0, `${part.refdes}.${pad.number} is on another net now: add the vias again`);
        continue;
      }
      const xs = spread(pad.x - pad.w / 2 + size / 2, pad.x + pad.w / 2 - size / 2);
      const ys = spread(pad.y - pad.h / 2 + size / 2, pad.y + pad.h / 2 - size / 2);
      for (const y of ys) for (const x of xs) out.fixed.push(via(x, y, { inPad: true }));
      entry(xs.length * ys.length);
    } else if (g.kind === 'points') {
      for (const [x, y] of g.points ?? []) out.fixed.push(via(x, y));
      entry(g.points?.length ?? 0);
    } else if (g.kind === 'drop') {
      const part = parts.find((p) => p.componentId === g.pad?.componentId);
      const pad = part?.pads.find((p) => p.number === g.pad?.number);
      if (!part || !pad) {
        entry(0, part ? `${part.refdes} has no pad ${g.pad?.number} any more` : 'its part is not on the board');
        continue;
      }
      const name = `${part.refdes}.${pad.number}`;
      if (!g.offsets?.length) {
        out.groups.push({ id: g.id, netId: g.netId, kind: 'drop', wanted: g.count ?? 0, pad: name, note: `the vias' spots are not given: place them with add_vias drop at (each right beside ${name})` });
        continue;
      }
      if (pad.netId !== g.netId) {
        out.groups.push({ id: g.id, netId: g.netId, kind: 'drop', wanted: 0, pad: name, note: `${name} is on another net now: add the vias again` });
        continue;
      }
      const spots = g.offsets.map((o) => dropSpot(part, pad, o));
      for (const [x, y] of spots) out.fixed.push(via(x, y));
      (out.drops ??= []).push({ group: g.id, componentId: part.componentId, number: pad.number, vias: spots.map(([x, y]) => ({ x, y })) });
      // each via's stub: from inside the pad (its round end within it) straight to the via
      const sw = r3(Math.min(rules.powerTrack, size, pad.w, pad.h));
      const layer = pad.layers[0]!;
      for (const [x, y] of spots) {
        let [ax, ay] = [x, y];
        if (pad.shape === 'round') {
          // towards the nearest point of the pad's centre line (its centre, or along an oval)
          const c = padCapsule(pad);
          const [cx, cy] = [Math.max(c.ax, Math.min(c.bx, x)), Math.max(c.ay, Math.min(c.by, y))];
          const d = Math.hypot(x - cx, y - cy);
          const r = Math.max(0, c.r - sw / 2);
          if (d > r) [ax, ay] = [cx + ((x - cx) * r) / d, cy + ((y - cy) * r) / d];
        } else {
          const [hx, hy] = [Math.max(0, pad.w / 2 - sw / 2), Math.max(0, pad.h / 2 - sw / 2)];
          [ax, ay] = [Math.max(pad.x - hx, Math.min(pad.x + hx, x)), Math.max(pad.y - hy, Math.min(pad.y + hy, y))];
        }
        (out.stubs ??= []).push({ netId: g.netId, layer, width: sw, pts: [r3(ax), r3(ay), x, y] });
      }
      const current = g.amps ?? amps(g.netId);
      const need = current ? viasForCurrent(current, g.drill ?? rules.viaDrill) : 0;
      const note = need > spots.length ? `${spots.length} for ${r3(current!)} A, which wants ${need}: place more beside the pad` : current ? `enough for ${r3(current)} A` : undefined;
      out.groups.push({ id: g.id, netId: g.netId, kind: 'drop', wanted: spots.length, pad: name, ...(note ? { note } : {}) });
    } else if (g.kind === 'tie') {
      // as many as the current wants, in a tight block round the spot (as square as can be), then
      // the spots round it in case some are blocked
      const [cx, cy] = g.points?.[0] ?? [w / 2, h / 2];
      const current = g.amps ?? amps(g.netId);
      const per = viaCurrentFor(g.drill ?? rules.viaDrill);
      const n = Math.max(TIE_MIN, Math.min(TIE_MAX, current ? Math.ceil(current / per - 1e-6) : TIE_MIN));
      const q = g.pitch || Math.ceil((size + rules.clearance) / 0.1 - 1e-6) * 0.1;
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      const spots: [number, number, number][] = [];
      for (let j = -1; j <= rows; j++) {
        for (let i = -1; i <= cols; i++) {
          const x = cx + (i - (cols - 1) / 2) * q;
          const y = cy + (j - (rows - 1) / 2) * q;
          const ring = i < 0 || j < 0 || i >= cols || j >= rows ? 1 : 0;
          spots.push([x, y, ring * 1e3 + Math.hypot(x - cx, y - cy)]);
        }
      }
      spots.sort((a, b) => a[2] - b[2]);
      for (const [x, y] of spots) out.fill.push(via(Math.round(x * 10) / 10, Math.round(y * 10) / 10));
      (out.limits ??= {})[g.id] = n;
      const why = current ? `${n} for ${r3(current)} A (about ${Math.round(per * 10) / 10} A per ${g.drill ?? rules.viaDrill} mm via)` : `${n}: no current known (give amps, or the net's max_current)`;
      entry(n, why);
    } else if (g.kind === 'fence' && g.along) {
      (out.along ??= []).push({ group: g.id, netId: g.netId, line: g.along, pitch, drill: g.drill ?? rules.viaDrill, pad: size });
      out.groups.push({ id: g.id, netId: g.netId, kind: 'fence', wanted: 0, along: g.along });
    } else {
      const box = areaBox(g.area ?? {}, parts, w, h);
      if (!box) {
        entry(0, 'its parts are not on the board');
        continue;
      }
      const [x0, y0, x1, y1] = box;
      const spots: [number, number][] = [];
      // a grid stays inside the area (a via on its edge would stick out of a pour there); a fence
      // runs along the edge, in the copper round the area
      const inset = size / 2 + rules.clearance;
      if (g.kind === 'grid') for (const y of spread(y0 + inset, y1 - inset)) for (const x of spread(x0 + inset, x1 - inset)) spots.push([x, y]);
      else {
        // round the edge, corners once, no gap wider than the pitch
        const side = (ax: number, ay: number, bx: number, by: number) => {
          const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / pitch - 1e-6));
          for (let i = 0; i < n; i++) spots.push([ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n]);
        };
        side(x0, y0, x1, y0);
        side(x1, y0, x1, y1);
        side(x1, y1, x0, y1);
        side(x0, y1, x0, y0);
      }
      for (const [x, y] of spots) out.fill.push(via(x, y));
      // stitching a supply's copper: say what its vias carry against what the net draws
      const current = g.kind === 'grid' ? amps(g.netId) : undefined;
      const per = viaCurrentFor(g.drill ?? rules.viaDrill);
      const need = current ? Math.max(TIE_MIN, Math.ceil(current / per - 1e-6)) : 0;
      entry(spots.length, current && spots.length > 2 * need ? `${spots.length} spots carry about ${Math.round(spots.length * per)} A; the net draws ${current} A, which ${need} vias carry: a tie (add_vias kind tie) where the current crosses to the plane does the same with less copper drilled` : undefined);
    }
  }
  return out;
}

/** An area (under parts, with its margin, or a rectangle) on this placement, clamped to the board; null: nothing left of it. */
function areaBox(area: PlaneArea, parts: BoardPart[], w: number, h: number): [number, number, number, number] | null {
  let box: [number, number, number, number];
  if (area.rect) box = area.rect;
  else {
    const ps = parts.filter((p) => area.under?.includes(p.componentId));
    if (!ps.length) return null;
    const m = area.margin ?? PLANE_AREA_MARGIN;
    box = [Math.min(...ps.map((p) => p.courtyard.x)) - m, Math.min(...ps.map((p) => p.courtyard.y)) - m, Math.max(...ps.map((p) => p.courtyard.x + p.courtyard.w)) + m, Math.max(...ps.map((p) => p.courtyard.y + p.courtyard.h)) + m];
  }
  const r = [Math.max(0, box[0]), Math.max(0, box[1]), Math.min(w, box[2]), Math.min(h, box[3])].map(r3) as [number, number, number, number];
  return r[2] - r[0] < 1 || r[3] - r[1] < 1 ? null : r;
}

function placePlanes(planes: ReturnType<typeof settingsPlanes>, parts: BoardPart[], w: number, h: number): BoardView['planes'] {
  const out: BoardView['planes'] = [];
  for (const pl of planes) {
    const { area, ...plane } = pl;
    if (!area) {
      out.push(plane);
      continue;
    }
    const r = areaBox(area, parts, w, h);
    if (!r) continue;
    const under = area.rect ? undefined : parts.filter((p) => area.under?.includes(p.componentId)).map((p) => p.refdes);
    out.push({ ...plane, area: r, ...(under ? { under } : {}) });
  }
  return out;
}
