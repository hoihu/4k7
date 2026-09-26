<script lang="ts">
  import { body3dFor, type Body3D } from '@tracewise/parts';
  import type { BoardView } from '@tracewise/schema';
  import type { BoardViewer, ViewPreset } from '../three-body.ts';

  /** The assembled board in 3D (three.js, loaded when first shown). */
  let { board }: { board: BoardView } = $props();

  let host: HTMLDivElement | undefined = $state();
  let canvas: HTMLCanvasElement | undefined = $state();
  let viewer = $state.raw<BoardViewer | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    const c = canvas;
    if (!c) return;
    let v: BoardViewer | null = null;
    let gone = false;
    void import('../three-body.ts')
      .then(({ createBoardViewer }) => {
        if (gone) return;
        v = createBoardViewer(c);
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
    if (!viewer) return;
    const bodies = new Map<string, Body3D>();
    for (const p of board.parts) {
      const r = body3dFor(p.pkgInfo, p.pads.map((x) => x.number));
      if (r.ok) bodies.set(p.componentId, r.body);
    }
    viewer.setBoard(board, bodies);
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

<div class="b3" bind:this={host}>
  <canvas bind:this={canvas}></canvas>
  <div class="views">
    {#each views as [v, label] (v)}<button onclick={() => viewer?.view(v)}>{label}</button>{/each}
  </div>
  {#if error}<div class="err">{error}</div>{/if}
</div>

<style>
  .b3 { position: absolute; inset: 0; background: radial-gradient(ellipse at 50% 40%, #1a2230, var(--canvas)); }
  canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; cursor: grab; touch-action: none; }
  canvas:active { cursor: grabbing; }
  .views { position: absolute; right: 10px; bottom: 32px; display: flex; gap: 2px; }
  .views button { border: 1px solid var(--line-2); background: var(--panel); color: var(--txt-2); font-size: 11px; padding: 2px 8px; border-radius: 5px; cursor: pointer; }
  .err { position: absolute; left: 10px; bottom: 32px; color: var(--err); font-size: 12px; }
</style>
