<script lang="ts">
  import { onMount } from 'svelte';
  import { app, type View } from './lib/app.svelte.ts';
  import { server } from './lib/server.svelte.ts';
  import Chat from './lib/components/Chat.svelte';
  import Inspector from './lib/components/Inspector.svelte';
  import SchematicCanvas from './lib/components/SchematicCanvas.svelte';
  import Settings from './lib/components/Settings.svelte';
  import Logo from './lib/components/Logo.svelte';
  import Parts from './lib/components/Parts.svelte';
  import LayoutView from './lib/components/LayoutView.svelte';
  import EnclosureView from './lib/components/EnclosureView.svelte';
  import { printSchematic } from './lib/print.ts';
  import { PAPER_IDS, type PaperId } from '@4k7/schema';

  let canvas: SchematicCanvas | undefined = $state();
  // the agent is told which area of the sheet the user is looking at
  $effect(() => {
    app.visibleArea.sch = () => canvas?.getVisibleRect() ?? null;
    return () => (app.visibleArea.sch = null);
  });

  /** Optimize the area on screen; text typed in the chat box says what bothers the user. */
  function optimize() {
    const rect = canvas?.getVisibleRect();
    if (!rect) return;
    const goal = app.input.trim();
    app.input = '';
    void app.optimize(rect, goal || undefined);
  }

  let pane = $state<'chat' | 'canvas' | 'insp'>('canvas');

  // the update banner, once dismissed, stays away for that version
  let updateDismissed = $state(sessionStorage.getItem('4k7.update.dismissed'));
  const update = $derived(server.update && server.update.version !== updateDismissed ? server.update : null);
  function dismissUpdate() {
    updateDismissed = server.update?.version ?? null;
    if (updateDismissed) sessionStorage.setItem('4k7.update.dismissed', updateDismissed);
  }

  function print() {
    if (app.k) void printSchematic(app.k.view, app.k.summary.name);
  }

  onMount(() => {
    void app.init();
    const fromHash = () => {
      const h = location.hash.slice(1) as View;
      if (['sch', 'lay', 'enc', 'parts', 'set'].includes(h)) app.view = h;
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !(e.target as HTMLElement).closest('input,textarea')) {
        e.preventDefault();
        if (e.shiftKey) {
          if (app.k?.canRedo && !app.k.proposal) void app.redo();
        } else if (app.k?.canUndo && !app.k.proposal) void app.undo();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'p' && app.view === 'sch') {
        e.preventDefault();
        print();
      }
      if (e.key === 'Escape') app.selection = [];
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('hashchange', fromHash);
      window.removeEventListener('keydown', onKey);
    };
  });

  const undoTitle = $derived.by(() => {
    const e = app.k?.history[0];
    if (!app.k?.canUndo || !e) return 'Nothing to undo (⌘Z)';
    return app.k.proposal ? 'Accept or reject the pending changes first' : `Undo #${e.id}: ${e.summary} (⌘Z)`;
  });
  const redoTitle = $derived.by(() => {
    const e = app.k?.nextRedo;
    if (!e) return 'Nothing to redo (⇧⌘Z)';
    return app.k?.proposal ? 'Accept or reject the pending changes first' : `Redo #${e.id}: ${e.summary} (⇧⌘Z)`;
  });

  $effect(() => {
    if (location.hash.slice(1) !== app.view) history.replaceState(null, '', `#${app.view}`);
  });

  const views: { id: View; label: string }[] = [
    { id: 'sch', label: 'Schematic' },
    { id: 'lay', label: 'Layout' },
    { id: 'enc', label: 'Enclosure' },
    { id: 'parts', label: 'Parts' },
    { id: 'set', label: 'Settings' },
  ];

  const sheet = $derived(app.k?.view.sheets[app.sheet]);
  const overlays = $derived.by(() => {
    const o: Record<string, 'add' | 'change'> = {};
    for (const h of app.k?.proposal?.hunks ?? []) {
      if (h.kind === 'component' && h.change !== 'remove' && !app.hunkOff[h.id]) o[h.entityId] = h.change === 'add' ? 'add' : 'change';
    }
    return o;
  });
  const counts = $derived(app.k?.counts);

  function openIssues() {
    app.view = 'sch';
    app.tab = 'issues';
    pane = 'insp';
  }
