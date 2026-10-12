<script lang="ts">
  import type { Design } from '@4k7/schema';
  import { app } from '../../app.svelte.ts';
  import { disk } from '../../disk.svelte.ts';
  import Field from './Field.svelte';
  import Section from './Section.svelte';

  let fileInput: HTMLInputElement | undefined = $state();

  $effect(() => {
    if (disk.status === 'ok') void app.refreshProjects();
  });

  function download(json: string, name: string) {
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.twd.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /** The save dialog where the browser has one (Chrome, Edge); a download elsewhere. */
  type SavePicker = (o: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;

  async function saveCopy() {
    const json = await app.exportJson();
    const name = app.k?.summary.name ?? 'design';
    const pick = (window as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
    if (!pick) return download(json, name);
    try {
      const handle = await pick({ suggestedName: `${name}.twd.json`, types: [{ description: '4k7 project', accept: { 'application/json': ['.json'] } }] });
      const w = await handle.createWritable();
      await w.write(json);
      await w.close();
      app.flash(`Saved a copy as ${handle.name}`);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') app.flash(`Could not save the copy: ${(e as Error).message}`);
    }
  }

  /** Changes that could not be written are lost when another project replaces this one. */
  const leave = () => !app.unsaved || window.confirm('The open project has changes that are not saved (the 4k7 server is not reachable). Leave them?');

  /** A file from the projects folder opens in place; any other is copied in as a new project. */
  async function openFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f || !leave()) return;
    try {
      const text = await f.text();
      const id = f.name.replace(/\.twd\.json$|\.json$/, '');
      // the open project's own file may lag behind a save in flight, so its name is enough
      const inFolder = id === app.projectId || (app.projects.some((p) => p.id === id) && (await disk.loadProject(id).catch(() => undefined)) === text);
      if (inFolder) {
        if (id !== app.projectId && !(await app.openProject(id))) return;
      } else {
        await app.importDesign(JSON.parse(text) as Design);
        app.flash(`Copied ${f.name} into the projects folder`);
      }
      app.view = 'sch';
    } catch (err) {
      app.flash(`Could not open ${f.name}: ${(err as Error).message}`);
    }
  }

  let newName = $state('');

  function newProject(e: SubmitEvent) {
    e.preventDefault();
    if (leave()) void app.newProject(newName.trim() || 'untitled').then(() => ((newName = ''), (app.view = 'sch')));
  }
</script>

<Section id="project" title="General">
  <Field label="Project">
    <div class="row">
      <input class="text grow" aria-label="Project name" value={app.k?.summary.name ?? ''} onchange={(e) => app.renameProject((e.currentTarget as HTMLInputElement).value)} />
      <button class="btn" onclick={() => app.revealProjects()} disabled={disk.status !== 'ok'}>Show folder</button>
      <button class="btn" onclick={saveCopy} title="Save a copy elsewhere; you keep working on this project">Save copy as…</button>
    </div>
    {#snippet hint()}
      {#if disk.status !== 'ok'}<span class="bad">Not saved: the 4k7 server is not reachable.</span>
      {:else if app.unsaved}<span class="bad">Not saved yet.</span>
      {:else if app.projectId}<code>{disk.projectsDir}/{app.projectId}.twd.json</code> · saved as you work{/if}
    {/snippet}
  </Field>
  <Field label="Open" hint="Files from elsewhere are copied into the projects folder.">
    <button class="btn" onclick={() => fileInput?.click()}>Open file…</button>
    <input type="file" accept=".json,application/json" hidden bind:this={fileInput} onchange={openFile} />
  </Field>
  <Field label="New">
    <form class="row" onsubmit={newProject}>
      <input class="text grow" aria-label="New project name" placeholder="untitled" bind:value={newName} />
      <button class="btn">Create</button>
    </form>
  </Field>
</Section>

<style>
  .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .grow { flex: 1; min-width: 10em; }
  code { overflow-wrap: anywhere; }
  .bad { color: var(--err); }
</style>
