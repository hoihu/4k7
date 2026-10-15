<script lang="ts">
  import { boardBodies } from '@4k7/parts';
  import type { BoardView } from '@4k7/schema';
  import type { BoardViewer, TopView, ViewPreset } from '../three-body.ts';

  /**
   * The assembled board in 3D (three.js, loaded when first shown). With `from` (the 2D view's
   * area), it starts exactly at that top-down view and flies into 3D; `onready` once the first
   * frame is drawn (so the 2D view can step aside without a blank moment).
   */
  let { board, from = null, onready }: { board: BoardView; from?: TopView | null; onready?: () => void } = $props();
  let started = false;

  /** Fly back to straight above the current point (before switching to 2D). */
  export async function flyToTop(): Promise<TopView | null> {
    return viewer ? viewer.flyToTop() : null;
  }

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
      .catch((e: Error) => {
        error = `3D view unavailable: ${e.message}`;
        onready?.();
      });
    return () => {
      gone = true;
      v?.dispose();
      viewer = null;
    };
  });

  $effect(() => {
    if (!viewer) return;
    viewer.setBoard(board, boardBodies(board));
    if (!started) {
      started = true;
      if (from) viewer.flyFromTop(from);
      requestAnimationFrame(() => onready?.());
    }
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
