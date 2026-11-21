<script lang="ts">
  import { app, type ChatItem } from '../app.svelte.ts';

  /** An external agent's plan (propose_plan, the plan step). `readonly`: a message of an earlier conversation. */
  let { item, readonly = false }: { item: ChatItem; readonly?: boolean } = $props();

  const live = $derived(!readonly && item.plan?.state === 'pending');
  let comment = $state('');
  const mark = { accepted: '✓ Plan accepted', rejected: '✕ Plan rejected', superseded: '↓ Replaced by a newer plan', unreviewed: '– Not decided when this conversation ended', pending: '– Not decided when this conversation ended' };

  function decide(accepted: boolean) {
    app.decidePlan(accepted, comment);
    comment = '';
  }
</script>

{#if item.plan}
  <div class="cs" class:done={!live}>
    <div class="cs-h"><b class="grow trunc">{live ? 'Plan to review' : mark[item.plan.state]}</b><span class="muted">{item.plan.steps.length} step{item.plan.steps.length === 1 ? '' : 's'}</span></div>
    {#if item.plan.summary}<div class="sum">{item.plan.summary}</div>{/if}
    <ol class="steps">
      {#each item.plan.steps as s, i (i)}<li>{s}</li>{/each}
    </ol>
    {#if live}
      <div class="cs-f">
        <input class="text grow" aria-label="Comment on the plan" placeholder="Comment (optional): what to change or keep in mind" bind:value={comment} />
        <button class="btn pri" onclick={() => decide(true)}>Accept</button>
        <button class="btn" onclick={() => decide(false)}>Reject</button>
      </div>
    {:else if item.plan.comment}
      <div class="sum muted">Comment: {item.plan.comment}</div>
    {/if}
  </div>
{/if}

<style>
  .cs { border: 1px solid var(--line-2); border-radius: 8px; margin-top: 6px; overflow: hidden; background: var(--panel); }
  .cs-h { display: flex; align-items: center; gap: 6px; padding: 5px 8px; background: var(--panel-2); font-size: 12px; }
  .sum { padding: 5px 8px 0; font-size: 12px; }
  .steps { margin: 0; padding: 5px 8px 6px 28px; font-size: 12px; }
  .steps li { margin: 2px 0; }
  .cs.done .steps { color: var(--txt-2); }
  .cs-f { display: flex; gap: 6px; align-items: center; padding: 5px 8px; border-top: 1px solid var(--line); }
  .grow { flex: 1; min-width: 6em; }
</style>
