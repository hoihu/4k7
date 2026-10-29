/**
 * Router benchmark on a board built through the kernel (real parts, auto-placement, default
 * planes): the 12 V buck plus clusters of ATtiny85 with LEDs and decoupling, LM358 stages and a
 * 555, on a 10-pin header. Times the route step (routing, pours, copper checks).
 *
 *   node --experimental-transform-types packages/kernel/bench/board.ts [layers 2|4] [clusters 1|2|3] [moves | place | steady]
 *
 * Prints the time, the board stats, the unrouted nets and a hash of the routes. With moves (a
 * number), then moves that many parts in turn, one step each, and routes again after each move,
 * incrementally (keeping the copper that still holds) and from scratch, for comparison. With
 * place: the placement instead, as proposed (small parts refined or not), then try_placements on
 * the main parts as they stand (the kernel improves on them), each routed. With steady (and a
 * number of moves, default 6): no routing; one part moved 1.5 mm at a time (small parts, then
 * main parts), and how many other parts that disturbed and how far.
 */
import { createHash } from 'node:crypto';
import { Kernel } from '../src/index.ts';
import { benchKernel } from './benchboard.ts';

const clusters = Number(process.argv[3] ?? 1);
const k = benchKernel(process.argv[2] === '4' ? 4 : 2, clusters);
if (process.argv[4] === 'place') {
  const routed = (kk: Kernel) => {
    kk.transact({ summary: 'route', ops: [{ op: 'route' }] });
    const t = performance.now();
    const b = kk.board();
    return `routed in ${((performance.now() - t) / 1000).toFixed(1)} s: ${b.stats.unrouted} open, ${Math.round(b.stats.trackLength)} mm of track, ${b.stats.vias} vias, ${b.diagnostics.filter((x) => x.severity === 'error').length} errors`;
  };
  const line = (name: string, kk: Kernel) => {
    const m = kk.boardPlacement();
    console.log(`${name}: ${m.outline.w} × ${m.outline.h} mm, ratsnest ${m.measures.ratsnestMm} mm, ${m.measures.crossings} crossings, congestion ${m.measures.congestion.overflowMm} mm; ${routed(kk)}`);
  };
  for (const refine of [false, true]) {
    const kk = new Kernel(k.draftDesign());
    kk.transact({ summary: 'propose', ops: [{ op: 'propose_placement', refine }] });
    line(refine ? 'proposed, small parts refined' : 'proposed', kk);
  }
  k.transact({ summary: 'propose', ops: [{ op: 'propose_placement' }] });
  const main = k.boardPlacement().parts.filter((p) => p.pads.length > 3 && !p.componentId.startsWith('hole:')).map((p) => ({ ref: p.refdes, x_mm: p.x, y_mm: p.y, rot: p.rot as 0 | 90 | 180 | 270 }));
  const t = performance.now();
  const r = k.query({ op: 'try_placements', candidates: [{ name: 'as proposed', parts: main }] }) as { options: { parts?: typeof main }[]; explored?: string };
  console.log(`try_placements: ${((performance.now() - t) / 1000).toFixed(1)} s; ${r.explored}`);
  const best = r.options.find((o) => o.parts);
  if (best) {
    const kk = new Kernel(k.draftDesign());
    kk.transact({ summary: 'apply', ops: [{ op: 'propose_placement', parts: best.parts }] });
    line('improved by try_placements', kk);
  }
  process.exit(0);
}

