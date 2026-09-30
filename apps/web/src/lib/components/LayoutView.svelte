<script lang="ts">
  import { fabFiles, zip } from '@tracewise/fab';
  import type { BoardDiagnostic, CopperLayer } from '@tracewise/schema';
  import { app } from '../app.svelte.ts';
  import Board3DView from './Board3DView.svelte';
  import BoardCanvas from './BoardCanvas.svelte';
  import type { TopView } from '../three-body.ts';
  import Chat from './Chat.svelte';

  /** Layout workspace: agent chat, the board, and a panel with checks, layers and outputs. */
  $effect(() => {
    void app.refreshBoard();
  });

  const b = $derived(app.board);
  let show = $state<Record<string, boolean>>({ board: true, 'F.Cu': true, 'In1.Cu': true, 'In2.Cu': true, 'B.Cu': true, silk: true, courtyard: false, ratsnest: true });
  let hotNet = $state<string | null>(null);
  let mode = $state<'2d' | '3d'>('2d');
  // switching views: the 3D view starts from the 2D view's area and flies into 3D; back, it flies
  // to straight above and the 2D view takes over that area. The 2D view stays up until 3D is drawn.
  let canvas2d: BoardCanvas | undefined = $state();
  let view3d: Board3DView | undefined = $state();
  let from2d = $state<TopView | null>(null);
  let show2d = $state(true);
  let switching = false;
  function to3d() {
    if (mode === '3d' || switching) return;
    from2d = canvas2d?.getView() ?? null;
    show2d = true;
    mode = '3d';
  }
  async function to2d() {
    if (mode === '2d' || switching) return;
    switching = true;
    const v = await view3d?.flyToTop();
    if (v) canvas2d?.setView(v);
    show2d = true;
    mode = '2d';
    switching = false;
  }
  let marker = $state<{ x: number; y: number } | null>(null);
  const netName = (id: string | null) => (id ? (b?.netNames[id] ?? id) : '');
  const errors = $derived(b?.diagnostics.filter((d) => d.severity === 'error').length ?? 0);
  const warnings = $derived(b?.diagnostics.filter((d) => d.severity === 'warning').length ?? 0);
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
  ]);

  const selectedPart = $derived(app.selection.length === 1 ? (b?.parts.find((p) => p.refdes === app.selection[0]) ?? null) : null);
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

  // board size: the proposal's, or the user's
  let sizeW = $state('');
  let sizeH = $state('');
  $effect(() => {
    sizeW = b ? String(b.outline.w) : '';
    sizeH = b ? String(b.outline.h) : '';
  });
  function setSize() {
    const w = Number(sizeW);
    const h = Number(sizeH);
    if (!(w > 0 && h > 0) || (b && w === b.outline.w && h === b.outline.h && b.sizeBy === 'user')) return;
    void app.userEdit(`Board ${w} × ${h} mm`, [{ op: 'set_board', width_mm: w, height_mm: h }]);
  }
  // (routing runs after the placement shows: until its result is in, it is "routing…")
  const routing = $derived(b?.routing === 'done' && app.boardBusy && app.boardStage !== 'routed');
  const routeLabel = $derived(routing ? 'Routing…' : b?.routing === 'done' ? 'Routed' : b?.routing === 'stale' ? 'Routing out of date' : 'Not routed');

  /** Gerbers, drill, BOM and pick-and-place as one zip. */
  function exportFab() {
    if (!b) return;
    const name = app.k?.summary.name && app.k.summary.name !== 'untitled' ? app.k.summary.name : 'tracewise-board';
    const files = fabFiles(b, name);
    const url = URL.createObjectURL(new Blob([zip(files) as BlobPart], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name.replace(/[^\w.-]+/g, '_')}-fab.zip`;
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
    {#if mode === '3d' && b}<Board3DView bind:this={view3d} board={b} from={from2d} onready={() => (show2d = false)} />{/if}
    <div class="stage2d" class:hidden={!show2d}>
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
    />
    </div>
    <div class="fl tl">
      {#if !app.chatOpen}<button class="ib" onclick={() => (app.chatOpen = true)}>⟩ Agent</button>{/if}
      <div class="seg"><button aria-pressed={mode === '2d'} onclick={to2d}>2D</button><button aria-pressed={mode === '3d'} onclick={to3d}>3D</button></div>
      {#if b?.parts.length}
        <button class="btn" disabled={app.running} title="A fresh board size (unless you set one) and placement; your placement choices and locked parts stay" onclick={() => void app.userEdit('Propose layout', [{ op: 'propose_layout' }])}>Propose layout</button>
        <button class="btn" class:pri={b.routing !== 'done'} disabled={app.running || b.routing === 'done'} title="Route the board as it is placed now (the last step)" onclick={() => void app.userEdit('Route', [{ op: 'route' }])}>{b.routing === 'stale' ? 'Route again' : 'Route'}</button>
        <span class="chip" class:stale={b.routing === 'stale'} class:ok={b.routing === 'done' && !routing}>{routeLabel}</span>
      {/if}
      {#if app.boardBusy}<span class="busy">updating…</span>{/if}
    </div>
    {#if app.k?.proposal}
      <div class="fl pend">
        <span class="pulse"></span>
        <span class="trunc"><b>{app.acceptedCount}</b> of {app.pendingCount} changes pending</span>
        <button class="btn pri" disabled={app.running || app.acceptedCount === 0} onclick={() => app.accept()}>Accept</button>
        <button class="btn" disabled={app.running} onclick={() => app.reject()}>Reject</button>
      </div>
    {/if}
    {#if b && !b.parts.length}
      <div class="blank"><p><b>No parts yet.</b> Draw the circuit in the schematic (or ask the agent); the board is placed from it automatically.</p></div>
    {/if}
    <div class="status">
      <span>{mode === '3d' ? 'drag = rotate · right-drag = pan · wheel = zoom' : 'click = reference · drag part = place it (kept as your choice) · R = rotate · L = lock · drag board = pan · wheel = zoom'}</span>
      <span class="sp mono">{hotNet ? netName(hotNet) : app.selection.join(' ') || '—'}</span>
    </div>
  </div>
  <aside class="col side">
    <div class="ph"><b>Board</b><span class="grow"></span>{#if b}<span class="mono muted">{b.outline.w} × {b.outline.h} mm · {b.layers.length} layers</span>{/if}</div>
    {#if b?.parts.length}
      <form class="size" onsubmit={(e) => (e.preventDefault(), setSize())}>
        <input class="mono" aria-label="Board width (mm)" bind:value={sizeW} onblur={setSize} />
        <span class="muted">×</span>
        <input class="mono" aria-label="Board height (mm)" bind:value={sizeH} onblur={setSize} />
        <span class="muted small">mm · {b.sizeBy === 'user' ? 'your size' : 'proposed'}</span>
        {#if b.sizeBy === 'user'}<button type="button" class="btn" title="Back to the proposed size" onclick={() => void app.userEdit('Board size: proposed', [{ op: 'set_board', width_mm: null, height_mm: null }])}>Auto</button>{/if}
      </form>
    {/if}
    <div class="scroll">
      {#if b}
        <div class="stats">
          <div><b>{b.parts.filter((p) => !p.componentId.startsWith('hole:')).length}</b><span>parts{#if b.parts.some((p) => p.componentId.startsWith('hole:'))} · {b.parts.filter((p) => p.componentId.startsWith('hole:')).length} holes{/if}</span></div>
          <div><b>{b.routing === 'done' ? `${b.stats.routed}/${b.stats.nets}` : '—'}</b><span>{b.routing === 'done' ? 'nets routed' : routeLabel.toLowerCase()}</span></div>
          <div><b>{b.ratsnest.length}</b><span>unrouted</span></div>
          <div><b>{b.stats.vias}</b><span>vias</span></div>
        </div>
        <h4>Checks <span class="tag err">{errors}</span> <span class="tag warn">{warnings}</span></h4>
        {#if !b.diagnostics.length}<p class="muted small">No problems found.</p>{/if}
        <ul class="diags">
          {#each b.diagnostics as d, i (i)}
            <li><button class="r" onclick={() => focus(d)}><span class="tag {d.severity === 'error' ? 'err' : d.severity === 'warning' ? 'warn' : 'info'}">{d.severity[0]!.toUpperCase()}</span><span class="grow">{d.message}</span></button></li>
          {/each}
        </ul>
        {#if selectedPart}
          <h4>{selectedPart.refdes} <span class="muted mono">{selectedPart.pkg}</span></h4>
          <p class="small mono">x {selectedPart.x} · y {selectedPart.y} mm · {selectedPart.rot}°</p>
          <p class="small">
            {#if selectedPart.locked}Locked here.
            {:else if selectedPart.intent}Your placement{selectedPart.intent.anchor ? `, kept relative to ${selectedPart.intent.anchor} (it follows ${selectedPart.intent.anchor})` : ''}; the placer nudges it only if it must.
            {:else}Placed automatically{selectedPart.follows ? `; it follows ${selectedPart.follows}` : ''}.{/if}
          </p>
          {#if !selectedPart.componentId.startsWith('hole:')}
            <div class="row2">
              <button class="btn" onclick={() => toggleLock(selectedPart.refdes)}>{selectedPart.locked ? 'Unlock' : 'Lock here'}</button>
              {#if selectedPart.locked || selectedPart.intent}<button class="btn" onclick={() => release(selectedPart.refdes)}>Let the placer decide</button>{/if}
            </div>
          {/if}
        {/if}
        <h4>Manufacturing</h4>
        <button class="btn pri wide" onclick={exportFab} disabled={!b.parts.length}>Download fab files (.zip)</button>
        <p class="small muted">Gerber (copper, mask, paste, silkscreen, outline), Excellon drill, BOM and pick-and-place.{#if errors} Fix the {errors} error{errors > 1 ? 's' : ''} first; the files would not make a working board.{/if}</p>
        <h4>Layers</h4>
        <ul class="layers">
          {#each layerNames as [key, label] (key)}
            <li><label><input type="checkbox" bind:checked={show[key]} /><span class="sw {key.replace('.', '')}"></span>{label}</label></li>
          {/each}
        </ul>
        <h4>Planes</h4>
        {#if b.planes.length}
          <ul class="plain small">
            {#each b.planes as p (p.layer)}
              <li><span class="mono">{b.netNames[p.netId] ?? p.netId}</span> on {p.layer} · {p.layer === 'F.Cu' || p.layer === 'B.Cu' ? 'pour around the tracks' : 'dedicated plane'}{p.auto ? ' · automatic' : ''}</li>
            {/each}
          </ul>
        {:else}<p class="small muted">None.</p>{/if}
        <p class="small muted">Ask the agent, e.g. “4 layers with GND on In1 and +3V3 on In2”.</p>
        <h4>Rules</h4>
        <p class="small mono muted">clearance {b.rules.clearance} · track {b.rules.track} / {b.rules.powerTrack} · via {b.rules.viaPad}/{b.rules.viaDrill} mm</p>
        <p class="small muted">Workflow: propose the layout, adjust the size and the parts (drag, R, L), then route. Or ask the agent, e.g. “make the board 40 × 30 mm”, “lock J1 at the left edge”, “use 4 layers”.</p>
      {/if}
    </div>
  </aside>
</section>

<style>
  .chip { font-size: 11px; padding: 2px 8px; border-radius: 10px; border: 1px solid var(--line); color: var(--txt); background: var(--panel); opacity: 0.8; }
  .chip.ok { color: var(--ok); }
  .chip.stale { color: var(--warn); }
  .size { display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-bottom: 1px solid var(--line); }
  .size input { width: 52px; padding: 2px 4px; }
  .row2 { display: flex; gap: 6px; flex-wrap: wrap; }
  .lay { display: grid; grid-template-columns: 330px minmax(0, 1fr) 280px; gap: 1px; background: var(--line); height: 100%; min-height: 0; }
  .lay.nochat { grid-template-columns: 0 minmax(0, 1fr) 280px; }
  .col { background: var(--panel); min-height: 0; min-width: 0; display: flex; flex-direction: column; }
  .canvas { position: relative; background: var(--canvas); }
  .fl { position: absolute; display: flex; gap: 6px; align-items: center; }
  .tl { top: 8px; left: 8px; z-index: 2; }
  .stage2d { position: absolute; inset: 0; }
  .stage2d.hidden { visibility: hidden; }
  .seg { display: inline-flex; }
  .seg button { border: 1px solid var(--line-2); background: var(--panel); color: var(--txt-2); padding: 2px 10px; font-size: 12px; cursor: pointer; }
  .seg button:first-child { border-radius: 6px 0 0 6px; }
  .seg button:last-child { border-radius: 0 6px 6px 0; border-left: 0; }
  .seg button[aria-pressed='true'] { background: var(--accent-soft); color: var(--accent-txt); }
  .busy { font-size: 11px; color: var(--txt-3); background: var(--panel); padding: 2px 8px; border-radius: 10px; border: 1px solid var(--line); }
  .pend { top: 8px; left: 50%; transform: translateX(-50%); background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 4px 6px 4px 10px; box-shadow: var(--shadow); font-size: 12px; max-width: calc(100% - 24px); }
  .pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); flex: none; }
  .blank { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
  .blank p { max-width: 360px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; color: var(--txt-2); }
  .status { position: absolute; bottom: 0; left: 0; right: 0; display: flex; gap: 10px; padding: 3px 10px; font-size: 11px; color: var(--txt-3); background: color-mix(in srgb, var(--panel) 85%, transparent); border-top: 1px solid var(--line); }
  .status .sp { margin-left: auto; }
  .side .scroll { padding: 8px 10px; }
  .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 8px; }
  .stats div { background: var(--panel-2); border-radius: 6px; padding: 6px 8px; display: flex; flex-direction: column; }
  .stats b { font-size: 15px; font-family: var(--mono); }
  .stats span { font-size: 11px; color: var(--txt-3); }
  h4 { margin: 12px 0 4px; font-size: 12px; display: flex; gap: 4px; align-items: center; }
  .small { font-size: 11.5px; margin: 2px 0 6px; }
  .wide { width: 100%; margin: 2px 0 4px; }
  .plain { margin: 0; padding-left: 16px; color: var(--txt-2); }
  .diags, .layers { list-style: none; margin: 0; padding: 0; }
  .diags .r { width: 100%; display: flex; gap: 6px; align-items: flex-start; text-align: left; border: 0; background: none; padding: 3px 2px; font-size: 12px; color: var(--txt-2); cursor: pointer; border-radius: 4px; }
  .diags .r:hover { background: var(--hover); }
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
  @media (max-width: 900px) {
    .lay, .lay.nochat { grid-template-columns: minmax(0, 1fr); grid-template-rows: 60% 40%; }
    .chatcol { display: none; }
  }
</style>
