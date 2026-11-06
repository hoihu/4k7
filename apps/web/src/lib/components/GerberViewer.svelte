<script lang="ts">
  import { untrack } from 'svelte';
  import { fileContents } from '@4k7/fab';
  import { app } from '../app.svelte.ts';
  import { pastDrag, plainKey } from '../canvas.svelte.ts';
  import { drawFabFiles, drawScaleBar, fitView, layerStyle, viewRect } from '../gerberDraw.ts';
  import { gerberViewer as gv } from '../gerberViewer.svelte.ts';
  import Splitter from './Splitter.svelte';

  /**
   * The Gerber viewer: production files drawn layer by layer (this board's, its panel's, or files
   * dropped in), with the layers to switch, top or bottom, zoom, pan and a measure on the canvas,
   * and what the files say about the board in the side panel.
   */

  // this board's files are made from the design as it is, routed (not from the placement shown
  // while it routes), and again when it changes; the board is computed only if it is not current
  $effect(() => {
    untrack(() => {
      if (!app.boardCurrent && !app.boardBusy) void app.refreshBoard();
    });
  });
  $effect(() => {
    const b = app.board;
    if (!b?.parts.length || app.boardStage !== 'routed') return;
    untrack(() => {
      if (gv.source === null || gv.source === 'board') gv.fromBoard(b, app.fabName);
      else if (gv.source === 'panel' && b.panel) gv.fromBoard(b, app.fabName, true);
    });
  });

  let stage: HTMLDivElement | undefined = $state();
  let canvas: HTMLCanvasElement | undefined = $state();
  let overlay: HTMLCanvasElement | undefined = $state();
  let picker: HTMLInputElement | undefined = $state();
  let size = $state({ w: 0, h: 0, dpr: 1 });
  /** The files' point at the centre and the scale, CSS px per mm. */
  let view = $state<{ cx: number; cy: number; scale: number } | null>(null);
  type At = { x: number; y: number };
  let cursor = $state<At | null>(null);
  /** The measure: from a to b, or to the cursor until a second click fixes b. */
  let measure = $state<{ a: At; b: At | null } | null>(null);
  let dropping = $state(false);

  $effect(() => {
    if (!stage) return;
    const el = stage;
    const ro = new ResizeObserver(() => (size = { w: el.clientWidth, h: el.clientHeight, dpr: window.devicePixelRatio || 1 }));
    ro.observe(el);
    return () => ro.disconnect();
  });

  // files opened or an area asked for (by the agent too): fit it in; a resize keeps the view
  let fitted = -1;
  $effect(() => {
    const n = gv.fit;
    const { w, h } = size;
    if (!w || !h || n === fitted) return;
    const f = untrack(() => gv.frame ?? gv.whole());
    if (!f) return;
    fitted = n;
    const v = fitView(f, w, h, false);
    view = { cx: v.cx, cy: v.cy, scale: v.scale };
  });

  // the agent is told which area the user is looking at
  $effect(() => {
    gv.visible = () => (view && size.w ? viewRect({ ...view, below: gv.below }, size.w, size.h) : null);
    return () => (gv.visible = null);
  });

  let raf = 0;
  $effect(() => {
    const [v, s, files, below] = [view, size, gv.shown, gv.below];
    if (!canvas || !v || !s.w) return;
    const c = canvas;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const [w, h] = [Math.round(s.w * s.dpr), Math.round(s.h * s.dpr)];
      if (c.width !== w || c.height !== h) [c.width, c.height] = [w, h];
      const ctx = c.getContext('2d')!;
      const fv = { ...v, scale: v.scale * s.dpr, below };
      drawFabFiles(ctx, files, fv);
      // (above the status bar)
      drawScaleBar(ctx, fv.scale, s.dpr, 34);
    });
    return () => cancelAnimationFrame(raf);
  });

  const sign = () => (gv.below ? -1 : 1);
  function toFiles(e: { clientX: number; clientY: number }): At {
    const r = canvas!.getBoundingClientRect();
    const v = view!;
    return { x: v.cx + (e.clientX - r.left - r.width / 2) / (v.scale * sign()), y: v.cy - (e.clientY - r.top - r.height / 2) / v.scale };
  }
  const toScreen = (p: At): [number, number] => [size.w / 2 + (p.x - view!.cx) * view!.scale * sign(), size.h / 2 - (p.y - view!.cy) * view!.scale];

  // the measure on a canvas of its own, so a moving cursor does not draw the files again
  $effect(() => {
    const [m, c, s] = [measure, cursor, size];
    void [view, gv.below];
    if (!overlay || !view || !s.w) return;
    const [w, h] = [Math.round(s.w * s.dpr), Math.round(s.h * s.dpr)];
    if (overlay.width !== w || overlay.height !== h) [overlay.width, overlay.height] = [w, h];
    const ctx = overlay.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const b = m?.b ?? c;
    if (!m || !b) return;
    ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
    const [ax, ay] = toScreen(m.a);
    const [bx, by] = toScreen(b);
    ctx.strokeStyle = ctx.fillStyle = '#7fe0ff';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const [x, y] of [[ax, ay], [bx, by]] as const) {
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(`${dist(m.a, b)} mm`, (ax + bx) / 2 + 8, (ay + by) / 2 - 8);
  });

  const r3 = (v: number) => (Math.round(v * 1000) / 1000).toFixed(3);
  const dist = (a: At, b: At) => r3(Math.hypot(b.x - a.x, b.y - a.y));

  function onwheel(e: WheelEvent) {
    e.preventDefault();
    if (!view) return;
    const p = toFiles(e);
    const f = Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 60) * 0.004);
    const scale = Math.min(Math.max(view.scale / f, 0.05), 4000);
    const k = view.scale / scale;
    view = { scale, cx: p.x - (p.x - view.cx) * k, cy: p.y - (p.y - view.cy) * k };
  }

  let press: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
  function onpointerdown(e: PointerEvent) {
    if ((e.button !== 0 && e.button !== 1) || !view) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    press = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy, moved: false };
  }
  function onpointermove(e: PointerEvent) {
    if (!view) return;
    cursor = toFiles(e);
    if (!press) return;
    if (pastDrag(press, e)) press.moved = true;
    if (press.moved) view = { ...view, cx: press.cx - (e.clientX - press.x) / (view.scale * sign()), cy: press.cy + (e.clientY - press.y) / view.scale };
  }
  function onpointerup(e: PointerEvent) {
    const p = press;
    press = null;
    if (!p || p.moved || e.button !== 0 || !view) return;
    // a click measures: from here, then to the second click
    const at = toFiles(e);
    measure = !measure || measure.b ? { a: at, b: null } : { a: measure.a, b: at };
  }
  function onkeydown(e: KeyboardEvent) {
    if (!plainKey(e)) return;
    if (e.key === 'Escape') measure = null;
    else if (e.key === 'b' || e.key === 'B') gv.below = !gv.below;
    else if (e.key === 'f' || e.key === 'F') gv.show(null);
    else return;
    e.preventDefault();
  }

  function ondrop(e: DragEvent) {
    e.preventDefault();
    dropping = false;
    void gv.fromFiles([...(e.dataTransfer?.files ?? [])]);
  }

  const set = $derived(gv.set);
  const s = $derived(set?.summary);
  const board = $derived(app.board);
  const routed = $derived(board?.parts.length && app.boardStage === 'routed' ? board : null);
  const mm = (v: number) => `${Math.round(v * 1000) / 1000}`;
  const how = { attribute: 'told by its X2 attribute', content: 'a drill file', name: 'told by its name', guess: 'not told: shown as another layer' } as const;
  const plated = (p?: boolean) => (p === true ? 'plated' : p === false ? 'non-plated' : '');
  /** Every layer shown, or none. */
  function toggleAll(on: boolean) {
    gv.hidden = on ? {} : Object.fromEntries((set?.files ?? []).map((f) => [f.layer.id, true]));
  }
