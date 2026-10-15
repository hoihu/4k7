<script lang="ts">
  import { untrack } from 'svelte';
  import { app } from '../../app.svelte.ts';
  import Field from './Field.svelte';

  /** The user's own notes for the agent (schematic or board layout): a text box saved after a pause in typing. */
  let { setting, what, placeholder }: { setting: 'schematicNotes' | 'layoutNotes'; what: string; placeholder: string } = $props();

  let text = $state(untrack(() => app.settings[setting]));
  let timer: ReturnType<typeof setTimeout> | undefined;

  // another tab (or Clear) changed the setting: show it, unless it is what the box already says
  $effect(() => {
    const t = app.settings[setting];
    if (t !== untrack(() => text)) text = t;
  });

  function save() {
    clearTimeout(timer);
    timer = undefined;
    const next = text.trim() ? text : '';
    if (next !== app.settings[setting]) void app.updateSettings({ [setting]: next });
  }

  function typed() {
    clearTimeout(timer);
    timer = setTimeout(save, 800);
  }

  function clear() {
    clearTimeout(timer);
    text = '';
    void app.updateSettings({ [setting]: '' });
  }
</script>

<Field label="Your notes">
  {#snippet hint()}
    The agent reads these with every request, and they win over its own habits. Keep them short. Saved as you type.
  {/snippet}
  <textarea class="text notes" aria-label="Your notes on {what}" {placeholder} bind:value={text} oninput={typed} onblur={save}></textarea>
  <div class="row">
    <button class="btn" onclick={clear} disabled={!text}>Clear</button>
  </div>
</Field>

<style>
  .notes { width: 100%; box-sizing: border-box; min-height: 180px; max-height: 50vh; resize: vertical; line-height: 1.45; }
  .row { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
</style>
