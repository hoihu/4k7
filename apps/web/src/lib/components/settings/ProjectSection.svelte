<script lang="ts">
  import type { Design } from '@tracewise/schema';
  import { app } from '../../app.svelte.ts';
  import Field from './Field.svelte';
  import Section from './Section.svelte';

  let fileInput: HTMLInputElement | undefined = $state();

  async function exportFile() {
    const json = await app.exportJson();
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${app.k?.summary.name ?? 'design'}.twd.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function importFile(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      await app.importDesign(JSON.parse(await f.text()) as Design);
      app.flash(`Loaded ${f.name}`);
      app.view = 'sch';
    } catch (err) {
      app.flash(`Import failed: ${(err as Error).message}`);
    }
  }

  function reset() {
    if (app.k?.summary.components.length === 0 || window.confirm('Start a new, empty project? The current one is replaced.')) void app.newProject();
  }
</script>

<Section id="project" title="Project">
  {#snippet status()}<span class="muted">stored locally in IndexedDB</span>{/snippet}
  <Field label="Name">
    <input class="text" value={app.k?.summary.name ?? ''} onchange={(e) => app.renameProject((e.currentTarget as HTMLInputElement).value)} />
  </Field>
  <Field label="File" hint="The native .twd.json format keeps the whole design and its board as solved now, so it opens unchanged in later versions.">
    <div class="row">
      <button class="btn" onclick={exportFile}>Export .twd.json</button>
      <button class="btn" onclick={() => fileInput?.click()}>Import…</button>
      <input type="file" accept=".json,application/json" hidden bind:this={fileInput} onchange={importFile} />
    </div>
  </Field>
  <Field label="Reset">
    <button class="btn" onclick={reset}>New empty project</button>
  </Field>
</Section>

<style>
  .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
</style>
