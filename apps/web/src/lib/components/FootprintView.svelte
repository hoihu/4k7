<script lang="ts">
  import { footprintFor } from '@4k7/parts';
  import type { PartCard } from '@4k7/schema';
  import type { TopView } from '../three-body.ts';

  /** Top view of the generated land pattern: pads, body outline, courtyard and pin 1. */
  let { card, hover = $bindable(null) }: { card: PartCard; hover?: string | null } = $props();

  const result = $derived(card.packageInfo ? footprintFor(card.packageInfo, card.pins.map((p) => p.number)) : null);
  const fp = $derived(result?.ok ? result.footprint : null);
  const names = $derived(new Map(card.pins.map((p) => [p.number.toUpperCase(), p.name])));
  const size = $derived(fp ? Math.max(fp.courtyard.w, fp.courtyard.h) * 1.12 : 1);
  const view = $derived.by(() => {
    if (!fp) return '0 0 1 1';
    const m = Math.max(fp.courtyard.w, fp.courtyard.h) * 0.06;
    const w = fp.courtyard.w + 2 * m;
    const h = fp.courtyard.h + 2 * m;
    return `${-w / 2} ${-h / 2} ${w} ${h}`;
  });
  /*
   * Millimetre paper behind the pads, lines through the body centre: fine, medium and bold steps
   * of 1, 5 and 10 mm, or 0.1, 0.5 and 1 mm for small parts, so a pitch can be read off.
   */
  const step = $derived(size < 6 ? 0.1 : 1);
  let pw = $state(0);
  let ph = $state(0);
  /** One screen pixel in mm (the view box is fitted into the panel), so grid lines stay visible. */
  const line = $derived.by(() => {
    if (!fp || !pw || !ph) return size / 700;
    const [, , vw, vh] = view.split(' ').map(Number);
    return 1 / Math.min(pw / vw!, ph / vh!);
  });
  const uid = `fp${Math.random().toString(36).slice(2, 8)}`;

  /** What the panel shows, as a top-down view (mm, centred on the body), for the 3D view to start from. */
  export function getView(): TopView | null {
    if (!fp || !pw || !ph) return null;
    const [, , vw, vh] = view.split(' ').map(Number);
    return { cx: 0, cy: 0, visH: ph / Math.min(pw / vw!, ph / vh!) };
  }
  /** Pad numbers only where they fit. */
  const labelSize = $derived(fp ? Math.min(...fp.pads.map((p) => Math.min(p.w, p.h))) * 0.7 : 0);
  const pkg = $derived(card.packageInfo);
</script>

