<script lang="ts">
  import { body3dFor } from '@tracewise/parts';
  import type { PartCard } from '@tracewise/schema';
  import type { BodyViewer, ViewPreset } from '../three-body.ts';

  /** 3D preview of the generated package body (three.js, loaded when first shown). */
  let { card }: { card: PartCard } = $props();

  const result = $derived(card.packageInfo ? body3dFor(card.packageInfo, card.pins.map((p) => p.number)) : null);
  let host: HTMLDivElement | undefined = $state();
  let canvas: HTMLCanvasElement | undefined = $state();
  let viewer = $state.raw<BodyViewer | null>(null);
  let error = $state<string | null>(null);

  // create the viewer once the canvas exists; dispose with the component
  $effect(() => {
    const c = canvas;
    if (!c) return;
    let v: BodyViewer | null = null;
    let gone = false;
    void import('../three-body.ts')
      .then(({ createBodyViewer }) => {
        if (gone) return;
        v = createBodyViewer(c);
        viewer = v;
      })
      .catch((e: Error) => (error = `3D view unavailable: ${e.message}`));
    return () => {
      gone = true;
      v?.dispose();
      viewer = null;
    };
  });

  $effect(() => {
    if (viewer && result?.ok) viewer.setBody(result.body);
  });

  $effect(() => {
    const v = viewer;
    if (!v || !host) return;
    const ro = new ResizeObserver(() => v.resize(host!.clientWidth, host!.clientHeight));
    ro.observe(host);
    return () => ro.disconnect();
  });

  const views: [ViewPreset, string][] = [['iso', 'reset'], ['top', 'top'], ['bottom', 'bottom'], ['front', 'front']];
</script>

<div class="b3">
  {#if result?.ok}
    <div class="stage" bind:this={host}><canvas bind:this={canvas}></canvas></div>
    <div class="meta">
      <span>height {result.body.height} mm</span>
      <span class="muted">drag to rotate · right-drag to pan · wheel to zoom</span>
      <span class="grow"></span>
      {#each views as [v, label] (v)}<button class="link" onclick={() => viewer?.view(v)}>{label}</button>{/each}
    </div>
    {#if error}<div class="note">{error}</div>{/if}
    {#each result.body.notes as n, i (i)}<div class="note">{n}</div>{/each}
  {:else if result && !result.ok}
    <div class="empty">No 3D body: {result.reason}.</div>
  {:else}
    <div class="empty">No package data for a 3D body.</div>
  {/if}
</div>

<style>
  .b3 { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .stage { flex: 1; min-height: 0; position: relative; }
  canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; cursor: grab; touch-action: none; }
  canvas:active { cursor: grabbing; }
  .meta { display: flex; gap: 10px; padding: 4px 8px; font-size: 11px; color: var(--txt-3); border-top: 1px solid var(--line); flex-wrap: wrap; }
  .grow { flex: 1; }
  .note { padding: 0 8px 4px; font-size: 11px; color: var(--warn); }
  .link { border: 0; background: none; padding: 0; color: var(--accent-txt); cursor: pointer; font: inherit; }
  .empty { margin: auto; padding: 16px; color: var(--txt-3); font-size: 12px; text-align: center; }
</style>
