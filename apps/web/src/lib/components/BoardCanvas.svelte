<script lang="ts">
  import type { BoardView, CopperLayer } from '@tracewise/schema';

  /** 2D board view (mm, top view): outline, pads, tracks, vias, silkscreen, ratsnest. */
  interface Props {
    board: BoardView | null;
    show: Record<string, boolean>;
    selection?: string[];
    hotNet?: string | null;
    marker?: { x: number; y: number } | null;
    onselect?: (refdes: string, additive: boolean) => void;
    onclear?: () => void;
    onhovernet?: (netId: string | null) => void;
    /** Drag or rotate a part: pin it there (the place op). */
    onplace?: (refdes: string, x: number, y: number, rot: number) => void;
  }
  let { board, show, selection = [], hotNet = null, marker = null, onselect, onclear, onhovernet, onplace }: Props = $props();

  /** Part being dragged: offset in mm, snapped to 0.1 mm. */
  let partDrag = $state<{ ref: string; sx: number; sy: number; dx: number; dy: number; moved: boolean } | null>(null);
  const snap = (v: number) => Math.round(v * 10) / 10;

  let svg: SVGSVGElement | undefined = $state();
  let vb = $state({ x: -2, y: -2, w: 40, h: 30 });
  let fittedFor = '';
  let userMoved = false;

  $effect(() => {
    if (!board) return;
    const key = `${board.outline.w}x${board.outline.h}`;
    if (key !== fittedFor && !userMoved) {
      fittedFor = key;
      const m = Math.max(board.outline.w, board.outline.h) * 0.08 + 2;
      vb = { x: -m, y: -m, w: board.outline.w + 2 * m, h: board.outline.h + 2 * m };
    }
  });

  function toSvg(e: { clientX: number; clientY: number }) {
    const m = svg!.getScreenCTM()!.inverse();
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m);
    return { x: p.x, y: p.y };
  }
  function onwheel(e: WheelEvent) {
    e.preventDefault();
    const p = toSvg(e);
    const f = Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 60) * 0.004);
    const w = Math.min(Math.max(vb.w * f, 2), 2000);
    const k = w / vb.w;
    vb = { x: p.x - (p.x - vb.x) * k, y: p.y - (p.y - vb.y) * k, w, h: vb.h * k };
    userMoved = true;
  }
  let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
  function onpointerdown(e: PointerEvent) {
    if (e.button !== 0 && e.button !== 1) return;
    const ref = e.button === 0 && onplace ? (e.target as Element).closest('[data-ref]')?.getAttribute('data-ref') : null;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (ref) {
      const p = toSvg(e);
      partDrag = { ref, sx: p.x, sy: p.y, dx: 0, dy: 0, moved: false };
      return;
    }
    drag = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y, moved: false };
  }
  function onpointermove(e: PointerEvent) {
    if (partDrag) {
      const p = toSvg(e);
      const dx = snap(p.x - partDrag.sx);
      const dy = snap(p.y - partDrag.sy);
      if (Math.abs(dx) + Math.abs(dy) >= 0.2) partDrag.moved = true;
      partDrag.dx = dx;
      partDrag.dy = dy;
      return;
    }
    if (!drag || !svg) {
      const net = (e.target as Element).closest('[data-net]')?.getAttribute('data-net') ?? null;
      onhovernet?.(net);
      return;
    }
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = userMoved = true;
    const r = svg.getBoundingClientRect();
    const s = Math.max(vb.w / r.width, vb.h / r.height);
    vb = { ...vb, x: drag.vx - dx * s, y: drag.vy - dy * s };
  }
  function onpointerup(e: PointerEvent) {
    if (partDrag) {
      const d = partDrag;
      partDrag = null;
      const part = board?.parts.find((p) => p.refdes === d.ref);
      if (d.moved && part) onplace?.(d.ref, Math.round((part.x + d.dx) * 1000) / 1000, Math.round((part.y + d.dy) * 1000) / 1000, part.rot);
      else onselect?.(d.ref, e.shiftKey || e.metaKey || e.ctrlKey);
      return;
    }
    if (drag && !drag.moved) {
      const target = (e.target as Element).closest('[data-ref]');
      if (target) onselect?.(target.getAttribute('data-ref')!, e.shiftKey || e.metaKey || e.ctrlKey);
      else onclear?.();
    }
    drag = null;
  }

  function onkeydown(e: KeyboardEvent) {
    if ((e.key === 'r' || e.key === 'R') && selection.length === 1 && onplace) {
      const part = board?.parts.find((p) => p.refdes === selection[0]);
      if (!part) return;
      e.preventDefault();
      onplace(part.refdes, part.x, part.y, (part.rot + 90) % 360);
    }
  }

  const LAYER_CLASS: Record<CopperLayer, string> = { 'F.Cu': 'fcu', 'In1.Cu': 'in1', 'In2.Cu': 'in2', 'B.Cu': 'bcu' };
  /** Draw bottom first so the top layer is on top. */
  const order: CopperLayer[] = ['B.Cu', 'In2.Cu', 'In1.Cu', 'F.Cu'];
  const tracksOn = (l: CopperLayer) => board?.tracks.filter((t) => t.layer === l) ?? [];
  const zonePath = (r: number[]) => {
    let d = '';
    for (let i = 0; i + 3 < r.length; i += 4) d += `M${r[i]},${r[i + 1]}h${r[i + 2]}v${r[i + 3]}h${-r[i + 2]!}z`;
    return d;
  };
  const path = (pts: number[]) => pts.reduce((s, v, i) => s + (i % 2 ? `,${v}` : `${i ? ' L' : 'M'}${v}`), '');
