<script lang="ts">
  import { body3dFor, type Body3D } from '@tracewise/parts';
  import type { PartCard } from '@tracewise/schema';

  /**
   * Rotatable 3D preview of the generated package body (drag to turn). A small SVG renderer:
   * orthographic projection, back faces culled. Solids (boxes, balls) never intersect, so they
   * are painted in an exact order: of two solids that overlap on screen, the one on the far
   * side of a plane separating them goes first. (Sorting faces by average depth fails for big
   * faces such as the top of the body.)
   */
  let { card }: { card: PartCard } = $props();

  const result = $derived(card.packageInfo ? body3dFor(card.packageInfo, card.pins.map((p) => p.number)) : null);
  let az = $state(-35);
  let el = $state(38);

  const COLORS = { body: [46, 49, 55], lead: [196, 200, 208], mark: [120, 124, 132] } as const;

  interface Solid {
    min: readonly number[];
    max: readonly number[];
    /** Screen bounds, for the overlap test. */
    sb: [number, number, number, number];
    depth: number;
    polys: { pts: string; fill: string }[];
    ball?: { x: number; y: number; r: number };
  }

  const scene = $derived.by(() => {
    if (!result?.ok) return null;
    const b: Body3D = result.body;
    const a = (az * Math.PI) / 180;
    const e = (el * Math.PI) / 180;
    const [ca, sa, ce, se] = [Math.cos(a), Math.sin(a), Math.cos(e), Math.sin(e)];
    const rot = (x: number, y: number, z: number) => [x * ca - y * sa, x * sa + y * ca, z] as const;
    const project = (x: number, y: number, z: number) => {
      const [x1, y1, z1] = rot(x, y, z);
      return { sx: x1, sy: y1 * se - z1 * ce, depth: y1 * ce + z1 * se };
    };
    // towards the viewer, in rotated coordinates: +y is nearer (drawn lower on screen), +z is up
    const view = [0, ce, se] as const;
    const viewWorld = [sa * ce, ca * ce, se]; // the same direction in world coordinates
    const light = normalize([0.35, ce * 0.6, se + 0.6]);
    const shade = (rgb: readonly number[], n: readonly [number, number, number]) => {
      const k = 0.5 + 0.5 * Math.max(0, n[0] * light[0] + n[1] * light[1] + n[2] * light[2]);
      return `rgb(${rgb.map((c) => Math.round(c * k)).join(',')})`;
    };
    const ptsOf = (pr: { sx: number; sy: number }[]) => pr.map((p) => `${p.sx.toFixed(3)},${p.sy.toFixed(3)}`).join(' ');
    const bounds = (min: readonly number[], max: readonly number[]): Solid['sb'] => {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const x of [min[0]!, max[0]!]) for (const y of [min[1]!, max[1]!]) for (const z of [min[2]!, max[2]!]) {
        const p = project(x, y, z);
        xs.push(p.sx);
        ys.push(p.sy);
      }
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    };

    const solids: Solid[] = [];
    for (const bx of b.boxes) {
      const [x0, y0, z0] = bx.min;
      const [x1, y1, z1] = bx.max;
      const faces: [number[][], [number, number, number]][] = [
        [[[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1]],
        [[[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], [0, 0, -1]],
        [[[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0]],
        [[[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], [0, 1, 0]],
        [[[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0]],
        [[[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [1, 0, 0]],
      ];
      const polys: Solid['polys'] = [];
      for (const [pts, n] of faces) {
        const rn = rot(...n);
        if (rn[0] * view[0] + rn[1] * view[1] + rn[2] * view[2] <= 1e-6) continue; // back face
        polys.push({ pts: ptsOf(pts.map((p) => project(p[0]!, p[1]!, p[2]!))), fill: shade(COLORS[bx.mat], rn) });
      }
      if (bx.mat === 'body' && se > 0) {
        // pin-1 mark: a disc on the top face, painted with the body
        const m = b.pin1;
        const disc = Array.from({ length: 16 }, (_, i) => project(m.x + m.r * Math.cos((i * Math.PI) / 8), m.y + m.r * Math.sin((i * Math.PI) / 8), m.z));
        polys.push({ pts: ptsOf(disc), fill: shade(COLORS.mark, rot(0, 0, 1)) });
      }
      const c = project((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      solids.push({ min: bx.min, max: bx.max, sb: bounds(bx.min, bx.max), depth: c.depth, polys });
    }
    for (const ball of b.balls) {
      const [x, y, z] = ball.c;
      const p = project(x, y, z);
      const min = [x - ball.r, y - ball.r, z - ball.r];
      const max = [x + ball.r, y + ball.r, z + ball.r];
      solids.push({ min, max, sb: [p.sx - ball.r, p.sy - ball.r, p.sx + ball.r, p.sy + ball.r], depth: p.depth, polys: [], ball: { x: p.sx, y: p.sy, r: ball.r } });
    }

    const order = paintOrder(solids, viewWorld);
    const [minX, minY, maxX, maxY] = solids.reduce((acc, s) => [Math.min(acc[0], s.sb[0]), Math.min(acc[1], s.sb[1]), Math.max(acc[2], s.sb[2]), Math.max(acc[3], s.sb[3])], [Infinity, Infinity, -Infinity, -Infinity]);
    const pad = Math.max(maxX - minX, maxY - minY) * 0.08;
    return { solids: order, viewBox: `${minX - pad} ${minY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`, body: b };
  });

  /**
   * Painter's order for non-intersecting solids: for each pair overlapping on screen, find an
   * axis along which they are separated; the one farther from the viewer along that axis is
   * painted first. Topological sort, ties (and any cycle) broken by centre depth.
   */
  function paintOrder(solids: Solid[], v: number[]): Solid[] {
    const n = solids.length;
    const after: number[][] = Array.from({ length: n }, () => []);
    const indeg = new Array<number>(n).fill(0);
    const EPS = 1e-6;
    for (let i = 0; i < n; i++) {
      const A = solids[i]!;
      for (let j = i + 1; j < n; j++) {
        const B = solids[j]!;
        if (A.sb[2] <= B.sb[0] || B.sb[2] <= A.sb[0] || A.sb[3] <= B.sb[1] || B.sb[3] <= A.sb[1]) continue;
        for (let k = 0; k < 3; k++) {
          if (Math.abs(v[k]!) < 1e-9) continue;
          let first: number | null = null;
          if (A.max[k]! <= B.min[k]! + EPS) first = v[k]! > 0 ? i : j; // A on the low side
          else if (B.max[k]! <= A.min[k]! + EPS) first = v[k]! > 0 ? j : i;
          if (first === null) continue;
          const second = first === i ? j : i;
          after[first]!.push(second);
          indeg[second]!++;
          break;
        }
      }
    }
    const out: Solid[] = [];
    const done = new Array<boolean>(n).fill(false);
    const ready = solids.map((_, i) => i).filter((i) => indeg[i] === 0);
    while (out.length < n) {
      let pick: number;
      if (ready.length) {
        ready.sort((x, y) => solids[y]!.depth - solids[x]!.depth); // farthest last in the list → pop
        pick = ready.pop()!;
      } else {
        // cycle (should not happen with separated solids): take the farthest remaining
        pick = solids.map((_, i) => i).filter((i) => !done[i]).sort((x, y) => solids[x]!.depth - solids[y]!.depth)[0]!;
      }
      if (done[pick]) continue;
      done[pick] = true;
      out.push(solids[pick]!);
      for (const k of after[pick]!) if (--indeg[k]! === 0 && !done[k]) ready.push(k);
    }
    return out;
  }

  function normalize(v: number[]): [number, number, number] {
    const l = Math.hypot(v[0]!, v[1]!, v[2]!);
    return [v[0]! / l, v[1]! / l, v[2]! / l];
  }

  let drag: { x: number; y: number; az: number; el: number } | null = null;
  function down(e: PointerEvent) {
    drag = { x: e.clientX, y: e.clientY, az, el };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }
  function move(e: PointerEvent) {
    if (!drag) return;
    az = drag.az - (e.clientX - drag.x) * 0.5;
    el = Math.min(89, Math.max(0, drag.el + (e.clientY - drag.y) * 0.4));
  }
</script>

<div class="b3">
  {#if scene}
    <svg viewBox={scene.viewBox} role="img" aria-label="3D view of the package" onpointerdown={down} onpointermove={move} onpointerup={() => (drag = null)}>
      <defs>
        <radialGradient id="ball" cx="35%" cy="35%" r="70%"><stop offset="0" stop-color="#eef0f4" /><stop offset="1" stop-color="#8d929b" /></radialGradient>
      </defs>
      {#each scene.solids as so, i (i)}
        {#if so.ball}
          <circle cx={so.ball.x} cy={so.ball.y} r={so.ball.r} fill="url(#ball)" />
        {:else}
          {#each so.polys as p, j (j)}<polygon points={p.pts} fill={p.fill} stroke={p.fill} stroke-width="0.01" />{/each}
        {/if}
      {/each}
    </svg>
    <div class="meta">
      <span>height {scene.body.height} mm</span>
      <span class="muted">drag to rotate</span>
      <button class="link" onclick={() => ((az = -35), (el = 38))}>reset</button>
      <button class="link" onclick={() => ((az = 0), (el = 89))}>top</button>
    </div>
    {#each scene.body.notes as n, i (i)}<div class="note">{n}</div>{/each}
  {:else if result && !result.ok}
    <div class="empty">No 3D body: {result.reason}.</div>
  {:else}
    <div class="empty">No package data for a 3D body.</div>
  {/if}
</div>

<style>
  .b3 { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  svg { flex: 1; min-height: 0; width: 100%; cursor: grab; touch-action: none; }
  svg:active { cursor: grabbing; }
  .meta { display: flex; gap: 10px; padding: 4px 8px; font-size: 11px; color: var(--txt-3); border-top: 1px solid var(--line); }
  .note { padding: 0 8px 4px; font-size: 11px; color: var(--warn); }
  .link { border: 0; background: none; padding: 0; color: var(--accent-txt); cursor: pointer; font: inherit; }
  .empty { margin: auto; padding: 16px; color: var(--txt-3); font-size: 12px; text-align: center; }
</style>
