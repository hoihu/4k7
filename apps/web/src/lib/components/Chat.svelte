<script lang="ts">
  import { CHAT_FILE_TYPES, app } from '../app.svelte.ts';
  import { server } from '../server.svelte.ts';
  import ChatMessage from './ChatMessage.svelte';
  import ModelPicker from './ModelPicker.svelte';
  import { currentChoice, currentEffort, effortLevels, effortPatch } from '../models.ts';

  let scroller: HTMLDivElement | undefined = $state();
  let picker: HTMLInputElement | undefined = $state();
  /** Files are being dragged over the chat (counted: dragenter/dragleave fire for every child). */
  let dragDepth = $state(0);
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
    if (!app.input.trim() && !app.attachments.length) return;
    // a schematic dropped in on its own: rebuild it
    void app.send(app.input.trim() || 'Recreate this schematic.');
    app.input = '';
  }

  const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');

  function ondragenter(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
  }

  function ondragover(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  }

  function ondrop(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    void app.attach(e.dataTransfer!.files);
  }

  /**
   * A picture on the clipboard (a screenshot, a copied image) pasted anywhere in the app goes to the chat,
   * except into another text field. Some browsers list it only among the items.
   */
  function onpaste(e: ClipboardEvent) {
    const t = e.target as HTMLElement | null;
    if (t?.closest('input, textarea, [contenteditable]') && !t.closest('.composer')) return;
    const data = e.clipboardData;
    let files = [...(data?.files ?? [])];
    if (!files.length) files = [...(data?.items ?? [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => !!f);
    if (!files.length) return;
    e.preventDefault();
    void app.attach(files);
  }

  const thumb = (f: { mime: string; data: string }) => `data:${f.mime};base64,${f.data}`;

  /** When an earlier conversation started, for its divider. */
  const when = (at: string | undefined) => (at ? new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Earlier');

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) submit(e);
  }
</script>

<svelte:window {onpaste} />

<div class="pane chat" class:dropping={dragDepth > 0} role="region" aria-label="Chat" {ondragenter} {ondragover} ondragleave={(e) => hasFiles(e) && (dragDepth = Math.max(0, dragDepth - 1))} {ondrop}>
  {#if dragDepth > 0}<div class="dropzone">Drop a schematic (picture or PDF) and the agent rebuilds it</div>{/if}
  <div class="ph">
    <b>Agent</b>
    <span class="grow"></span>
    {#if app.keepConversation}<button class="kept" onclick={() => (app.view = 'set')} title="This conversation is saved in the project file (Settings → General → Conversation)">kept</button>{/if}
    {#if app.chat.length}<button class="ib" onclick={() => app.clearChat()} title={app.keepConversation ? 'New conversation (the design is kept, and this conversation stays in the project file)' : 'New conversation (the design is kept)'}>clear</button>{/if}
    <button class="ib" onclick={() => (app.chatOpen = false)} title="Collapse chat">⟨</button>
  </div>
  <div class="scroll" bind:this={scroller}>
    <div class="msgs">
      {#if app.chatArchive.length}
        {@const n = app.chatArchive.length}
        <details class="earlier">
          <summary>{n} earlier conversation{n === 1 ? '' : 's'} · kept in the project file</summary>
          <div class="msgs past">
            {#each app.chatArchive as session, i (i)}
              <div class="sess">{when(session.items[0]?.at)}</div>
              {#each session.items as m (m.id)}<ChatMessage {m} readonly />{/each}
            {/each}
            <div class="sess">The agent does not see these: it starts from the design.</div>
          </div>
        </details>
      {/if}
      {#if app.chat.length === 0}
        <div class="intro">
          <p><b>What do you want to build today?</b></p>
          <p>Or drop a picture or PDF of a schematic here to have it rebuilt.</p>
          {#if app.noModel}
            <p class="demo">
              {#if app.apiProblem === 'no model'}The chat has no model yet: pick one with the model button below, or
              {:else}The API is not set up ({app.apiProblem}). <button class="linkbtn" onclick={() => (app.view = 'set')}>Finish it</button>, or{/if} {#if __APP_RUN__}open {__SERVER_RUN__}{:else}run <code>{__SERVER_RUN__}</code> and open the link it prints{/if} to chat with a coding agent on this computer
              (<b>Claude Code</b>, <b>GitHub Copilot</b>, <b>Codex</b>, <b>OpenCode</b>).
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
        <ChatMessage {m} />
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
      {#if app.attachments.length}
        <div class="files pending">
          {#each app.attachments as f, i (i)}
            <span class="pfile" title={f.name}>
              {#if f.pages}<span class="fchip">{f.name} · {f.pages} p.</span>{:else}<img class="fthumb" src={thumb(f)} alt={f.name} />{/if}
              <button type="button" class="rm" title="Remove" aria-label={`Remove ${f.name}`} onclick={() => app.attachments.splice(i, 1)}>×</button>
            </span>
          {/each}
        </div>
      {/if}
      <textarea rows="1" bind:value={app.input} {onkeydown} placeholder={app.attachments.length ? 'Recreate this schematic, or say what to do with it…' : 'Ask, or give a hint…'} aria-label="Message"></textarea>
      <div class="bar">
        <button type="button" class="web" title="Attach a picture or PDF (a schematic to rebuild). You can also drop one here or paste a screenshot (⌘V)" aria-label="Attach a file" onclick={() => picker?.click()}>+</button>
        <input bind:this={picker} type="file" accept={CHAT_FILE_TYPES.join(',')} multiple hidden onchange={(e) => { const el = e.currentTarget as HTMLInputElement; void app.attach([...(el.files ?? [])]); el.value = ''; }} />
        <span class="div"></span>
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
          <button type="submit" class="btn pri" disabled={!app.input.trim() && !app.attachments.length}>↵</button>
        {/if}
      </div>
    </div>
  </form>
</div>

<style>
  .chat { height: 100%; position: relative; }
  .dropzone { position: absolute; inset: 6px; z-index: 5; display: flex; align-items: center; justify-content: center; text-align: center; padding: 16px; border: 2px dashed var(--accent); border-radius: 10px; background: color-mix(in srgb, var(--accent-soft) 85%, transparent); color: var(--accent-txt); font-size: 13px; font-weight: 600; pointer-events: none; }
  .files { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 4px; }
  .files.pending { padding-top: 5px; }
  .fthumb { display: block; height: 56px; max-width: 120px; object-fit: cover; border-radius: 5px; border: 1px solid var(--line-2); background: #fff; }
  .fchip { font-size: 11px; background: var(--panel-2); border: 1px solid var(--line-2); border-radius: 5px; padding: 2px 6px; display: inline-block; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pfile { position: relative; }
  .rm { position: absolute; top: -5px; right: -5px; width: 16px; height: 16px; border-radius: 50%; border: 1px solid var(--line-2); background: var(--panel); color: var(--txt-2); font-size: 11px; line-height: 1; padding: 0; }
  .msgs { padding: 8px; display: flex; flex-direction: column; gap: 10px; }
  .intro { font-size: 12.5px; color: var(--txt-2); padding: 4px 2px; }
  .earlier > summary { font-size: 11.5px; color: var(--txt-3); }
  .msgs.past { padding: 6px 0 0; opacity: .85; }
  .sess { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--txt-3); }
  .sess::before, .sess::after { content: ''; flex: 1; border-top: 1px solid var(--line); }
  .kept { border: 0; background: var(--accent-soft); color: var(--accent-txt); font-size: 10.5px; border-radius: 4px; padding: 0 5px; line-height: 16px; margin-right: 4px; }
  .intro p { margin: 0 0 8px; }
  .demo { background: var(--warn-soft); color: var(--warn); border-radius: 6px; padding: 6px 8px; }
  .linkbtn { border: 0; background: none; padding: 0; color: inherit; text-decoration: underline; font-weight: 600; }
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
