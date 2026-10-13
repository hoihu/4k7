<script lang="ts">
  import { fabFiles, panelFabFiles, zip } from '@4k7/fab';
  import type { BoardDiagnostic, CopperLayer } from '@4k7/schema';
  import { app } from '../app.svelte.ts';
  import Board3DView from './Board3DView.svelte';
  import BoardCanvas from './BoardCanvas.svelte';
  import type { TopView } from '../three-body.ts';
  import Chat from './Chat.svelte';
  import FabRules from './FabRules.svelte';
  import PanelCanvas from './PanelCanvas.svelte';
  import PanelSetup from './PanelSetup.svelte';

  /** Layout workspace: agent chat, the board, and a panel with checks, layers and outputs. */
  $effect(() => {
    void app.refreshBoard();
  });

  const b = $derived(app.board);
  let show = $state<Record<string, boolean>>({ board: true, 'F.Cu': true, 'In1.Cu': true, 'In2.Cu': true, 'B.Cu': true, silk: true, courtyard: false, ratsnest: true, placement: false, dims: true });
  let hotNet = $state<string | null>(null);
  let mode = $state<'2d' | '3d' | 'panel'>('2d');
  // switching views: the 3D view starts from the 2D view's area and flies into 3D; back, it flies
  // to straight above and the 2D view takes over that area. The 2D view stays up until 3D is drawn.
  let canvas2d: BoardCanvas | undefined = $state();
  let view3d: Board3DView | undefined = $state();
  let from2d = $state<TopView | null>(null);
  let show2d = $state(true);
  let switching = false;
  function to3d() {
    if (mode === '3d' || switching) return;
    from2d = mode === '2d' ? (canvas2d?.getView() ?? null) : null;
    show2d = true;
    mode = '3d';
  }
  async function to2d() {
    if (mode === '2d' || switching) return;
    if (mode === 'panel') {
      mode = '2d';
      show2d = true;
      return;
    }
    switching = true;
    const v = await view3d?.flyToTop();
    if (v) canvas2d?.setView(v);
    show2d = true;
    mode = '2d';
    switching = false;
  }
  /** The panel: the copies in their frame, with tabs edited on it. */
  function toPanel() {
    if (mode === 'panel' || switching) return;
    mode = 'panel';
  }
  let marker = $state<{ x: number; y: number } | null>(null);
  const netName = (id: string | null) => (id ? (b?.netNames[id] ?? id) : '');
  const desc = $derived(app.k?.description ?? null);
  const openChecks = $derived(b?.diagnostics.filter((d) => !d.waivedBy) ?? []);
  const waivedChecks = $derived(b?.diagnostics.filter((d) => d.waivedBy) ?? []);
  const errors = $derived(openChecks.filter((d) => d.severity === 'error').length);
  const warnings = $derived(openChecks.filter((d) => d.severity === 'warning').length);
  const layerNames: [string, string][] = $derived([
    ['board', 'Board · substrate / solder mask'],
    ...(b?.layers ?? ['F.Cu', 'B.Cu']).map((l: CopperLayer): [string, string] => {
      const plane = b?.planes.find((p) => p.layer === l);
      const name = l === 'F.Cu' ? 'Top copper' : l === 'B.Cu' ? 'Bottom copper' : `Inner ${l.slice(2, 3)}`;
      return [l, plane ? `${name} · ${b!.netNames[plane.netId] ?? plane.netId} ${l === 'F.Cu' || l === 'B.Cu' ? 'pour' : 'plane'}` : name];
    }),
    ['silk', 'Silkscreen'],
    ['courtyard', 'Courtyards'],
    ['ratsnest', 'Ratsnest'],
    ['placement', 'Placement · yours / locked'],
    ['dims', 'Dimensions · size, holes (mm)'],
  ]);

  const selectedPart = $derived(app.selection.length === 1 ? (b?.parts.find((p) => p.refdes === app.selection[0]) ?? null) : null);
  /* the parts the user placed (a choice the placer keeps) */
  const choices = $derived((b?.parts ?? []).filter((p) => !p.componentId.startsWith('hole:') && !p.locked && p.intent).map((p) => p.refdes));
  /** Every choice back to the placer; locked parts stay. */
  function releaseAll() {
    const ids = choices.map((ref) => app.k?.ledger.find((x) => x.text.startsWith(`position(${ref})`))?.id).filter((id): id is string => !!id);
    if (ids.length) void app.userEdit(`Let the placer place ${ids.length} part(s) again`, ids.map((id) => ({ op: 'remove_constraint', id })));
  }
  /** Forget the user's placement of a part: the placer decides again. */
  function release(ref: string) {
    const k = app.k?.ledger.find((x) => x.text.startsWith(`position(${ref})`));
    if (k) void app.userEdit(`Let the placer place ${ref}`, [{ op: 'remove_constraint', id: k.id }]);
  }
  /** Lock a part exactly where it is, or unlock it (it stays there as the user's choice). */
  function toggleLock(ref: string) {
    const p = b?.parts.find((x) => x.refdes === ref);
    if (!p || p.componentId.startsWith('hole:')) return;
    void app.userEdit(`${p.locked ? 'Unlock' : 'Lock'} ${ref}`, [{ op: 'place', ref, x_mm: p.x, y_mm: p.y, rot: p.rot as 0 | 90 | 180 | 270, lock: !p.locked }]);
  }

  /** Flip a part to the other side of the board. */
  function flip(ref: string) {
    const p = b?.parts.find((x) => x.refdes === ref);
    if (!p || p.componentId.startsWith('hole:')) return;
    void app.setSide(ref, p.side === 'bottom' ? 'top' : 'bottom');
  }

  // (routing runs after the placement shows: until its result is in, it is "routing…")
  const routing = $derived(b?.routing === 'done' && app.boardBusy && app.boardStage !== 'routed');
  const nParts = $derived(b?.parts.filter((p) => !p.componentId.startsWith('hole:')).length ?? 0);
  let checksOpen = $state(false);
  let allChecks = $state(false);
  let waivedOpen = $state(false);
  const CHECKS_SHOWN = 4;
  const routeLabel = $derived(routing ? 'Routing…' : b?.routing === 'done' ? 'Routed' : b?.routing === 'stale' ? 'Routing out of date' : 'Not routed');

  /** Gerbers, drill, BOM and pick-and-place as one zip: of the board, or of its panel. */
  function exportFab(panel = false) {
    if (!b) return;
    const name = app.k?.summary.name && app.k.summary.name !== 'untitled' ? app.k.summary.name : '4k7-board';
    const files = panel ? panelFabFiles(b, name) : fabFiles(b, name);
    const url = URL.createObjectURL(new Blob([zip(files) as BlobPart], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name.replace(/[^\w.-]+/g, '_')}-${panel ? 'panel' : 'fab'}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    app.flash(`Exported ${files.length} files${errors ? ` (the board still has ${errors} DRC error${errors > 1 ? 's' : ''})` : ''}`);
  }

  function focus(d: BoardDiagnostic) {
    marker = d.at ?? null;
    app.selection = d.entities.filter((e) => b?.parts.some((p) => p.refdes === e));
  }
</script>

<section class="lay" class:nochat={!app.chatOpen}>
  <div class="col chatcol">{#if app.chatOpen}<Chat />{/if}</div>
  <div class="col canvas">
    {#if mode === 'panel' && b?.panel}<div class="stagep"><PanelCanvas board={b} ontabs={(tabs) => void app.userEdit('Panel tabs', [{ op: 'set_panel', tabs }])} /></div>
    {:else if mode === 'panel' && b?.parts.length}<div class="blank"><p><b>No panel yet.</b> A panel holds copies of the board in a frame, milled apart except at tabs with mouse bites. Make one in the side panel, or ask the agent.</p></div>{/if}
    {#if mode === '3d' && b}<Board3DView bind:this={view3d} board={b} from={from2d} onready={() => (show2d = false)} />{/if}
    <div class="stage2d" class:hidden={!show2d || mode === 'panel'}>
    <BoardCanvas
      bind:this={canvas2d}
      board={b}
      {show}
      {hotNet}
      {marker}
      selection={app.selection}
      onselect={(r, add) => app.toggleSelect(r, add)}
      onclear={() => ((app.selection = []), (marker = null))}
      onhovernet={(n) => (hotNet = n)}
      onplace={(ref, x, y, rot) => void app.userEdit(`Place ${ref}`, [{ op: 'place', ref, x_mm: x, y_mm: y, rot }])}
      onlock={toggleLock}
      onflip={flip}
      ongraphic={(id, dx, dy) => void app.userEdit(`Move ${id}`, [{ op: 'edit_graphic', id, dx_mm: dx, dy_mm: dy }])}
    />
    </div>
    <!-- one row: the pending bar goes on a line of its own when the tools leave no room, never under them -->
    <div class="top">
    <div class="tools">
      {#if !app.chatOpen}<button class="ib" onclick={() => (app.chatOpen = true)}>⟩ Agent</button>{/if}
      <div class="seg"><button aria-pressed={mode === '2d'} onclick={to2d}>2D</button><button aria-pressed={mode === '3d'} onclick={to3d}>3D</button><button aria-pressed={mode === 'panel'} title="The fabrication panel: copies in a frame, tabs with mouse bites" onclick={toPanel}>Panel</button></div>
      {#if b?.parts.length}
        <button class="btn" disabled={app.running} title="A fresh board size (unless you set one) and placement; your placement choices and locked parts stay" onclick={() => void app.userEdit('Propose layout', [{ op: 'propose_layout' }])}>Propose layout</button>
        {#if choices.length}<button class="btn" disabled={app.running} title="Your {choices.length} placement choice{choices.length > 1 ? 's' : ''} go back to the placer; locked parts stay" onclick={releaseAll}>Release choices ({choices.length})</button>{/if}
        <button class="btn" class:pri={b.routing !== 'done'} disabled={app.running || b.routing === 'done'} title="Route the board as it is placed now (the last step)" onclick={() => void app.userEdit('Route', [{ op: 'route' }])}>{b.routing === 'stale' ? 'Route again' : 'Route'}</button>
        <button class="btn" disabled={!b.parts.length} title="Gerber (copper, mask, paste, silkscreen, outline), Excellon drill, BOM and pick-and-place as a .zip{errors ? `. The board has ${errors} error${errors > 1 ? 's' : ''}: the files would not make a working board` : ''}" onclick={() => exportFab()}>Fab files ⤓</button>
        {#if b.panel}<button class="btn" title="The {b.panel.settings.cols} × {b.panel.settings.rows} panel ({b.panel.w} × {b.panel.h} mm): Gerber, drill with the mouse bites and tooling holes, BOM and pick-and-place of every copy, as a .zip{errors ? `. The board has ${errors} error${errors > 1 ? 's' : ''}` : ''}" onclick={() => exportFab(true)}>Panel files ⤓</button>{/if}
      {/if}
      {#if app.boardBusy}<span class="busy">updating…</span>{/if}
    </div>
    {#if app.k?.proposal}
      <div class="pend">
        <span class="pulse"></span>
        <span class="trunc"><b>{app.acceptedCount}</b> of {app.pendingCount} changes pending</span>
        <button class="btn pri" disabled={app.running || app.acceptedCount === 0} onclick={() => app.accept()}>Accept</button>
        <button class="btn" disabled={app.running} onclick={() => app.reject()}>Reject</button>
      </div>
    {/if}
    </div>
    {#if b && !b.parts.length}
      <div class="blank"><p><b>No parts yet.</b> Draw the circuit in the schematic (or ask the agent); the board is placed from it automatically.</p></div>
    {/if}
    <div class="status">
      <span class="sp mono">
        {#if b && mode === 'panel' && b.panel}Panel {b.panel.w} × {b.panel.h} mm · {b.panel.settings.cols} × {b.panel.settings.rows} boards of {b.outline.w} × {b.outline.h} mm<span class="dot">·</span>
        {:else if b}{b.outline.w} × {b.outline.h} mm · {b.layers.length} layers<span class="dot">·</span>{/if}
        {#if b?.parts.length}
          <span class:stale={b.routing === 'stale'} class:ok={b.routing === 'done' && !routing}>{routeLabel}</span>
          {#if b.routing === 'done' && !routing}<span> {b.stats.routed}/{b.stats.nets} nets · {b.stats.vias} vias</span>{#if b.ratsnest.length}<span class="stale"> · {b.ratsnest.length} unrouted</span>{/if}{/if}
          <span class="dot">·</span>{nParts} parts<span class="dot">·</span>
        {/if}
        {hotNet ? netName(hotNet) : app.selection.join(' ') || '—'}
      </span>
    </div>
  </div>
  <aside class="col side">
    <div class="scroll">
      {#if b}
        {#if mode === 'panel' && b.parts.length}<PanelSetup panel={b.panel} size={b.outline} onexport={() => exportFab(true)} />{/if}
        {#if selectedPart && mode !== 'panel'}
          <h4>{selectedPart.refdes} <span class="muted mono">{selectedPart.pkg}</span></h4>
          <p class="small mono">x {selectedPart.x} · y {selectedPart.y} mm · {selectedPart.rot}°{selectedPart.componentId.startsWith('hole:') ? '' : ` · ${selectedPart.side} side`}</p>
          <p class="small">
            {#if selectedPart.locked}Locked here.
            {:else if selectedPart.intent}Your placement{selectedPart.intent.anchor ? `, kept relative to ${selectedPart.intent.anchor} (it follows ${selectedPart.intent.anchor})` : ''}; the placer nudges it only if it must.
            {:else}Placed automatically{selectedPart.follows ? `; it follows ${selectedPart.follows}` : ''}.{/if}
          </p>
          {#if !selectedPart.componentId.startsWith('hole:')}
            <div class="row2">
              <button class="btn" onclick={() => toggleLock(selectedPart.refdes)}>{selectedPart.locked ? 'Unlock' : 'Lock here'}</button>
              <button class="btn" disabled={app.running} title="Mount it on the other side of the board (F)" onclick={() => flip(selectedPart.refdes)}>{selectedPart.side === 'bottom' ? 'To the top side' : 'To the bottom side'}</button>
              {#if selectedPart.locked || selectedPart.intent}<button class="btn" onclick={() => release(selectedPart.refdes)}>Let the placer decide</button>{/if}
            </div>
          {/if}
        {/if}
        <h4><button class="fold" aria-expanded={checksOpen} onclick={() => (checksOpen = !checksOpen)}><span class="chev">{checksOpen ? '▾' : '▸'}</span>Checks <span class="tag err">{errors}</span> <span class="tag warn">{warnings}</span></button></h4>
        {#if checksOpen}
        {#if !openChecks.length}<p class="muted small">No problems found.</p>{/if}
        <ul class="diags">
          {#each allChecks ? openChecks : openChecks.slice(0, CHECKS_SHOWN) as d, i (i)}
            <li>
              <button class="r" title={d.message} onclick={() => focus(d)}><span class="tag {d.severity === 'error' ? 'err' : d.severity === 'warning' ? 'warn' : 'info'}">{d.severity[0]!.toUpperCase()}</span><span class="grow clamp">{d.message}</span></button>
              {#if d.entities.length}<button class="x" title="Not a problem: intended, so this check goes away" aria-label="Mark as not a problem" disabled={app.running} onclick={() => void app.waiveCheck(d)}>✕</button>{/if}
            </li>
          {/each}
        </ul>
        {#if openChecks.length > CHECKS_SHOWN}<button class="more" onclick={() => (allChecks = !allChecks)}>{allChecks ? 'Show fewer' : `Show all ${openChecks.length}`}</button>{/if}
        {#if waivedChecks.length}
          <button class="more" aria-expanded={waivedOpen} onclick={() => (waivedOpen = !waivedOpen)}>{waivedOpen ? 'Hide' : 'Show'} {waivedChecks.length} marked as not a problem</button>
          {#if waivedOpen}
            <ul class="diags">
              {#each waivedChecks as d, i (i)}
                <li>
                  <button class="r" title={d.message} onclick={() => focus(d)}><span class="tag info">{d.severity[0]!.toUpperCase()}</span><span class="grow clamp muted">{d.message}</span></button>
                  <button class="x" title="Check this again" aria-label="Check this again" disabled={app.running} onclick={() => void app.restoreCheck(d.waivedBy!)}>↺</button>
                </li>
              {/each}
            </ul>
          {/if}
        {/if}
        {/if}
        {#if mode !== 'panel'}
        <h4>Layers</h4>
        <ul class="layers">
          {#each layerNames as [key, label] (key)}
            <li><label><input type="checkbox" bind:checked={show[key]} /><span class="sw {key.replace('.', '')}"></span>{label}</label></li>
          {/each}
        </ul>
        {/if}
        <FabRules rules={b.rules} fab={b.fab} layers={b.layers.length as 2 | 4} />
        <button class="btn wide" onclick={() => app.designDocument()} disabled={!b.parts.length || app.docBusy} title="The functional blocks described, each with its schematic and its place on the board, then layout, assembly drawing, BOM and schematic">{app.docBusy ? 'Preparing…' : 'Design document (print / PDF)'}</button>
        <p class="small muted">
          {#if desc}{desc.blocks.length} block{desc.blocks.length === 1 ? '' : 's'} described{#if desc.undescribed.length}, <span class="stale">{desc.undescribed.length} part{desc.undescribed.length === 1 ? '' : 's'} in none</span>{/if}.
          {:else}No description yet. Ask the agent to describe the design.{/if}
        </p>
      {/if}
    </div>
  </aside>
</section>

<style>
  .ok { color: var(--ok); }
  .stale { color: var(--warn); }
  .row2 { display: flex; gap: 6px; flex-wrap: wrap; }
  .lay { display: grid; grid-template-columns: 330px minmax(0, 1fr) 280px; gap: 1px; background: var(--line); height: 100%; min-height: 0; }
  .lay.nochat { grid-template-columns: 0 minmax(0, 1fr) 280px; }
  .col { background: var(--panel); min-height: 0; min-width: 0; display: flex; flex-direction: column; }
  .canvas { position: relative; background: var(--canvas); }
  .top { position: absolute; top: 8px; left: 8px; right: 8px; z-index: 2; display: flex; flex-wrap: wrap; gap: 6px; align-items: flex-start; pointer-events: none; }
  .top > * { pointer-events: auto; }
  .tools { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .stage2d { position: absolute; inset: 0; }
  .stage2d.hidden { visibility: hidden; }
  .stagep { position: absolute; inset: 0; }
  .seg { display: inline-flex; }
  .seg button { border: 1px solid var(--line-2); background: var(--panel); color: var(--txt-2); padding: 2px 10px; font-size: 12px; cursor: pointer; }
  .seg button:first-child { border-radius: 6px 0 0 6px; }
  .seg button:last-child { border-radius: 0 6px 6px 0; border-left: 0; }
  .seg button[aria-pressed='true'] { background: var(--accent-soft); color: var(--accent-txt); }
  .busy { font-size: 11px; color: var(--txt-3); background: var(--panel); padding: 2px 8px; border-radius: 10px; border: 1px solid var(--line); }
  .pend { display: flex; gap: 6px; align-items: center; margin: 0 auto; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 4px 6px 4px 10px; box-shadow: var(--shadow); font-size: 12px; max-width: calc(100% - 24px); }
  .pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); flex: none; }
  .blank { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
  .blank p { max-width: 360px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; color: var(--txt-2); }
  .status { position: absolute; bottom: 0; left: 0; right: 0; display: flex; gap: 10px; padding: 3px 10px; font-size: 11px; color: var(--txt-3); background: color-mix(in srgb, var(--panel) 85%, transparent); border-top: 1px solid var(--line); }
  .status .sp { margin-left: auto; flex: none; white-space: nowrap; }
  .status .dot { margin: 0 4px; }
  .side .scroll { padding: 8px 10px; }
  h4 { margin: 12px 0 4px; font-size: 12px; display: flex; gap: 4px; align-items: center; }
  .small { font-size: 11.5px; margin: 2px 0 6px; }
  .wide { width: 100%; margin: 2px 0 4px; }
  .clamp { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .fold { display: flex; gap: 4px; align-items: center; border: 0; background: none; padding: 0; font: inherit; font-weight: inherit; color: inherit; cursor: pointer; }
  .chev { width: 10px; color: var(--txt-3); }
  .more { border: 0; background: none; color: var(--accent-txt); font-size: 11.5px; padding: 2px; cursor: pointer; }
  .diags, .layers { list-style: none; margin: 0; padding: 0; }
  .diags .r { display: flex; gap: 6px; align-items: flex-start; text-align: left; border: 0; background: none; padding: 3px 2px; font-size: 12px; color: var(--txt-2); cursor: pointer; border-radius: 4px; }
  .diags .r:hover { background: var(--hover); }
  .diags li { display: flex; align-items: flex-start; }
  .diags .r { flex: 1; min-width: 0; }
  .diags .x { border: 0; background: none; color: var(--txt-3); font-size: 12px; padding: 3px 5px; cursor: pointer; border-radius: 4px; }
  .diags .x:hover:not(:disabled) { background: var(--hover); color: var(--txt); }
  .layers label { display: flex; gap: 6px; align-items: center; font-size: 12px; padding: 2px 0; cursor: pointer; }
  .sw { width: 12px; height: 12px; border-radius: 3px; display: inline-block; background: var(--line-2); }
  .sw.board { background: #0f2a22; border: 1px solid var(--line-2); }
  .sw.FCu { background: #c9463d; }
  .sw.BCu { background: #3f7fd6; }
  .sw.In1Cu { background: #c9a13d; }
  .sw.In2Cu { background: #8e5cd6; }
  .sw.silk { background: #e9ecef; }
  .sw.courtyard { background: #d65db1; }
  .sw.ratsnest { background: #9aa3ad; }
  .sw.dims { background: #7fdcb4; }
  .sw.placement { background: linear-gradient(90deg, #6fb5ff 50%, #f0a03c 50%); }
  @media (max-width: 900px) {
    .lay, .lay.nochat { grid-template-columns: minmax(0, 1fr); grid-template-rows: 60% 40%; }
    .chatcol { display: none; }
  }
</style>
