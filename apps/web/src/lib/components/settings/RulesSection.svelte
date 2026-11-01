<script lang="ts">
  import { SCHEMATIC_CHECKS, SCHEMATIC_NOTES_PLACEHOLDER, changedChecks, resolveChecks, type RuleLevel } from '@4k7/schema';
  import { app } from '../../app.svelte.ts';
  import Field from './Field.svelte';
  import NotesField from './NotesField.svelte';
  import Section from './Section.svelte';

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
    {#if app.settings.schematicNotes.trim() || changed}<span class="tag info">your own</span>{:else}<span class="tag">default</span>{/if}
  {/snippet}

  <NotesField setting="schematicNotes" what="how to draw schematics" placeholder={SCHEMATIC_NOTES_PLACEHOLDER} />

  <Field label="Checks">
    {#snippet hint()}
      These say how a schematic reads, not whether the circuit is right, so they guide the agent and stay out of Issues.
      <b>Must fix</b>: it fixes a finding before it finishes, and one it cannot shows under Issues. <b>Warn</b>: it looks over the ones its own changes bring. <b>Note</b>: it can read them, no more.
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
