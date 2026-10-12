<script lang="ts">
  import { app } from '../app.svelte.ts';
  import { server } from '../server.svelte.ts';
  import ChangesetCard from './ChangesetCard.svelte';
  import ModelPicker from './ModelPicker.svelte';
  import { currentChoice, currentEffort, effortLevels, effortPatch } from '../models.ts';
  import { markdown } from '../markdown.ts';
  import { USAGE_TITLE, usageLine } from '../usage.ts';

  let scroller: HTMLDivElement | undefined = $state();
  const efforts = $derived(effortLevels(currentChoice(app.settings)));

  $effect(() => {
    // keep scrolled to the bottom while streaming
    void app.chat.length;
    const last = app.chat[app.chat.length - 1];
    void last?.segments.length;
    void (last?.segments[last.segments.length - 1] as { text?: string } | undefined)?.text;
    queueMicrotask(() => scroller?.scrollTo({ top: scroller.scrollHeight }));
  });

  function submit(e?: Event) {
    e?.preventDefault();
    if (!app.input.trim()) return;
    void app.send(app.input);
    app.input = '';
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) submit(e);
  }
</script>

<div class="pane chat">
  <div class="ph">
    <span class="grow"></span>
    {#if app.chat.length}<button class="ib" onclick={() => app.clearChat()} title="New conversation (the design is kept)">clear</button>{/if}
    <button class="ib" onclick={() => (app.chatOpen = false)} title="Collapse chat">⟨</button>
  </div>
  <div class="scroll" bind:this={scroller}>
    <div class="msgs">
      {#if app.chat.length === 0}
        <div class="intro">
          <p><b>What do you want to build today?</b></p>
          {#if app.noModel}
            <p class="demo">
              {#if app.apiProblem === 'no model'}The chat has no model yet: pick one with the model button below, or
              {:else}The API is not set up ({app.apiProblem}). <button class="linkbtn" onclick={() => (app.view = 'set')}>Finish it</button>, or{/if} {#if __APP_RUN__}open {__SERVER_RUN__}{:else}run <code>{__SERVER_RUN__}</code> and open the link it prints{/if} to chat with a coding agent on this computer
              (<b>Claude Code</b>, <b>GitHub Copilot</b>, <b>OpenCode</b>).
            </p>
          {:else if app.settings.provider === 'agent' && server.status !== 'connected'}
            <p class="demo">
              The chat uses your {app.harness.name}, but the server is {server.status === 'elsewhere' ? 'connected in another tab' : 'not connected'}.
              {#if server.status === 'elsewhere'}<button class="linkbtn" onclick={() => server.useThisTab()}>Use this tab</button>{:else if __APP_RUN__}Open {__SERVER_RUN__} again.{:else}Run <code>{__SERVER_RUN__}</code> and open the link it prints.{/if}
            </p>
          {/if}
        </div>
      {/if}
      {#each app.chat as m (m.id)}
        {#if m.role === 'user'}
          <div class="m u">
            {#if m.refs?.length}<div class="refs">{#each m.refs as r (r)}<span class="rchip">@{r}</span>{/each}</div>{/if}
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
                <details class="verify"><summary>kernel: {s.errors} error{s.errors === 1 ? '' : 's'} open → fix round {s.round}</summary><pre>{s.message}</pre></details>
              {:else if s.type === 'question'}
                <div class="q">
                  <div>{s.question}</div>
                  <div class="opts">
                    {#each s.options as o (o)}
                      <button class="opt" class:chosen={s.answered === o} disabled={!!s.answered || app.running} onclick={() => app.send(o)}>{o}</button>
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
            <ChangesetCard item={m} />
          </div>
        {/if}
      {/each}
    </div>
  </div>
  <form class="composer" onsubmit={submit}>
    {#if app.selection.length}
      <div class="refs">
        {#each app.selection as r (r)}<span class="rchip">@{r}</span>{/each}
        <button type="button" class="ib" onclick={() => (app.selection = [])}>clear</button>
      </div>
    {/if}
    <div class="inp">
      <textarea rows="1" bind:value={app.input} {onkeydown} placeholder="Ask, or give a hint…" aria-label="Message"></textarea>
      <div class="bar">
        <ModelPicker />
        {#if efforts}
          <span class="div"></span>
          <select class="effort" value={currentEffort(app.settings)} title="Effort: higher is more thorough and uses more tokens" aria-label="Effort" onchange={(e) => void app.updateSettings(effortPatch(app.settings, (e.currentTarget as HTMLSelectElement).value as (typeof efforts)[number]))}>
            {#each efforts as e (e)}<option value={e}>{e ? e[0]!.toUpperCase() + e.slice(1) : 'Default'}</option>{/each}
          </select>
        {/if}
        {#if app.settings.provider === 'agent'}
          <span class="div"></span>
          <button type="button" class="web" aria-pressed={app.settings.agentWeb} title={`Let ${app.harness.name} read the web (datasheets, application notes)`} onclick={() => void app.updateSettings({ agentWeb: !app.settings.agentWeb })}>Web</button>
        {/if}
        <span class="grow"></span>
        {#if app.running}
          <button type="button" class="btn" onclick={() => app.stop()}>Stop</button>
        {:else}
          <button type="submit" class="btn pri" disabled={!app.input.trim()}>↵</button>
        {/if}
      </div>
    </div>
  </form>
</div>

<style>
  .chat { height: 100%; }
  .msgs { padding: 8px; display: flex; flex-direction: column; gap: 10px; }
  .intro { font-size: 12.5px; color: var(--txt-2); padding: 4px 2px; }
  .intro p { margin: 0 0 8px; }
  .demo { background: var(--warn-soft); color: var(--warn); border-radius: 6px; padding: 6px 8px; }
  .linkbtn { border: 0; background: none; padding: 0; color: inherit; text-decoration: underline; font-weight: 600; }
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
  .refs { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; margin-bottom: 3px; }
  .rchip { font-family: var(--mono); font-size: 11px; background: var(--info-soft); color: var(--info); border-radius: 4px; padding: 0 5px; line-height: 18px; }
  .composer { border-top: 1px solid var(--line); padding: 6px 8px 8px; display: flex; flex-direction: column; gap: 5px; flex: none; }
  .inp { display: flex; flex-direction: column; border: 1px solid var(--line-2); border-radius: 8px; background: var(--canvas); padding: 2px 3px 3px 8px; }
  .inp:focus-within { border-color: var(--accent); }
  .inp textarea { flex: 1; min-width: 0; border: 0; background: transparent; outline: none; padding: 5px 0; resize: none; field-sizing: content; line-height: 1.4; min-height: calc(5 * 1.4em + 10px); max-height: 320px; overflow-x: hidden; overflow-y: auto; scrollbar-width: thin; }
  .bar { display: flex; align-items: center; gap: 2px; margin-left: -5px; min-width: 0; }
  .bar .grow { flex: 1; }
  .bar .div { width: 1px; height: 14px; background: var(--line-2); margin: 0 3px; flex: none; }
  .effort { border: 0; background: none; color: var(--txt-2); font-size: 12px; padding: 2px 3px; border-radius: 5px; }
  .effort:hover { background: var(--hover); color: var(--txt); }
  .web { border: 0; background: none; color: var(--txt-3); font-size: 12px; padding: 2px 6px; border-radius: 5px; }
  .web:hover { background: var(--hover); }
  .web[aria-pressed="true"] { color: var(--accent-txt); background: var(--accent-soft); }
</style>
