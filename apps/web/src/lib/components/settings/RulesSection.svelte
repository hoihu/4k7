<script lang="ts">
  import { untrack } from 'svelte';
  import { SCHEMATIC_CHECKS, SCHEMATIC_NOTES_PLACEHOLDER, changedChecks, resolveChecks, type RuleLevel } from '@4k7/schema';
  import { app } from '../../app.svelte.ts';
  import Field from './Field.svelte';
  import Section from './Section.svelte';

  /** The text in the box, saved after a pause in typing. */
  let text = $state(untrack(() => app.settings.schematicNotes));
  let timer: ReturnType<typeof setTimeout> | undefined;

  // another tab (or Clear) changed the setting: show it, unless it is what the box already says
  $effect(() => {
    const t = app.settings.schematicNotes;
    if (t !== untrack(() => text)) text = t;
  });

  function save() {
    clearTimeout(timer);
    timer = undefined;
    const next = text.trim() ? text : '';
    if (next !== app.settings.schematicNotes) void app.updateSettings({ schematicNotes: next });
  }

  function typed() {
    clearTimeout(timer);
    timer = setTimeout(save, 800);
  }

  function clear() {
    clearTimeout(timer);
    text = '';
    void app.updateSettings({ schematicNotes: '' });
  }

  const LEVELS: { level: RuleLevel; label: string }[] = [
    { level: 'error', label: 'Must fix' },
    { level: 'warning', label: 'Warn' },
    { level: 'info', label: 'Note' },
    { level: 'off', label: 'Off' },
  ];

  const checks = $derived(resolveChecks(app.settings.schematicChecks));
  const changed = $derived(Object.keys(app.settings.schematicChecks).length > 0);

  function setCheck(id: string, patch: { level?: RuleLevel; max?: number }) {
    const cur = app.settings.schematicChecks;
    void app.updateSettings({ schematicChecks: changedChecks({ ...cur, [id]: { ...cur[id], ...patch } }) });
  }

  function setMax(id: string, e: Event) {
    const n = Number((e.currentTarget as HTMLInputElement).value);
    if (Number.isInteger(n) && n >= 0) setCheck(id, { max: n });
  }
</script>

<Section id="rules" title="Schematic drawing">
  {#snippet status()}
    {#if text.trim() || changed}<span class="tag info">your own</span>{:else}<span class="tag">default</span>{/if}
  {/snippet}

  <Field label="Your notes">
    {#snippet hint()}
      The agent reads these with every request, and they win over its own habits. Keep them short. Saved as you type.
    {/snippet}
    <textarea class="text notes" aria-label="Your notes on how to draw schematics" placeholder={SCHEMATIC_NOTES_PLACEHOLDER} bind:value={text} oninput={typed} onblur={save}></textarea>
    <div class="row">
      <button class="btn" onclick={clear} disabled={!text}>Clear</button>
    </div>
  </Field>

  <Field label="Checks">
    {#snippet hint()}
      <b>Must fix</b>: the agent fixes it before it finishes. <b>Warn</b> and <b>Note</b> show in the list of findings.
      {#if changed}<button class="link" onclick={() => app.updateSettings({ schematicChecks: {} })}>Back to the defaults</button>{/if}
    {/snippet}
    <div class="checks">
      {#each SCHEMATIC_CHECKS as c (c.id)}
        {@const r = checks[c.id]!}
        <div class="check">
          <div class="what">
            <div class="title">{c.title}</div>
            <div class="muted">{c.text}</div>
          </div>
          <div class="how">
            <div class="seg">
              {#each LEVELS as l (l.level)}<button aria-pressed={r.level === l.level} onclick={() => setCheck(c.id, { level: l.level })}>{l.label}</button>{/each}
            </div>
            {#if r.max !== undefined}
              <label class="max">allowed <input class="text" type="number" min="0" step="1" value={r.max} onchange={(e) => setMax(c.id, e)} /></label>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  </Field>
</Section>

<style>
  .notes { width: 100%; box-sizing: border-box; min-height: 180px; max-height: 50vh; resize: vertical; line-height: 1.45; }
  .row { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
  .checks { display: flex; flex-direction: column; }
  .check { display: flex; gap: 10px; align-items: center; justify-content: space-between; padding: 5px 0; border-bottom: 1px solid var(--line); }
  .check:last-child { border-bottom: 0; }
  .what { min-width: 0; }
  .title { color: var(--txt); }
  .muted { font-size: 11.5px; }
  .how { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex-shrink: 0; }
  .max { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--txt-3); }
  .max input { width: 52px; padding: 1px 6px; }
  .link { border: 0; background: none; padding: 0; margin-left: 6px; color: var(--accent); font-size: inherit; cursor: pointer; }
  @media (max-width: 560px) { .check { flex-direction: column; align-items: stretch; } .how { align-items: flex-start; } }
</style>
