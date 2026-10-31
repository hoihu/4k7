/**
 * One pass of the router, its searches (router.ts): A* on the fine grid, within a corridor found on
 * a coarse one.
 */
import { keepoutDistance } from '@4k7/schema';
import { Heap } from './heap.ts';
import { CLIP_COST, COARSE, G, now, type PassGrid, TURN_COST } from './routegrid.ts';

export function passSearch(grid: PassGrid) {
  const { input, pads, deadline, history, style, rules, layers, W, H, N, L, widths, searching, stitching, maps, CW, CH, CN, crow, ccol, coarseOf, padDist, viaAt, viaNear, ownCopper, ownInset, toCentre, touch, offMiddle, splitCost, pays, clips, offCentre } = grid;
  /** Where searches stop (with a pour, the signals stop a little earlier), and the searches so far. */
  const clock = { until: deadline, searches: 0 };
  // A* buffers
  const S = L * N;
  const cost = new Float32Array(S);
  const from = new Int32Array(S);
  const dirOf = new Int8Array(S);
  const goal = new Int32Array(S);
  // cost[s] is valid only where seenAt[s] is the current search (no clearing of S cells per search)
  const seenAt = new Int32Array(S);
  // the reachability flood (see search); its buffers only once a search needs one
  let floodAt: Int32Array | null = null;
  let floodQueue: Int32Array | null = null;
  // the corridors (coarse cells) searches keep to, by number (see widen)
  const corridorAt = new Int32Array(CN);
  let corridorNo = 0;
  // a search this long without a way found floods first (a flood costs about as much as S / 8
  // expansions of the search; most routable connections are found well before)
  const FLOOD_AFTER = Math.max(1 << 16, S >> 3);
  // 1 F.Cu (prefers horizontal steps), 2 B.Cu (vertical), 0 inner
  const layerKind = layers.map((l) => (l === 'F.Cu' ? 1 : l === 'B.Cu' ? 2 : 0));
  const DX = [1, 1, 0, -1, -1, -1, 0, 1];
  const DY = [0, 1, 1, 1, 0, -1, -1, -1];
  const STEP = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2];

  const freeFor = (net: number, k: number) => (l: number, i: number) => {
    const v = maps[k]![l]![i]!;
    if (v === 0 || v === net) return true;
    // inside the net's own pad: only where the track stays on the pad (no copper sticking out)
    const st = l * N + i;
    return ownCopper[st] === net && ownInset[st]! >= widths[k]! / 2 - 0.01;
  };
  /*
   * Via keep-out: no via overlapping any pad (its own net's included) or within the land pattern
   * of a small part (between a resistor's pads), unless the board allows vias in pads.
   */
  const viaBlocked = new Uint8Array(N);
  if ((searching || stitching) && !rules.viaInPad) {
    const reach = rules.viaPad / 2 + rules.clearance;
    pads.forEach((p) => {
      const d = padDist(p);
      for (let j = Math.max(0, Math.floor((p.y - p.h / 2 - reach) / G)); j <= Math.min(H - 1, Math.ceil((p.y + p.h / 2 + reach) / G)); j++) {
        for (let i = Math.max(0, Math.floor((p.x - p.w / 2 - reach) / G)); i <= Math.min(W - 1, Math.ceil((p.x + p.w / 2 + reach) / G)); i++) if (d(i * G, j * G) < reach) viaBlocked[j * W + i] = 1;
      }
    });
    for (const part of input.parts) {
      if (part.pads.length > 3) continue; // under ICs vias are fine (and needed to fan out BGAs)
      // the whole via stays out of the land pattern (its ring too, not just its centre)
      const r = rules.viaPad / 2;
      const b = part.courtyard;
      for (let j = Math.max(0, Math.floor((b.y - r) / G)); j <= Math.min(H - 1, Math.ceil((b.y + b.h + r) / G)); j++) {
        for (let i = Math.max(0, Math.floor((b.x - r) / G)); i <= Math.min(W - 1, Math.ceil((b.x + b.w + r) / G)); i++) viaBlocked[j * W + i] = 1;
      }
    }
  }
  // keep-outs that hold vias off (a via goes through every layer)
  for (const ko of input.keepouts ?? []) {
    if (!ko.forbid.includes('vias') || !ko.layers.length) continue;
    const reach = rules.viaPad / 2 + G * 0.35;
    const [x0, y0, x1, y1] = ko.bounds;
    for (let j = Math.max(0, Math.floor((y0 - reach) / G)); j <= Math.min(H - 1, Math.ceil((y1 + reach) / G)); j++) {
      for (let i = Math.max(0, Math.floor((x0 - reach) / G)); i <= Math.min(W - 1, Math.ceil((x1 + reach) / G)); i++) if (keepoutDistance(ko, i * G, j * G) < reach) viaBlocked[j * W + i] = 1;
    }
  }
  const viaFreeFor = (net: number) => (i: number) => {
    if (viaAt[i] === net) return true; // reuse an existing via of this net
    if (viaBlocked[i] || viaNear[i]) return false;
    for (let l = 0; l < L; l++) {
      const v = maps[2]![l]![i]!;
      if (v !== 0 && v !== net) return false;
    }
    return true;
  };

  /** Of a group's cells, those deepest inside their pad (within half a grid step). */
  const deepestCells = (cells: number[]) => {
    let m = -Infinity;
    for (const st of cells) m = Math.max(m, ownInset[st]!);
    return cells.filter((st) => ownInset[st]! >= m - G / 2 - 1e-6);
  };

  /**
   * A* from any start state to a goal state; returns the path (start → goal) or null. `corr`: only
   * within that corridor (a number from widen; 0: anywhere). `floodFirst`: check that a goal can
   * be reached at all before searching (for a connection that is probably impossible).
   * `within`: no way dearer than that.
   */
  /*
   * The estimate of the way left (A*): the distance to the target: a point, or the box round all
   * goal cells. With a group of copper as the goal, a point (one pad of it) would overestimate
   * the way to the group's nearer parts, and the search would run past them to that pad.
   */
  const search = (net: number, k: number, starts: number[], isGoal: (s: number) => boolean, target: { x: number; y: number } | { x0: number; y0: number; x1: number; y1: number }, accept?: (s: number) => boolean, corr = 0, floodFirst = false, within = Infinity): number[] | null => {
    // no new search once the time is up (its reachability flood alone can take a while)
    if (now() > clock.until) return null;
    const free = freeFor(net, k);
    const viaFree = viaFreeFor(net);
    const run = ++clock.searches;
    const inPad = widths[k]! / 2 - 0.01;
    // a track wider than a via pad may not fit where a via does (its clearance reaches farther):
    // only then must a via's landing be checked for the track as well
    const wide = widths[k]! > rules.viaPad;
    const costOf = (st: number) => (seenAt[st] === run ? cost[st]! : Infinity);
    const split = splitCost && pays(net) ? splitCost : null;
    const heap = new Heap();
    const [bx0, by0, bx1, by1] = 'x0' in target ? [target.x0, target.y0, target.x1, target.y1] : [target.x / G, target.y / G, target.x / G, target.y / G];
    const h = (s: number) => {
      const i = s % N;
      const x = i % W;
      const y = Math.floor(i / W);
      const dx = Math.max(bx0 - x, 0, x - bx1);
      const dy = Math.max(by0 - y, 0, y - by1);
      return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    };
    // starts and goals only where this width fits; if none does (a track wider than its pad),
    // the cells deepest inside the pad: on its centre line, not at a corner
    const usable = (st: number) => free(Math.floor(st / N), st % N);
    const centred = (st: number) => usable(st) && !offCentre(net, k, st);
    const seeds = starts.filter(centred);
    if (!seeds.length) seeds.push(...starts.filter(usable));
    const from0 = seeds.length ? seeds : deepestCells(starts);
    const goalOk = (st: number) => isGoal(st) && (accept ? accept(st) : usable(st));
    /*
     * Can any goal be reached at all? A plain flood over the same steps as the search (it reaches
     * exactly what the search would, given time), far cheaper per cell than the search.
     * An unroutable connection would otherwise expand all the copper it can reach.
     */
    const reachable = () => {
      floodAt ??= new Int32Array(S);
      floodQueue ??= new Int32Array(S);
      const seen = floodAt;
      const queue = floodQueue;
      let head = 0;
      let tail = 0;
      for (const st of from0) {
        if (seen[st] === run) continue;
        seen[st] = run;
        queue[tail++] = st;
      }
      while (head < tail) {
        const st = queue[head++]!;
        if (goalOk(st)) return true;
        const l = Math.floor(st / N);
        const i = st - l * N;
        const x = i % W;
        const y = (i - x) / W;
        const m = maps[k]![l]!;
        const lo = l * N;
        const ok = (c: number) => {
          const v = m[c]!;
          return v === 0 || v === net || (ownCopper[lo + c] === net && ownInset[lo + c]! >= inPad);
        };
        for (let d = 0; d < 8; d++) {
          const dx = DX[d]!;
          const dy = DY[d]!;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const ni = ny * W + nx;
          const ns = lo + ni;
          if (seen[ns] === run || (!ok(ni) && !isGoal(ns))) continue;
          if (dx !== 0 && dy !== 0 && (!ok(y * W + nx) || !ok(ny * W + x))) continue;
          seen[ns] = run;
          queue[tail++] = ns;
        }
        if (L > 1 && viaFree(i)) {
          for (let l2 = 0; l2 < L; l2++) {
            const ns = l2 * N + i;
            if (seen[ns] === run || (wide && !free(l2, i) && !isGoal(ns))) continue;
            seen[ns] = run;
            queue[tail++] = ns;
          }
        }
      }
      return false;
    };
    // a start on a pad pays for the piece from the pad centre, so tracks leave near the centre
    for (const s of from0) {
      seenAt[s] = run;
      cost[s] = toCentre(s);
      from[s] = -1;
      dirOf[s] = -1;
      heap.push(s, cost[s]! + h(s));
    }
    let reached = -1;
    let best = Infinity; // the cheapest arrival so far, including the piece on to the pad centre
    let expanded = 0;
    // bounded per connection (turn costs allow some re-expansion); the overall time budget
    // protects big boards
    const LIMIT = S * 3;
    while (heap.size) {
      const s = heap.pop();
      if (heap.lastPrio >= best - 1e-6 || heap.lastPrio > within) break;
      // outdated entry: this state was reached more cheaply since it was pushed. (Costs are kept
      // as 32-bit floats and the priorities as 64-bit numbers: at a cost of a few hundred the
      // rounding alone is ~1e-4, so the tolerance must be above that; real differences are ≥ 0.05.)
      if (heap.lastPrio - h(s) > cost[s]! + 0.01) continue;
      if (goalOk(s) && cost[s]! + toCentre(s) < best) {
        best = cost[s]! + toCentre(s);
        reached = s;
      }
      if (++expanded > LIMIT) break;
      // a long search with no way found yet: give up if there is none
      // (in a corridor the search is small anyway, and the flood would cover the whole board)
      if (expanded === (floodFirst ? 1 : FLOOD_AFTER) && reached < 0 && !corr && !reachable()) break;
      if ((expanded & 4095) === 0 && now() > clock.until) break;
      const l = Math.floor(s / N);
      const i = s % N;
      // copper of the net where this width does not fit (a goal: thinner copper, e.g. a drop to a
      // pour): a way may end there, not run on along it (its copper would reach beyond the thin one)
      if (from[s]! >= 0 && ownCopper[s] !== net && maps[k]![l]![i] !== 0 && maps[k]![l]![i] !== net) continue;
      const x = i % W;
      const y = (i - x) / W;
      const base = cost[s]!;
      const dir = dirOf[s]!;
      // free(l, ·) for this layer, inlined (the hottest test of the search)
      const m = maps[k]![l]!;
      const lo = l * N;
      const ok = (c: number) => {
        const v = m[c]!;
        return v === 0 || v === net || (ownCopper[lo + c] === net && ownInset[lo + c]! >= inPad);
      };
      const kind = layerKind[l]!;
      const tch = k < 2 ? touch[k]! : null;
      for (let d = 0; d < 8; d++) {
        const dx = DX[d]!;
        const dy = DY[d]!;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (corr && corridorAt[crow[ny]! + ccol[nx]!] !== corr) continue;
        const ns = lo + ni;
        if (!ok(ni) && !isGoal(ns)) continue;
        // diagonal steps: both orthogonal neighbours must be clear too (no corner cutting)
        if (dx !== 0 && dy !== 0 && (!ok(y * W + nx) || !ok(ny * W + x))) continue;
        const off = kind === 1 ? dy !== 0 : kind === 2 ? dx !== 0 : false;
        const nc = base + STEP[d]! + (dir >= 0 && dir !== d ? TURN_COST : 0) + (off ? style.offAxis : 0) + (tch !== null && tch[ns] !== 0 && clips(net, k, l, ni, dx, dy) ? CLIP_COST : 0) + offMiddle[ns]! + (split !== null ? split[ns]! : 0) + history[ns]!;
        if (nc < costOf(ns)) {
          seenAt[ns] = run;
          cost[ns] = nc;
          from[ns] = s;
          dirOf[ns] = d;
          heap.push(ns, nc + h(ns));
        }
      }
      if (L > 1 && viaFree(i)) {
        for (let l2 = 0; l2 < L; l2++) {
          if (l2 === l) continue;
          const ns = l2 * N + i;
          // the track goes on from the via: it must fit there too (see wide)
          if (wide && !free(l2, i) && !isGoal(ns)) continue;
          const nc = base + style.via + history[ns]!;
          if (nc < costOf(ns)) {
            seenAt[ns] = run;
            cost[ns] = nc;
            from[ns] = s;
            dirOf[ns] = -1;
            heap.push(ns, nc + h(ns));
          }
        }
      }
    }
    if (reached < 0) {
      return null;
    }
    const path: number[] = [];
    for (let s = reached; s >= 0; s = from[s]!) path.push(s);
    return path.reverse();
  };

  /*
   * Coarse routing (global routing): an A* over coarse cells finds roughly where a connection can
   * go, and the fine search then keeps within a corridor round that way (left to itself, most of
   * its work goes into states far from where the track ends up). A step between two coarse cells
   * is open where a track can cross their boundary: grid points on both sides of it open for the
   * net (free, or a start or goal), side by side; the fewer such lanes, the dearer. A diagonal
   * step is open where one of its two detours through a neighbour is. A via fits in a cell where
   * it fits on any of its grid points. Every fine path crossing a boundary needs such a lane (a
   * diagonal step needs both its orthogonal neighbours free), so with no coarse way there is no
   * fine one either. Like the fine search, the way pays for the piece from a pad cell to the pad
   * centre at both ends (else it would aim at pad corners and escape ends). The starts are marked
   * in goal[] with the negated stamp. Returns the way (coarse cells), or null if there is none
   * (or the time is up).
   */
  const ccost = new Float64Array(L * CN);
  const cfrom = new Int32Array(L * CN);
  const cseen = new Int32Array(L * CN);
  const cgoal = new Int32Array(L * CN);
  const cend = new Float64Array(L * CN); // the cheapest piece on to a pad centre, per goal state
  const viaSeen = new Int32Array(CN);
  const viaFits = new Uint8Array(CN);
  let coarseNo = 0;
  const corridor = (net: number, k: number, starts: number[], goals: number[], goalStamp: number): number[] | null => {
    const run = ++coarseNo;
    for (const st of starts) if (goal[st] !== goalStamp) goal[st] = -goalStamp;
    const mk = maps[k]!;
    const inPad = widths[k]! / 2 - 0.01;
    /** freeFor(net, k), or a start or goal. */
    const open = (l: number, i: number) => {
      const v = mk[l]![i]!;
      if (v === 0 || v === net) return true;
      const st = l * N + i;
      return (ownCopper[st] === net && ownInset[st]! >= inPad) || goal[st] === goalStamp || goal[st] === -goalStamp;
    };
    const viaFree = viaFreeFor(net);
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const st of goals) {
      const c = coarseOf(st % N);
      const cs = Math.floor(st / N) * CN + c;
      const e = toCentre(st);
      if (cgoal[cs] !== run || e < cend[cs]!) cend[cs] = e;
      cgoal[cs] = run;
      const x = c % CW;
      const y = (c - x) / CW;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    /** Lanes across the boundary between cell (x, y) and its neighbour (x + dx, y + dy), dx or dy 0. */
    const lanes = (l: number, x: number, y: number, dx: number, dy: number) => {
      let n = 0;
      // the last grid points of this cell and the first of the next, side by side
      if (dx) {
        const ia = dx > 0 ? x * COARSE + COARSE - 1 : x * COARSE;
        const ib = ia + dx; // (on the board: the neighbour cell is)
        for (let ja = y * COARSE; ja < Math.min(H, y * COARSE + COARSE); ja++) if (open(l, ja * W + ia) && open(l, ja * W + ib)) n++;
      } else {
        const ja = dy > 0 ? y * COARSE + COARSE - 1 : y * COARSE;
        const jb = ja + dy;
        for (let ia = x * COARSE; ia < Math.min(W, x * COARSE + COARSE); ia++) if (open(l, ja * W + ia) && open(l, jb * W + ia)) n++;
      }
      return n;
    };
    const viaIn = (c: number) => {
      if (viaSeen[c] !== run) {
        viaSeen[c] = run;
        viaFits[c] = 0;
        const x = c % CW;
        const y = (c - x) / CW;
        for (let j = y * COARSE; j < Math.min(H, y * COARSE + COARSE) && !viaFits[c]; j++) {
          for (let i = x * COARSE; i < Math.min(W, x * COARSE + COARSE); i++) {
            if (viaFree(j * W + i)) {
              viaFits[c] = 1;
              break;
            }
          }
        }
      }
      return viaFits[c] === 1;
    };
    // (the distance to the box round the goal cells)
    const h = (c: number) => {
      const x = c % CW;
      const y = (c - x) / CW;
      const dx = Math.max(x0 - x, 0, x - x1);
      const dy = Math.max(y0 - y, 0, y - y1);
      return COARSE * (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy));
    };
    const heap = new Heap();
    for (const st of starts) {
      const cs = Math.floor(st / N) * CN + coarseOf(st % N);
      const c0 = toCentre(st);
      if (cseen[cs] === run && ccost[cs]! <= c0) continue;
      cseen[cs] = run;
      ccost[cs] = c0;
      cfrom[cs] = -1;
      heap.push(cs, c0 + h(cs % CN));
    }
    let reached = -1;
    let best = Infinity; // the cheapest arrival so far, including the piece on to the pad centre
    let pops = 0;
    while (heap.size) {
      const s = heap.pop();
      if (heap.lastPrio >= best) break;
      if ((++pops & 4095) === 0 && now() > clock.until) return null;
      const l = Math.floor(s / CN);
      const c = s - l * CN;
      if (heap.lastPrio - h(c) > ccost[s]! + 1e-9) continue;
      if (cgoal[s] === run && ccost[s]! + cend[s]! < best) {
        best = ccost[s]! + cend[s]!;
        reached = s;
      }
      const x = c % CW;
      const y = (c - x) / CW;
      const kind = layerKind[l]!;
      for (let d = 0; d < 8; d++) {
        const dx = DX[d]!;
        const dy = DY[d]!;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= CW || ny >= CH) continue;
        const ncell = ny * CW + nx;
        const ns = l * CN + ncell;
        // (a step costs at least COARSE: no use counting lanes into a cell already that cheap)
        if (cseen[ns] === run && ccost[ns]! <= ccost[s]! + COARSE) continue;
        const n = dx && dy ? Math.max(Math.min(lanes(l, x, y, dx, 0), lanes(l, nx, y, 0, dy)), Math.min(lanes(l, x, y, 0, dy), lanes(l, x, ny, dx, 0))) : lanes(l, x, y, dx, dy);
        if (!n) continue;
        const off = kind === 1 ? dy !== 0 : kind === 2 ? dx !== 0 : false;
        const ncost = ccost[s]! + COARSE * (STEP[d]! * (2 - n / COARSE) + (off ? style.offAxis : 0));
        if (cseen[ns] !== run || ncost < ccost[ns]!) {
          cseen[ns] = run;
          ccost[ns] = ncost;
          cfrom[ns] = s;
          heap.push(ns, ncost + h(ncell));
        }
      }
      if (L < 2) continue;
      let gain = false; // (a via only where it can make another layer cheaper)
      for (let l2 = 0; l2 < L && !gain; l2++) if (l2 !== l && (cseen[l2 * CN + c] !== run || ccost[s]! + style.via < ccost[l2 * CN + c]!)) gain = true;
      if (!gain || !viaIn(c)) continue;
      for (let l2 = 0; l2 < L; l2++) {
        if (l2 === l) continue;
        const ns = l2 * CN + c;
        const ncost = ccost[s]! + style.via;
        if (cseen[ns] !== run || ncost < ccost[ns]!) {
          cseen[ns] = run;
          ccost[ns] = ncost;
          cfrom[ns] = s;
          heap.push(ns, ncost + h(c));
        }
      }
    }
    if (reached < 0) return null;
    const way: number[] = [];
    for (let s = reached; s >= 0; s = cfrom[s]!) way.push(s % CN);
    return way;
  };
  /** Mark a corridor: the coarse cells within r of the way. Returns its number (for search). */
  const widen = (way: number[], r: number): number => {
    const no = ++corridorNo;
    for (const c of way) {
      const x = c % CW;
      const y = (c - x) / CW;
      for (let j = Math.max(0, y - r); j <= Math.min(CH - 1, y + r); j++) for (let i = Math.max(0, x - r); i <= Math.min(CW - 1, x + r); i++) corridorAt[j * CW + i] = no;
    }
    return no;
  };

  return { clock, cost, from, goal, seenAt, DX, DY, STEP, freeFor, viaBlocked, viaFreeFor, deepestCells, search, corridor, widen };
}

export type PassSearch = ReturnType<typeof passSearch>;
