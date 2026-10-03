<script lang="ts">
  import type { Snippet } from 'svelte';
  let { id, title, status, children }: { id: string; title: string; status?: Snippet; children: Snippet } = $props();
</script>

<section class="card" {id}>
  <div class="ph"><b>{title}</b><span class="grow"></span>{#if status}{@render status()}{/if}</div>
  <div class="body">{@render children()}</div>
</section>

<style>
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; min-width: 0; scroll-margin-top: 10px; }
  .body { padding: 2px 0; font-size: 12.5px; }
</style>
