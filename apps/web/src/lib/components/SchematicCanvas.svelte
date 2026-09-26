<script lang="ts">
  import type { LabelView, Prim, SheetView, SymbolView } from '@tracewise/schema';

  interface Props {
    sheet: SheetView | undefined;
    /** componentId → overlay kind for pending changes */
    overlays?: Record<string, 'add' | 'change'>;
    hot?: string | null;
    showDiff?: boolean;
    selection?: string[];
    onselect?: (refdes: string, additive: boolean) => void;
    onclear?: () => void;
    compact?: boolean;
  }

  let { sheet, overlays = {}, hot = null, showDiff = true, selection = [], onselect, onclear, compact = false }: Props = $props();

  let svg: SVGSVGElement | undefined = $state();
  let vb = $state({ x: 0, y: 0, w: 1000, h: 1000 });
  let fittedFor = '';
  let zoomPct = $state(100);

  function fit() {
    if (!sheet) return;
    const b = sheet.bbox;
    vb = { x: b.x, y: b.y, w: Math.max(b.w, 2000), h: Math.max(b.h, 1400) };
    if (b.w < 2000) vb.x = b.x - (2000 - b.w) / 2;
    if (b.h < 1400) vb.y = b.y - (1400 - b.h) / 2;
    updateZoom();
  }

  /** Follow the design as it grows until the user pans or zooms; switching sheets always refits. */
  let userMoved = false;
  let lastSheet = '';
  $effect(() => {
    const key = sheet ? `${sheet.id}:${sheet.bbox.x},${sheet.bbox.y},${sheet.bbox.w},${sheet.bbox.h}` : '';
    if (sheet && sheet.id !== lastSheet) {
      lastSheet = sheet.id;
      userMoved = false;
    }
    if (key !== fittedFor && !userMoved) {
      fittedFor = key;
      fit();
    }
  });

  function updateZoom() {
    if (!svg || !sheet) return;
    const r = svg.getBoundingClientRect();
    const scale = Math.min(r.width / vb.w, r.height / vb.h);
    zoomPct = Math.round(scale * 1000); // 100% = 1 px per mil × 10
  }

  function toSvg(e: { clientX: number; clientY: number }) {
    const m = svg!.getScreenCTM()!.inverse();
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m);
    return { x: p.x, y: p.y };
  }

  function onwheel(e: WheelEvent) {
    e.preventDefault();
    const p = toSvg(e);
    const f = Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 60) * 0.004);
    const w = Math.min(Math.max(vb.w * f, 300), 200000);
    const k = w / vb.w;
    vb = { x: p.x - (p.x - vb.x) * k, y: p.y - (p.y - vb.y) * k, w, h: vb.h * k };
    userMoved = true;
    updateZoom();
  }

  let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
  function onpointerdown(e: PointerEvent) {
    if (e.button !== 0 && e.button !== 1) return;
    drag = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y, moved: false };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }
  function onpointermove(e: PointerEvent) {
    if (!drag || !svg) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = userMoved = true;
    const r = svg.getBoundingClientRect();
    const s = Math.max(vb.w / r.width, vb.h / r.height);
    vb = { ...vb, x: drag.vx - dx * s, y: drag.vy - dy * s };
  }
  function onpointerup(e: PointerEvent) {
    if (drag && !drag.moved) {
      const target = (e.target as Element).closest('[data-ref]');
      if (target) onselect?.(target.getAttribute('data-ref')!, e.shiftKey || e.metaKey || e.ctrlKey);
      else onclear?.();
    }
    drag = null;
  }

  const pad = 70;
  /** Highlight frame: rotated symbols get a frame that follows their body. */
  const box = (s: SymbolView) =>
    s.rotation && s.origin
      ? { x: s.origin.x - 150, y: s.origin.y - 250, w: 300, h: 500, transform: `rotate(${s.rotation} ${s.origin.x} ${s.origin.y})` }
      : { x: s.bbox.x - pad, y: s.bbox.y - pad, w: s.bbox.w + 2 * pad, h: s.bbox.h + 2 * pad, transform: undefined };

  function flag(l: LabelView): string {
    const w = l.text.length * 50 + 70;
    const s = l.dir === 'left' ? -1 : 1;
    const x0 = l.x;
    const y = l.y;
    return [x0, y, x0 + s * 40, y - 45, x0 + s * (40 + w), y - 45, x0 + s * (40 + w), y + 45, x0 + s * 40, y + 45].join(',');
  }
</script>

<svg
  bind:this={svg}
  class="sch"
  class:compact
  viewBox="{vb.x} {vb.y} {vb.w} {vb.h}"
  data-bbox={sheet ? `${sheet.bbox.x},${sheet.bbox.y},${sheet.bbox.w},${sheet.bbox.h}` : undefined}
  preserveAspectRatio="xMidYMid meet"
  role="application"
  aria-label="Schematic"
  {onwheel}
  {onpointerdown}
  {onpointermove}
  {onpointerup}
