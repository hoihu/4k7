/**
 * One pass of the router, from a path to copper (router.ts): the zigzag of grid cells straightened
 * into long pieces at 45°, ends aligned to their pads, the track laid and stamped.
 */
import { type BoardPad, type Via } from '@4k7/schema';
import { r3, reversePts, segDist, segmentsOf, segSegDist } from './geom.ts';
import { cutPts, entryBend, G, type PassGrid, sgn, simplify } from './routegrid.ts';
import { type PassSearch } from './routesearch.ts';

export function passTracks(grid: PassGrid, finder: PassSearch) {
  const { input, pads, rules, layers, W, H, N, L, numOf, padNet, widths, trackClass, padDist, stampSeg, stampVia, copperCells, addVia, padCells, escapes, offMiddle, gaps, clips, find, tracks, vias } = grid;
  const { freeFor } = finder;
  /** Turn a path into tracks and vias, reserve its copper; pad ends start/stop at pad centres. */
  /**
   * Straighten a run of grid cells on one layer into long 0/45/90° pieces (the maze path zigzags
   * when the direction is not octilinear): from each vertex, jump to the farthest cell that one
   * straight piece plus one diagonal piece (either order) reaches through free cells. Returns the
   * vertices and every cell the straightened track covers.
   */
  const straighten = (l: number, cells: number[], free: (l: number, i: number) => boolean, clip: (l: number, i: number, dx: number, dy: number) => boolean) => {
    // in the gaps between IC pins the pieces keep to the maze path (it found the gap's middle)
    const onPath = new Set(cells);
    const walk = (a: number, b: number, out: number[]): boolean => {
      let x = a % W;
      let y = (a - x) / W;
      const bx = b % W;
      const by = (b - bx) / W;
      const sx = Math.sign(bx - x);
      const sy = Math.sign(by - y);
      while (x !== bx || y !== by) {
        const nx = x + sx;
        const ny = y + sy;
        if (!free(l, ny * W + nx) || clip(l, ny * W + nx, sx, sy) || (offMiddle[l * N + ny * W + nx]! > 0.05 && !onPath.has(ny * W + nx))) return false;
        if (sx && sy && (!free(l, y * W + nx) || !free(l, ny * W + x))) return false;
        x = nx;
        y = ny;
        out.push(y * W + x);
      }
      return true;
    };
    const octo = (a: number, b: number): { corner: number; cells: number[] } | null => {
      const ax = a % W;
      const ay = (a - ax) / W;
      const dx = (b % W) - ax;
      const dy = (b - (b % W)) / W - ay;
      const m = Math.min(Math.abs(dx), Math.abs(dy));
      const diagFirst = (ay + Math.sign(dy) * m) * W + ax + Math.sign(dx) * m;
      const straightFirst = (ay + dy - Math.sign(dy) * m) * W + ax + dx - Math.sign(dx) * m;
      for (const corner of [diagFirst, straightFirst]) {
        const out: number[] = [];
        if (walk(a, corner, out) && walk(corner, b, out)) return { corner, cells: out };
      }
      return null;
    };
    const verts = [cells[0]!];
    const covered = [cells[0]!];
    for (let i = 0; i < cells.length - 1; ) {
      let next = i + 1;
      let piece: { corner: number; cells: number[] } | null = null;
      for (let j = Math.min(cells.length - 1, i + 250); j > i + 1; j--) {
        piece = octo(cells[i]!, cells[j]!);
        if (piece) {
          next = j;
          break;
        }
      }
      if (piece) {
        if (piece.corner !== cells[i] && piece.corner !== cells[next]) verts.push(piece.corner);
        covered.push(...piece.cells);
      } else covered.push(cells[next]!); // the maze step itself (it was legal when found)
      verts.push(cells[next]!);
      i = next;
    }
    if (!recentre(l, verts, free, clip)) return { verts, covered };
    // pieces moved: the copper they cover now
    const moved = [verts[0]!];
    for (let q = 0; q + 1 < verts.length; q++) {
      let x = verts[q]! % W;
      let y = (verts[q]! - x) / W;
      const bx = verts[q + 1]! % W;
      const by = (verts[q + 1]! - bx) / W;
      while (x !== bx || y !== by) {
        x += Math.sign(bx - x);
        y += Math.sign(by - y);
        moved.push(y * W + x);
      }
    }
    return { verts, covered: moved };
  };

  /*
   * A piece running through the gap between two IC pins moves onto the gap's middle row (or
   * column), if the copper fits there. Its neighbours keep their directions: they get longer or
   * shorter along their own line, so everything stays 0/45/90°.
   */
  const recentre = (l: number, verts: number[], free: (l: number, i: number) => boolean, clip: (l: number, i: number, dx: number, dy: number) => boolean) => {
    let changed = false;
    const xy = (c: number) => [c % W, (c - (c % W)) / W] as const;
    for (let q = 1; q + 2 < verts.length; q++) {
      const [ax, ay] = xy(verts[q]!);
      const [bx, by] = xy(verts[q + 1]!);
      const horizontal = ay === by;
      if (!horizontal && ax !== bx) continue;
      const gap = gaps.find((g) => {
        if (g.vertical !== horizontal || !g.layers.includes(l)) return false;
        const across = (horizontal ? ay : ax) * G;
        const [lo, hi] = horizontal ? [g.y0, g.y1] : [g.x0, g.x1];
        const [s0, s1] = horizontal ? [Math.min(ax, bx) * G, Math.max(ax, bx) * G] : [Math.min(ay, by) * G, Math.max(ay, by) * G];
        const [r0, r1] = horizontal ? [g.x0, g.x1] : [g.y0, g.y1];
        return across > lo && across < hi && Math.min(s1, r1) - Math.max(s0, r0) >= 0.2;
      });
      if (!gap) continue;
      const shift = Math.round(gap.mid / G) - (horizontal ? ay : ax);
      if (!shift) continue;
      // each end slides along its other piece onto the new row / column
      const slide = (c: number, other: number): number | null => {
        const [cx, cy] = xy(c);
        const [ox, oy] = xy(other);
        const dx = Math.sign(cx - ox);
        const dy = Math.sign(cy - oy);
        const along = horizontal ? dy : dx; // how the other piece advances across the gap
        if (!along) return null;
        const t = shift / along; // steps to move along the other piece (negative: shorten it)
        const nx = cx + dx * t;
        const ny = cy + dy * t;
        // the other piece must keep a positive length
        if ((nx - ox) * dx + (ny - oy) * dy <= 0 && (dx || dy)) return null;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) return null;
        return ny * W + nx;
      };
      const na = slide(verts[q]!, verts[q - 1]!);
      const nb = slide(verts[q + 1]!, verts[q + 2]!);
      if (na === null || nb === null) continue;
      // the three new pieces must be clear
      const ok = (a: number, b: number) => {
        let [x, y] = xy(a);
        const [tx, ty] = xy(b);
        const sx = Math.sign(tx - x);
        const sy = Math.sign(ty - y);
        while (x !== tx || y !== ty) {
          const nx = x + sx;
          const ny = y + sy;
          if (!free(l, ny * W + nx) || clip(l, ny * W + nx, sx, sy)) return false;
          if (sx && sy && (!free(l, y * W + nx) || !free(l, ny * W + x))) return false;
          x = nx;
          y = ny;
        }
        return true;
      };
      if (!ok(verts[q - 1]!, na) || !ok(na, nb) || !ok(nb, verts[q + 2]!)) continue;
      verts[q] = na;
      verts[q + 1] = nb;
      changed = true;
    }
    return changed;
  };

  /** Turn a path into tracks and vias, reserve its copper; returns the cells the copper covers. */
  const commit = (netId: string, net: number, k: number, path: number[], startPad: number, endPad: number, endVia = false): number[] => {
    const width = widths[k]!;
    const free = freeFor(net, k);
    const runs: { l: number; cells: number[] }[] = [];
    for (const s of path) {
      const l = Math.floor(s / N);
      const run = runs.at(-1);
      if (!run || run.l !== l) runs.push({ l, cells: [s % N] });
      else run.cells.push(s % N);
    }
    // a path starting or ending inside a pad runs on to (from) the pad's centre cell, so the
    // straightening can aim its last piece at the pad centre (not at some cell off to the side)
    const toward = (from: number, to: number) => {
      const out: number[] = [];
      let x = from % W;
      let y = (from - x) / W;
      const tx = to % W;
      const ty = (to - tx) / W;
      while (x !== tx || y !== ty) {
        x += Math.sign(tx - x);
        y += Math.sign(ty - y);
        out.push(y * W + x);
      }
      return out;
    };
    const centreCell = (p: BoardPad) => Math.round(p.y / G) * W + Math.round(p.x / G);
    const startsInPad = startPad >= 0 && !(escapes[startPad]?.state === path[0]) && padCells[startPad]!.includes(path[0]!);
    const endsInPad = endPad >= 0 && !(escapes[endPad]?.state === path.at(-1)) && padCells[endPad]!.includes(path.at(-1)!);
    if (startsInPad && runs[0]) runs[0].cells = [...toward(runs[0].cells[0]!, centreCell(pads[startPad]!)).reverse(), runs[0].cells[0]!, ...runs[0].cells.slice(1)].filter((c, i, a) => i === 0 || c !== a[i - 1]);
    if (endsInPad && runs.at(-1)) {
      const run = runs.at(-1)!;
      run.cells = [...run.cells, ...toward(run.cells.at(-1)!, centreCell(pads[endPad]!))];
    }
    if (startsInPad && runs[0]) {
      // (the cells toward the centre were listed from the path outwards: put the centre first)
      const c0 = centreCell(pads[startPad]!);
      const i0 = runs[0].cells.indexOf(c0);
      if (i0 > 0) runs[0].cells = [...runs[0].cells.slice(0, i0 + 1).reverse(), ...runs[0].cells.slice(i0 + 1)];
    }
    const covered: number[] = [];
    const lines = runs.map((run, ri) => {
      const clip = (l: number, i: number, dx: number, dy: number) => clips(net, k, l, i, dx, dy);
      let { verts, covered: cov } = straighten(run.l, run.cells, free, clip);
      // again on the result, until it stops improving: a spike in the maze path (up and back
      // down) is cut off once the pieces before and after it can see each other
      for (let again = 0; again < 3; again++) {
        const next = straighten(run.l, cov, free, clip);
        if (next.verts.length >= verts.length) break;
        ({ verts, covered: cov } = next);
      }
      for (const c of cov) covered.push(run.l * N + c);
      const pts = verts.flatMap((c) => [(c % W) * G, Math.floor(c / W) * G]);
      if (ri > 0) addVia(netId, net, pts[0]!, pts[1]!);
      return { l: run.l, pts };
    });
    if (startPad >= 0 && lines[0]) {
      const sp = pads[startPad]!;
      const se = escapes[startPad];
      const pts = lines[0].pts;
      pts.unshift(...(se && se.state === path[0] ? [sp.x, sp.y, se.p1.x, se.p1.y] : [sp.x, sp.y, ...entryBend(pts[0]!, pts[1]!, sp, width)]));
    }
    const last = lines.at(-1)!;
    if (endPad >= 0) {
      const ep = pads[endPad]!;
      const ee = escapes[endPad];
      const pts = last.pts;
      pts.push(...(ee && ee.state === path.at(-1) ? [ee.p1.x, ee.p1.y] : entryBend(pts.at(-2)!, pts.at(-1)!, ep, width)), ep.x, ep.y);
    }
    let dropVia: Via | undefined;
    if (endVia) {
      // a drop to a plane: the via at the end of the path
      const i = path.at(-1)! % N;
      const before = vias.length;
      addVia(netId, net, (i % W) * G, Math.floor(i / W) * G);
      if (vias.length > before) dropVia = vias.at(-1);
    }
    // exactly onto the pads' centre lines (the grid only gets within half a step)
    if (startPad >= 0 && lines[0]) lines[0].pts = reversePts(alignEnd(reversePts(simplify(lines[0].pts)), pads[startPad]!, lines[0].l, net, width, lines.length === 1 ? dropVia : undefined));
    if (endPad >= 0) last.pts = alignEnd(simplify(last.pts), pads[endPad]!, last.l, net, width);
    // an end on a track of the net (a join): exactly onto that track's centre line
    if (startPad < 0 && lines[0] && !(lines.length === 1 && endVia)) lines[0].pts = reversePts(joinTrack(reversePts(simplify(lines[0].pts)), lines[0].l, net, width));
    if (endPad < 0 && !endVia) last.pts = joinTrack(simplify(last.pts), last.l, net, width);
    for (const line of lines) line.pts = dejog(simplify(line.pts), line.l, net, width);
    // a net whose width is set, routed narrower for a pad too small for it: narrow only where it
    // goes into that pad, the full width elsewhere where that keeps its clearance
    const own = input.netWidths?.[netId];
    const laid: { l: number; pts: number[]; width: number }[] = [];
    lines.forEach((line, li) => {
      const pts = simplify(line.pts);
      // (the pads at its ends too small for the full width: a neck into each)
      const small = (q: number) => (q >= 0 && own !== undefined && Math.min(pads[q]!.w, pads[q]!.h) < own * 0.9 ? pads[q]! : null);
      const into = (end: boolean) => (end ? (li === lines.length - 1 ? small(endPad) : null) : li === 0 ? small(startPad) : null);
      const wide = own !== undefined && own > width + 1e-9 && pts.length >= 4 ? widened(net, line.l, pts, width, own, into(false), into(true)) : null;
      laid.push(...(wide ?? [{ l: line.l, pts, width }]));
    });
    // the copper as it finally lies (aligned ends moved it): the cells later routes may join
    const onCopper = new Set<number>();
    for (const line of laid) {
      const pts = simplify(line.pts);
      if (pts.length < 4) continue;
      tracks.push({ netId, layer: layers[line.l]!, width: line.width, pts: pts.map(r3) });
      for (let q = 0; q + 3 < pts.length; q += 2) stampSeg(line.l, net, pts[q]!, pts[q + 1]!, pts[q + 2]!, pts[q + 3]!, line.width);
      for (const st of copperCells(line.l, pts, line.width)) onCopper.add(st);
    }
    return onCopper.size ? [...onCopper] : covered;
  };
  /**
   * A track laid at `narrow` for a pad too small for `wide` (the net's set width), as a narrow neck
   * into each such pad (`a` at its start, `b` at its end) and the rest at `wide`: the wide piece
   * starts where its round end stays off the pad and its copper clears everything of other nets
   * (the grid's map for that width, which knows the edge, and exactly). Null where it does not fit
   * (the track stays narrow).
   */
  const widened = (net: number, l: number, pts: number[], narrow: number, wide: number, a: BoardPad | null, b: BoardPad | null): { l: number; pts: number[]; width: number }[] | null => {
    const kw = trackClass(wide);
    if (kw < 0) return null;
    const free = freeFor(net, kw);
    // points along the track every 0.05 mm, with how far along it they are
    const at: { x: number; y: number; s: number }[] = [];
    let s0 = 0;
    for (const [ax, ay, bx, by] of segmentsOf(pts)) {
      const len = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.ceil(len / 0.05));
      for (let i = at.length ? 1 : 0; i <= n; i++) at.push({ x: ax + ((bx - ax) * i) / n, y: ay + ((by - ay) * i) / n, s: s0 + (len * i) / n });
      s0 += len;
    }
    const cellOk = (p: { x: number; y: number }) => {
      const i = Math.round(p.x / G);
      const j = Math.round(p.y / G);
      return i >= 0 && j >= 0 && i < W && j < H && free(l, j * W + i);
    };
    const off = (p: BoardPad | null, q: { x: number; y: number }) => !p || Math.max(Math.abs(q.x - p.x) - p.w / 2, Math.abs(q.y - p.y) - p.h / 2) >= wide / 2;
    let i0 = 0;
    if (a) while (i0 < at.length && !(off(a, at[i0]!) && cellOk(at[i0]!))) i0++;
    let i1 = at.length - 1;
    if (b) while (i1 > i0 && !(off(b, at[i1]!) && cellOk(at[i1]!))) i1--;
    if (i1 - i0 < 2 || !at.slice(i0, i1 + 1).every(cellOk)) return null;
    const [d0, d1] = [at[i0]!.s, at[i1]!.s];
    const mid = cutPts(pts, d0, d1);
    if (!clearOf(net, l, wide, segmentsOf(mid))) return null;
    return [
      ...(d0 > 1e-6 ? [{ l, pts: cutPts(pts, 0, d0), width: narrow }] : []),
      { l, pts: mid, width: wide },
      ...(d1 < s0 - 1e-6 ? [{ l, pts: cutPts(pts, d1, s0), width: narrow }] : []),
    ];
  };
  /*
   * The run into a pad (pts ends at the pad centre), moved so that its line goes exactly through
   * the pad centre: grid rows rarely hit a pad's centre line, so a track would run in slightly
   * off-centre (or a diagonal aim past the centre). The run keeps its direction; the piece before
   * it slides along its own direction to meet it (angles stay). If the run starts at a via made
   * for this track (a drop to a plane), the via moves with it. Made only if the copper keeps its
   * clearance from everything of other nets (checked exactly).
   */
  const alignEnd = (pts: number[], p: BoardPad, l: number, net: number, width: number, via?: Via): number[] => {
    const n = pts.length / 2;
    const px = pts[2 * n - 2]!;
    const py = pts[2 * n - 1]!;
    const outside = (x: number, y: number) => Math.abs(x - p.x) > p.w / 2 + 1e-9 || Math.abs(y - p.y) > p.h / 2 + 1e-9;
    for (let j = n - 2; j >= 1; j--) {
      // the run [A, B] = points j-1, j: the last one starting outside the pad
      const ax = pts[2 * j - 2]!;
      const ay = pts[2 * j - 1]!;
      const bx = pts[2 * j]!;
      const by = pts[2 * j + 1]!;
      if (!outside(ax, ay)) continue;
      const ux = sgn(bx - ax);
      const uy = sgn(by - ay);
      if (ux === 0 && uy === 0) return pts;
      // across a pad's long side it may meet the pad anywhere: nothing to align
      if ((uy === 0 && p.h > p.w * 1.2) || (ux === 0 && p.w > p.h * 1.2)) return pts;
      const ul = Math.hypot(ux, uy);
      const off = ((px - ax) * uy - (py - ay) * ux) / ul; // signed distance of the centre from the run's line
      if (Math.abs(off) > 0.3 || (px - ax) * ux + (py - ay) * uy <= 0) return pts;
      if (Math.abs(off) < 1e-6) return [...pts.slice(0, 2 * j), px, py]; // on the line: straight in
      let nax: number;
      let nay: number;
      if (j >= 2) {
        // slide A along [Z, A] onto the line through the centre (direction u); an escape stub's
        // sub-grid jog before A is dropped: then A slides along the stub itself
        let zi = j - 2;
        let zx = pts[2 * zi]!;
        let zy = pts[2 * zi + 1]!;
        const octilinear = (dx: number, dy: number) => Math.abs(dx) < 1e-9 || Math.abs(dy) < 1e-9 || Math.abs(Math.abs(dx) - Math.abs(dy)) < 1e-9;
        let vx = ax - zx;
        let vy = ay - zy;
        if (!octilinear(vx, vy) && zi >= 1) {
          const yx = pts[2 * zi - 2]!;
          const yy = pts[2 * zi - 1]!;
          vx = zx - yx;
          vy = zy - yy;
          zi--;
          zx = yx;
          zy = yy;
        }
        vx = sgn(vx);
        vy = sgn(vy);
        const det = uy * vx - ux * vy;
        if (Math.abs(det) < 1e-9) return pts; // [Z, A] parallel to the run
        const t = ((px - zx) * uy - (py - zy) * ux) / det;
        if (t <= 1e-6) return pts; // [Z, A] would turn back
        nax = zx + vx * t;
        nay = zy + vy * t;
        // the corner must not end up half over the pad's edge (the piece before turns off there),
        // nor on or next to another pad of the net (the turn would leave that pad across its edge)
        if (padDist(p)(nax, nay) < width / 2 - 0.08) return pts;
        const layer0 = layers[l]!;
        if (pads.some((o, q) => o !== p && padNet[q] === net && (o.drill || o.layers.includes(layer0)) && padDist(o)(nax, nay) < width / 2 + 0.05)) return pts;
        if (!clearOf(net, l, width, [[zx, zy, nax, nay], [nax, nay, px, py]])) return pts;
        return [...pts.slice(0, 2 * zi + 2), nax, nay, px, py];
      }
      // A is the track's other end. On a pad of the net (its centre): a short step inside that
      // pad onto the line through this pad's centre, then straight in
      const layer = layers[l]!;
      const q = pads.findIndex((o, qi) => padNet[qi] === net && o !== p && Math.abs(o.x - ax) < 1e-6 && Math.abs(o.y - ay) < 1e-6 && (o.drill || o.layers.includes(layer)));
      if (q >= 0) {
        const o = pads[q]!;
        // only where the track may meet that pad anywhere (across its long side): its own entry
        // must not suffer
        if (!((uy === 0 && o.h > o.w * 1.2) || (ux === 0 && o.w > o.h * 1.2))) return pts;
        nax = ax + (off * uy) / ul;
        nay = ay - (off * ux) / ul;
        if (Math.abs(nax - o.x) <= o.w / 2 - width / 2 + 1e-6 && Math.abs(nay - o.y) <= o.h / 2 - width / 2 + 1e-6 && clearOf(net, l, width, [[nax, nay, px, py]])) return [ax, ay, nax, nay, px, py];
        return pts;
      }
      // on a via of the net: a step hidden under the via's ring onto the line, then straight in
      const atVia = vias.find((v) => numOf(v.netId) === net && Math.abs(v.x - ax) < 1e-6 && Math.abs(v.y - ay) < 1e-6);
      if (atVia && Math.abs(off) <= atVia.pad / 2 - width / 2) {
        nax = ax + (off * uy) / ul;
        nay = ay - (off * ux) / ul;
        if (clearOf(net, l, width, [[nax, nay, px, py]])) return [ax, ay, nax, nay, px, py];
      }
      // where it joins a track of the net, it slides along that track
      for (const t of tracks) {
        if (t.layer !== layer || numOf(t.netId) !== net) continue;
        for (let q = 0; q + 3 < t.pts.length; q += 2) {
          const [cx, cy, dx, dy] = [t.pts[q]!, t.pts[q + 1]!, t.pts[q + 2]!, t.pts[q + 3]!];
          if (segDist(cx, cy, dx, dy)(ax, ay) > 1e-6) continue;
          const vx = sgn(dx - cx);
          const vy = sgn(dy - cy);
          const det = uy * vx - ux * vy;
          if (Math.abs(det) < 1e-9) continue;
          const s2 = ((px - ax) * uy - (py - ay) * ux) / det;
          nax = ax + vx * s2;
          nay = ay + vy * s2;
          // still on that piece of track
          if (segDist(cx, cy, dx, dy)(nax, nay) > 1e-6) continue;
          if (!clearOf(net, l, width, [[nax, nay, px, py]])) continue;
          return [nax, nay, px, py];
        }
      }
      // or it is this track's own new via (a drop to a plane): the via moves with it
      if (!via || Math.abs(via.x - ax) > 1e-6 || Math.abs(via.y - ay) > 1e-6) return pts;
      // (the foot of A on the line through the centre)
      nax = ax + (off * uy) / ul;
      nay = ay - (off * ux) / ul;
      if (!clearOf(net, l, width, [[nax, nay, px, py]])) return pts;
      for (let vl = 0; vl < L; vl++) if (!clearOf(net, vl, via.pad, [[nax, nay, nax, nay]])) return pts;
      via.x = r3(nax);
      via.y = r3(nay);
      stampVia(net, nax, nay);
      return [nax, nay, px, py];
    }
    return pts;
  };
  /*
   * A path that ends on a track of its net joins it somewhere inside its copper, which on a wide
   * track can be off its centre line: the last run slides on along its direction onto the centre
   * line (or, running alongside it, a short step across). Only with exact clearance, for the
   * copper that moves: this track's, at its width.
   */
  const joinTrack = (pts: number[], l: number, net: number, width: number): number[] => {
    const n = pts.length / 2;
    if (n < 2) return pts;
    const [px, py] = [pts[2 * n - 2]!, pts[2 * n - 1]!];
    const [ax, ay] = [pts[2 * n - 4]!, pts[2 * n - 3]!];
    const layer = layers[l]!;
    let best: { d: number; cx: number; cy: number; dx: number; dy: number; w: number } | null = null;
    for (const t of tracks) {
      if (t.layer !== layer || numOf(t.netId) !== net) continue;
      for (let q = 0; q + 3 < t.pts.length; q += 2) {
        const [cx, cy, ex, ey] = [t.pts[q]!, t.pts[q + 1]!, t.pts[q + 2]!, t.pts[q + 3]!];
        const d = segDist(cx, cy, ex, ey)(px, py);
        if (d <= t.width / 2 + 1e-6 && (!best || d < best.d)) best = { d, cx, cy, dx: ex - cx, dy: ey - cy, w: t.width };
      }
    }
    if (!best || best.d < 1e-6) return pts; // not on a track, or already on its centre line
    const { cx, cy, dx, dy } = best;
    const ux = px - ax;
    const uy = py - ay;
    // where the run's line meets the track's centre line (t along the run beyond P, s on the track)
    const det = ux * dy - uy * dx;
    let q: [number, number] | null = null;
    if (Math.abs(det) > 1e-9) {
      const t = ((cx - px) * dy - (cy - py) * dx) / det;
      const s2 = ((cx - px) * uy - (cy - py) * ux) / det;
      if (t > -1e-9 && t * Math.hypot(ux, uy) <= best.w && s2 >= -1e-9 && s2 <= 1 + 1e-9) q = [px + ux * t, py + uy * t];
    }
    if (!q) {
      // alongside: the foot on the centre line
      const l2 = dx * dx + dy * dy;
      const s2 = l2 ? Math.max(0, Math.min(1, ((px - cx) * dx + (py - cy) * dy) / l2)) : 0;
      q = [cx + dx * s2, cy + dy * s2];
      if (!clearOf(net, l, width, [[px, py, q[0], q[1]]])) return pts;
      return [...pts, q[0], q[1]];
    }
    if (!clearOf(net, l, width, [[ax, ay, q[0], q[1]]])) return pts;
    return [...pts.slice(0, 2 * n - 2), q[0], q[1]];
  };

  /*
   * Small jogs: two parallel runs joined by a short step (under 0.3 mm), e.g. where the maze
   * lined a diagonal up with a pad centre. The corner before the first run slides along its own
   * direction until that run is on the line of the second, and the step is gone (angles stay).
   * Only with exact clearance; ends of the track stay where they are.
   */
  const dejog = (pts: number[], l: number, net: number, width: number): number[] => {
    let out = pts;
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      const n = out.length / 2;
      for (let i = 1; i + 2 < n; i++) {
        // runs: Z→A (before), A→B (first), B→C (the step), C→D (second)
        if (i < 2) continue;
        const P = (k: number) => [out[2 * k]!, out[2 * k + 1]!] as const;
        const [zx, zy] = P(i - 2);
        const [ax, ay] = P(i - 1);
        const [bx, by] = P(i);
        const [cx, cy] = P(i + 1);
        const [dx, dy] = P(i + 2);
        if (Math.hypot(cx - bx, cy - by) > 0.3) continue;
        const u = [sgn(bx - ax), sgn(by - ay)];
        const v = [sgn(dx - cx), sgn(dy - cy)];
        if (u[0] !== v[0] || u[1] !== v[1]) continue; // not parallel, same way
        // slide A along Z→A onto the line through C with direction u
        const w = [sgn(ax - zx), sgn(ay - zy)];
        const det = w[0]! * u[1]! - w[1]! * u[0]!;
        if (Math.abs(det) < 1e-9) continue;
        const t = ((cx - zx) * u[1]! - (cy - zy) * u[0]!) / det;
        const nx = zx + w[0]! * t;
        const ny = zy + w[1]! * t;
        // A' must stay on the Z side of D (the run A'→D keeps its direction)
        if (t <= 1e-6 || (dx - nx) * u[0]! + (dy - ny) * u[1]! <= 1e-6) continue;
        if (!clearOf(net, l, width, [[zx, zy, nx, ny], [nx, ny, dx, dy]])) continue;
        // nor half over a pad of the net (the step may have been there to line up with one)
        const layer = layers[l]!;
        const overPad = pads.some((p, q) => {
          if (padNet[q] !== net || (!p.drill && !p.layers.includes(layer))) return false;
          const d = padDist(p);
          for (let k = 0; k <= 10; k++) {
            const x = zx + ((nx - zx) * k) / 10;
            const y = zy + ((ny - zy) * k) / 10;
            const e = d(x, y);
            if (e > 0 && e < width / 2 - 0.02) return true; // touching from outside, not on it
          }
          // and the new corner not on or next to one (the turn would leave the pad across its edge)
          return d(nx, ny) < width / 2 + 0.05;
        });
        if (overPad) continue;
        out = [...out.slice(0, 2 * (i - 1)), nx, ny, ...out.slice(2 * (i + 2))];
        changed = true;
        break;
      }
      if (!changed) break;
    }
    return out;
  };

  /** The segments (of the given width, on layer l) keep the clearance from all copper of other nets. */
  // drop sites reserved for pours (see reserveDrops): pad → its drop path (pad → via site) and
  // width class, and the copper held for them (a via's on every layer: l = -1)
  const reserved = new Map<number, { path: number[]; k: number }>();
  const held: { net: number; l: number; ax: number; ay: number; bx: number; by: number; w: number }[] = [];
  const clearOf = (net: number, l: number, width: number, segs: [number, number, number, number][]) => {
    const need = rules.clearance + width / 2 - 1e-3;
    const layer = layers[l]!;
    for (const [ax, ay, bx, by] of segs) {
      const len = Math.hypot(bx - ax, by - ay);
      const steps = Math.max(1, Math.ceil(len / 0.01));
      const near = segDist(ax, ay, bx, by);
      for (let q = 0; q < pads.length; q++) {
        const p = pads[q]!;
        if (padNet[q] === net || (!p.drill && !p.layers.includes(layer))) continue;
        if (Math.abs(p.x - (ax + bx) / 2) > len / 2 + Math.max(p.w, p.h) + 1 || Math.abs(p.y - (ay + by) / 2) > len / 2 + Math.max(p.w, p.h) + 1) continue;
        const d = padDist(p);
        for (let i = 0; i <= steps; i++) if (d(ax + ((bx - ax) * i) / steps, ay + ((by - ay) * i) / steps) < need) return false;
        // a reserved escape stub of another net
        const e = escapes[q];
        if (e && e.l === l) {
          const stub = rules.clearance + (width + rules.track) / 2 - 1e-3;
          for (const [cx, cy, dx, dy] of [[p.x, p.y, e.p1.x, e.p1.y], [e.p1.x, e.p1.y, e.ex, e.ey]] as const) {
            if (segSegDist(ax, ay, bx, by, cx, cy, dx, dy) < stub) return false;
          }
        }
      }
      for (const t of tracks) {
        if (t.layer !== layer || numOf(t.netId) === net) continue;
        const gap = rules.clearance + (width + t.width) / 2 - 1e-3;
        for (let q = 0; q + 3 < t.pts.length; q += 2) if (segSegDist(ax, ay, bx, by, t.pts[q]!, t.pts[q + 1]!, t.pts[q + 2]!, t.pts[q + 3]!) < gap) return false;
      }
      for (const v of vias) if (numOf(v.netId) !== net && near(v.x, v.y) < rules.clearance + (width + v.pad) / 2 - 1e-3) return false;
      for (const c of held) if (c.net !== net && (c.l < 0 || c.l === l) && segSegDist(ax, ay, bx, by, c.ax, c.ay, c.bx, c.by) < rules.clearance + (width + c.w) / 2 - 1e-3) return false;
    }
    return true;
  };
  const padAt = (root: number, state: number) => pads.findIndex((_, idx) => find(idx) === root && padCells[idx]!.includes(state));

  return { commit, reserved, held, clearOf, padAt };
}

export type PassTracks = ReturnType<typeof passTracks>;
