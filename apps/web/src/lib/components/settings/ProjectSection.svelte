<script lang="ts">
  import type { Design } from '@4k7/schema';
  import { app } from '../../app.svelte.ts';
  import Field from './Field.svelte';
  import Section from './Section.svelte';

  let fileInput: HTMLInputElement | undefined = $state();

  function download(json: string, name: string) {
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.twd.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function exportFile() {
    download(await app.exportJson(), app.k?.summary.name ?? 'design');
  }

  function deleteKept(key: string) {
    if (window.confirm('Delete this kept project? Download it first if you still need it.')) void app.deleteKeptProject(key);
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
  <Field label="File" hint="The native .twd.json format keeps the whole design, including history.">
    <div class="row">
      <button class="btn" onclick={exportFile}>Export .twd.json</button>
      <button class="btn" onclick={() => fileInput?.click()}>Import…</button>
      <input type="file" accept=".json,application/json" hidden bind:this={fileInput} onchange={importFile} />
    </div>
  </Field>
  {#each app.keptProjects as kept (kept.key)}
    <Field label="Kept copy" hint={`Saved project from ${new Date(kept.at).toLocaleString()} that could not be loaded: ${kept.reason}`}>
      <div class="row">
        <button class="btn" onclick={() => download(kept.json, `unreadable-${new Date(kept.at).toISOString().slice(0, 10)}`)}>Download</button>
        <button class="btn" onclick={() => deleteKept(kept.key)}>Delete</button>
      </div>
    </Field>
  {/each}
  <Field label="Reset">
    <button class="btn" onclick={reset}>New empty project</button>
  </Field>
</Section>

<style>
  .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
</style>
