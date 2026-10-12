<script lang="ts">
  import { HARNESSES, type HarnessId } from '@4k7/schema';
  import { server } from '../../server.svelte.ts';
  import Field from './Field.svelte';
  import Section from './Section.svelte';

  /** The path typed per agent (until saved), the save in progress, and the last error. */
  let typed = $state<Partial<Record<HarnessId, string>>>({});
  let saving = $state<HarnessId | null>(null);
  let errors = $state<Partial<Record<HarnessId, string>>>({});
  let looking = $state(false);

  const connected = $derived(server.status === 'connected');
  const knowsPaths = $derived(server.harnesses.some((h) => h.binFrom));

  $effect(() => {
    void server.harnesses;
    looking = false;
  });

  async function save(id: HarnessId, bin: string | null) {
    saving = id;
    const error = await server.setAgentBin(id, bin);
    saving = null;
    errors = { ...errors, [id]: error ?? '' };
    if (!error) typed = { ...typed, [id]: undefined };
  }

  function lookAgain() {
    looking = server.detectAgents();
  }
</script>

<Section id="agents" title="Coding agents">
  {#snippet status()}
    {#if connected}<span class="tag ok">{server.harnesses.filter((h) => h.available).length} of {HARNESSES.length} found</span>{:else}<span class="tag warn">server not connected</span>{/if}
  {/snippet}

  {#if !connected}
    <Field label="Programs" hint="The local server runs the agents; connect it to see and change which programs it uses (see Local server).">
      <span class="muted">not connected</span>
    </Field>
  {:else if !knowsPaths}
    <Field label="Programs" hint="Restart the server to choose the agents' programs here (this one is older).">
      <span class="muted">set FOURK7_CLAUDE_BIN, FOURK7_COPILOT_BIN or FOURK7_OPENCODE_BIN instead</span>
    </Field>
  {:else}
    {#each HARNESSES as h (h.id)}
      {@const cap = server.harnesses.find((c) => c.id === h.id)}
      {@const value = typed[h.id] ?? (cap?.binFrom === 'settings' ? (cap.bin ?? '') : '')}
      <Field label={h.name}>
        {#snippet hint()}
          {#if errors[h.id]}<span class="err">{errors[h.id]}</span>
          {:else if cap?.binFrom === 'env'}Set by {cap.binEnv} when the server started.
          {:else if cap?.binFrom === 'settings'}Set here.{#if !cap.available} {cap.reason}{/if}
          {:else if cap?.available}Found on the PATH{#if cap.path}: <span class="mono">{cap.path}</span>{/if}. Give a full path to run another one.
          {:else}Not found. <a href={h.install} target="_blank" rel="noreferrer">Install it</a>, sign in once in a terminal, then press Look again, or give the full path.{/if}
        {/snippet}
        <div class="row">
          <span class="tag" class:ok={cap?.available} class:warn={!cap?.available} title={cap?.available ? cap.version : cap?.reason}>{cap?.available ? (cap.version?.match(/\d+(\.\d+)+/)?.[0] ?? 'ok') : 'not found'}</span>
          <input
            class="text grow mono"
            {value}
            disabled={cap?.binFrom === 'env' || saving === h.id}
            placeholder={cap?.binFrom === 'env' ? (cap.bin ?? '') : (cap?.path ?? `/full/path/to/${h.id === 'claude-code' ? 'claude' : h.id}`)}
            spellcheck="false"
            autocomplete="off"
            aria-label={`${h.name} program`}
            oninput={(e) => (typed = { ...typed, [h.id]: (e.currentTarget as HTMLInputElement).value })}
            onkeydown={(e) => e.key === 'Enter' && value.trim() && void save(h.id, value.trim())}
          />
          {#if cap?.binFrom !== 'env'}
            <button class="btn" disabled={!value.trim() || saving === h.id || (cap?.binFrom === 'settings' && value.trim() === cap.bin)} onclick={() => save(h.id, value.trim())}>{saving === h.id ? 'Checking…' : 'Save'}</button>
            {#if cap?.binFrom === 'settings'}<button class="ib" disabled={saving === h.id} onclick={() => save(h.id, null)} title="Look for it on the PATH again">use PATH</button>{/if}
          {/if}
        </div>
      </Field>
    {/each}
    <Field label="" hint="After installing an agent or signing in. The paths are kept in the server's settings file (~/.4k7/server.json).">
      <button class="btn" disabled={looking} onclick={lookAgain}>{looking ? 'Looking…' : 'Look again'}</button>
    </Field>
  {/if}
</Section>

<style>
  .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .row input.text { flex: 1 1 200px; min-width: 0; }
  .err { color: var(--err); }
</style>
