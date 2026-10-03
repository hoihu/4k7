<script lang="ts">
  import type { Snippet } from 'svelte';
  /** One settings row: label on the left, control on the right, an optional one-line hint under the control. */
  let { label, hint, children }: { label: string; hint?: string | Snippet; children: Snippet } = $props();
</script>

<div class="field">
  <div class="label">{label}</div>
  <div class="ctl">
    {@render children()}
    {#if typeof hint === 'string'}<div class="hint">{hint}</div>{:else if hint}<div class="hint">{@render hint()}</div>{/if}
  </div>
</div>

<style>
  .field { display: grid; grid-template-columns: 110px 1fr; gap: 0 8px; padding: 6px 10px; border-bottom: 1px solid var(--line); }
  .field:last-child { border-bottom: 0; }
  .label { color: var(--txt-3); padding-top: 3px; }
  .ctl { min-width: 0; }
  .hint { font-size: 11px; color: var(--txt-3); margin-top: 4px; }
  @media (max-width: 480px) { .field { grid-template-columns: 1fr; gap: 2px; } }
</style>
