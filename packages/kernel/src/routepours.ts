/**
 * One pass of the router, its planes and pours (router.ts): the areas they may fill on the grid, in
 * islands, and their exact geometry.
 */
import { boardPolygon, cutoutBounds, cutoutDistance, keepoutDistance, padCapsule, type Zone, type ZoneShape } from '@4k7/schema';
import { r3, segDist } from './geom.ts';
import { G, islandsOf, type PassGrid, type Plane } from './routegrid.ts';
import { type PassSearch } from './routesearch.ts';
import { type PassTracks } from './routetracks.ts';

export function passPours(grid: PassGrid, finder: PassSearch, lay: PassTracks) {
  const { input, pads, rules, W, H, N, layerIdx, netNum, numOf, padNet, padDist, cornerR, shaped, inside, groupCells, tracks, vias, solidPads } = grid;
  /*
   * Planes and pours. Inner planes are dedicated to their net (no tracks there); pours on outer
   * layers fill what the tracks leave. Every group of a plane net that does not reach its plane
   * drops onto it (short track + via). Order: inner-plane drops → pour drop sites reserved →
   * signal routing → outer-pour drops → the pour net's remaining tracks → final areas (clear of
   * every via of other nets) → connectivity.
   */
  const zones: Zone[] = [];
  const planes = (input.planes ?? []).filter((pl) => layerIdx.has(pl.layer) && netNum.has(pl.netId));
  const margin = G * 0.75; // a cell stands for a G × G square: keep its corners clear
  /** A plane's distances as set_plane_style shaped it (never below the board's own). */
  const planeLook = (pl: Plane) => {
    const st = pl.style ?? {};
    const clear = Math.max(rules.clearance, st.clearance ?? 0);
    return {
      clear,
      edge: Math.max(rules.edgeClearance, st.edge ?? 0),
      thermal: st.thermal !== false,
      ring: Math.max(clear, 0.25),
      spoke: st.spoke ?? Math.min(0.4, Math.max(0.3, rules.track)),
    };
  };
  /** The gap round an area plane, to the plane it lies in. */
  const areaGap = (q: Plane) => Math.max(rules.clearance, q.style?.gap ?? 0);
  /**
   * Whether `pl` goes round the area plane `q` on its layer: a full plane goes round every area;
   * of two areas the smaller lies on top (a +5V patch inside a local GND pour), the later one
   * when they are as big.
   */
  const areaSize = (a: [number, number, number, number]) => (a[2] - a[0]) * (a[3] - a[1]);
  const goesRound = (pl: Plane, q: Plane) => {
    if (q === pl || q.layer !== pl.layer || !q.area) return false;
    if (!pl.area) return true;
    const d = areaSize(q.area) - areaSize(pl.area);
    return Math.abs(d) > 1e-6 ? d < 0 : planes.indexOf(q) > planes.indexOf(pl);
  };
  const region = (pl: Plane) => {
    const l = layerIdx.get(pl.layer)!;
    const pnet = numOf(pl.netId);
    const ok = new Uint8Array(N);
    const look = planeLook(pl);
    const keep = look.edge + margin;
    // (cells inside the box round the outline by rows: this is millions of cells, for every pour)
    let [i0, i1] = [W, -1];
    for (let i = 0; i < W; i++) {
      if (i * G < keep || i * G > input.outline.w - keep) continue;
      i0 = Math.min(i0, i);
      i1 = i;
    }
    for (let j = 0; j < H && i0 <= i1; j++) {
      const y = j * G;
      if (y < keep || y > input.outline.h - keep) continue;
      if (!shaped) ok.fill(1, j * W + i0, j * W + i1 + 1);
      else for (let i = i0; i <= i1; i++) if (inside(i * G, y) >= keep) ok[j * W + i] = 1;
    }
    for (const c of input.cutouts ?? []) {
      const [x0, y0, x1, y1] = cutoutBounds(c);
      for (let j = Math.max(0, Math.floor((y0 - keep) / G)); j <= Math.min(H - 1, Math.ceil((y1 + keep) / G)); j++) {
        for (let i = Math.max(0, Math.floor((x0 - keep) / G)); i <= Math.min(W - 1, Math.ceil((x1 + keep) / G)); i++) if (cutoutDistance(c, i * G, j * G) < keep) ok[j * W + i] = 0;
      }
    }
    // keep-outs that hold pours off on this layer: no copper fill in them
    for (const ko of input.keepouts ?? []) {
      if (!ko.forbid.includes('pours') || !ko.layers.includes(pl.layer)) continue;
      const [x0, y0, x1, y1] = ko.bounds;
      for (let j = Math.max(0, Math.floor((y0 - margin) / G)); j <= Math.min(H - 1, Math.ceil((y1 + margin) / G)); j++) {
        for (let i = Math.max(0, Math.floor((x0 - margin) / G)); i <= Math.min(W - 1, Math.ceil((x1 + margin) / G)); i++) if (keepoutDistance(ko, i * G, j * G) < margin) ok[j * W + i] = 0;
      }
    }
    // split planes: an area plane only inside its rectangle; the layer's other planes round each
    // area on it, with the clearance
    for (const q of planes) {
      if (q !== pl && !goesRound(pl, q)) continue;
      if (q.layer !== pl.layer || !q.area) continue;
      const [a0, b0, a1, b1] = q.area;
      const grow = q === pl ? -margin : areaGap(q) + margin;
      let [ai0, ai1] = [W, -1];
      for (let i = 0; i < W; i++) {
        if (i * G < a0 - grow || i * G > a1 + grow) continue;
        ai0 = Math.min(ai0, i);
        ai1 = i;
      }
      for (let j = 0; j < H; j++) {
        const inRow = ai0 <= ai1 && j * G >= b0 - grow && j * G <= b1 + grow;
        const row = j * W;
        if (q === pl) {
          // only inside its rectangle
          if (!inRow) ok.fill(0, row, row + W);
          else {
            ok.fill(0, row, row + ai0);
            ok.fill(0, row + ai1 + 1, row + W);
          }
        } else if (inRow) ok.fill(0, row + ai0, row + ai1 + 1);
      }
    }
    const clearAround = (x0: number, y0: number, x1: number, y1: number, extra: number, dist: (x: number, y: number) => number) => {
      const reach = look.clear + extra + margin;
      for (let j = Math.max(0, Math.floor((y0 - reach) / G)); j <= Math.min(H - 1, Math.ceil((y1 + reach) / G)); j++) {
        for (let i = Math.max(0, Math.floor((x0 - reach) / G)); i <= Math.min(W - 1, Math.ceil((x1 + reach) / G)); i++) if (dist(i * G, j * G) < reach) ok[j * W + i] = 0;
      }
    };
    // (a line at a set impedance keeps its own gap, on the layers it runs on)
    const more = (netId: string | undefined) => (netId && input.pourGaps?.[netId] !== undefined && tracks.some((t) => t.netId === netId && t.layer === pl.layer) ? Math.max(0, input.pourGaps[netId] - look.clear) : 0);
    pads.forEach((p, idx) => {
      if (padNet[idx] === pnet) return;
      if (!p.drill && !p.layers.includes(pl.layer)) return;
      clearAround(p.x - p.w / 2, p.y - p.h / 2, p.x + p.w / 2, p.y + p.h / 2, more(p.netId), padDist(p));
    });
    for (const t of tracks) {
      if (t.netId === pl.netId || t.layer !== pl.layer) continue;
      for (let q = 0; q + 3 < t.pts.length; q += 2) {
        const [ax, ay, bx, by] = [t.pts[q]!, t.pts[q + 1]!, t.pts[q + 2]!, t.pts[q + 3]!];
        clearAround(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by), t.width / 2 + more(t.netId), segDist(ax, ay, bx, by));
      }
    }
    for (const v of vias) if (v.netId !== pl.netId) clearAround(v.x, v.y, v.x, v.y, v.pad / 2 + more(v.netId), (x, y) => Math.hypot(x - v.x, y - v.y));
    /*
     * Thermal reliefs where the plane meets its own vias and pins: a clearance ring with four
     * spokes (easier to solder and to rework than a solid connection).
     */
    const okOthers = ok.slice(); // before the reliefs: where other nets allow copper
    const gap = look.ring;
    const spoke = look.spoke;
    const relief = (cx: number, cy: number, halfW: number, halfH: number, dist: (x: number, y: number) => number) => {
      const outer = gap + margin;
      for (let j = Math.max(0, Math.floor((cy - halfH - outer) / G)); j <= Math.min(H - 1, Math.ceil((cy + halfH + outer) / G)); j++) {
        for (let i = Math.max(0, Math.floor((cx - halfW - outer) / G)); i <= Math.min(W - 1, Math.ceil((cx + halfW + outer) / G)); i++) {
          const x = i * G;
          const y = j * G;
          const d = dist(x, y);
          if (d <= 0 || d >= outer) continue; // the pad itself stays; beyond the ring is plane
          if (Math.abs(x - cx) <= spoke / 2 || Math.abs(y - cy) <= spoke / 2) continue; // spokes
          ok[j * W + i] = 0;
        }
      }
    };
    // (joined solid: no reliefs)
    if (look.thermal) {
      for (const v of vias) if (v.netId === pl.netId && !v.group) relief(v.x, v.y, v.pad / 2, v.pad / 2, (x, y) => Math.hypot(x - v.x, y - v.y) - v.pad / 2);
      pads.forEach((p, idx) => {
        if (padNet[idx] !== pnet || solidPads.has(idx) || !(p.drill || p.layers.includes(pl.layer))) return;
        relief(p.x, p.y, p.w / 2, p.h / 2, padDist(p));
      });
    }
    // islands (4-connected)
    const { island, sizes } = islandsOf(ok, W, H);
    // islands touched by the net's copper on this layer (pads, tracks) and by its vias
    const touched = new Set<number>();
    for (const [r, cells] of groupCells) {
      if (padNet[r] !== pnet) continue;
      for (const st of cells) if (Math.floor(st / N) === l && island[st % N]! >= 0) touched.add(island[st % N]!);
    }
    pads.forEach((p, idx) => {
      if (padNet[idx] !== pnet || !(p.drill || p.layers.includes(pl.layer))) return;
      const c = Math.round(p.x / G) + Math.round(p.y / G) * W;
      if (island[c]! >= 0) touched.add(island[c]!);
    });
    for (const v of vias) {
      if (v.netId !== pl.netId) continue;
      const c = Math.round(v.x / G) + Math.round(v.y / G) * W;
      if (island[c]! >= 0) touched.add(island[c]!);
    }
    const candidates = [...(touched.size ? touched : sizes.keys())];
    const main = candidates.sort((x, y) => sizes[y]! - sizes[x]! || x - y)[0];
    return { l, pnet, island, sizes, main, touched, okOthers };
  };

  /** Exact plane geometry: outline minus clearances, relief rings and dead islands, plus spokes. */
  const planeShape = (pl: Plane, rg: ReturnType<typeof region>, alive: Set<number>): ZoneShape => {
    const look = planeLook(pl);
    const c = look.clear;
    const e = look.edge;
    const cuts: ZoneShape['cuts'] = [];
    // split planes: the layer's other planes go round each area on it, with its gap
    for (const q of planes) {
      if (!goesRound(pl, q) || !q.area) continue;
      const g = areaGap(q);
      cuts.push({ k: 'rect', x: r3(q.area[0] - g), y: r3(q.area[1] - g), w: r3(q.area[2] - q.area[0] + 2 * g), h: r3(q.area[3] - q.area[1] + 2 * g) });
    }
    const adds: ZoneShape['adds'] = [];
    // (a line at a set impedance keeps its own gap, on the layers it runs on)
    const gapOf = (netId: string | undefined) => (netId && input.pourGaps?.[netId] !== undefined && tracks.some((t) => t.netId === netId && t.layer === pl.layer) ? Math.max(c, input.pourGaps[netId]) : c);
    pads.forEach((p, idx) => {
      if (padNet[idx] === rg.pnet || !(p.drill || p.layers.includes(pl.layer))) return;
      const g = gapOf(p.netId);
      if (p.shape === 'round') cuts.push({ k: 'circle', x: p.x, y: p.y, d: r3(Math.min(p.w, p.h) + 2 * g) });
      else cuts.push({ k: 'rect', x: r3(p.x - p.w / 2 - g), y: r3(p.y - p.h / 2 - g), w: r3(p.w + 2 * g), h: r3(p.h + 2 * g) });
    });
    for (const t of tracks) if (t.netId !== pl.netId && t.layer === pl.layer) cuts.push({ k: 'stroke', pts: t.pts, w: r3(t.width + 2 * gapOf(t.netId)) });
    for (const v of vias) if (v.netId !== pl.netId) cuts.push({ k: 'circle', x: v.x, y: v.y, d: r3(v.pad + 2 * gapOf(v.netId)) });
    // thermal reliefs: a ring cut, spokes back where no other net is in the way
    const gap = look.ring;
    const spokeW = look.spoke;
    const spokesOf = (x: number, y: number, hx: number, hy: number) => {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const x1 = x + dx * (hx + gap + G);
        const y1 = y + dy * (hy + gap + G);
        let clear = true;
        for (let t = 0; t <= 1.0001 && clear; t += 0.1) {
          const i = Math.round((x + (x1 - x) * t) / G);
          const j = Math.round((y + (y1 - y) * t) / G);
          if (Math.hypot((x1 - x) * t, (y1 - y) * t) <= Math.min(hx, hy)) continue; // on the pad itself
          if (i < 0 || j < 0 || i >= W || j >= H || !rg.okOthers[j * W + i]) clear = false;
        }
        if (clear) adds.push({ pts: [r3(x), r3(y), r3(x1), r3(y1)], w: spokeW });
      }
    };
    for (const v of vias) {
      if (v.netId !== pl.netId || !look.thermal || v.group) continue;
      cuts.push({ k: 'circle', x: v.x, y: v.y, d: r3(v.pad + 2 * gap) });
      spokesOf(v.x, v.y, v.pad / 2, v.pad / 2);
    }
    pads.forEach((p, idx) => {
      if (padNet[idx] !== rg.pnet || !(p.drill || p.layers.includes(pl.layer)) || !look.thermal || solidPads.has(idx)) return;
      if (p.shape === 'round' && p.w === p.h) cuts.push({ k: 'circle', x: p.x, y: p.y, d: r3(p.w + 2 * gap) });
      else if (p.shape === 'round') {
        const c = padCapsule(p); // an oval pad
        cuts.push({ k: 'stroke', pts: [r3(c.ax), r3(c.ay), r3(c.bx), r3(c.by)], w: r3(2 * c.r + 2 * gap) });
      } else cuts.push({ k: 'rect', x: r3(p.x - p.w / 2 - gap), y: r3(p.y - p.h / 2 - gap), w: r3(p.w + 2 * gap), h: r3(p.h + 2 * gap) });
      spokesOf(p.x, p.y, p.w / 2, p.h / 2);
    });
    // milled cutouts and rounded board corners, with the edge clearance around them
    for (const co of input.cutouts ?? []) {
      const a = (co.angle * Math.PI) / 180;
      const along = (d: number) => [r3(co.x - (d / 2) * Math.cos(a)), r3(co.y - (d / 2) * Math.sin(a)), r3(co.x + (d / 2) * Math.cos(a)), r3(co.y + (d / 2) * Math.sin(a))];
      if (co.shape === 'circle') cuts.push({ k: 'circle', x: co.x, y: co.y, d: r3(co.w + 2 * e) });
      else if (co.shape === 'slot') cuts.push({ k: 'stroke', pts: along(Math.max(0, co.w - co.h)), w: r3(co.h + 2 * e) });
      else if (co.angle % 90 === 0) {
        const [cw, ch] = co.angle % 180 === 0 ? [co.w, co.h] : [co.h, co.w];
        cuts.push({ k: 'rect', x: r3(co.x - cw / 2 - e), y: r3(co.y - ch / 2 - e), w: r3(cw + 2 * e), h: r3(ch + 2 * e) });
      } else cuts.push({ k: 'stroke', pts: along(co.w), w: r3(co.h + 2 * e) }); // turned: a covering oblong
    }
    // keep-outs that hold pours off: their area is cut out, exactly
    for (const ko of input.keepouts ?? []) if (ko.forbid.includes('pours') && ko.layers.includes(pl.layer)) cuts.push({ k: 'poly', pts: ko.poly.map(r3) });
    // a rounded or free-form outline: the pour is clipped to it, and a band of the edge
    // clearance along it is cut
    let clip: number[] | undefined;
    if (shaped) {
      clip = boardPolygon({ outline: input.outline, cornerRadius: cornerR, shape: input.shape ?? null }).map(r3);
      cuts.push({ k: 'stroke', pts: [...clip, clip[0]!, clip[1]!], w: r3(2 * e) });
    }
    // islands that are not kept (no connection to the net): cut them out, grown into the
    // clearance around them (always at least one grid cell wide)
    for (let j = 0; j < H; j++) {
      let start = -1;
      for (let i = 0; i <= W; i++) {
        const isl = i < W ? rg.island[j * W + i]! : -1;
        const dead = isl >= 0 && !alive.has(isl);
        if (dead && start < 0) start = i;
        if (!dead && start >= 0) {
          cuts.push({ k: 'rect', x: r3(start * G - G), y: r3(j * G - G), w: r3((i - start + 1) * G), h: r3(2 * G) });
          start = -1;
        }
      }
    }
    const box: [number, number, number, number] = [e, e, r3(input.outline.w - e), r3(input.outline.h - e)];
    const outline: [number, number, number, number] = pl.area ? [r3(Math.max(box[0], pl.area[0])), r3(Math.max(box[1], pl.area[1])), r3(Math.min(box[2], pl.area[2])), r3(Math.min(box[3], pl.area[3]))] : box;
    if (pl.area && clip) {
      // a shaped board fills its clip polygon, not the outline rectangle: cut what lies outside the area
      const [x0, y0, x1, y1] = outline;
      const [W0, H0] = [input.outline.w, input.outline.h];
      for (const [x, y, w, h] of [[0, 0, W0, y0], [0, y1, W0, H0 - y1], [0, y0, x0, y1 - y0], [x1, y0, W0 - x1, y1 - y0]] as const) if (w > 0 && h > 0) cuts.push({ k: 'rect', x: r3(x), y: r3(y), w: r3(w), h: r3(h) });
    }
    return { outline, ...(clip ? { clip } : {}), cuts, adds };
  };

  return { zones, planes, margin, region, planeShape };
}

export type PassPours = ReturnType<typeof passPours>;