</script>

<!-- an interactive canvas: pointer and keyboard (R = rotate) are the point -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<svg
  bind:this={svg}
  class="board"
  viewBox="{vb.x} {vb.y} {vb.w} {vb.h}"
  preserveAspectRatio="xMidYMid meet"
  role="application"
  aria-label="Board layout"
  {onwheel}
  {onpointerdown}
  {onpointermove}
  {onpointerup}
  onpointerleave={() => onhovernet?.(null)}
  {onkeydown}
  tabindex="0"
>
  {#if board}
    <rect class="substrate" x="0" y="0" width={board.outline.w} height={board.outline.h} rx="0.5" />

    {#each order as layer (layer)}
      {#if show[layer]}
        <g class="layer {LAYER_CLASS[layer]}" class:dim={layer !== 'F.Cu' && show['F.Cu']}>
          {#each board.zones.filter((z) => z.layer === layer) as z, zi (zi)}
            {#if z.shape}
              {@const id = `zm-${layer}-${zi}`}
              {@const o = z.shape.outline}
              <mask {id} maskUnits="userSpaceOnUse" x={o[0] - 1} y={o[1] - 1} width={o[2] - o[0] + 2} height={o[3] - o[1] + 2}>
                <rect x={o[0]} y={o[1]} width={o[2] - o[0]} height={o[3] - o[1]} fill="white" />
                {#each z.shape.cuts as c, ci (ci)}
                  {#if c.k === 'circle'}<circle cx={c.x} cy={c.y} r={c.d / 2} fill="black" />
                  {:else if c.k === 'rect'}<rect x={c.x} y={c.y} width={c.w} height={c.h} fill="black" />
                  {:else}<path d={path(c.pts)} stroke="black" stroke-width={c.w} fill="none" stroke-linecap="round" stroke-linejoin="round" />{/if}
                {/each}
                {#each z.shape.adds as a, ai (ai)}<path d={path(a.pts)} stroke="white" stroke-width={a.w} fill="none" />{/each}
              </mask>
              <rect class="zone" class:hot={hotNet === z.netId} x={o[0]} y={o[1]} width={o[2] - o[0]} height={o[3] - o[1]} mask="url(#{id})" data-net={z.netId} />
            {:else}
              <path class="zone" class:hot={hotNet === z.netId} d={zonePath(z.rects)} data-net={z.netId} />
            {/if}
          {/each}
          {#each tracksOn(layer) as t, i (i)}
            <path d={path(t.pts)} stroke-width={t.width} data-net={t.netId} class:hot={hotNet === t.netId} />
          {/each}
        </g>
      {/if}
    {/each}

    {#if show.courtyard}
      {#each board.parts as p (p.componentId)}
        <rect class="court" x={p.courtyard.x} y={p.courtyard.y} width={p.courtyard.w} height={p.courtyard.h} />
      {/each}
    {/if}

    <!-- pads (top copper + through-hole) -->
    {#each board.parts as p (p.componentId)}
      <g
        class="part"
        class:sel={selection.includes(p.refdes)}
        class:locked={p.locked}
        class:dragging={partDrag?.ref === p.refdes}
        data-ref={p.refdes}
        transform={partDrag?.ref === p.refdes ? `translate(${partDrag.dx} ${partDrag.dy})` : undefined}
      >
        <rect class="hit" x={p.courtyard.x} y={p.courtyard.y} width={p.courtyard.w} height={p.courtyard.h} />
        {#each p.pads as pad, i (i)}
          {@const r = pad.shape === 'round' ? Math.min(pad.w, pad.h) / 2 : Math.min(pad.w, pad.h) * 0.15}
          <rect
            class="pad"
            class:tht={!!pad.drill}
            class:hot={!!pad.netId && hotNet === pad.netId}
            x={pad.x - pad.w / 2}
            y={pad.y - pad.h / 2}
            width={pad.w}
            height={pad.h}
            rx={r}
            data-net={pad.netId}
          />
          {#if pad.drill}<circle class="drill" cx={pad.x} cy={pad.y} r={pad.drill / 2} />{/if}
        {/each}
        {#if show.silk}
          <rect class="silk" x={p.body.x} y={p.body.y} width={p.body.w} height={p.body.h} />
          <circle class="silkdot" cx={p.pin1.x} cy={p.pin1.y} r="0.18" />
          {#if p.locked}<circle class="pin" cx={p.courtyard.x + p.courtyard.w} cy={p.courtyard.y} r="0.3"><title>pinned</title></circle>{/if}
          <text class="ref" x={p.x} y={p.y} font-size={Math.max(0.5, Math.min(1.2, Math.min(p.body.w, p.body.h) * 0.45))}>{p.refdes}</text>
        {/if}
      </g>
    {/each}

    {#each board.vias as v, i (i)}
      <g class="via" data-net={v.netId} class:hot={hotNet === v.netId}>
        <circle cx={v.x} cy={v.y} r={v.pad / 2} />
        <circle class="drill" cx={v.x} cy={v.y} r={v.drill / 2} />
      </g>
    {/each}

    {#if show.ratsnest}
      {#each board.ratsnest as l, i (i)}
        <line class="rats" class:hot={hotNet === l.netId} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />
      {/each}
    {/if}

    <rect class="edge" x="0" y="0" width={board.outline.w} height={board.outline.h} rx="0.5" />
    {#if marker}<circle class="marker" cx={marker.x} cy={marker.y} r="1.2" />{/if}
  {/if}
</svg>

<style>
  .board { width: 100%; height: 100%; display: block; background: var(--canvas); cursor: default; touch-action: none; }
  .substrate { fill: #0f2a22; }
  .edge { fill: none; stroke: #e0c341; stroke-width: 0.15; }
  .layer path { fill: none; stroke-linecap: round; stroke-linejoin: round; }
  .layer .zone { stroke: none; opacity: 0.16; }
  .fcu .zone { fill: #c9463d; }
  .bcu .zone { fill: #3f7fd6; }
  .in1 .zone { fill: #c9a13d; }
  .in2 .zone { fill: #8e5cd6; }
  .layer .zone.hot { fill: #fff27a; opacity: 0.35; }
  .fcu path { stroke: #c9463d; }
  .bcu path { stroke: #3f7fd6; }
  .in1 path { stroke: #c9a13d; }
  .in2 path { stroke: #8e5cd6; }
  .layer.dim path { opacity: 0.7; }
  .layer path.hot { stroke: #fff27a; }
  .pad { fill: #c98a3c; }
  .pad.tht { fill: #d8a24a; }
  .pad.hot { fill: #fff27a; }
  .drill { fill: #0b0f14; }
  .via circle { fill: #b9bec7; }
  .via .drill { fill: #0b0f14; }
  .via.hot circle:first-child { fill: #fff27a; }
  .silk { fill: none; stroke: #e9ecef; stroke-width: 0.12; opacity: 0.85; }
  .silkdot { fill: #e9ecef; }
  .ref { fill: #e9ecef; text-anchor: middle; dominant-baseline: central; font-family: var(--mono); pointer-events: none; opacity: 0.9; }
  .court { fill: none; stroke: #d65db1; stroke-width: 0.05; stroke-dasharray: 0.3 0.2; opacity: 0.6; }
  .rats { stroke: #e9ecef; stroke-width: 0.06; opacity: 0.55; }
  .rats.hot { stroke: #fff27a; opacity: 1; stroke-width: 0.1; }
  .hit { fill: transparent; }
  .part:hover .silk { stroke: #9fd2ff; opacity: 1; }
  .part.sel .silk { stroke: #6fb5ff; stroke-width: 0.2; opacity: 1; }
  .part.sel .hit { fill: rgba(111, 181, 255, 0.12); }
  .marker { fill: none; stroke: #ff5a5a; stroke-width: 0.25; }
  .board:focus { outline: none; }
  .part { cursor: grab; }
  .part.dragging { cursor: grabbing; opacity: 0.85; }
  .part.dragging .hit { fill: rgba(111, 181, 255, 0.18); }
  .pin { fill: #e0a93b; stroke: #0b0f14; stroke-width: 0.08; }
</style>
