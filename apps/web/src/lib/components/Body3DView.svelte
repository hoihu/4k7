<script lang="ts">
  import { body3dFor, type Body3D } from '@tracewise/parts';
  import type { PartCard } from '@tracewise/schema';

  /**
   * Rotatable 3D preview of the generated package body (drag to turn). A small SVG renderer:
   * orthographic projection, back faces culled, faces painted far to near.
   */
  let { card }: { card: PartCard } = $props();

  const result = $derived(card.packageInfo ? body3dFor(card.packageInfo, card.pins.map((p) => p.number)) : null);
  let az = $state(-35);
  let el = $state(38);

  const COLORS = { body: [46, 49, 55], lead: [196, 200, 208], mark: [120, 124, 132] } as const;

  interface Poly {
    pts: string;
    depth: number;
    fill: string;
  }
  interface Ball {
    x: number;
    y: number;
    r: number;
    depth: number;
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
      return { sx: x1, sy: y1 * se - z1 * ce, depth: -y1 * ce + z1 * se };
    };
    const view = [0, -ce, se] as const; // towards the viewer, in rotated coordinates
    const light = normalize([0.35 * ca + 0.2, -ce + 0.2, se + 0.5]);
    const polys: Poly[] = [];
    const shade = (rgb: readonly number[], n: readonly [number, number, number]) => {
      const k = 0.5 + 0.5 * Math.max(0, n[0] * light[0] + n[1] * light[1] + n[2] * light[2]);
      return `rgb(${rgb.map((c) => Math.round(c * k)).join(',')})`;
    };
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
      for (const [pts, n] of faces) {
        const rn = rot(...n);
        if (rn[0] * view[0] + rn[1] * view[1] + rn[2] * view[2] <= 1e-6) continue;
        const pr = pts.map((p) => project(p[0]!, p[1]!, p[2]!));
        polys.push({ pts: pr.map((p) => `${p.sx.toFixed(3)},${p.sy.toFixed(3)}`).join(' '), depth: pr.reduce((s, p) => s + p.depth, 0) / 4, fill: shade(COLORS[bx.mat], rn) });
      }
    }
    // pin-1 mark: a disc on the top face
    const m = b.pin1;
    const disc = Array.from({ length: 16 }, (_, i) => project(m.x + m.r * Math.cos((i * Math.PI) / 8), m.y + m.r * Math.sin((i * Math.PI) / 8), m.z + 0.001));
    polys.push({ pts: disc.map((p) => `${p.sx.toFixed(3)},${p.sy.toFixed(3)}`).join(' '), depth: project(m.x, m.y, m.z).depth + 0.01, fill: shade(COLORS.mark, rot(0, 0, 1)) });
    const balls: Ball[] = b.balls.map((ball) => {
      const p = project(...ball.c);
      return { x: p.sx, y: p.sy, r: ball.r, depth: p.depth };
    });
    const items = [...polys.map((p) => ({ kind: 'poly' as const, ...p })), ...balls.map((x) => ({ kind: 'ball' as const, ...x }))].sort((p, q) => p.depth - q.depth);
    // fit: bounds of everything projected
    const xs: number[] = [];
    const ys: number[] = [];
    for (const p of polys) for (const pt of p.pts.split(' ')) {
      const [x, y] = pt.split(',').map(Number);
      xs.push(x!);
      ys.push(y!);
    }
    for (const x of balls) {
      xs.push(x.x - x.r, x.x + x.r);
      ys.push(x.y - x.r, x.y + x.r);
    }
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const pad = Math.max(maxX - minX, maxY - minY) * 0.08;
    return { items, viewBox: `${minX - pad} ${minY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`, body: b };
  });

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
    el = Math.min(89, Math.max(-10, drag.el + (e.clientY - drag.y) * 0.4));
  }
</script>

<div class="b3">
  {#if scene}
    <svg viewBox={scene.viewBox} role="img" aria-label="3D view of the package" onpointerdown={down} onpointermove={move} onpointerup={() => (drag = null)}>
      <defs>
        <radialGradient id="ball" cx="35%" cy="35%" r="70%"><stop offset="0" stop-color="#eef0f4" /><stop offset="1" stop-color="#8d929b" /></radialGradient>
      </defs>
      {#each scene.items as it, i (i)}
        {#if it.kind === 'poly'}
          <polygon points={it.pts} fill={it.fill} stroke={it.fill} stroke-width="0.01" />
        {:else}
          <circle cx={it.x} cy={it.y} r={it.r} fill="url(#ball)" />
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