>
  {#if sheet}
    <!-- wires -->
    {#each sheet.wires as w, i (i)}
      <polyline class="wire" points={w.pts.join(',')} />
    {/each}
    {#each sheet.junctions as j, i (i)}
      <circle class="junction" cx={j.x} cy={j.y} r="24" />
    {/each}

    <!-- labels -->
    {#each sheet.labels as l, i (i)}
      {#if l.kind === 'ground'}
        {@const gx = l.dir === 'left' ? l.x - 100 : l.dir === 'right' ? l.x + 100 : l.x}
        {@const up = l.dir === 'up' ? -1 : 1}
        <g class="pwr">
          {#if gx !== l.x}<line x1={l.x} y1={l.y} x2={gx} y2={l.y} />{/if}
          <line x1={gx} y1={l.y} x2={gx} y2={l.y + up * 80} />
          <line x1={gx - 70} y1={l.y + up * 80} x2={gx + 70} y2={l.y + up * 80} />
          <line x1={gx - 45} y1={l.y + up * 115} x2={gx + 45} y2={l.y + up * 115} />
          <line x1={gx - 20} y1={l.y + up * 150} x2={gx + 20} y2={l.y + up * 150} />
        </g>
      {:else if l.kind === 'rail'}
        <g class="pwr">
          {#if l.dir === 'up' || l.dir === 'down'}
            {@const s = l.dir === 'up' ? -1 : 1}
            <line x1={l.x} y1={l.y} x2={l.x} y2={l.y + s * 100} />
            <line x1={l.x - 70} y1={l.y + s * 100} x2={l.x + 70} y2={l.y + s * 100} />
            <text class="rail-t" x={l.x} y={l.dir === 'up' ? l.y - 135 : l.y + 195} text-anchor="middle">{l.text}</text>
          {:else}
            {@const s = l.dir === 'left' ? -1 : 1}
            <line x1={l.x} y1={l.y} x2={l.x + s * 100} y2={l.y} />
            <line x1={l.x + s * 100} y1={l.y - 60} x2={l.x + s * 100} y2={l.y + 60} />
            <text class="rail-t" x={l.x + s * 135} y={l.y + 27} text-anchor={s < 0 ? 'end' : 'start'}>{l.text}</text>
          {/if}
        </g>
      {:else if l.dir === 'on'}
        <text class="net-t" x={l.x} y={l.y - 30} text-anchor="middle">{l.text}</text>
      {:else if l.dir === 'left' || l.dir === 'right'}
        <polygon class="flag" points={flag(l)} />
        <text class="net-t" x={l.dir === 'left' ? l.x - 60 : l.x + 60} y={l.y + 25} text-anchor={l.dir === 'left' ? 'end' : 'start'}>{l.text}</text>
      {:else}
        {@const s = l.dir === 'up' ? -1 : 1}
        <line class="wire" x1={l.x} y1={l.y} x2={l.x} y2={l.y + s * 70} />
        <text class="net-t" x={l.x} y={l.dir === 'up' ? l.y - 95 : l.y + 150} text-anchor="middle">{l.text}</text>
      {/if}
    {/each}

    {#each sheet.noConnects as p, i (i)}
      <g class="nc"><line x1={p.x - 40} y1={p.y - 40} x2={p.x + 40} y2={p.y + 40} /><line x1={p.x - 40} y1={p.y + 40} x2={p.x + 40} y2={p.y - 40} /></g>
    {/each}

    <!-- symbols -->
    {#each sheet.symbols as s (s.componentId)}
      <g class="sym" data-ref={s.refdes}>
        <rect class="hit" x={s.bbox.x} y={s.bbox.y} width={s.bbox.w} height={s.bbox.h} />
        <g transform={s.rotation && s.origin ? `rotate(${s.rotation} ${s.origin.x} ${s.origin.y})` : undefined}>
        {#each s.prims as p, i (i)}
          {@const q = p as Prim}
          {#if q.t === 'rect'}
            <rect class:filled={q.fill} x={q.x} y={q.y} width={q.w} height={q.h} />
          {:else if q.t === 'line'}
            <line x1={q.x1} y1={q.y1} x2={q.x2} y2={q.y2} />
          {:else if q.t === 'poly'}
            {#if q.closed}<polygon class:filled={q.fill} points={q.pts.join(',')} />{:else}<polyline points={q.pts.join(',')} />{/if}
          {:else if q.t === 'path'}
            <path d={q.d} />
          {:else if q.t === 'circle'}
            <circle class:filled={q.fill} cx={q.x} cy={q.y} r={q.r} />
          {/if}
        {/each}
        </g>
        {#each s.pins as p (p.number)}
          {#if p.showName}
            {#if p.side === 'left'}<text class="pin-n" x={p.x + 230} y={p.y + 25}>{p.name}</text>
            {:else if p.side === 'right'}<text class="pin-n" x={p.x - 230} y={p.y + 25} text-anchor="end">{p.name}</text>
            {:else if p.side === 'top'}<text class="pin-n" x={p.x} y={p.y + 300} text-anchor="middle">{p.name}</text>
            {:else}<text class="pin-n" x={p.x} y={p.y - 250} text-anchor="middle">{p.name}</text>{/if}
          {/if}
          {#if p.showNumber}
            {#if p.side === 'left'}<text class="pin-no" x={p.x + 100} y={p.y - 22} text-anchor="middle">{p.number}</text>
            {:else if p.side === 'right'}<text class="pin-no" x={p.x - 100} y={p.y - 22} text-anchor="middle">{p.number}</text>
            {:else if p.side === 'top'}<text class="pin-no" x={p.x + 22} y={p.y + 110}>{p.number}</text>
            {:else}<text class="pin-no" x={p.x + 22} y={p.y - 70}>{p.number}</text>{/if}
          {/if}
        {/each}
        <text class="ref" x={s.refPos.x} y={s.refPos.y} text-anchor={s.refPos.anchor}>{s.refdes}</text>
        <text class="val" x={s.valuePos.x} y={s.valuePos.y} text-anchor={s.valuePos.anchor}>
          {#each s.valueLines ?? [s.value] as line, li (li)}<tspan x={s.valuePos.x} dy={li === 0 ? 0 : 85}>{line}</tspan>{/each}
        </text>
      </g>
    {/each}

    <!-- overlays -->
    {#if showDiff}
      {#each sheet.symbols as s (s.componentId)}
        {#if overlays[s.componentId]}
          {@const b = box(s)}
          <rect class="ov {overlays[s.componentId]}" class:hot={hot === s.componentId} x={b.x} y={b.y} width={b.w} height={b.h} rx="40" transform={b.transform} />
        {/if}
      {/each}
    {/if}
    {#each sheet.symbols as s (s.componentId)}
      {#if selection.includes(s.refdes)}
        {@const b = box(s)}
        <rect class="selbox" x={b.x - 20} y={b.y - 20} width={b.w + 40} height={b.h + 40} rx="50" transform={b.transform} />
      {/if}
    {/each}
  {/if}
</svg>
{#if !compact}
  <div class="zoom mono">{zoomPct}% <button class="ib" onclick={() => { userMoved = false; fit(); }} title="Fit to view">⤢</button></div>
{/if}

<style>
  .sch { position: absolute; inset: 0; width: 100%; height: 100%; cursor: default; touch-action: none; user-select: none; }
  .sch.compact { position: static; height: 100%; }
  .wire { stroke: var(--wire); stroke-width: 14; fill: none; stroke-linecap: round; stroke-linejoin: round; }
  .junction { fill: var(--wire); }
  .sym :global(line), .sym :global(path), .sym :global(polyline) { stroke: var(--sym); stroke-width: 12; fill: none; stroke-linecap: round; stroke-linejoin: round; }
  .sym rect, .sym polygon, .sym circle { stroke: var(--sym); stroke-width: 12; fill: none; }
  .sym .filled { fill: var(--sym-fill); }
  .sym polygon.filled { fill: var(--sym); }
  .sym .hit { fill: transparent; stroke: none; cursor: pointer; }
  .sym:hover .hit { fill: var(--accent); fill-opacity: .05; }
  text { font-family: var(--mono); }
  .ref { fill: var(--sym); font-size: 88px; font-weight: 700; }
  .val { fill: var(--sch-txt); font-size: 80px; }
  .pin-n { fill: var(--sch-txt); font-size: 70px; }
  .pin-no { fill: var(--pin-txt); font-size: 52px; }
  .pwr line { stroke: var(--wire); stroke-width: 14; stroke-linecap: round; }
  .rail-t { fill: var(--wire); font-size: 78px; font-weight: 700; }
  .net-t { fill: var(--wire); font-size: 72px; font-weight: 600; }
  .flag { fill: var(--canvas); stroke: var(--wire); stroke-width: 10; }
  .nc line { stroke: var(--err); stroke-width: 12; }
  .ov { stroke-width: 14; stroke-dasharray: 60 36; transition: fill-opacity .15s, stroke-width .15s; pointer-events: none; }
  .ov.add { fill: var(--ok); fill-opacity: .08; stroke: var(--ok); }
  .ov.change { fill: var(--warn); fill-opacity: .1; stroke: var(--warn); }
  .ov.hot { fill-opacity: .25; stroke-width: 26; }
  .selbox { fill: var(--accent); fill-opacity: .06; stroke: var(--accent); stroke-width: 16; stroke-dasharray: 50 30; pointer-events: none; }
  .zoom { position: absolute; right: 8px; bottom: 26px; font-size: 11px; color: var(--txt-3); display: flex; align-items: center; gap: 2px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 0 2px 0 8px; z-index: 2; }
</style>
