<script lang="ts">
  import { PAGE, type LabelView, type Prim, type SheetView, type SymbolView } from '@tracewise/schema';

  interface Props {
    sheet: SheetView | undefined;
    /** For the title block of each page. */
    designName?: string;
    /** Pages in the whole design (the "of N" in the title block); defaults to this sheet's count. */
    pageCount?: number;
    /** componentId → overlay kind for pending changes */
    overlays?: Record<string, 'add' | 'change'>;
    hot?: string | null;
    showDiff?: boolean;
    selection?: string[];
    /** The selected net (id): its wires and labels are highlighted. */
    selectedNet?: string | null;
    onselect?: (refdes: string, additive: boolean) => void;
    /** A click on a wire or a net label. */
    onselectnet?: (netId: string) => void;
    onclear?: () => void;
    compact?: boolean;
  }

  let { sheet, designName, pageCount, overlays = {}, hot = null, showDiff = true, selection = [], selectedNet = null, onselect, onselectnet, onclear, compact = false }: Props = $props();

  /** Length of a supply symbol's stem, in mils (keep in sync with labelRect in the kernel). */
  const RAIL_STEM = 200;

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

  /** `ref`: the part under the pointer when the press began (once captured, events target the canvas itself). */
  let drag: { x: number; y: number; vx: number; vy: number; moved: boolean; ref: string | null; net: string | null } | null = null;
  function onpointerdown(e: PointerEvent) {
    if (e.button !== 0 && e.button !== 1) return;
    const ref = (e.target as Element).closest('[data-ref]')?.getAttribute('data-ref') ?? null;
    const net = (e.target as Element).closest('[data-net]')?.getAttribute('data-net') ?? null;
    drag = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y, moved: false, ref, net };
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
      if (drag.ref) onselect?.(drag.ref, e.shiftKey || e.metaKey || e.ctrlKey);
      else if (drag.net && onselectnet) onselectnet(drag.net);
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

  /**
   * Tag outline as [along, across] pairs, `along` counted from the wire. A signal into the part
   * (the default) gives a tag pointing at the pin, one out of the part points away from it and a
   * bidirectional one points both ways.
   */
  function outline(l: LabelView, len: number, h: number): [number, number][] {
    const t = 40;
    if (l.flow === 'out') return [[0, -h], [len - t, -h], [len, 0], [len - t, h], [0, h]];
    if (l.flow === 'io') return [[0, 0], [t, -h], [len - t, -h], [len, 0], [len - t, h], [t, h]];
    return [[0, 0], [t, -h], [len, -h], [len, h], [t, h]];
  }
  /** Outline of a signal tag, drawn along the lead: sideways for left/right, and for up/down the same tag turned by 90°. */
  function flag(l: LabelView): string {
    const len = l.text.length * 50 + 110;
    const pts = outline(l, len, 45);
    if (l.dir === 'up' || l.dir === 'down') {
      const s = l.dir === 'up' ? -1 : 1;
      return pts.map(([a, b]) => `${l.x + b},${l.y + s * a}`).join(' ');
    }
    const s = l.dir === 'left' ? -1 : 1;
    return pts.map(([a, b]) => `${l.x + s * a},${l.y + b}`).join(' ');
  }
  /** The name inside the tag, from `gap` mils off the pin. Vertical tags read bottom to top. */
  function nameAt(l: LabelView): { transform: string; anchor: 'start' | 'end' } {
    const gap = l.flow === 'out' ? 30 : 60;
    if (l.dir === 'up') return { transform: `translate(${l.x} ${l.y - gap}) rotate(-90)`, anchor: 'start' };
    if (l.dir === 'down') return { transform: `translate(${l.x} ${l.y + gap}) rotate(-90)`, anchor: 'end' };
    const s = l.dir === 'left' ? -1 : 1;
    return { transform: `translate(${l.x + s * gap} ${l.y})`, anchor: l.dir === 'left' ? 'end' : 'start' };
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
    <!-- pages: the paper, its frame and a title block (what is on the page, sheet, page n of N) -->
    {#each sheet.pages as p (p.number)}
      {@const m = PAGE.margin}
      {@const ty = p.rect.y + p.rect.h - m - PAGE.title}
      <g class="page">
        <rect class="paper" x={p.rect.x} y={p.rect.y} width={p.rect.w} height={p.rect.h} />
        <rect class="frame" x={p.rect.x + m} y={p.rect.y + m} width={p.rect.w - 2 * m} height={p.rect.h - 2 * m} />
        <line class="frame" x1={p.rect.x + m} y1={ty} x2={p.rect.x + p.rect.w - m} y2={ty} />
        <text class="title" x={p.rect.x + m + 150} y={ty + 320}>{p.name}</text>
        <text class="title-s" x={p.rect.x + p.rect.w - m - 150} y={ty + 320} text-anchor="end">{[designName, sheet.name, `page ${p.number} of ${pageCount ?? sheet.pages.length}`, p.oversized ? 'larger than A4, prints scaled' : ''].filter(Boolean).join(' · ')}</text>
      </g>
    {/each}

    <!-- wires -->
    {#each sheet.wires as w, i (i)}
      <!-- (a wide invisible stroke makes the thin wire easy to click) -->
      <g class="net" class:hl={w.netId === selectedNet} data-net={w.netId}>
        {#if onselectnet}<polyline class="wire-hit" points={w.pts.join(',')} />{/if}
        <polyline class="wire" points={w.pts.join(',')} />
      </g>
    {/each}
    {#each sheet.junctions as j, i (i)}
      <circle class="junction" cx={j.x} cy={j.y} r="24" />
    {/each}

    <!-- labels -->
    {#each sheet.labels as l, i (i)}
      <g class="net" class:hl={l.netId === selectedNet} data-net={l.netId}>
      {#if l.kind === 'ground' || l.kind === 'rail'}
        <!-- supplies are always vertical; on a horizontal lead a stub comes first -->
        {@const sx = l.x + (l.stub === 'left' ? -1 : l.stub === 'right' ? 1 : 0) * (l.stubLen ?? 100)}
        {@const s = l.dir === 'up' ? -1 : 1}
        <!-- (rise: a longer stem, clearing symbols of neighbouring pins that point the other way) -->
        {@const r = l.rise ?? 0}
        {@const stem = RAIL_STEM + r}
        <g class="pwr">
          {#if sx !== l.x}<line x1={l.x} y1={l.y} x2={sx} y2={l.y} />{/if}
          {#if l.kind === 'ground'}
            <line x1={sx} y1={l.y} x2={sx} y2={l.y + s * (r + 80)} />
            <line x1={sx - 70} y1={l.y + s * (r + 80)} x2={sx + 70} y2={l.y + s * (r + 80)} />
            <line x1={sx - 45} y1={l.y + s * (r + 115)} x2={sx + 45} y2={l.y + s * (r + 115)} />
            <line x1={sx - 20} y1={l.y + s * (r + 150)} x2={sx + 20} y2={l.y + s * (r + 150)} />
          {:else}
            <!-- supply rail: a long stem ending in an arrow pointing away from the circuit -->
            <line x1={sx} y1={l.y} x2={sx} y2={l.y + s * stem} />
            <polygon class="arrow" points="{sx},{l.y + s * (stem + 70)} {sx - 45},{l.y + s * stem} {sx + 45},{l.y + s * stem}" />
            <text class="rail-t" x={sx} y={s < 0 ? l.y - stem - 100 : l.y + stem + 160} text-anchor="middle">{l.text}</text>
          {/if}
        </g>
      {:else if l.dir === 'on'}
        <text class="net-t" x={l.x} y={l.y - 30} text-anchor="middle">{l.text}</text>
      {:else}
        {@const n = nameAt(l)}
        <polygon class="flag" points={flag(l)} />
        <text class="net-t" transform={n.transform} y="25" text-anchor={n.anchor}>{l.text}</text>
      {/if}
      </g>
    {/each}

    {#each sheet.noConnects as p, i (i)}
      <g class="nc"><line x1={p.x - 40} y1={p.y - 40} x2={p.x + 40} y2={p.y + 40} /><line x1={p.x - 40} y1={p.y + 40} x2={p.x + 40} y2={p.y - 40} /></g>
    {/each}

    <!-- symbols -->
    {#each sheet.symbols as s (s.componentId + (s.unit ?? ""))}
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
        <text class="ref" x={s.refPos.x} y={s.refPos.y} text-anchor={s.refPos.anchor}>{s.refdes}{s.unit ?? ''}</text>
        <text class="val" x={s.valuePos.x} y={s.valuePos.y} text-anchor={s.valuePos.anchor}>
          {#each s.valueLines ?? [s.value] as line, li (li)}<tspan x={s.valuePos.x} dy={li === 0 ? 0 : 85}>{line}</tspan>{/each}
        </text>
      </g>
    {/each}

    <!-- overlays -->
    {#if showDiff}
      {#each sheet.symbols as s (s.componentId + (s.unit ?? ""))}
        {#if overlays[s.componentId]}
          {@const b = box(s)}
          <rect class="ov {overlays[s.componentId]}" class:hot={hot === s.componentId} x={b.x} y={b.y} width={b.w} height={b.h} rx="40" transform={b.transform} />
        {/if}
      {/each}
    {/if}
    {#each sheet.symbols as s (s.componentId + (s.unit ?? ""))}
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
  .page .paper { fill: var(--paper); stroke: var(--grid); stroke-width: 12; }
  .page .frame { fill: none; stroke: var(--grid); stroke-width: 10; }
  .page .title { fill: var(--sch-txt); font-size: 220px; font-weight: 700; }
  .page .title-s { fill: var(--pin-txt); font-size: 170px; }
  .wire { stroke: var(--wire); stroke-width: 14; fill: none; stroke-linecap: round; stroke-linejoin: round; }
  .wire-hit { stroke: transparent; stroke-width: 70; fill: none; pointer-events: stroke; cursor: pointer; }
  .net:hover .wire { stroke-width: 20; }
  /* the selected net: wires, supply symbols and labels in the accent colour */
  .net.hl .wire, .net.hl line { stroke: var(--accent); stroke-width: 22; }
  .net.hl .arrow { fill: var(--accent); stroke: var(--accent); }
  .net.hl .flag { stroke: var(--accent); }
  .net.hl text { fill: var(--accent); }
  .junction { fill: var(--wire); }
  .sym :global(line), .sym :global(path), .sym :global(polyline) { stroke: var(--sym); stroke-width: 12; fill: none; stroke-linecap: round; stroke-linejoin: round; }
  .sym rect, .sym polygon, .sym circle { stroke: var(--sym); stroke-width: 12; fill: none; }
  .sym .filled { fill: var(--sym-fill); }
  .sym polygon.filled { fill: var(--sym); }
  .sym .hit { fill: transparent; stroke: none; cursor: pointer; }
  /* hover highlights the part itself: brighter, slightly bolder, a soft glow */
  .sym:hover { filter: drop-shadow(0 0 20px var(--sym-glow)); }
  .sym:hover :global(line), .sym:hover :global(path), .sym:hover :global(polyline),
  .sym:hover rect:not(.hit), .sym:hover polygon, .sym:hover circle { stroke: var(--sym-hover); stroke-width: 16; }
  .sym:hover .filled { fill: var(--sym-fill-hover); }
  .sym:hover polygon.filled { fill: var(--sym-hover); }
  .sym:hover .ref, .sym:hover .val { fill: var(--sym-hover); }
  text { font-family: var(--mono); }
  .ref { fill: var(--sym); font-size: 88px; font-weight: 700; }
  .val { fill: var(--sch-txt); font-size: 80px; }
  .pin-n { fill: var(--sch-txt); font-size: 70px; }
  .pin-no { fill: var(--pin-txt); font-size: 52px; }
  .pwr line { stroke: var(--wire); stroke-width: 14; stroke-linecap: round; }
  .pwr .arrow { fill: var(--wire); stroke: var(--wire); stroke-width: 8; stroke-linejoin: round; }
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
