<script lang="ts">
  import { app, type ChatItem } from '../app.svelte.ts';
  import ChangesetCard from './ChangesetCard.svelte';
  import { markdown } from '../markdown.ts';
  import { USAGE_TITLE, usageLine } from '../usage.ts';

  /** One message of the chat; `readonly`: from an earlier conversation the project file keeps. */
  let { m, readonly = false }: { m: ChatItem; readonly?: boolean } = $props();

  const thumb = (f: { mime: string; data: string }) => `data:${f.mime};base64,${f.data}`;
</script>

{#if m.role === 'user'}
  <div class="m u">
    {#if m.refs?.length}<div class="refs">{#each m.refs as r (r)}<span class="rchip">@{r}</span>{/each}</div>{/if}
    {#if m.files?.length}
      <div class="files">
        {#each m.files as f (f.n)}
          {#if f.omitted}<span class="fchip" title={`${f.name}: the project file left it out (the conversation was too large)`}>#{f.n} {f.name} · not kept</span>
          {:else if f.pages}<span class="fchip" title={f.name}>#{f.n} {f.name} · {f.pages} p.</span>
          {:else}<img class="fthumb" src={thumb(f)} alt={f.name} title={`#${f.n} ${f.name}`} />{/if}
        {/each}
      </div>
    {/if}
    {m.text}
  </div>
{:else}
  <div class="m a">
    {#if m.source}<div class="src"><span class="ext">⇄</span> {m.source} <span class="muted">via local server</span></div>{/if}
    {#each m.segments as s, i (i)}
      {#if s.type === 'text'}
        <!-- the agent's reply, rendered from Markdown (escaped; see markdown.ts) -->
        <div class="txt md">{@html markdown(s.text)}</div>
      {:else if s.type === 'thinking'}
        <details class="think"><summary>reasoning</summary><div>{s.text}</div></details>
      {:else if s.type === 'tool'}
        <div class="tl" title={s.detail}><span class={s.ok ? 'ok' : 'er'}>{s.ok ? '✓' : '✕'}</span> {s.label}<span class="muted"> · {s.detail}</span></div>
      {:else if s.type === 'verify'}
        <details class="verify"><summary>{#if s.review}kernel: {s.errors} new drawing finding{s.errors === 1 ? '' : 's'} → schematic review{:else}kernel: {s.errors} error{s.errors === 1 ? '' : 's'} open → fix round {s.round}{/if}</summary><pre>{s.message}</pre></details>
      {:else if s.type === 'question'}
        <div class="q">
          <div>{s.question}</div>
          <div class="opts">
            {#each s.options as o (o)}
              <button class="opt" class:chosen={s.answered === o} disabled={readonly || !!s.answered || app.running} onclick={() => app.send(o)}>{o}</button>
            {/each}
          </div>
        </div>
      {:else if s.type === 'error'}
        <div class="err">{s.text}</div>
      {:else if s.type === 'note'}
        <div class="note">{s.text}</div>
      {/if}
    {/each}
    {#if m.status === 'streaming'}<div class="working"><span class="dot"></span>{m.source ? `${m.source} is editing the working copy…` : 'working…'}</div>{/if}
    {#if m.usage}<div class="usage" title={USAGE_TITLE}>{usageLine(m.usage, m.usage.costUsd, m.usage.exact)}</div>{/if}
    <ChangesetCard item={m} {readonly} />
  </div>
{/if}
<style>
  .files { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 4px; }
  .fthumb { display: block; height: 56px; max-width: 120px; object-fit: cover; border-radius: 5px; border: 1px solid var(--line-2); background: #fff; }
  .fchip { font-size: 11px; background: var(--panel-2); border: 1px solid var(--line-2); border-radius: 5px; padding: 2px 6px; display: inline-block; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .refs { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; margin-bottom: 3px; }
  .rchip { font-family: var(--mono); font-size: 11px; background: var(--info-soft); color: var(--info); border-radius: 4px; padding: 0 5px; line-height: 18px; }
  .m { font-size: 12.5px; min-width: 0; overflow-wrap: anywhere; }
  .m.u { align-self: flex-end; background: var(--accent-soft); border-radius: 8px; padding: 6px 9px; max-width: 90%; white-space: pre-wrap; }
  .m.a { padding: 0 2px; display: flex; flex-direction: column; gap: 3px; }
  .txt { white-space: pre-wrap; }
  .usage { font-family: var(--mono); font-size: 10.5px; color: var(--txt-3); margin-top: 3px; }
  .txt.md { white-space: normal; }
  .md :global(p) { margin: 0 0 6px; }
  .md :global(p:last-child), .md :global(ul:last-child), .md :global(ol:last-child) { margin-bottom: 0; }
  .md :global(ul), .md :global(ol) { margin: 0 0 6px; padding-left: 18px; }
  .md :global(li) { margin: 2px 0; }
  .md :global(h5) { margin: 8px 0 4px; font-size: 12.5px; }
  .md :global(code) { font-family: var(--mono); font-size: 0.92em; background: var(--panel-2); padding: 0 3px; border-radius: 3px; }
  .md :global(pre) { background: var(--panel-2); padding: 6px 8px; border-radius: 5px; overflow-x: auto; margin: 0 0 6px; }
  .md :global(pre code) { background: none; padding: 0; }
  .md :global(table) { border-collapse: collapse; margin: 0 0 6px; font-size: 0.95em; display: block; overflow-x: auto; max-width: 100%; }
  .md :global(th), .md :global(td) { border: 1px solid var(--line-2); padding: 2px 6px; text-align: left; vertical-align: top; }
  .md :global(th) { background: var(--panel-2); font-weight: 600; }
  .md :global(a) { color: var(--accent-txt, var(--accent)); }
  .tl { font-family: var(--mono); font-size: 11px; color: var(--txt-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tl .ok { color: var(--ok); } .tl .er { color: var(--err); }
  details summary { cursor: pointer; color: var(--txt-3); font-size: 11.5px; list-style: none; }
  details summary::before { content: '▸ '; }
  details[open] summary::before { content: '▾ '; }
  .think div { color: var(--txt-3); font-size: 11.5px; white-space: pre-wrap; padding: 2px 0 2px 12px; }
  .verify summary { color: var(--warn); font-family: var(--mono); font-size: 11px; }
  .verify pre { font-size: 10.5px; white-space: pre-wrap; color: var(--txt-2); margin: 2px 0 0 12px; }
  .q { border-left: 2px solid var(--accent); padding-left: 8px; }
  .opts { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 5px; }
  .opt { border: 1px solid var(--line-2); background: var(--panel); border-radius: 6px; padding: 2px 8px; font-size: 12px; text-align: left; }
  .opt.chosen { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-txt); opacity: 1; }
  .err { color: var(--err); font-size: 12px; }
  .note { color: var(--txt-3); font-size: 11.5px; }
  .src { font-size: 11px; color: var(--info); font-weight: 600; }
  .ext { font-family: var(--mono); }
  .working { color: var(--txt-3); font-size: 11.5px; display: flex; align-items: center; gap: 6px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); animation: pulse 1s infinite alternate; }
  @keyframes pulse { from { opacity: .3; } to { opacity: 1; } }
</style>
