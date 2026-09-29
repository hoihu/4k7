<script lang="ts">
  import type { Datasheet } from '../ingest.svelte.ts';
  import type { Highlight } from '../pdf.ts';

  /**
   * One datasheet page, with the rows a value was read from highlighted. With `onpick`, a drag
   * over the page selects a rectangle (a picture to take from the datasheet).
   */
  let {
    sheet,
    page = $bindable(1),
    terms = [],
    label = '',
    onpick,
  }: { sheet: Datasheet; page?: number; terms?: string[]; label?: string; onpick?: (page: number, box: [number, number, number, number]) => void } = $props();

  let sel = $state<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  function local(e: PointerEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: Math.min(Math.max(e.clientX - r.left, 0), r.width), y: Math.min(Math.max(e.clientY - r.top, 0), r.height), w: r.width, h: r.height };
  }
  function pickDown(e: PointerEvent) {
    const p = local(e);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    sel = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  }
  function pickMove(e: PointerEvent) {
    if (!sel) return;
    const p = local(e);
    sel = { ...sel, x1: p.x, y1: p.y };
  }
  function pickUp(e: PointerEvent) {
    if (!sel) return;
    const p = local(e);
    const [x0, x1] = [Math.min(sel.x0, p.x), Math.max(sel.x0, p.x)];
    const [y0, y1] = [Math.min(sel.y0, p.y), Math.max(sel.y0, p.y)];
    sel = null;
    if (x1 - x0 < 8 || y1 - y0 < 8) return;
    onpick?.(page, [x0 / p.w, y0 / p.h, x1 / p.w, y1 / p.h]);
  }

  let host: HTMLDivElement | undefined = $state();
  let canvas: HTMLCanvasElement | undefined = $state();
  let width = $state(0);
  let pages = $state(0);
  let marks = $state<Highlight[]>([]);
  let error = $state<string | null>(null);
  let busy = $state(false);
  let queue: Promise<void> = Promise.resolve();

  $effect(() => {
    if (!host) return;
    const ro = new ResizeObserver(() => (width = Math.max(200, Math.floor(host!.clientWidth - 16))));
    ro.observe(host);
    return () => ro.disconnect();
  });

  $effect(() => {
    const [s, p, t, w, c] = [sheet, page, [...terms], width, canvas];
    if (!c || !w) return;
    let stale = false;
    busy = true;
    // one render at a time: pdf.js refuses concurrent renders into the same canvas
    queue = queue.then(async () => {
      if (stale) return;
      try {
        const { openPdf, renderPage } = await import('../pdf.ts'); // pdf.js only when a datasheet is shown
        const doc = await openPdf(s.hash, s.data);
        if (stale) return;
        pages = doc.numPages;
        const m = await renderPage(doc, p, c, w, t);
        if (stale) return;
        marks = m;
        error = null;
        // bring the highlighted row into view
        if (m[0] && host) host.scrollTo({ top: Math.max(0, m[0].y - host.clientHeight / 3), behavior: 'smooth' });
      } catch (e) {
        if (!stale) error = (e as Error).message;
      } finally {
        if (!stale) busy = false;
      }
    });
    return () => (stale = true);
  });
</script>

<div class="ds">
  <div class="bar">
    <button class="btn" disabled={page <= 1} onclick={() => (page = page - 1)} aria-label="Previous page">‹</button>
    <span class="mono">p. {page}{#if pages} / {pages}{/if}</span>
    <button class="btn" disabled={!!pages && page >= pages} onclick={() => (page = page + 1)} aria-label="Next page">›</button>
    <span class="grow trunc muted">{label || sheet.name}</span>
    {#if busy}<span class="muted">…</span>{/if}
  </div>
  <div class="page" bind:this={host}>
    {#if error}<p class="err">Could not show the page: {error}</p>{/if}
    <div class="sheet">
      <canvas bind:this={canvas}></canvas>
      {#each marks as m, i (i)}<div class="mark" style="left:{m.x}px;top:{m.y}px;width:{m.w}px;height:{m.h}px"></div>{/each}
      {#if onpick}
        <div class="pick" role="presentation" onpointerdown={pickDown} onpointermove={pickMove} onpointerup={pickUp}>
          {#if sel}<div class="sel" style="left:{Math.min(sel.x0, sel.x1)}px;top:{Math.min(sel.y0, sel.y1)}px;width:{Math.abs(sel.x1 - sel.x0)}px;height:{Math.abs(sel.y1 - sel.y0)}px"></div>{/if}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .ds { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .bar { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-bottom: 1px solid var(--line); font-size: 12px; flex: none; }
  .bar .btn { padding: 0 8px; }
  .page { flex: 1; min-height: 0; overflow: auto; padding: 8px; background: var(--canvas); }
  .sheet { position: relative; width: max-content; margin: 0 auto; box-shadow: var(--shadow); background: #fff; }
  canvas { display: block; }
  .mark { position: absolute; background: rgba(255, 200, 0, 0.28); outline: 2px solid rgba(230, 150, 0, 0.9); border-radius: 2px; pointer-events: none; }
  .err { color: var(--err); font-size: 12px; }
  .pick { position: absolute; inset: 0; cursor: crosshair; touch-action: none; }
  .sel { position: absolute; border: 2px dashed var(--accent); background: rgba(80, 140, 255, 0.12); pointer-events: none; }
</style>
