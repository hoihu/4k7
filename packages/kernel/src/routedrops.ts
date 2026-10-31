/**
 * One pass of the router, the way down to a plane (router.ts): the sites reserved for a pour's pads
 * before the signals, and the drops (a short track and a via) of what does not reach its plane.
 */
import { G, inArea, MAX_STUB, now, type PassGrid, simplify } from './routegrid.ts';
import { type PassPours } from './routepours.ts';
import { type PassSearch } from './routesearch.ts';
import { type PassTracks } from './routetracks.ts';

export function passDrops(grid: PassGrid, finder: PassSearch, lay: PassTracks, pouring: PassPours) {
  const { input, pads, deadline, rules, W, N, layerIdx, numOf, padNet, widths, trackClass, stampSeg, viaAt, VIA_SPACING, stampVia, padCells, escapes, find, groupCells } = grid;
  const { clock, freeFor, viaFreeFor, search } = finder;
  const { commit, reserved, held, padAt } = lay;
  const { planes, margin, region } = pouring;
  // 1. provisional areas; 2. drops of every group that does not reach its plane
  const dropVias = new Map<number, { x: number; y: number }[]>(); // pad root (when it dropped) → drop vias
  /** The groups of a plane's net that reach its main area (they are connected through it). */
  const reachMain = (pl: (typeof planes)[number], rg: ReturnType<typeof region>) => {
    const roots = [...new Set(pads.map((_, idx) => find(idx)).filter((r) => padNet[r] === rg.pnet))];
    const inMain = (x: number, y: number) => rg.island[Math.round(x / G) + Math.round(y / G) * W] === rg.main;
    // (drop vias are listed under the root their group had when it dropped)
    const dropped = new Set([...dropVias].filter(([, vs]) => vs.some((v) => inMain(v.x, v.y))).map(([r]) => find(r)));
    return roots.filter(
      (r) =>
        groupCells.get(r)!.some((st) => Math.floor(st / N) === rg.l && rg.island[st % N] === rg.main) ||
        dropped.has(r) ||
        pads.some((p, idx) => find(idx) === r && (p.drill || p.layers.includes(pl.layer)) && inMain(p.x, p.y)),
    );
  };
  /**
   * A drop's width: the net's own where all the pads it starts from can take it; else, on a power
   * net, the power width where they can take that; else the signal width.
   */
  const dropClass = (netId: string, from: number[]) => {
    const takes = (w: number) => from.every((idx) => Math.min(pads[idx]!.w, pads[idx]!.h) >= w * 0.9);
    const own = input.netWidths?.[netId];
    if (own) return own <= rules.track || takes(own) ? trackClass(own) : 0;
    return input.powerNets.has(netId) && takes(rules.powerTrack) ? 1 : 0;
  };
  const groupPads = (root: number) => pads.flatMap((_, idx) => (find(idx) === root ? [idx] : []));
  /*
   * Drop sites for outer pours, reserved before the signals: every SMD pad of the pour's net off
   * the pour layer gets the nearest via site with a short stub (on its own layer, within
   * MAX_STUB), and that copper is kept clear of other nets (as the escape stubs are). It is laid
   * only after the signals, where the pad still needs it: routed among the signals, the pour
   * net's many tracks would wall them off; routed after them, its pads could be shut off from
   * every via site. (A reservation that is not laid stays marked in the clearance maps: harmless,
   * as only the pour's own net routes after the drops.)
   */
  const reserveDrops = (list: typeof planes) => {
    for (const pl of list) {
      const l = layerIdx.get(pl.layer)!;
      const pnet = numOf(pl.netId);
      const viaFree = viaFreeFor(pnet);
      const rr = rules.viaPad / 2 + margin + rules.clearance;
      pads.forEach((p, idx) => {
        if (padNet[idx] !== pnet || p.drill || p.layers.includes(pl.layer) || now() > clock.until) return;
        // its copper already reaches the pour's layer (a kept drop, thermal vias)
        if (groupCells.get(find(idx))!.some((st) => Math.floor(st / N) === l)) return;
        const siteAt = (k: number) => {
          const free = freeFor(pnet, k);
          const path = search(pnet, k, padCells[idx]!, (st) => {
            if (Math.floor(st / N) === l) return false;
            const i = st % N;
            if (viaAt[i] === pnet) return true; // another pad's site
            if (!viaFree(i)) return false;
            // room for the pour round the via
            const vx = (i % W) * G;
            const vy = Math.floor(i / W) * G;
            for (const [dx, dy] of [[rr, 0], [-rr, 0], [0, rr], [0, -rr]] as const) {
              const ii = Math.round((vx + dx) / G) + Math.round((vy + dy) / G) * W;
              if (ii < 0 || ii >= N || !free(l, ii)) return false;
            }
            return true;
          }, p, undefined, 0, false, 2 * MAX_STUB);
          // (a long way to a via site, or one over other layers, would block more than it saves)
          return path && path.length <= MAX_STUB && path.every((st) => Math.floor(st / N) === Math.floor(path[0]! / N)) ? path : null;
        };
        // (a power-width stub that finds no site is tried again at the signal width)
        let k = dropClass(pl.netId, [idx]);
        let path = siteAt(k);
        if (!path && k) path = siteAt((k = 0));
        if (!path) return;
        const l0 = Math.floor(path[0]! / N);
        const e = escapes[idx];
        const pts = simplify([...(e && e.state === path[0] ? [p.x, p.y, e.p1.x, e.p1.y] : [p.x, p.y]), ...path.flatMap((st) => [((st % N) % W) * G, Math.floor((st % N) / W) * G])]);
        for (let q = 0; q + 3 < pts.length; q += 2) {
          const [ax, ay, bx, by] = [pts[q]!, pts[q + 1]!, pts[q + 2]!, pts[q + 3]!];
          stampSeg(l0, pnet, ax, ay, bx, by, widths[k]!);
          held.push({ net: pnet, l: l0, ax, ay, bx, by, w: widths[k]! });
        }
        const [vx, vy] = [pts.at(-2)!, pts.at(-1)!];
        if (viaAt[Math.round(vy / G) * W + Math.round(vx / G)] !== pnet) {
          stampVia(pnet, vx, vy);
          held.push({ net: pnet, l: -1, ax: vx, ay: vy, bx: vx, by: vy, w: rules.viaPad });
        }
        reserved.set(idx, { path, k });
      });
    }
  };
  const dropOnto = (list: typeof planes) => {
  for (const pl of list) {
    const rg = region(pl);
    if (rg.main === undefined || rg.sizes[rg.main]! * G * G < 1) continue;
    const rr = rules.viaPad / 2 + margin + rules.clearance;
    /** A new via site well inside the main area (the via then joins the plane). */
    const siteOk = (i: number) => {
      if (rg.island[i] !== rg.main || !viaFreeFor(rg.pnet)(i)) return false;
      const vx = (i % W) * G;
      const vy = Math.floor(i / W) * G;
      for (const [dx, dy] of [[rr, 0], [-rr, 0], [0, rr], [0, -rr]] as const) {
        const ii = Math.round((vx + dx) / G) + Math.round((vy + dy) / G) * W;
        if (rg.island[ii] !== rg.main) return false;
      }
      return true;
    };
    // (an area plane: only the groups with a pad inside the area; the others are joined by tracks)
    const roots = [...new Set(pads.map((_, idx) => find(idx)).filter((r) => padNet[r] === rg.pnet))].filter((r) => !pl.area || pads.some((p, idx) => find(idx) === r && inArea(pl, p)));
    // copper of the drops so far → the via it leads down to: a later drop may simply join it
    const dropCopper = new Map<number, { x: number; y: number }>();
    for (const r of roots) {
      const reaches = groupCells.get(r)!.some((st) => Math.floor(st / N) === rg.l && rg.island[st % N] === rg.main);
      if (reaches) continue;
      // a site reserved before the signals that lies in the main area: laid as it is (no search,
      // so even once the time is up)
      const site = pads.findIndex((_, idx) => find(idx) === r && reserved.has(idx) && rg.island[reserved.get(idx)!.path.at(-1)! % N] === rg.main);
      if (site >= 0) {
        const { path, k: ks } = reserved.get(site)!;
        const joins = dropCopper.get(path.at(-1)!);
        const copper = commit(pl.netId, rg.pnet, ks, path, site, -1, !joins);
        groupCells.get(r)!.push(...copper);
        const end = path.at(-1)! % N;
        const via = joins ?? { x: (end % W) * G, y: Math.floor(end / W) * G };
        for (const st of copper) dropCopper.set(st, via);
        dropVias.set(r, [...(dropVias.get(r) ?? []), via]);
        continue;
      }
      if (now() > deadline) continue;
      const starts = groupCells.get(r)!.filter((st) => Math.floor(st / N) !== rg.l);
      if (!starts.length) continue;
      const wayAt = (k: number) =>
        search(rg.pnet, k, starts, (st) => {
          if (Math.floor(st / N) === rg.l) return false;
          if (dropCopper.has(st)) return true; // join an earlier drop
          const i = st % N;
          if (viaAt[i] === rg.pnet && rg.island[i] === rg.main) return true; // join an existing via
          return siteOk(i);
        }, pads[r]!);
      // (a power-width drop that finds no way is tried again at the signal width)
      let k = dropClass(pl.netId, groupPads(r));
      let path = wayAt(k);
      if (!path && k && now() <= deadline) path = wayAt((k = 0));
      if (!path) continue;
      const joins = dropCopper.get(path.at(-1)!);
      // a way that changed layer itself already has a via: not another one right next to it
      const end = path.at(-1)! % N;
      const crowded = (q: number) => {
        if (q === 0 || Math.floor(path[q]! / N) === Math.floor(path[q - 1]! / N)) return false;
        const d = Math.hypot(((path[q]! % N) % W) - (end % W), Math.floor((path[q]! % N) / W) - Math.floor(end / W)) * G;
        return d > 1e-9 && d < VIA_SPACING;
      };
      if (!joins && path.some((_, q) => crowded(q) && q < path.length - 1)) continue;
      const from = padAt(r, path[0]!);
      const copper = commit(pl.netId, rg.pnet, k, path, from, -1, !joins);
      groupCells.get(r)!.push(...copper);
      const via = joins ?? { x: (end % W) * G, y: Math.floor(end / W) * G };
      for (const st of copper) dropCopper.set(st, via);
      dropVias.set(r, [...(dropVias.get(r) ?? []), via]);
    }
  }
  };

  return { reachMain, reserveDrops, dropOnto };
}

export type PassDrops = ReturnType<typeof passDrops>;
