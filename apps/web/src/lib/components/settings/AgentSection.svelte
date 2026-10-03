<script lang="ts">
  import { app } from '../../app.svelte.ts';
  import type { Settings } from '../../persist.ts';
  import Field from './Field.svelte';
  import Section from './Section.svelte';

  function set<K extends keyof Settings>(k: K, v: Settings[K]) {
    void app.updateSettings({ [k]: v } as Partial<Settings>);
  }
</script>

<Section id="agent" title="Agent">
  <Field label="Autonomy" hint="Auto-commit applies a changeset as soon as the checks pass.">
    <div class="seg">
      <button aria-pressed={app.settings.mode === 'review'} onclick={() => set('mode', 'review')}>Review each changeset</button>
      <button aria-pressed={app.settings.mode === 'auto'} onclick={() => set('mode', 'auto')}>Auto-commit when clean</button>
    </div>
  </Field>
  <Field label="Fix budget" hint="How many verification rounds the agent gets per request. Applies to new conversations.">
    <div class="seg">
      {#each [2, 3, 5, 8] as n (n)}<button aria-pressed={app.settings.fixBudget === n} onclick={() => set('fixBudget', n)}>{n} rounds</button>{/each}
    </div>
  </Field>
</Section>
