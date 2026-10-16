<script lang="ts">
  import type { EnclosureScene, EnclosureViewer, SceneOptions } from '../enclosure3d.ts';

  /**
   * The enclosure in 3D: the board with the pieces OpenSCAD rendered (three.js, loaded when first
   * shown). `cut`: a section through a part's opening (the plane across the wall along its plug's way).
   */
  let { scene, options, cut = null }: { scene: EnclosureScene; options: SceneOptions; cut?: string | null } = $props();

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
        v = createEnclosureViewer(c);
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
    if (!viewer) return;
    const m = cut ? scene.facts.parts.find((p) => p.ref === cut)?.mating : null;
    viewer.section(m ? { at: m.origin, normal: m.u } : null);
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
