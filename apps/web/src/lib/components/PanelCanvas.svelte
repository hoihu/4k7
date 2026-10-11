<script lang="ts">
  import { boardPolygon, type BoardView, type PanelSide, type PanelTab, type PanelView } from '@tracewise/schema';

  /**
   * The fabrication panel (mm, top view): the frame and the copies, the milled channels between
   * them, tabs with their mouse bites, fiducials and tooling holes. Tabs are edited here: click a
   * board edge to add one (on every copy), drag one along its side, click one to remove it.
   */
  interface Props {
    board: BoardView;
    /** The panel's new tab list (set_panel tabs). */
    ontabs?: (tabs: PanelTab[]) => void;
  }
  let { board, ontabs }: Props = $props();

  const panel = $derived(board.panel!);
  const s = $derived(panel.settings);
  const W = $derived(board.outline.w);
  const H = $derived(board.outline.h);
  const poly = $derived(boardPolygon(board));

  const polyPath = (pts: number[]) => pts.reduce((d, v, i) => (i % 2 ? `${d} ${v}` : `${d}${i ? ' L' : 'M'} ${v}`), '') + ' Z';
  const path = (pts: number[]) => pts.reduce((d, v, i) => d + (i % 2 ? `,${v}` : `${i ? ' L' : 'M'}${v}`), '');
  const zonePath = (r: number[]) => {
    let d = '';
    for (let i = 0; i + 3 < r.length; i += 4) d += `M${r[i]},${r[i + 1]}h${r[i + 2]}v${r[i + 3]}h${-r[i + 2]!}z`;
    return d;
  };
  const material = $derived(panel.edges.map(polyPath).join(' '));
  const outline = $derived(polyPath(poly));

  /* view: fitted to the panel, wheel zooms, drag pans */
  let svg: SVGSVGElement | undefined = $state();
  let vb = $state({ x: -5, y: -5, w: 100, h: 80 });
  let fitted = '';
  $effect(() => {
    const key = `${panel.w}x${panel.h}`;
    if (key === fitted) return;
    fitted = key;
    const m = Math.max(panel.w, panel.h) * 0.06 + 2;
    vb = { x: -m, y: -m, w: panel.w + 2 * m, h: panel.h + 2 * m };
  });
  function toSvg(e: { clientX: number; clientY: number }) {
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg!.getScreenCTM()!.inverse());
    return { x: p.x, y: p.y };
  }
  function onwheel(e: WheelEvent) {
    e.preventDefault();
    const p = toSvg(e);
    const f = Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 60) * 0.004);
    const w = Math.min(Math.max(vb.w * f, 2), 3000);
    const k = w / vb.w;
    vb = { x: p.x - (p.x - vb.x) * k, y: p.y - (p.y - vb.y) * k, w, h: vb.h * k };
  }

  /* where the board edge is along a line across a side (board coordinates) */
  const vertical = (side: PanelSide) => side === 'top' || side === 'bottom';
  const outward = (side: PanelSide) => (side === 'top' || side === 'left' ? -1 : 1);
  function edgeAt(side: PanelSide, u: number): number | undefined {
    const hits: number[] = [];
    for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
      // (u, v): along the side and across it
      const [au, av, bu, bv] = vertical(side) ? [poly[j]!, poly[j + 1]!, poly[i]!, poly[i + 1]!] : [poly[j + 1]!, poly[j]!, poly[i + 1]!, poly[i]!];
      if (au > u === bu > u) continue;
      hits.push(av + ((u - au) * (bv - av)) / (bu - au));
    }
    if (!hits.length) return undefined;
    return outward(side) < 0 ? Math.min(...hits) : Math.max(...hits);
  }
  const sideLen = (side: PanelSide) => (vertical(side) ? W : H);
  /** A tab's rectangle on a copy (board coordinates), reaching across the gap; undefined where the side misses the board. */
  function tabBox(side: PanelSide, at: number) {
    const tw = s.tab.width;
    const u = at * sideLen(side);
    const v = edgeAt(side, u);
    if (v === undefined) return undefined;
    const o = outward(side);
    const [v0, v1] = o < 0 ? [v - s.gap, v] : [v, v + s.gap];
    return vertical(side) ? { x: u - tw / 2, y: v0, w: tw, h: v1 - v0 } : { x: v0, y: u - tw / 2, w: v1 - v0, h: tw };
  }
  /** Whether a tab there would overlap another on the same side (leaving out the tabs `except`, by index). */
  function clashes(side: PanelSide, at: number, except: number[] = []): boolean {
    const len = sideLen(side);
    return s.tabs.some((t, i) => !except.includes(i) && t.side === side && Math.abs(t.at - at) * len < s.tab.width + 0.5);
  }
  /** The copy under a point, and the point in its coordinates. */
  function copyAt(x: number, y: number) {
    let best: { k: number; lx: number; ly: number; d: number } | null = null;
    panel.copies.forEach((c, k) => {
      const lx = x - c.dx;
      const ly = y - c.dy;
      const d = Math.max(-lx, lx - W, -ly, ly - H, 0);
      if (!best || d < best.d) best = { k, lx, ly, d };
    });
    return best as { k: number; lx: number; ly: number; d: number } | null;
  }
  /** The side and position a click there would put a tab: just outside a board edge, within the gap. */
  function spotAt(x: number, y: number): { k: number; side: PanelSide; at: number } | null {
    const c = copyAt(x, y);
    if (!c || c.d > s.gap + 1) return null;
    let best: { side: PanelSide; at: number; d: number } | null = null;
    for (const side of ['top', 'right', 'bottom', 'left'] as PanelSide[]) {
      const len = sideLen(side);
      const [u, v] = vertical(side) ? [c.lx, c.ly] : [c.ly, c.lx];
      const half = s.tab.width / 2;
      if (u < half || u > len - half) continue;
      const e = edgeAt(side, u);
      if (e === undefined) continue;
      const d = (v - e) * outward(side);
      if (d < -0.8 || d > s.gap + 0.8) continue;
      if (!best || Math.abs(d) < best.d) best = { side, at: Math.round(Math.round(u * 2) / 2 / len * 1000) / 1000, d: Math.abs(d) };
    }
    return best && !clashes(best.side, best.at) ? { k: c.k, side: best.side, at: best.at } : null;
  }

  /* editing: hover shows where a tab would go; a tab can be dragged along its side or clicked away */
  let hover = $state<{ k: number; side: PanelSide; at: number } | null>(null);
  let hoverTab = $state<number | null>(null);
  let tabDrag = $state<{ i: number; sx: number; sy: number; at: number; moved: boolean } | null>(null);
  let pan: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
  /** After an edit, the tabs as asked for, shown until the panel arrives with them (or a while passes). */
  let pending = $state<{ was: string; ghost: { side: PanelSide; at: number }[] } | null>(null);
  const tabsKey = $derived(JSON.stringify(s.tabs));
  $effect(() => {
    if (pending && pending.was !== tabsKey) pending = null;
  });
  // a new panel renumbers its tabs: the one under the pointer is found again on the next move
  $effect(() => {
    void panel;
    hoverTab = null;
  });
  function commit(tabs: PanelTab[], ghost: { side: PanelSide; at: number }[]) {
    pending = { was: tabsKey, ghost };
    setTimeout(() => (pending = null), 5000);
    ontabs?.(tabs);
  }

  /** Along-the-side position of a dragged tab, from the pointer. */
  function dragAt(i: number, x: number, y: number): number {
    const t = panel.tabs[i]!;
    const c = panel.copies[t.copy]!;
    const len = sideLen(t.side);
    const u = vertical(t.side) ? x - c.dx : y - c.dy;
    const half = s.tab.width / 2;
    return Math.round((Math.min(Math.max(Math.round(u * 2) / 2, half), len - half) / len) * 1000) / 1000;
  }

  function onpointerdown(e: PointerEvent) {
    if (e.button !== 0 && e.button !== 1) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const tab = e.button === 0 && ontabs ? (e.target as Element).closest('[data-tab]')?.getAttribute('data-tab') : null;
    if (tab != null) {
      const i = Number(tab);
      const t = panel.tabs[i]!;
      const st = s.tabs[t.src[0]!]!;
      tabDrag = { i, sx: e.clientX, sy: e.clientY, at: st.at, moved: false };
      return;
    }
    pan = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y, moved: false };
  }
  function onpointermove(e: PointerEvent) {
    const p = toSvg(e);
    if (tabDrag) {
      if (Math.abs(e.clientX - tabDrag.sx) + Math.abs(e.clientY - tabDrag.sy) > 3) tabDrag.moved = true;
      // it stops short of another tab on its side
      const at = dragAt(tabDrag.i, p.x, p.y);
      if (tabDrag.moved && !clashes(panel.tabs[tabDrag.i]!.side, at, panel.tabs[tabDrag.i]!.src)) tabDrag.at = at;
      return;
    }
    if (pan) {
      const dx = e.clientX - pan.x;
      const dy = e.clientY - pan.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true;
      const r = svg!.getBoundingClientRect();
      const k = Math.max(vb.w / r.width, vb.h / r.height);
      vb = { ...vb, x: pan.vx - dx * k, y: pan.vy - dy * k };
      return;
    }
    const tab = (e.target as Element).closest('[data-tab]')?.getAttribute('data-tab');
    hoverTab = tab != null ? Number(tab) : null;
    hover = ontabs && hoverTab === null ? spotAt(p.x, p.y) : null;
  }
  function onpointerup() {
    if (tabDrag) {
      const d = tabDrag;
      tabDrag = null;
      const t = panel.tabs[d.i]!;
      if (d.moved && d.at !== s.tabs[t.src[0]!]!.at) {
        // a shared tab stands for a side's tab and the facing side's: both move
        const tabs = s.tabs.map((x, i) => (t.src.includes(i) ? { ...x, at: d.at } : x));
        commit(tabs, t.src.map((i) => ({ side: s.tabs[i]!.side, at: d.at })));
      } else if (!d.moved) commit(s.tabs.filter((_, i) => !t.src.includes(i)), []);
      return;
    }
    if (pan && !pan.moved && hover) {
      const h = hover;
      commit([...s.tabs, { side: h.side, at: h.at }], [{ side: h.side, at: h.at }]);
      hover = null;
    }
    pan = null;
  }

  const ghosts = $derived.by(() => {
    const out: { side: PanelSide; at: number }[] = [];
    if (tabDrag?.moved) {
      const t = panel.tabs[tabDrag.i]!;
      out.push({ side: t.side, at: tabDrag.at });
    } else if (pending) out.push(...pending.ghost);
    else if (hover) out.push({ side: hover.side, at: hover.at });
    return out;
  });
  const hidden = $derived(tabDrag?.moved ? tabDrag.i : null);
  const tabTitle = (t: PanelView['tabs'][number]) =>
    `Tab ${t.joins ? 'between two boards' : `on the ${t.side} side`} · drag to move it along the side (on every copy), click to remove it`;
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<svg
  bind:this={svg}
  class="panel"
  class:adding={!!hover}
  viewBox="{vb.x} {vb.y} {vb.w} {vb.h}"
  preserveAspectRatio="xMidYMid meet"
  role="application"
  aria-label="Fabrication panel"
  {onwheel}
  {onpointerdown}
  {onpointermove}
  {onpointerup}
  onpointerleave={() => ((hover = null), (hoverTab = null))}
  tabindex="0"
