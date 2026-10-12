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

  async function exportFile() {
    download(await app.exportJson(), app.k?.summary.name ?? 'design');
  }

  /** Changes that could not be written are lost when another project replaces this one. */
  const leave = () => !app.unsaved || window.confirm('The open project has changes that are not saved (the 4k7 server is not reachable). Leave them?');

  async function importFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f || !leave()) return;
    try {
      await app.importDesign(JSON.parse(await f.text()) as Design);
      app.flash(`Imported ${f.name} as a new project`);
      app.view = 'sch';
    } catch (err) {
      app.flash(`Import failed: ${(err as Error).message}`);
    }
  }

  async function open(e: Event) {
    const select = e.currentTarget as HTMLSelectElement;
    const id = select.value;
    if (id === app.projectId) return;
    if (!leave() || !(await app.openProject(id))) {
      select.value = app.projectId ?? '';
      return;
    }
    app.view = 'sch';
  }

  function newProject() {
    if (leave()) void app.newProject().then(() => (app.view = 'sch'));
  }

  const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
</script>

<Section id="project" title="Project">
  {#snippet status()}
    {#if disk.status !== 'ok'}<span class="bad">not saved: server not reachable</span>
    {:else if app.unsaved}<span class="bad">not saved</span>
    {:else if app.projectId}<span class="muted">saved to {app.projectId}.twd.json</span>{/if}
  {/snippet}
  <Field label="Open" hint={disk.projectsDir ? `Every project is a file in ${disk.projectsDir}, saved as you work.` : 'Projects are files on this computer, kept by the 4k7 server.'}>
    <div class="row">
      <select class="text sel" aria-label="Project" value={app.projectId ?? ''} onchange={open} disabled={disk.status !== 'ok'}>
        {#if !app.projectId}<option value="">{app.k?.summary.name ?? 'untitled'} (not saved yet)</option>{/if}
        {#each app.projects as p (p.id)}
          <option value={p.id}>{p.id} · {when(p.modified)}</option>
        {/each}
      </select>
      <button class="btn" onclick={newProject}>New</button>
      <button class="btn" onclick={() => app.revealProjects()} disabled={disk.status !== 'ok'}>Show folder</button>
    </div>
  </Field>
  <Field label="Name" hint="Renames the project's file too.">
    <input class="text" value={app.k?.summary.name ?? ''} onchange={(e) => app.renameProject((e.currentTarget as HTMLInputElement).value)} />
  </Field>
  <Field label="File" hint="A copy of the project to send or keep elsewhere (.twd.json keeps the whole design, history included). Import opens one as a new project.">
    <div class="row">
      <button class="btn" onclick={exportFile}>Download .twd.json</button>
      <button class="btn" onclick={() => fileInput?.click()}>Import…</button>
      <input type="file" accept=".json,application/json" hidden bind:this={fileInput} onchange={importFile} />
    </div>
  </Field>
</Section>

<style>
  .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .sel { flex: 1; min-width: 12em; }
  .bad { color: var(--err); }
</style>
