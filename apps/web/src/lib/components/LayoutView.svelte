<script lang="ts">
  import type { BoardDiagnostic, CopperLayer } from '@tracewise/schema';
  import { app } from '../app.svelte.ts';
  import BoardCanvas from './BoardCanvas.svelte';
  import Chat from './Chat.svelte';

  /** Layout workspace: agent chat, the board, and a panel with checks, layers and outputs. */
  $effect(() => {
    void app.refreshBoard();
  });

  const b = $derived(app.board);
  let show = $state<Record<string, boolean>>({ 'F.Cu': true, 'In1.Cu': true, 'In2.Cu': true, 'B.Cu': true, silk: true, courtyard: false, ratsnest: true });
  let hotNet = $state<string | null>(null);
  let marker = $state<{ x: number; y: number } | null>(null);
  const netName = (id: string | null) => (id ? (b?.netNames[id] ?? id) : '');
  const errors = $derived(b?.diagnostics.filter((d) => d.severity === 'error').length ?? 0);
  const warnings = $derived(b?.diagnostics.filter((d) => d.severity === 'warning').length ?? 0);
  const layerNames: [string, string][] = $derived([
    ...(b?.layers ?? ['F.Cu', 'B.Cu']).map((l: CopperLayer): [string, string] => [l, l === 'F.Cu' ? 'Top copper' : l === 'B.Cu' ? 'Bottom copper' : l]),
    ['silk', 'Silkscreen'],
    ['courtyard', 'Courtyards'],
    ['ratsnest', 'Ratsnest'],
  ]);

  function focus(d: BoardDiagnostic) {
    marker = d.at ?? null;
    app.selection = d.entities.filter((e) => b?.parts.some((p) => p.refdes === e));
  }
</script>

<section class="lay" class:nochat={!app.chatOpen}>
  <div class="col chatcol">{#if app.chatOpen}<Chat />{/if}</div>
  <div class="col canvas">
    <BoardCanvas
      board={b}
      {show}
      {hotNet}
      {marker}
      selection={app.selection}
      onselect={(r, add) => app.toggleSelect(r, add)}
      onclear={() => ((app.selection = []), (marker = null))}
      onhovernet={(n) => (hotNet = n)}
    />
    <div class="fl tl">
      {#if !app.chatOpen}<button class="ib" onclick={() => (app.chatOpen = true)}>⟩ Agent</button>{/if}
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
      <span>click = reference · drag = pan · wheel = zoom</span>
      <span class="sp mono">{hotNet ? netName(hotNet) : app.selection.join(' ') || '—'}</span>
    </div>
  </div>
  <aside class="col side">
    <div class="ph"><b>Board</b><span class="grow"></span>{#if b}<span class="mono muted">{b.outline.w} × {b.outline.h} mm · {b.layers.length} layers</span>{/if}</div>
    <div class="scroll">
      {#if b}
        <div class="stats">
          <div><b>{b.parts.length}</b><span>parts</span></div>
          <div><b>{b.stats.routed}/{b.stats.nets}</b><span>nets routed</span></div>
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
        <h4>Layers</h4>
        <ul class="layers">
          {#each layerNames as [key, label] (key)}
            <li><label><input type="checkbox" bind:checked={show[key]} /><span class="sw {key.replace('.', '')}"></span>{label}</label></li>
          {/each}
        </ul>
        <h4>Rules</h4>
        <p class="small mono muted">clearance {b.rules.clearance} · track {b.rules.track} / {b.rules.powerTrack} · via {b.rules.viaPad}/{b.rules.viaDrill} mm</p>
        <p class="small muted">Ask the agent for board changes, e.g. “make the board 40 × 30 mm”, “put J1 at the left edge”, “use 4 layers”.</p>
      {/if}
    </div>
  </aside>
</section>

<style>
  .lay { display: grid; grid-template-columns: 330px minmax(0, 1fr) 280px; gap: 1px; background: var(--line); height: 100%; min-height: 0; }
  .lay.nochat { grid-template-columns: 0 minmax(0, 1fr) 280px; }
  .col { background: var(--panel); min-height: 0; min-width: 0; display: flex; flex-direction: column; }
  .canvas { position: relative; background: var(--canvas); }
  .fl { position: absolute; display: flex; gap: 6px; align-items: center; }
  .tl { top: 8px; left: 8px; }
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
  .diags, .layers { list-style: none; margin: 0; padding: 0; }
  .diags .r { width: 100%; display: flex; gap: 6px; align-items: flex-start; text-align: left; border: 0; background: none; padding: 3px 2px; font-size: 12px; color: var(--txt-2); cursor: pointer; border-radius: 4px; }
  .diags .r:hover { background: var(--hover); }
  .layers label { display: flex; gap: 6px; align-items: center; font-size: 12px; padding: 2px 0; cursor: pointer; }
  .sw { width: 12px; height: 12px; border-radius: 3px; display: inline-block; background: var(--line-2); }
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
