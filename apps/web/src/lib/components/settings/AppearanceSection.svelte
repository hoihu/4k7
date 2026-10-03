<script lang="ts">
  import { app } from '../../app.svelte.ts';
  import type { Settings } from '../../persist.ts';
  import Field from './Field.svelte';
  import Section from './Section.svelte';
</script>

<Section id="appearance" title="Appearance">
  <Field label="Theme">
    <div class="seg">
      {#each ['system', 'light', 'dark'] as t (t)}
        <button aria-pressed={app.settings.theme === t} onclick={() => void app.updateSettings({ theme: t as Settings['theme'] })}>{t}</button>
      {/each}
    </div>
  </Field>
</Section>