</script>

<div class="app">
  <header class="bar">
    <div class="logo" aria-hidden="true">
      <Logo />
    </div>
    <span class="proj trunc" title="Project">{app.k?.summary.name ?? '4k7'}</span>
    <nav class="nav" aria-label="Workspace">
      {#each views as v (v.id)}
        <button aria-current={app.view === v.id} onclick={() => (app.view = v.id)}>{v.label}</button>
      {/each}
    </nav>
    <div class="right">
      {#if counts && (counts.errors > 0 || counts.warnings > 0)}
        <button class="chipbtn" onclick={openIssues} title="Open issues">
          <span class="n e"><i></i>{counts.errors}</span><span class="n w"><i></i>{counts.warnings}</span>
        </button>
      {/if}
      {#if app.k?.proposal && app.view !== 'sch'}
        <button class="chipbtn pending" onclick={() => (app.view = 'sch')} title="A changeset is waiting for review. Click to open the schematic.">
          <span class="pulse"></span>{app.pendingCount} pending
        </button>
        <button class="btn pri" disabled={app.running || app.acceptedCount === 0} onclick={() => app.accept()}>Accept</button>
        <button class="btn" disabled={app.running} onclick={() => app.reject()}>Reject</button>
      {/if}
      {#if app.routeProgress && app.view !== 'lay'}
        <button class="chipbtn" onclick={() => (app.view = 'lay')} title="The board is being routed (pass {app.routeProgress.pass}). Open the layout to watch it.">routing {Math.round((100 * app.routeProgress.done) / Math.max(1, app.routeProgress.connections))}%</button>
      {/if}
      {#if app.unsaved}
        <button class="chipbtn unsaved" onclick={() => (app.view = 'set')} title="Changes are not saved: the 4k7 server that writes the project file is not reachable. They are saved once it is back.">not saved</button>
      {/if}
      {#if server.status === 'waiting'}
        <button class="chipbtn" onclick={() => (app.view = 'set')} title="Waiting for the local server">⇄ <span class="muted">offline</span></button>
      {:else if server.status === 'elsewhere'}
        <button class="chipbtn" onclick={() => server.useThisTab()} title="Claude Code is connected in another tab of this app. Click to use this tab instead.">⇄ <span class="muted">other tab · use here</span></button>
      {:else if app.settings.provider === 'api' && !app.noModel}
        <button class="chipbtn" onclick={() => (app.view = 'set')} title="Session spend with the API ({app.apiChoice.model})"><span class="muted">${app.spend.toFixed(2)}</span></button>
      {/if}
      <button class="undo" title={undoTitle} aria-label={undoTitle} disabled={!app.k?.canUndo || !!app.k?.proposal} onclick={() => app.undo()}>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 3 2.5 6l3 3"/><path d="M3 6h6.5a3.5 3.5 0 0 1 0 7H6"/></svg>
        <span class="lbl">Undo</span>
      </button>
      <button class="redo" title={redoTitle} aria-label={redoTitle} disabled={!app.k?.canRedo || !!app.k?.proposal} onclick={() => app.redo()}>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10.5 3 3 3-3 3"/><path d="M13 6H6.5a3.5 3.5 0 0 0 0 7H10"/></svg>
      </button>
    </div>
  </header>

  <main>
    {#if !app.ready}
      <div class="loading">Loading…</div>
    {:else if app.view === 'sch'}
      <section class="sch" class:nochat={!app.chatOpen} data-pane={pane}>
        <div class="col chatcol">{#if app.chatOpen}<Chat />{/if}</div>
        <div class="col canvas">
          <SchematicCanvas
            bind:this={canvas}
            {sheet}
            scopeRect={app.scope && sheet && app.scope.scope.sheet === sheet.id ? app.scope.scope.rect : null}
            designName={app.k?.summary.name}
            pageCount={app.k?.summary.pages}
            paper={app.k?.view.paper}
            {overlays}
            hot={app.hoverHunk}
            showDiff={app.showDiff}
            selection={app.selection}
            selectedNet={app.selectedNet}
            onselect={(r, add) => app.toggleSelect(r, add)}
            onselectnet={(n) => app.selectNet(n)}
            onclear={() => app.clearSelection()}
          />
          <!-- one row: the pending bar goes on a line of its own when the tabs leave no room, never under them -->
          <div class="top">
          <div class="fl sheets">
            {#if !app.chatOpen}<button class="ib" onclick={() => (app.chatOpen = true)}>⟩ Agent</button>{/if}
            {#each app.k?.view.sheets ?? [] as s, i (s.id)}
              <button aria-pressed={i === app.sheet} onclick={() => (app.sheet = i)}>{s.name}{#if s.pages.length > 1}<span class="muted pc">{s.pages.length}p</span>{/if}</button>
            {/each}
            <button class="ib" disabled={app.running || !sheet || sheet.symbols.length < 2} onclick={optimize} title="Optimize the area on screen: the agent looks only at what you see and tries to improve how it is drawn. Text in the chat box says what bothers you.">✦ Optimize</button>
            <select class="paper-sel" value={app.k?.view.paper ?? 'A4'} disabled={app.running || !!app.k?.proposal} onchange={(e) => void app.setPaper(e.currentTarget.value as PaperId)} title="Paper size of the schematic pages: a bigger sheet holds more of the drawing per page" aria-label="Paper size">
              {#each PAPER_IDS as id (id)}<option value={id}>{id}</option>{/each}
            </select>
            <button class="ib" onclick={print} title="Print the schematic (⌘P): one {app.k?.view.paper ?? 'A4'} page per block, or save as PDF">⎙</button>
            <button class="ib" disabled={app.docBusy || !app.k?.summary.components.length} onclick={() => app.designDocument()} title="Design document: description of the blocks, layout, assembly drawing, BOM and schematic (print, or save as PDF)">{app.docBusy ? 'Preparing…' : 'Document'}</button>
          </div>
          {#if app.k?.proposal}
            <div class="fl pend">
              <span class="pulse"></span>
              <span class="trunc"><b>{app.acceptedCount}</b> of {app.pendingCount} changes pending</span>
              <button class="btn pri" disabled={app.running || app.acceptedCount === 0} onclick={() => app.accept()}>Accept</button>
              <button class="btn" disabled={app.running} onclick={() => app.reject()}>Reject</button>
              <button class="ib" aria-pressed={app.showDiff} onclick={() => (app.showDiff = !app.showDiff)} title="Toggle diff overlay">◧</button>
            </div>
          {/if}
          </div>
          {#if sheet && sheet.symbols.length === 0}
            <div class="blank">
              <p><b>Empty sheet.</b> Describe the circuit in the chat. The agent adds parts through the kernel, and the layout happens automatically.</p>
            </div>
          {/if}
          <div class="status">
            <span>click = reference · shift-click = add · drag = pan · wheel = zoom</span>
            <span class="sp mono">{app.selection.join(' ') || '—'}</span>
          </div>
        </div>
        <div class="col inspcol"><Inspector /></div>
      </section>
      <nav class="mobnav" aria-label="Pane">
        <button aria-pressed={pane === 'chat'} onclick={() => { pane = 'chat'; app.chatOpen = true; }}>Agent</button>
        <button aria-pressed={pane === 'canvas'} onclick={() => (pane = 'canvas')}>Canvas</button>
        <button aria-pressed={pane === 'insp'} onclick={() => (pane = 'insp')}>Issues · Ledger</button>
      </nav>
    {:else if app.view === 'lay'}
      <LayoutView />
    {:else if app.view === 'enc'}
      <EnclosureView />
    {:else if app.view === 'parts'}
      <!-- the chat stays beside the parts, so an import can be talked through without switching views -->
      <section class="partsv" class:nochat={!app.chatOpen}>
        <div class="col chatcol">{#if app.chatOpen}<Chat />{/if}</div>
        <div class="col partscol">
          <Parts />
          {#if !app.chatOpen}<button class="ib agentbtn" onclick={() => (app.chatOpen = true)}>⟩ Agent</button>{/if}
        </div>
      </section>
    {:else}
      <Settings />
    {/if}
  </main>
  {#if app.toast}<div class="toast" role="status">{app.toast}</div>{/if}
  {#if update}
    <div class="update" role="status">
      Version {update.version} is available. <a href={update.url} target="_blank" rel="noopener">Download</a>
      <button class="ib" onclick={dismissUpdate} aria-label="Dismiss">×</button>
    </div>
  {/if}
</div>

<style>
  .app { display: grid; grid-template-rows: 40px minmax(0, 1fr); height: 100vh; height: 100dvh; }
  .bar { display: flex; align-items: center; gap: 10px; padding: 0 10px; background: var(--panel); border-bottom: 1px solid var(--line); min-width: 0; }
  .logo { width: 22px; height: 22px; display: grid; place-items: center; flex: none; }
  .proj { font-weight: 600; max-width: 180px; }
  .nav { display: flex; gap: 2px; margin-left: 6px; }
  .nav button { border: 0; background: transparent; padding: 5px 10px; border-radius: 6px; color: var(--txt-2); }
  .nav button[aria-current="true"] { background: var(--panel-2); color: var(--txt); font-weight: 600; }
  .nav button:hover { background: var(--hover); }
  .pending { color: var(--accent-txt); border-color: var(--accent-soft); }
  .redo { display: inline-flex; align-items: center; border: 1px solid var(--line-2); background: var(--panel); color: var(--txt-2); border-radius: 6px; padding: 4px 7px; }
  .redo:hover:not(:disabled) { background: var(--hover); color: var(--txt); }
  .redo:disabled { border-color: var(--line); background: transparent; color: var(--txt-3); opacity: .6; }
  .undo { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--accent); background: var(--accent-soft); color: var(--accent-txt); border-radius: 6px; padding: 3px 9px; font-size: 12px; font-weight: 600; white-space: nowrap; }
  .undo:hover:not(:disabled) { background: var(--accent); color: var(--on-accent); }
  .undo:disabled { border-color: var(--line); background: transparent; color: var(--txt-3); font-weight: 400; opacity: .7; }
  .right { margin-left: auto; display: flex; gap: 6px; align-items: center; }
  main { min-height: 0; display: grid; grid-template-rows: minmax(0, 1fr) auto; }
  .loading { display: grid; place-items: center; color: var(--txt-3); }

  .sch { display: grid; grid-template-columns: minmax(260px, 330px) minmax(0, 1fr) minmax(240px, 290px); gap: 1px; background: var(--line); min-height: 0; }
  .sch.nochat { grid-template-columns: 0 minmax(0, 1fr) minmax(240px, 290px); }
  .partsv { display: grid; grid-template-columns: minmax(260px, 330px) minmax(0, 1fr); gap: 1px; background: var(--line); min-height: 0; }
  .partsv.nochat { grid-template-columns: 0 minmax(0, 1fr); }
  .partsv .chatcol { display: flex; flex-direction: column; overflow: hidden; }
  .partscol { position: relative; }
  .agentbtn { position: absolute; left: 8px; bottom: 8px; z-index: 2; }
  .col { min-height: 0; min-width: 0; background: var(--panel); }
  .canvas { position: relative; overflow: hidden; background: var(--canvas); background-image: radial-gradient(var(--grid) 1px, transparent 1px); background-size: 16px 16px; }
  .fl { position: absolute; z-index: 3; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); }
  .top { position: absolute; top: 8px; left: 8px; right: 8px; z-index: 3; display: flex; flex-wrap: wrap; gap: 6px; align-items: flex-start; pointer-events: none; }
  .top > .fl { position: static; pointer-events: auto; }
  .sheets { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; padding: 2px; }
  /* one size and padding for tabs, actions and the paper picker, so the row reads as one control */
  .sheets > * { font-size: 12px; line-height: 18px; padding: 2px 8px; white-space: nowrap; }
  .sheets .pc { margin-left: 4px; }
  .sheets .paper-sel { border: 0; background: transparent; border-radius: 5px; padding: 2px 4px; color: var(--txt-3); cursor: pointer; }
  .sheets .paper-sel:hover:not(:disabled) { background: var(--hover); color: var(--txt); }
  .sheets button[aria-pressed] { border: 0; background: transparent; border-radius: 5px; color: var(--txt-2); }
  .sheets button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent-txt); }
  .pend { margin: 0 auto; display: flex; align-items: center; gap: 8px; padding: 3px 4px 3px 10px; font-size: 12px; white-space: nowrap; max-width: calc(100% - 16px); }
  .pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); box-shadow: 0 0 0 3px var(--warn-soft); flex: none; }
  .pend .ib[aria-pressed="true"] { color: var(--accent-txt); }
  .blank { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
  .blank p { max-width: 360px; text-align: center; color: var(--txt-3); background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 16px; }
  .status { position: absolute; left: 0; right: 0; bottom: 0; height: 22px; display: flex; align-items: center; gap: 12px; padding: 0 10px; font-size: 11.5px; color: var(--txt-3); background: color-mix(in srgb, var(--canvas) 85%, transparent); border-top: 1px solid var(--line); z-index: 2; white-space: nowrap; overflow: hidden; }
  .status .sp { margin-left: auto; }
  .update { position: fixed; top: 48px; right: 12px; display: flex; align-items: center; gap: 8px; background: var(--panel); color: var(--txt); border: 1px solid var(--line); padding: 5px 6px 5px 10px; border-radius: 8px; font-size: 12px; z-index: 50; box-shadow: var(--shadow); }
  .update a { color: var(--accent); font-weight: 600; }
  .chipbtn.unsaved { color: var(--err); }
  .toast { position: fixed; bottom: 34px; left: 50%; transform: translateX(-50%); background: var(--txt); color: var(--bg); padding: 6px 12px; border-radius: 8px; font-size: 12px; z-index: 50; box-shadow: var(--shadow); max-width: calc(100vw - 32px); }
  .mobnav { display: none; }

  @media (max-width: 1100px) {
    .sch, .sch.nochat { grid-template-columns: minmax(240px, 300px) minmax(0, 1fr) 0; }
    .inspcol { display: none; }
  }
  @media (max-width: 760px) {
    .app { grid-template-rows: auto minmax(0, 1fr); }
    .bar { flex-wrap: wrap; padding: 6px 10px; row-gap: 6px; }
    .nav { order: 3; width: 100%; margin: 0; overflow-x: auto; }
    .sch, .sch.nochat { grid-template-columns: minmax(0, 1fr); }
    .sch > .col { display: none; }
    .partsv, .partsv.nochat { grid-template-columns: minmax(0, 1fr); }
    .partsv .chatcol { display: none; }
    .sch[data-pane="chat"] .chatcol, .sch[data-pane="canvas"] .canvas, .sch[data-pane="insp"] .inspcol { display: block; }
    .mobnav { display: flex; border-top: 1px solid var(--line); background: var(--panel); height: 40px; }
    .mobnav button { flex: 1; border: 0; background: transparent; color: var(--txt-3); font-size: 12px; }
    .mobnav button[aria-pressed="true"] { color: var(--accent-txt); font-weight: 600; box-shadow: inset 0 2px 0 var(--accent); }
    .status span:first-child { display: none; }
  }
</style>