>
  <defs>
    <pattern id="mill" patternUnits="userSpaceOnUse" width="1" height="1" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="1" class="hatch" />
    </pattern>
    <!-- one copy of the board: pours, tracks, pads, part outlines -->
    <g id="pcopy">
      {#each board.zones as z, i (i)}<path class="zone {z.layer === 'F.Cu' ? 'f' : 'b'}" d={z.shape?.clip ? polyPath(z.shape.clip) : zonePath(z.rects)} />{/each}
      {#each board.tracks.filter((t) => t.layer !== 'F.Cu') as t, i (i)}<path class="trk b" d={path(t.pts)} stroke-width={t.width} />{/each}
      {#each board.tracks.filter((t) => t.layer === 'F.Cu') as t, i (i)}<path class="trk f" d={path(t.pts)} stroke-width={t.width} />{/each}
      {#each board.parts as p (p.componentId)}
        {#if !p.componentId.startsWith('hole:')}<rect class="body" x={p.body.x} y={p.body.y} width={p.body.w} height={p.body.h} />{/if}
        {#each p.pads as q, i (i)}
          {#if q.npth}<circle class="hole" cx={q.x} cy={q.y} r={q.drill! / 2} />
          {:else}<rect class="pad" x={q.x - q.w / 2} y={q.y - q.h / 2} width={q.w} height={q.h} rx={q.shape === 'round' ? Math.min(q.w, q.h) / 2 : 0} />{/if}
        {/each}
      {/each}
      {#each board.vias as v, i (i)}<circle class="via" cx={v.x} cy={v.y} r={v.pad / 2} />{/each}
      {#each board.cutouts as c (c.id)}<rect class="cut" x={c.x - c.w / 2} y={c.y - c.h / 2} width={c.w} height={c.h} rx={c.shape === 'rect' ? c.r : Math.min(c.w, c.h) / 2} transform="rotate({c.angle} {c.x} {c.y})" />{/each}
      <path class="outline" d={outline} />
    </g>
  </defs>

  <!-- milled (hatched) where the material is not -->
  <rect class="milled" x="0" y="0" width={panel.w} height={panel.h} />
  <path class="material" d={material} fill-rule="evenodd" />
  {#each panel.copies as c, i (i)}<use href="#pcopy" x={c.dx} y={c.dy} />{/each}

  {#each panel.tabs as t, i (i)}
    {#if i !== hidden}
      <rect class="tab" class:hot={hoverTab === i} class:edit={!!ontabs} data-tab={i} x={t.x} y={t.y} width={t.w} height={t.h}><title>{tabTitle(t)}</title></rect>
    {/if}
  {/each}
  {#each panel.bites as m, i (i)}<circle class="bite" cx={m.x} cy={m.y} r={m.d / 2} />{/each}
  {#each ghosts as g, gi (gi)}
    {#each panel.copies as c, ci (ci)}
      {@const r = tabBox(g.side, g.at)}
      {#if r}<rect class="ghost" x={c.dx + r.x} y={c.dy + r.y} width={r.w} height={r.h} />{/if}
    {/each}
  {/each}
  {#each panel.tooling as t, i (i)}<circle class="tool" cx={t.x} cy={t.y} r={t.d / 2}><title>Tooling hole Ø{t.d} mm</title></circle>{/each}
  {#each panel.fiducials as f, i (i)}
    <circle class="fidmask" cx={f.x} cy={f.y} r={f.mask / 2} />
    <circle class="fid" cx={f.x} cy={f.y} r={f.d / 2}><title>Fiducial: {f.d} mm copper, {f.mask} mm mask opening</title></circle>
  {/each}
  {#each panel.edges as e, i (i)}<path class="edge" d={polyPath(e)} />{/each}
</svg>

<style>
  .panel { width: 100%; height: 100%; display: block; background: var(--canvas); touch-action: none; }
  .panel:focus { outline: none; }
  .panel.adding { cursor: copy; }
  .milled { fill: url(#mill); }
  .hatch { stroke: #3a4552; stroke-width: 0.25; }
  .material { fill: #0f2a22; }
  .edge { fill: none; stroke: #e0c341; stroke-width: 0.12; pointer-events: none; }
  .outline { fill: none; stroke: #e0c341; stroke-width: 0.08; opacity: 0.5; }
  .zone { stroke: none; opacity: 0.12; }
  .zone.f { fill: #c9463d; }
  .zone.b { fill: #3f7fd6; }
  .trk { fill: none; stroke-linecap: round; stroke-linejoin: round; opacity: 0.75; }
  .trk.f { stroke: #c9463d; }
  .trk.b { stroke: #3f7fd6; opacity: 0.5; }
  .pad { fill: #c98a3c; }
  .via { fill: #b9bec7; }
  .hole { fill: #0b0f14; }
  .cut { fill: var(--canvas); }
  .body { fill: none; stroke: #e9ecef; stroke-width: 0.1; opacity: 0.5; }
  .tab { fill: #2c6b55; stroke: none; }
  .tab.edit { cursor: grab; }
  .tab.hot { fill: #3d8f72; stroke: #9fd2ff; stroke-width: 0.12; }
  .bite { fill: #0b0f14; stroke: #9aa3ad; stroke-width: 0.04; pointer-events: none; }
  .ghost { fill: rgba(111, 181, 255, 0.35); stroke: #6fb5ff; stroke-width: 0.1; stroke-dasharray: 0.4 0.3; pointer-events: none; }
  .tool { fill: #0b0f14; stroke: #9aa3ad; stroke-width: 0.06; }
  .fidmask { fill: #1d4a3a; }
  .fid { fill: #d8a24a; }
</style>
