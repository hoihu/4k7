<script lang="ts">
  import { app, type ChatItem } from '../app.svelte.ts';

  let { item }: { item: ChatItem } = $props();

  const live = $derived(item.changeset?.state === 'pending' ? app.k?.proposal ?? null : null);
  const delta = $derived(live ? { e: live.after.errors - live.before.errors, w: live.after.warnings - live.before.warnings } : null);
  const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
</script>

{#if item.changeset}
  <div class="cs" class:done={item.changeset.state !== 'pending'}>
    {#if live}
      <div class="cs-h">
        <b class="grow trunc">{live.hunks.length} change{live.hunks.length === 1 ? '' : 's'} to review</b>
        {#if delta && delta.e !== 0}<span class="n e" title="errors">{sign(delta.e)}</span>{/if}
        {#if delta && delta.w !== 0}<span class="n w" title="warnings">{sign(delta.w)}</span>{/if}
        <span class="muted mono">{live.after.errors}E {live.after.warnings}W</span>
      </div>
      <ul class="rows">
        {#each live.hunks as h (h.id)}
          {@const off = !!app.hunkOff[h.id]}
          <li
            class="r"
            class:rej={off}
            title={h.details.join('\n')}
            onmouseenter={() => (app.hoverHunk = h.entityId)}
            onmouseleave={() => (app.hoverHunk = null)}
          >
            <span class="gl {h.change}">{h.change === 'add' ? '+' : h.change === 'remove' ? '−' : '~'}</span>
            <span class="grow trunc">{h.title}{#if h.kind !== 'component'} <span class="d">{h.kind}</span>{/if}</span>
            <span class="yn">
              <button class="y" aria-pressed={!off} aria-label="Accept {h.title}" onclick={() => delete app.hunkOff[h.id]}>✓</button>
              <button class="n" aria-pressed={off} aria-label="Reject {h.title}" onclick={() => (app.hunkOff[h.id] = true)}>✕</button>
            </span>
          </li>
        {/each}
      </ul>
      <div class="cs-f">
        <button class="btn pri" onclick={() => app.accept()} disabled={app.running || app.acceptedCount === 0}>Accept {app.acceptedCount}</button>
        <button class="btn" onclick={() => app.reject()} disabled={app.running}>Reject</button>
        <span class="grow"></span>
        <span class="muted" style="font-size:11px">hover a row to see it on the canvas</span>
      </div>
    {:else}
      <div class="cs-h"><span class="muted">{item.changeset.state === 'accepted' ? '✓' : item.changeset.state === 'rejected' ? '✕' : '↓'} {item.changeset.note}</span></div>
    {/if}
  </div>
{/if}

<style>
  .cs { border: 1px solid var(--line-2); border-radius: 8px; margin-top: 6px; overflow: hidden; background: var(--panel); }
  .cs-h { display: flex; align-items: center; gap: 6px; padding: 5px 8px; background: var(--panel-2); font-size: 12px; }
  .cs.done .cs-h { background: var(--panel-2); }
  .cs .r { min-height: 24px; padding: 0 6px 0 8px; font-size: 12px; cursor: default; }
  .r .d { color: var(--txt-3); font-size: 11px; }
  .r.rej .grow { text-decoration: line-through; color: var(--txt-3); }
  .yn { display: inline-flex; border: 1px solid var(--line); border-radius: 5px; overflow: hidden; flex: none; }
  .yn button { border: 0; background: transparent; padding: 0 6px; font-size: 11px; line-height: 18px; color: var(--txt-3); }
  .yn button[aria-pressed="true"].y { background: var(--ok-soft); color: var(--ok); }
  .yn button[aria-pressed="true"].n { background: var(--err-soft); color: var(--err); }
  .cs-f { display: flex; gap: 6px; align-items: center; padding: 5px 8px; border-top: 1px solid var(--line); }
</style>