</script>

<!-- an interactive canvas: pointer and keyboard (Esc clears the measure, B flips, F fits) are the point -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="col canvas"
  class:dropping
  role="application"
  aria-label="Gerber viewer"
  tabindex="0"
  {onkeydown}
  ondragover={(e) => {
    e.preventDefault();
    dropping = true;
  }}
  ondragleave={() => (dropping = false)}
  {ondrop}
>
  <div class="stage" bind:this={stage}>
    <canvas
      bind:this={canvas}
      class="files"
      {onwheel}
      {onpointerdown}
      {onpointermove}
      {onpointerup}
      onpointerleave={() => (cursor = null)}
    ></canvas>
    <canvas bind:this={overlay} class="over"></canvas>
  </div>
  <div class="top">
    <div class="tools">
      {#if !app.chatOpen}<button class="ib" onclick={() => (app.chatOpen = true)}>⟩ Agent</button>{/if}
      {#if set}
        <div class="seg"><button aria-pressed={!gv.below} onclick={() => (gv.below = false)} title="Seen from the top">Top</button><button aria-pressed={gv.below} onclick={() => (gv.below = true)} title="Seen from below: mirrored, the bottom layers in front (B)">Bottom</button></div>
        <button class="ib fit" onclick={() => gv.show(null)} title="The whole board (F)">Fit</button>
      {/if}
      {#if gv.busy}<span class="busy">reading…</span>{/if}
    </div>
  </div>
  {#if !set?.files.length}
    <div class="blank">
      <p>
        {#if set}<b>No Gerber or drill files</b> in what was opened{set.skipped.length ? ` (${set.skipped.join(', ')})` : ''}.
        {:else if board?.parts.length}<b>Routing the board…</b> Its files show here when it is done. Or drop Gerbers, drill files or a zip of them here.
        {:else}<b>No production files yet.</b> Place parts on the board, or drop Gerbers, drill files or a zip of them here.{/if}
      </p>
    </div>
  {/if}
  <div class="status">
    <span>wheel = zoom · drag = pan · click = measure · Esc clears · B = flip · F = fit · drop files to open them</span>
    <span class="sp mono">
      {#if measure}Δx {r3(Math.abs((measure.b ?? cursor ?? measure.a).x - measure.a.x))} Δy {r3(Math.abs((measure.b ?? cursor ?? measure.a).y - measure.a.y))} · {dist(measure.a, measure.b ?? cursor ?? measure.a)} mm<span class="dot">·</span>{/if}
      {cursor ? `x ${r3(cursor.x)}  y ${r3(cursor.y)} mm` : '—'}
    </span>
  </div>
</div>
<aside class="col side">
  <Splitter pane="side" />
  <div class="scroll">
    <h4>Gerber viewer</h4>
    <p class="small muted">Production files as the fab house gets them, read back from the files: this board's, or Gerbers, drill files and zips from anywhere (drop them on the canvas).</p>
    <div class="row2">
      <!-- (from the routed board: not from the placement shown while it routes) -->
      <button class="btn" aria-pressed={gv.source === 'board'} disabled={!routed} title="This board's Gerbers and drill files, made from the design as it is now (as Fab files in Layout exports them){routed || !board?.parts.length ? '' : '. The board is being routed'}" onclick={() => routed && gv.fromBoard(routed, app.fabName)}>This board</button>
      {#if board?.panel}<button class="btn" aria-pressed={gv.source === 'panel'} disabled={!routed} title="The files of the board's panel" onclick={() => routed && gv.fromBoard(routed, app.fabName, true)}>Its panel</button>{/if}
      <button class="btn" title="Gerber and drill files, or a zip of them" onclick={() => picker?.click()}>Open files…</button>
      <input
        bind:this={picker}
        type="file"
        multiple
        hidden
        onchange={(e) => {
          void gv.fromFiles([...(e.currentTarget.files ?? [])]);
          e.currentTarget.value = '';
        }}
      />
    </div>
    {#if gv.error}<p class="small err">{gv.error}</p>{/if}
    {#if set && s}
      <h4 class="trunc" title={gv.title}>{gv.title}</h4>
      {#if s.board}<p class="small mono">{mm(s.board.w)} × {mm(s.board.h)} mm{s.board.fromOutline ? '' : ' (no outline)'} · {s.copperLayers} copper layer{s.copperLayers === 1 ? '' : 's'}</p>{/if}
      <h4>
        Layers
        <span class="grow"></span>
        <button class="more" onclick={() => toggleAll(true)}>all</button>
        <button class="more" onclick={() => toggleAll(false)}>none</button>
      </h4>
      <ul class="layers">
        {#each set.files as f (f.layer.id)}
          <li title="{f.name}: {how[f.layer.by]}; {fileContents(f)}{f.notes.length ? `; read with: ${f.notes.join('; ')}` : ''}">
            <label>
              <input type="checkbox" checked={!gv.hidden[f.layer.id]} onchange={(e) => (gv.hidden = { ...gv.hidden, [f.layer.id]: !e.currentTarget.checked })} />
              <span class="sw" style:background={layerStyle(f.layer).colour}></span>
              <span class="mono id">{f.layer.id}</span>
              <span class="muted trunc">{f.layer.label}{f.negative ? ' (openings)' : ''}</span>
              {#if f.notes.length || f.layer.by === 'guess'}<span class="tag warn">?</span>{/if}
            </label>
          </li>
        {/each}
      </ul>
      {#if s.drills.length}
        <h4>Holes</h4>
        <table class="holes mono">
          <tbody>
            {#each s.drills as d (`${d.d}|${d.plated}`)}
              <tr><td>Ø{mm(d.d)}</td><td>{d.holes || ''}{d.slots ? `${d.holes ? ' + ' : ''}${d.slots} slot${d.slots === 1 ? '' : 's'}` : ''}</td><td class="muted">{plated(d.plated)}</td></tr>
            {/each}
          </tbody>
        </table>
      {/if}
      {#if s.smallestDrill !== null || s.smallestTrack !== null}
        <p class="small mono">{[s.smallestDrill !== null ? `smallest drill ${mm(s.smallestDrill)} mm` : '', s.smallestTrack !== null ? `smallest track ${mm(s.smallestTrack)} mm` : ''].filter(Boolean).join(' · ')}</p>
      {/if}
      {#if s.notes.length || set.skipped.length}
        <h4>Notes</h4>
        <ul class="notes small">
          {#each s.notes as n, i (i)}<li>{n}</li>{/each}
          {#if set.skipped.length}<li class="muted">Not Gerber or drill files, not shown: {set.skipped.join(', ')}</li>{/if}
        </ul>
      {/if}
    {/if}
  </div>
</aside>

<style>
  .col { position: relative; background: var(--panel); min-height: 0; min-width: 0; display: flex; flex-direction: column; }
  .canvas { background: #0b0e13; outline: none; }
  .canvas.dropping { box-shadow: inset 0 0 0 2px var(--accent); }
  .stage { position: absolute; inset: 0; }
  .stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; }
  .files { cursor: crosshair; }
  .over { pointer-events: none; }
  .top { position: absolute; top: 8px; left: 8px; right: 8px; z-index: 2; display: flex; flex-wrap: wrap; gap: 6px; align-items: flex-start; pointer-events: none; }
  .top > * { pointer-events: auto; }
  .tools { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .tools .ib, .busy { background: var(--panel); border: 1px solid var(--line); }
  .seg { display: inline-flex; }
  .seg button { border: 1px solid var(--line-2); background: var(--panel); color: var(--txt-2); padding: 2px 10px; font-size: 12px; cursor: pointer; }
  .seg button:first-child { border-radius: 6px 0 0 6px; }
  .seg button:last-child { border-radius: 0 6px 6px 0; border-left: 0; }
  .seg button[aria-pressed='true'] { background: var(--accent-soft); color: var(--accent-txt); }
  .busy { font-size: 11px; color: var(--txt-3); padding: 2px 8px; border-radius: 10px; }
  .blank { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
  .blank p { max-width: 360px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; color: var(--txt-2); }
  .status { position: absolute; bottom: 0; left: 0; right: 0; display: flex; gap: 10px; padding: 3px 10px; font-size: 11px; color: var(--txt-3); background: color-mix(in srgb, var(--panel) 85%, transparent); border-top: 1px solid var(--line); white-space: nowrap; overflow: hidden; }
  .status > span:first-child { overflow: hidden; text-overflow: ellipsis; }
  .status .sp { margin-left: auto; flex: none; }
  .status .dot { margin: 0 4px; }
  .side .scroll { padding: 8px 10px; }
  h4 { margin: 12px 0 4px; font-size: 12px; display: flex; gap: 4px; align-items: center; }
  h4:first-child { margin-top: 2px; }
  h4.trunc { display: block; }
  .small { font-size: 11.5px; margin: 2px 0 6px; }
  .err { color: var(--err); }
  .row2 { display: flex; gap: 6px; flex-wrap: wrap; }
  .row2 .btn[aria-pressed='true'] { border-color: var(--accent); color: var(--accent-txt); }
  .more { border: 0; background: none; color: var(--accent-txt); font-size: 11.5px; font-weight: 400; padding: 0 2px; cursor: pointer; }
  .layers, .notes { list-style: none; margin: 0; padding: 0; }
  .layers label { display: flex; gap: 6px; align-items: center; font-size: 12px; padding: 2px 0; cursor: pointer; min-width: 0; }
  .layers .id { flex: none; }
  .sw { width: 12px; height: 12px; border-radius: 3px; display: inline-block; flex: none; }
  .notes li { padding: 2px 0; color: var(--txt-2); }
  .holes { border-collapse: collapse; font-size: 11.5px; }
  .holes td { padding: 1px 12px 1px 0; }
  @media (max-width: 900px) {
    .status > span:first-child { display: none; }
  }
</style>
