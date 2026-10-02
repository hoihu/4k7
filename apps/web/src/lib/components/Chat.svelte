<script lang="ts">
  import { app } from '../app.svelte.ts';
  import { bridge } from '../bridge.svelte.ts';
  import ChangesetCard from './ChangesetCard.svelte';
  import { markdown } from '../markdown.ts';
  import { USAGE_TITLE, usageLine } from '../usage.ts';

  let scroller: HTMLDivElement | undefined = $state();

  const suggestions = $derived.by(() => {
    if (!app.k || app.k.summary.components.length === 0) {
      return app.isDemo
        ? ['12 V to 3.3 V buck, 2 A. Put C1 left of U1.']
        : ['12 V to 3.3 V buck converter, 2 A', '555 LED blinker at 1 Hz from 9 V', 'ATtiny85 with ISP header and power LED'];
    }
    const sel = app.selection[0];
    if (sel?.startsWith('C')) return [`make ${sel} 100uF`, `put ${sel} left of U1`];
    return app.isDemo ? ['make C2 100uF'] : ['Review the design for problems', 'Add a power LED on +3V3'];
  });

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
    <b>Agent</b>
    <span class="tag" class:info={!app.isDemo} title={app.lastModel || undefined}>{app.providerLabel}</span>
    <span class="grow"></span>
    {#if app.chat.length}<button class="ib" onclick={() => app.clearChat()} title="New conversation (the design is kept)">clear</button>{/if}
    <button class="ib" onclick={() => (app.chatOpen = false)} title="Collapse chat">⟨</button>
  </div>
  <div class="scroll" bind:this={scroller}>
    <div class="msgs">
      {#if app.chat.length === 0}
        <div class="intro">
          <p><b>Describe what you want to build.</b> The agent designs through the kernel's operations; every change comes back here as a changeset to review.</p>
          <p class="muted">Click parts on the canvas to reference them. Hints like “make C2 100µF” or “put C1 left of U1” are recorded in the ledger and kept on every re-layout.</p>
          {#if app.isDemo}
            <p class="demo">
              Offline demo (scripted). To use a real model, run <code>{__BRIDGE_RUN__}</code> and open its pairing link to chat with your
              <b>Claude Code</b>, or <button class="linkbtn" onclick={() => (app.view = 'set')}>add an API key</button>.
            </p>
          {:else if app.settings.provider === 'claude-code' && bridge.status !== 'connected'}
            <p class="demo">
              The chat uses your Claude Code, but the bridge is {bridge.status === 'elsewhere' ? 'connected in another tab' : 'not connected'}.
              {#if bridge.status === 'elsewhere'}<button class="linkbtn" onclick={() => bridge.useThisTab()}>Use this tab</button>{:else}Run <code>{__BRIDGE_RUN__}</code> and open its pairing link.{/if}
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
            {#if m.source}<div class="src"><span class="ext">⇄</span> {m.source} <span class="muted">via bridge</span></div>{/if}
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
      {#if app.running}
        <button type="button" class="btn" onclick={() => app.stop()}>Stop</button>
      {:else}
        <button type="submit" class="btn pri" disabled={!app.input.trim()}>↵</button>
      {/if}
    </div>
    <div class="sugg">
      {#each suggestions as s (s)}<button type="button" onclick={() => { app.input = s; }}>{s}</button>{/each}
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
  .src { font-size: 11px; color: var(--info); font-weight: 600; }
  .ext { font-family: var(--mono); }
  .working { color: var(--txt-3); font-size: 11.5px; display: flex; align-items: center; gap: 6px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); animation: pulse 1s infinite alternate; }
  @keyframes pulse { from { opacity: .3; } to { opacity: 1; } }
  .refs { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; margin-bottom: 3px; }
  .rchip { font-family: var(--mono); font-size: 11px; background: var(--info-soft); color: var(--info); border-radius: 4px; padding: 0 5px; line-height: 18px; }
  .composer { border-top: 1px solid var(--line); padding: 6px 8px 8px; display: flex; flex-direction: column; gap: 5px; flex: none; }
  .inp { display: flex; gap: 4px; align-items: flex-end; border: 1px solid var(--line-2); border-radius: 7px; background: var(--canvas); padding: 2px 2px 2px 8px; }
  .inp:focus-within { border-color: var(--accent); }
  .inp textarea { flex: 1; min-width: 0; border: 0; background: transparent; outline: none; padding: 5px 0; resize: none; field-sizing: content; max-height: 140px; }
  .sugg { display: flex; gap: 4px; flex-wrap: wrap; }
  .sugg button { border: 1px solid var(--line); background: var(--panel-2); border-radius: 99px; padding: 0 8px; font-size: 11.5px; line-height: 20px; color: var(--txt-2); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sugg button:hover { border-color: var(--accent); color: var(--accent-txt); }
</style>
