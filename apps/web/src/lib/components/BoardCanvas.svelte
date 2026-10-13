<script lang="ts">
  import { boardPolygon, cutoutPolygon, type BoardView, type CopperLayer } from '@4k7/schema';
  import { boardDimensions, dimPaths } from '../dimensions.ts';
  import type { TopView } from '../three-body.ts';

  /** 2D board view (mm, top view): outline, pads, tracks, vias, silkscreen, ratsnest, dimensions. */
  interface Props {
    board: BoardView | null;
    show: Record<string, boolean>;
    selection?: string[];
    hotNet?: string | null;
    marker?: { x: number; y: number } | null;
    onselect?: (refdes: string, additive: boolean) => void;
    onclear?: () => void;
    onhovernet?: (netId: string | null) => void;
    /** Drag or rotate a part: the user's choice for it (the place op). A drag keeps the rotation. */
    onplace?: (refdes: string, x: number, y: number, rot?: number) => void;
    /** L on a selected part: lock it where it is, or unlock it. */
    onlock?: (refdes: string) => void;
    /** F on a selected part: flip it to the other side of the board. */
    onflip?: (refdes: string) => void;
    /** A silkscreen graphic dragged by dx, dy (mm). */
    ongraphic?: (id: string, dx: number, dy: number) => void;
  }
  let { board, show, selection = [], hotNet = null, marker = null, onselect, onclear, onhovernet, onplace, onlock, onflip, ongraphic }: Props = $props();

  /* dragging a silkscreen graphic: like a part, it stays where it was dropped until the board shows it there */
  let gfxDrag = $state<{ id: string; sx: number; sy: number; dx: number; dy: number; moved: boolean } | null>(null);
  let gfxDropped = $state<{ id: string; x0: number; y0: number; dx: number; dy: number } | null>(null);
  const gfxStill = (id: string) => {
    const g = board?.graphics?.find((x) => x.id === id);
    return !!g && !!gfxDropped && Math.abs(g.bounds[0] - gfxDropped.x0) < 1e-6 && Math.abs(g.bounds[1] - gfxDropped.y0) < 1e-6;
  };
  $effect(() => {
    if (gfxDropped && !gfxStill(gfxDropped.id)) gfxDropped = null;
  });
  const gfxOffset = (id: string) => (gfxDrag?.id === id ? gfxDrag : gfxDropped?.id === id && gfxStill(id) ? gfxDropped : null);

  /** A closed polygon (flat x, y list) as SVG path data. */
  const polyPath = (pts: number[]) => pts.reduce((d, v, i) => (i % 2 ? `${d} ${v}` : `${d}${i ? ' L' : 'M'} ${v}`), '') + ' Z';
  /** The board outline (rounded corners) and its milled cutouts. */
  const outlinePath = $derived(board ? polyPath(boardPolygon(board.shape ? board : { ...board, cornerRadius: board.cornerRadius || 0.5 })) : '');
  const cutoutPaths = $derived(board ? board.cutouts.map((c) => polyPath(cutoutPolygon(c))) : []);
  /** The Dimensions layer: the board's size and its mounting holes' positions and diameters. */
  const dimensions = $derived(board ? boardDimensions(board) : null);

  /** Part being dragged: offset in mm, snapped to 0.1 mm. */
  let partDrag = $state<{ ref: string; sx: number; sy: number; dx: number; dy: number; moved: boolean } | null>(null);
  const snap = (v: number) => Math.round(v * 10) / 10;
  /**
   * A part just dropped: shown where it was dropped until a board arrives in which it has moved
   * (the edit and the placement take a moment, and boards computed before the edit may still
   * come in; without this it would flash back to its old place meanwhile). If it never moves
   * (the edit was refused), it goes back after a while.
   */
  let dropped = $state<{ ref: string; fromX: number; fromY: number; dx: number; dy: number } | null>(null);
  let droppedTimer: ReturnType<typeof setTimeout> | undefined;
  const stillAtOld = (ref: string) => {
    const p = board?.parts.find((x) => x.refdes === ref);
    return !!p && !!dropped && Math.abs(p.x - dropped.fromX) < 1e-6 && Math.abs(p.y - dropped.fromY) < 1e-6;
  };
  $effect(() => {
    // the part has moved in the board: the drop is done
    if (dropped && !stillAtOld(dropped.ref)) dropped = null;
  });
  const offset = (ref: string) => (partDrag?.ref === ref ? partDrag : dropped?.ref === ref && stillAtOld(ref) ? dropped : null);

  let svg: SVGSVGElement | undefined = $state();
  let vb = $state({ x: -2, y: -2, w: 40, h: 30 });
  let cw = $state(0);
  let ch = $state(0);
  /** One screen pixel in mm, so markers keep their size at any zoom. */
  const px = $derived(cw && ch ? 1 / Math.min(cw / vb.w, ch / vb.h) : vb.w / 800);
  /** How a part got where it is: the placer's, the user's choice, or locked. */
  const stateOf = (p: BoardView['parts'][number]) => (p.locked ? 'locked' : p.intent ? 'choice' : 'free');
  const centreOf = (ref: string) => board?.parts.find((x) => x.refdes === ref);
  let fittedFor = '';
  let userMoved = false;
  /**
   * Zooming or panning: pours are drawn from their cells instead of their exact (masked) shape
   * until the view rests. A mask is drawn again on every frame, which WebKit (Safari) makes slow.
   */
  let moving = $state(false);
  let movingTimer: ReturnType<typeof setTimeout> | undefined;
  function viewMoved() {
    moving = true;
    clearTimeout(movingTimer);
    movingTimer = setTimeout(() => (moving = false), 150);
  }

  $effect(() => {
    if (!board) return;
    const key = `${board.outline.w}x${board.outline.h}`;
    if (key !== fittedFor && !userMoved) {
      fittedFor = key;
      // room around the board for the dimensions (shown or not, so turning them on does not move the view)
      const m = Math.max(Math.max(board.outline.w, board.outline.h) * 0.08 + 2, (dimensions?.extent ?? 0) + 1);
      vb = { x: -m, y: -m, w: board.outline.w + 2 * m, h: board.outline.h + 2 * m };
    }
  });

  /** The area shown (for the 3D view to start from): centre and visible height, mm. */
  export function getView(): TopView {
    const r = svg?.getBoundingClientRect();
    const aspect = r && r.height > 0 ? r.width / r.height : vb.w / vb.h;
    // the view box is fitted into the element ("meet"): the visible height is the view box's, or more
    const visH = aspect > vb.w / vb.h ? vb.h : vb.w / aspect;
    return { cx: vb.x + vb.w / 2, cy: vb.y + vb.h / 2, visH };
  }
  /** Show this area (coming back from the 3D view). */
  export function setView(v: TopView) {
    const r = svg?.getBoundingClientRect();
    const aspect = r && r.height > 0 ? r.width / r.height : vb.w / vb.h;
    vb = { x: v.cx - (v.visH * aspect) / 2, y: v.cy - v.visH / 2, w: v.visH * aspect, h: v.visH };
    userMoved = true;
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
    const w = Math.min(Math.max(vb.w * f, 2), 2000);
    const k = w / vb.w;
    vb = { x: p.x - (p.x - vb.x) * k, y: p.y - (p.y - vb.y) * k, w, h: vb.h * k };
    userMoved = true;
    viewMoved();
  }
  /** Bottom-side parts are drawn first, so the top side lies over them. */
  const partsInOrder = $derived(board ? [...board.parts.filter((p) => p.side === 'bottom'), ...board.parts.filter((p) => p.side !== 'bottom')] : []);
  /**
   * The part under the pointer; of parts stacked on opposite sides the smallest (a cap under its
   * IC can be picked, the IC anywhere else).
   */
  function refAt(e: PointerEvent): string | null {
    const area = (ref: string) => {
      const c = board?.parts.find((p) => p.refdes === ref)?.courtyard;
      return c ? c.w * c.h : Infinity;
    };
    const refs = document.elementsFromPoint(e.clientX, e.clientY).flatMap((el) => (svg?.contains(el) ? [el.closest('[data-ref]')?.getAttribute('data-ref')] : [])).filter((r): r is string => !!r);
    if (!refs.length) return (e.target as Element).closest('[data-ref]')?.getAttribute('data-ref') ?? null;
    return refs.reduce((a, r) => (area(r) < area(a) ? r : a));
  }
  let drag: { x: number; y: number; vx: number; vy: number; moved: boolean; ref: string | null } | null = null;
  function onpointerdown(e: PointerEvent) {
    if (e.button !== 0 && e.button !== 1) return;
    const at = e.button === 0 ? refAt(e) : null;
    const ref = onplace ? at : null;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (ref) {
      const p = toSvg(e);
      partDrag = { ref, sx: p.x, sy: p.y, dx: 0, dy: 0, moved: false };
      return;
    }
    const gfx = e.button === 0 && ongraphic ? (e.target as Element).closest('[data-gfx]')?.getAttribute('data-gfx') : null;
    if (gfx) {
      const p = toSvg(e);
      gfxDrag = { id: gfx, sx: p.x, sy: p.y, dx: 0, dy: 0, moved: false };
      return;
    }
    drag = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y, moved: false, ref: at };
  }
  function onpointermove(e: PointerEvent) {
    if (gfxDrag) {
      const p = toSvg(e);
      gfxDrag.dx = snap(p.x - gfxDrag.sx);
      gfxDrag.dy = snap(p.y - gfxDrag.sy);
      if (Math.abs(gfxDrag.dx) + Math.abs(gfxDrag.dy) >= 0.2) gfxDrag.moved = true;
      return;
    }
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
    viewMoved();
  }
  function onpointerup(e: PointerEvent) {
    if (gfxDrag) {
      const d = gfxDrag;
      gfxDrag = null;
      const g = board?.graphics?.find((x) => x.id === d.id);
      if (d.moved && g) {
        gfxDropped = { id: d.id, x0: g.bounds[0], y0: g.bounds[1], dx: d.dx, dy: d.dy };
        setTimeout(() => gfxDropped?.id === d.id && (gfxDropped = null), 5000);
        ongraphic?.(d.id, d.dx, d.dy);
      }
      return;
    }
    if (partDrag) {
      const d = partDrag;
      partDrag = null;
      const part = board?.parts.find((p) => p.refdes === d.ref);
      if (d.moved && part && board) {
        dropped = { ref: d.ref, fromX: part.x, fromY: part.y, dx: d.dx, dy: d.dy };
        clearTimeout(droppedTimer);
        droppedTimer = setTimeout(() => (dropped = null), 5000);
        onplace?.(d.ref, Math.round((part.x + d.dx) * 1000) / 1000, Math.round((part.y + d.dy) * 1000) / 1000);
      }
      else onselect?.(d.ref, e.shiftKey || e.metaKey || e.ctrlKey);
      return;
    }
    if (drag && !drag.moved) {
      if (drag.ref) onselect?.(drag.ref, e.shiftKey || e.metaKey || e.ctrlKey);
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
    if ((e.key === 'f' || e.key === 'F') && selection.length === 1 && onflip && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      onflip(selection[0]!);
    }
    if ((e.key === 'l' || e.key === 'L') && selection.length === 1 && onlock) {
      e.preventDefault();
      onlock(selection[0]!);
    }
  }

  const LAYER_CLASS: Record<CopperLayer, string> = { 'F.Cu': 'fcu', 'In1.Cu': 'in1', 'In2.Cu': 'in2', 'B.Cu': 'bcu' };
  /** Draw bottom first so the top layer is on top. */
  const order: CopperLayer[] = ['B.Cu', 'In2.Cu', 'In1.Cu', 'F.Cu'];
  const anyCopper = $derived(order.some((l) => show[l]));
  const tracksOn = (l: CopperLayer) => board?.tracks.filter((t) => t.layer === l) ?? [];
  const zonePath = (r: number[]) => {
    let d = '';
    for (let i = 0; i + 3 < r.length; i += 4) d += `M${r[i]},${r[i + 1]}h${r[i + 2]}v${r[i + 3]}h${-r[i + 2]!}z`;
    return d;
  };
  /** Each pour's cells as one path (thousands of them: built once per board, not on every frame). */
  const zonePaths = $derived(new Map(board?.zones.map((z) => [z, zonePath(z.rects)])));
  const path = (pts: number[]) => pts.reduce((s, v, i) => s + (i % 2 ? `,${v}` : `${i ? ' L' : 'M'}${v}`), '');
</script>

<!-- an interactive canvas: pointer and keyboard (R = rotate, L = lock, F = flip) are the point -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<svg
  bind:this={svg}
  bind:clientWidth={cw}
  bind:clientHeight={ch}
  class="board"
  class:placing={show.placement}
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
    {#if show.board !== false}<path class="substrate" d={[outlinePath, ...cutoutPaths].join(' ')} fill-rule="evenodd" />{/if}

    {#each order as layer (layer)}
      {#if show[layer]}
        <g class="layer {LAYER_CLASS[layer]}" class:dim={layer !== 'F.Cu' && show['F.Cu']}>
          {#each board.zones.filter((z) => z.layer === layer) as z, zi (zi)}
            {#if z.shape && !moving}
              {@const id = `zm-${layer}-${zi}`}
              {@const o = z.shape.outline}
              <mask {id} maskUnits="userSpaceOnUse" x={o[0] - 1} y={o[1] - 1} width={o[2] - o[0] + 2} height={o[3] - o[1] + 2}>
                {#if z.shape.clip}<path d={polyPath(z.shape.clip)} fill="white" />{:else}<rect x={o[0]} y={o[1]} width={o[2] - o[0]} height={o[3] - o[1]} fill="white" />{/if}
                {#each z.shape.cuts as c, ci (ci)}
                  {#if c.k === 'circle'}<circle cx={c.x} cy={c.y} r={c.d / 2} fill="black" />
                  {:else if c.k === 'rect'}<rect x={c.x} y={c.y} width={c.w} height={c.h} fill="black" />
                  {:else}<path d={path(c.pts)} stroke="black" stroke-width={c.w} fill="none" stroke-linecap="round" stroke-linejoin="round" />{/if}
                {/each}
                {#each z.shape.adds as a, ai (ai)}<path d={path(a.pts)} stroke="white" stroke-width={a.w} fill="none" />{/each}
              </mask>
              <rect class="zone" x={o[0]} y={o[1]} width={o[2] - o[0]} height={o[3] - o[1]} mask="url(#{id})" />
            {:else}
              <path class="zone" d={zonePaths.get(z)} />
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

    {#if show.silk}
      <!-- silkscreen graphics (logos): filled even-odd (inner figures are holes) or outlines; the bottom side faded -->
      {#each board.graphics ?? [] as g (g.id)}
        {@const o = gfxOffset(g.id)}
        <path
          class="sgfx {g.mode}"
          class:bottom={g.side === 'bottom'}
          class:movable={!!ongraphic}
          class:dragging={gfxDrag?.id === g.id}
          class:off={g.inside === false}
          data-gfx={g.id}
          transform={o ? `translate(${o.dx} ${o.dy})` : undefined}
          d={g.polys.map((p) => polyPath(p)).join(' ')}
          fill-rule="evenodd"
          stroke-width={g.mode === 'outline' ? g.line : undefined}
        ><title>{g.id}{g.name ? ` · ${g.name}` : ''} ({g.side} silkscreen){g.inside === false ? ' · reaches past the board' : ''}{g.over?.length ? ` · over ${g.over.join(', ')}` : ''}{ongraphic ? ' · drag to move' : ''}</title></path>
      {/each}
    {/if}

    {#if show.placement}
      <!-- who placed what: your choices and locked parts coloured, the rest dimmed; a choice kept
           relative to another part is tied to it -->
      {#each board.parts as p (p.componentId)}
        {#if !p.componentId.startsWith('hole:')}
          {@const st = stateOf(p)}
          {@const o = offset(p.refdes)}
          <rect class="pl {st}" x={p.courtyard.x + (o?.dx ?? 0)} y={p.courtyard.y + (o?.dy ?? 0)} width={p.courtyard.w} height={p.courtyard.h} rx={Math.min(0.3, p.courtyard.w / 6)} />
          {#if st === 'choice' && p.intent?.anchor}
            {@const a = centreOf(p.intent.anchor)}
            {#if a}<line class="tie" x1={p.x + (o?.dx ?? 0)} y1={p.y + (o?.dy ?? 0)} x2={a.x} y2={a.y} stroke-width={px * 1.2} stroke-dasharray="{px * 4} {px * 3}" />{/if}
          {/if}
        {/if}
      {/each}
    {/if}

    <!-- pads (the part's side + through-hole); bottom-side parts first. An SMD pad is on its side's copper layer
         (shown with it, in its colour); a through-hole pad or via is on every layer (shown with any of them) -->
    {#each partsInOrder as p (p.componentId)}
      <g
        class="part"
        class:bottom={p.side === 'bottom'}
        class:sel={selection.includes(p.refdes)}
        class:locked={p.locked}
        class:free={show.placement && stateOf(p) === 'free' && !p.componentId.startsWith('hole:')}
        class:dragging={partDrag?.ref === p.refdes}
        data-ref={p.refdes}
        transform={offset(p.refdes) ? `translate(${offset(p.refdes)!.dx} ${offset(p.refdes)!.dy})` : undefined}
      >
        <rect class="hit" x={p.courtyard.x} y={p.courtyard.y} width={p.courtyard.w} height={p.courtyard.h} />
        {#each p.pads as pad, i (i)}
          {@const r = pad.shape === 'round' ? Math.min(pad.w, pad.h) / 2 : Math.min(pad.w, pad.h) * 0.15}
          {#if !pad.npth && !(pad.drill ? anyCopper : show[p.side === 'bottom' ? 'B.Cu' : 'F.Cu'])}
            <!-- its copper layer is hidden -->
          {:else if pad.npth}
            <circle class="keepout" cx={pad.x} cy={pad.y} r={pad.w / 2} />
            <circle class="drill npth" cx={pad.x} cy={pad.y} r={pad.drill! / 2} />
          {:else}
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
          {/if}
        {/each}
        {#if show.silk && !p.componentId.startsWith('hole:')}
          {#if p.body.round}<circle class="silk" cx={p.body.x + p.body.w / 2} cy={p.body.y + p.body.h / 2} r={p.body.w / 2} />
          {:else}<rect class="silk" x={p.body.x} y={p.body.y} width={p.body.w} height={p.body.h} />{/if}
          {#if p.polarized}<circle class="silkdot" cx={p.pin1.x} cy={p.pin1.y} r="0.18" />{/if}
          {#if p.side === 'bottom'}<title>{p.refdes} · bottom side (mirrored, seen from the top)</title>{/if}
          <text class="ref" x={p.x} y={p.y} font-size={Math.max(0.5, Math.min(1.2, Math.min(p.body.w, p.body.h) * 0.45))}>{p.refdes}</text>
        {/if}
        {#if !p.componentId.startsWith('hole:') && stateOf(p) !== 'free'}
          <!-- a marker of fixed screen size at the courtyard's top right: a padlock (locked) or a dot (your choice) -->
          <g class="mark {stateOf(p)}" transform="translate({p.courtyard.x + p.courtyard.w} {p.courtyard.y}) scale({px})">
            <title>{p.locked ? 'Locked here' : `Your placement${p.intent?.anchor ? `, kept relative to ${p.intent.anchor}` : ''}`}</title>
            {#if p.locked}
              <path class="shackle" d="M -3 -2 v -3 a 3 3 0 0 1 6 0 v 3" />
              <rect x="-5" y="-2.5" width="10" height="8" rx="1.5" />
            {:else}
              <circle r="4.5" />
            {/if}
          </g>
        {/if}
      </g>
    {/each}

    {#each anyCopper ? board.vias : [] as v, i (i)}
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

    <path class="edge" d={outlinePath} />
    {#each cutoutPaths as d, i (i)}<path class="edge" {d} />{/each}
    {#if show.dims && dimensions}
      <!-- the Dimensions layer (mm): size above and left, the holes' positions below and right, their diameters by them -->
      <g class="dims" font-size={dimensions.font} stroke-width={dimensions.font * 0.05}>
        {#each dimensions.dims as d, i (i)}
          {@const p = dimPaths(d, dimensions.arrow)}
          <path class="dl" d={p.lines} />
          <path class="da" d={p.arrows} />
          <text x={d.tx} y={d.ty} transform={d.dir === 'v' ? `rotate(-90 ${d.tx} ${d.ty})` : undefined}>{d.text}</text>
        {/each}
        {#each dimensions.notes as t, i (i)}<text class="note" x={t.x} y={t.y} style:text-anchor={t.anchor}>{t.text}</text>{/each}
      </g>
    {/if}
    {#if marker}<circle class="marker" cx={marker.x} cy={marker.y} r="1.2" />{/if}
  {/if}
</svg>

<style>
  .board { width: 100%; height: 100%; display: block; background: var(--canvas); cursor: default; touch-action: none; }
  /* the board itself (substrate under the solder mask): not a copper layer */
  .substrate { fill: #0f2a22; }
  .edge { fill: none; stroke: #e0c341; stroke-width: 0.15; }
  .layer > path { fill: none; stroke-linecap: round; stroke-linejoin: round; }
  /* planes and pours are never highlighted (they cover the board; hovering them would light it all up).
     In their layer's colour; faint under the top copper, so with every layer on the board stays green */
  .layer .zone { stroke: none; opacity: 0.3; pointer-events: none; }
  .layer.dim .zone { opacity: 0.1; }
  .fcu .zone { fill: #c9463d; }
  .bcu .zone { fill: #3f7fd6; }
  .in1 .zone { fill: #c9a13d; }
  .in2 .zone { fill: #8e5cd6; }
  .fcu > path { stroke: #c9463d; }
  .bcu > path { stroke: #3f7fd6; }
  .in1 > path { stroke: #c9a13d; }
  .in2 > path { stroke: #8e5cd6; }
  .layer.dim > path:not(.zone) { opacity: 0.7; }
  .layer > path.hot { stroke: #fff27a; }
  /* parts on the top side: pads in the top copper's colour */
  .pad { fill: #d0564c; }
  .pad.tht { fill: #d8a24a; }
  /* parts on the bottom side: pads in the bottom copper's colour, the outline dashed */
  .part.bottom .pad:not(.tht) { fill: #4f86d2; }
  .part.bottom .silk { stroke: #9dc0ee; stroke-dasharray: 0.4 0.25; }
  .part.bottom .silkdot, .part.bottom .ref { fill: #9dc0ee; }
  .pad.hot, .part.bottom .pad.hot { fill: #fff27a; }
  .drill { fill: #0b0f14; }
  .drill.npth { stroke: #9aa3ad; stroke-width: 0.08; }
  .keepout { fill: none; stroke: #9aa3ad; stroke-width: 0.05; stroke-dasharray: 0.25 0.2; opacity: 0.7; }
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
  .dims { pointer-events: none; }
  .dims .dl { fill: none; stroke: #7fdcb4; }
  .dims .da { fill: #7fdcb4; stroke: none; }
  .dims text { fill: #7fdcb4; stroke: none; text-anchor: middle; dominant-baseline: central; font-family: var(--mono); }
  .dims text.note { dominant-baseline: auto; }
  .marker { fill: none; stroke: #ff5a5a; stroke-width: 0.25; }
  .board:focus { outline: none; }
  .part { cursor: grab; }
  .part.dragging { cursor: grabbing; opacity: 0.85; }
  .part.dragging .hit { fill: rgba(111, 181, 255, 0.18); }
  .sgfx { pointer-events: none; }
  .sgfx.movable { pointer-events: all; cursor: grab; }
  .sgfx.movable:hover { filter: drop-shadow(0 0 0.3px #9fd2ff); opacity: 1; }
  .sgfx.dragging { cursor: grabbing; opacity: 0.7; }
  .sgfx.off { fill: #ffb27a; }
  .sgfx.outline.off { stroke: #ffb27a; fill: none; }
  .sgfx.fill { fill: #e9ecef; stroke: none; opacity: 0.85; }
  .sgfx.outline { fill: none; stroke: #e9ecef; stroke-linejoin: round; opacity: 0.85; }
  .sgfx.bottom { opacity: 0.3; }
  /* placement state: the markers (always) and the overlay (Placement on) */
  .mark { pointer-events: none; }
  .mark.choice circle { fill: #6fb5ff; stroke: #0b0f14; stroke-width: 1.5; }
  .mark.locked rect { fill: #f0a03c; stroke: #0b0f14; stroke-width: 1.2; }
  .mark.locked .shackle { fill: none; stroke: #f0a03c; stroke-width: 1.8; }
  .pl { pointer-events: none; stroke-width: 0.08; }
  .pl.free { fill: none; stroke: none; }
  .pl.choice { fill: rgba(111, 181, 255, 0.22); stroke: #6fb5ff; }
  .pl.locked { fill: rgba(240, 160, 60, 0.22); stroke: #f0a03c; }
  .tie { stroke: #6fb5ff; opacity: 0.8; pointer-events: none; }
  .placing .part.free { opacity: 0.4; }
</style>