if (process.argv[4] === 'steady') {
  // the placer as the user drives it: one placement, then single parts moved 1.5 mm in turn (small
  // two-pin parts, then main parts), and what else moved with each: parts disturbed, the furthest
  k.transact({ summary: 'propose', ops: [{ op: 'propose_placement' }] });
  const n = Number(process.argv[5] ?? 6);
  const first = k.boardPlacement();
  const lists = {
    small: first.parts.filter((p) => p.pads.length === 2 && !p.locked),
    main: first.parts.filter((p) => p.pads.length > 3 && !p.componentId.startsWith('hole:') && !p.locked),
  };
  for (const [name, list] of Object.entries(lists)) {
    let disturbed = 0;
    let followed = 0;
    let worst = 0;
    const t = performance.now();
    for (let m = 0; m < n; m++) {
      const before = k.boardPlacement();
      const p = before.parts.find((q) => q.refdes === list[Math.floor(((m + 0.5) * list.length) / n)]!.refdes)!;
      const dx = p.x + 3 < before.outline.w ? 1.5 : -1.5;
      k.transact({ summary: 'move', ops: [{ op: 'place', ref: p.refdes, x_mm: p.x + dx, y_mm: p.y }] });
      const after = k.boardPlacement();
      const was = new Map(before.parts.map((q) => [q.refdes, q]));
      // another part counts as disturbed if it moved by more than 0.05 mm or turned
      const others = after.parts
        .filter((q) => q.refdes !== p.refdes && was.has(q.refdes))
        .map((q) => ({ ref: q.refdes, d: Math.hypot(q.x - was.get(q.refdes)!.x, q.y - was.get(q.refdes)!.y), turned: q.rot !== was.get(q.refdes)!.rot }))
        .filter((q) => q.d > 0.05 || q.turned);
      // the parts that belong with it follow it, by design: only the others count
      const own = new Set([p.refdes]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const q of before.parts) if (q.follows && own.has(q.follows) && !own.has(q.refdes)) own.add(q.refdes), (grew = true);
      }
      const strangers = others.filter((q) => !own.has(q.ref));
      const far = Math.max(0, ...strangers.map((q) => q.d));
      disturbed += strangers.length;
      followed += others.length - strangers.length;
      worst = Math.max(worst, far);
      console.log(`${name} ${p.refdes} ${dx > 0 ? '+' : ''}${dx} mm: board ${before.outline.w}x${before.outline.h} -> ${after.outline.w}x${after.outline.h}; ${others.length - strangers.length} of its ${own.size - 1} followers moved, ${strangers.length} other parts disturbed, max ${far.toFixed(2)} mm: ${strangers.slice(0, 8).map((q) => `${q.ref}${q.turned ? ' turned' : ''} ${q.d.toFixed(2)}`).join(', ')}`);
    }
    console.log(`${name}: ${disturbed} other parts disturbed over ${n} moves (and ${followed} followers moved), furthest ${worst.toFixed(2)} mm (${((performance.now() - t) / n).toFixed(0)} ms per move)`);
  }
  process.exit(0);
}

const t0 = performance.now();
k.transact({ summary: 'route', ops: [{ op: 'route' }] });
const b = k.board();
const ms = performance.now() - t0;
console.log(`${b.layers.length}L ${b.outline.w}x${b.outline.h} mm, ${b.parts.length} parts: ${ms.toFixed(0)} ms, ${JSON.stringify(b.stats)}, planes ${b.planes.map((p) => b.netNames[p.netId] + '@' + p.layer).join(' ')}`);
console.log('unrouted:', b.diagnostics.filter((d) => d.code === 'DRC.UNROUTED').map((d) => d.message).join(' | '));
console.log('routes', createHash('sha1').update(JSON.stringify([b.tracks, b.vias, b.zones])).digest('hex').slice(0, 12));

const moves = Number(process.argv[4] ?? 0);
if (moves) {
  k.keepCopper(b.newCopper!);
  // small parts spread over the board, each moved 1.5 mm to the right (or left near the edge)
  const small = b.parts.filter((p) => p.pads.length === 2 && !p.locked);
  for (let m = 0; m < moves; m++) {
    const now = k.board();
    const p = now.parts.find((q) => q.refdes === small[Math.floor(((m + 0.5) * small.length) / moves)]!.refdes)!;
    const dx = p.x + 3 < now.outline.w ? 1.5 : -1.5;
    k.transact({ summary: 'move', ops: [{ op: 'place', ref: p.refdes, x_mm: p.x + dx, y_mm: p.y }, { op: 'route' }] });
    const t1 = performance.now();
    const inc = k.board();
    const incMs = performance.now() - t1;
    // the same placement from scratch: the design without the copper routed before
    const fresh = k.draftDesign();
    delete fresh.board!.copper;
    const t2 = performance.now();
    const full = new Kernel(fresh).board();
    const fullMs = performance.now() - t2;
    const errs = (x: typeof inc) => x.diagnostics.filter((d) => d.severity === 'error' && d.code !== 'DRC.UNROUTED').length;
    console.log(`move ${p.refdes} ${dx > 0 ? '+' : ''}${dx} mm: incremental ${incMs.toFixed(0)} ms (${inc.newCopper!.passes} passes, kept ${inc.newCopper!.reused?.tracks ?? 0} of ${inc.tracks.length} tracks, ${inc.newCopper!.reused?.vias ?? 0} vias), ${inc.stats.unrouted} open, ${errs(inc)} errors | from scratch ${fullMs.toFixed(0)} ms (${full.newCopper!.passes} passes), ${full.stats.unrouted} open, ${errs(full)} errors`);
    for (const d of inc.diagnostics.filter((x) => x.severity === 'error' && x.code !== 'DRC.UNROUTED')) console.log('  ', d.code, d.message, JSON.stringify(d.at));
    k.accept();
    k.keepCopper(inc.newCopper!);
  }
}
