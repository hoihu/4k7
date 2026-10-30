<script lang="ts">
  import type { EnclosureScene, EnclosureViewer, SceneOptions, ViewerSection } from '../enclosure3d.ts';

  /**
   * The enclosure in 3D: the board with the pieces the script made (three.js, loaded when first
   * shown). `cut`: a section, with a frame round it the user drags to move it (`onmove`: to where).
   */
  let { scene, options, cut = null, onmove }: { scene: EnclosureScene; options: SceneOptions; cut?: ViewerSection | null; onmove?: (at: number) => void } = $props();

  /** Where the camera is (board coordinates): a new cut takes away the half it looks from. */
  export function eye(): [number, number, number] | null {
    return viewer?.eye() ?? null;
  }

  let host: HTMLDivElement | undefined = $state();
  let canvas: HTMLCanvasElement | undefined = $state();
  let viewer = $state.raw<EnclosureViewer | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    const c = canvas;
    if (!c) return;
    let v: EnclosureViewer | null = null;
    let gone = false;
    void import('../enclosure3d.ts')
      .then(({ createEnclosureViewer }) => {
        if (gone) return;
        v = createEnclosureViewer(c, (at) => onmove?.(at));
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
    viewer?.setScene(scene, options);
  });

  $effect(() => {
    viewer?.section(cut ? $state.snapshot(cut) : null);
  });

  $effect(() => {
    const v = viewer;
    if (!v || !host) return;
    const ro = new ResizeObserver(() => v.resize(host!.clientWidth, host!.clientHeight));
    ro.observe(host);
    return () => ro.disconnect();
  });

  const views: ['iso' | 'top' | 'bottom' | 'front', string][] = [['iso', 'reset'], ['top', 'top'], ['bottom', 'bottom'], ['front', 'front']];
</script>

<div class="e3" bind:this={host}>
  <canvas bind:this={canvas}></canvas>
  <div class="views">
    {#each views as [v, label] (v)}<button onclick={() => viewer?.view(v)}>{label}</button>{/each}
  </div>
  {#if error}<div class="err">{error}</div>{/if}
</div>

<style>
  .e3 { position: absolute; inset: 0; background: radial-gradient(ellipse at 50% 40%, #1a2230, var(--canvas)); }
  canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; cursor: grab; touch-action: none; }
  canvas:active { cursor: grabbing; }
  .views { position: absolute; right: 10px; bottom: 32px; display: flex; gap: 2px; }
  .views button { border: 1px solid var(--line-2); background: var(--panel); color: var(--txt-2); font-size: 11px; padding: 2px 8px; border-radius: 5px; cursor: pointer; }
  .err { position: absolute; left: 10px; bottom: 32px; color: var(--err); font-size: 12px; }
</style>