<div class="fpv">
  {#if fp}
    <svg viewBox={view} role="img" aria-label="Footprint {pkg?.name}" bind:clientWidth={pw} bind:clientHeight={ph}>
      <defs>
        <pattern id="{uid}-a" width={step} height={step} patternUnits="userSpaceOnUse">
          <path class="g1" d="M {step} 0 L 0 0 0 {step}" stroke-width={line} />
        </pattern>
        <pattern id="{uid}-b" width={step * 5} height={step * 5} patternUnits="userSpaceOnUse">
          <rect width={step * 5} height={step * 5} fill="url(#{uid}-a)" />
          <path class="g5" d="M {step * 5} 0 L 0 0 0 {step * 5}" stroke-width={line} />
        </pattern>
        <pattern id="{uid}-c" width={step * 10} height={step * 10} patternUnits="userSpaceOnUse">
          <rect width={step * 10} height={step * 10} fill="url(#{uid}-b)" />
          <path class="g10" d="M {step * 10} 0 L 0 0 0 {step * 10}" stroke-width={line * 1.5} />
        </pattern>
      </defs>
      <!-- the grid reaches past the view box, which the panel may show more of -->
      <rect x={-size * 4} y={-size * 4} width={size * 8} height={size * 8} fill="url(#{uid}-c)" />
      <rect class="court" x={-fp.courtyard.w / 2} y={-fp.courtyard.h / 2} width={fp.courtyard.w} height={fp.courtyard.h} />
      {#if fp.body.round}<circle class="body" cx="0" cy="0" r={fp.body.w / 2} />
      {:else}<rect class="body" x={-fp.body.w / 2} y={-fp.body.h / 2} width={fp.body.w} height={fp.body.h} />{/if}
      {#each fp.pads as p (p.number)}
        {@const on = hover === p.number}
        <g
          class="pad"
          class:on
          role="presentation"
          onmouseenter={() => (hover = p.number)}
          onmouseleave={() => (hover = null)}
        >
          <title>{p.number} {names.get(p.number.toUpperCase()) ?? ''}</title>
          {#if p.shape === 'round'}
            <circle cx={p.x} cy={p.y} r={p.w / 2} />
          {:else}
            <rect x={p.x - p.w / 2} y={p.y - p.h / 2} width={p.w} height={p.h} rx={Math.min(p.w, p.h) * 0.15} />
          {/if}
          {#if p.drill}<circle class="drill" cx={p.x} cy={p.y} r={p.drill / 2} />{/if}
          {#if labelSize > 0.18}
            <text x={p.x} y={p.y} font-size={Math.min(labelSize, 0.8)} dominant-baseline="central" text-anchor="middle">{p.number}</text>
          {/if}
        </g>
      {/each}
      <circle class="pin1" cx={fp.pin1.x} cy={fp.pin1.y} r={Math.max(0.15, labelSize * 0.35 || 0.2)} />
    </svg>
    <div class="meta">
      <span class="mono">{pkg?.name}</span>
      {#if pkg?.pitch_mm}<span>pitch {pkg.pitch_mm} mm</span>{/if}
      {#if pkg?.body_mm}<span>body {pkg.body_mm[0]}×{pkg.body_mm[1]} mm</span>{/if}
      {#if pkg?.span_mm}<span>span {pkg.span_mm[0]}×{pkg.span_mm[1]} mm</span>{/if}
      <span>{fp.pads.length} pads</span>
      <span>grid {step} mm (bold {Math.round(step * 10 * 10) / 10} mm)</span>
      {#if hover}<span class="hl mono">{hover} {names.get(hover.toUpperCase()) ?? ''}</span>{/if}
    </div>
    {#each fp.notes as n, i (i)}<div class="note">{n}</div>{/each}
  {:else if result && !result.ok}
    <div class="empty">No footprint: {result.reason}.</div>
  {:else}
    <div class="empty">No package data: this part has no generated footprint.</div>
  {/if}
</div>

<style>
  .fpv { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  svg { flex: 1; min-height: 0; width: 100%; }
  .g1 { fill: none; stroke: var(--txt-2); opacity: 0.32; }
  .g5 { fill: none; stroke: var(--txt-2); opacity: 0.55; }
  .g10 { fill: none; stroke: var(--txt-2); opacity: 0.8; }
  .court { fill: none; stroke: var(--txt-3); stroke-width: 0.05; stroke-dasharray: 0.3 0.2; opacity: 0.6; }
  .body { fill: none; stroke: var(--sym); stroke-width: 0.12; }
  .pad { fill: #c98a3c; cursor: default; }
  .pad.on { fill: var(--accent); }
  .pad text { fill: #1a1206; font-family: var(--mono); pointer-events: none; }
  .drill { fill: var(--canvas); }
  .pin1 { fill: var(--err); }
  .meta { display: flex; flex-wrap: wrap; gap: 4px 10px; padding: 4px 8px; font-size: 11px; color: var(--txt-3); border-top: 1px solid var(--line); }
  .hl { color: var(--accent-txt); }
  .note { padding: 0 8px 4px; font-size: 11px; color: var(--warn); }
  .empty { margin: auto; padding: 16px; color: var(--txt-3); font-size: 12px; text-align: center; }
</style>
