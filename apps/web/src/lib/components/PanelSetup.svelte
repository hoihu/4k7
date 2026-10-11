<script lang="ts">
  import { autoTabs, PANEL_SIDES, type PanelSide, type PanelView } from '@tracewise/schema';
  import { app } from '../app.svelte.ts';

  /** The fabrication panel's settings (set_panel): copies, gap, rails, tabs, marks. */
  let { panel, size, onexport }: { panel: PanelView | undefined; size: { w: number; h: number }; onexport: () => void } = $props();

  const s = $derived(panel?.settings);
  const sides = $derived(new Set(s?.tabs.map((t) => t.side) ?? []));
  const perSide = $derived.by(() => {
    if (!s) return 'auto';
    if (JSON.stringify(s.tabs) === JSON.stringify(autoTabs(PANEL_SIDES.filter((x) => sides.has(x)), size.w, size.h))) return 'auto';
    const counts = PANEL_SIDES.filter((x) => sides.has(x)).map((x) => s.tabs.filter((t) => t.side === x).length);
    return counts.length && counts.every((c) => c === counts[0]) ? String(counts[0]) : 'mixed';
  });
  const sameRails = $derived(!!s && PANEL_SIDES.every((x) => s.rails[x] === s.rails.top));
  let railsOpen = $state(false);
  let more = $state(false);

  const edit = (summary: string, op: Record<string, unknown>) => app.userEdit(summary, [{ op: 'set_panel', ...op }]);

  /** A number field: sent when it changes and is valid, else put back. */
  async function num(e: Event, current: number, summary: (v: number) => string, key: (v: number) => Record<string, unknown>) {
    const el = e.currentTarget as HTMLInputElement;
    const v = Number(el.value);
    if (!Number.isFinite(v) || el.value === '' || v === current || !el.checkValidity()) {
      el.value = String(current);
      return;
    }
    if (!(await edit(summary(v), key(v)))) el.value = String(current);
  }
  /** Tabs on a side, or none there; the other sides keep theirs (moved ones too). */
  function toggleSide(side: PanelSide) {
    if (!s) return;
    const on = !sides.has(side);
    const n = perSide !== 'auto' && perSide !== 'mixed' ? Number(perSide) : undefined;
    const tabs = on ? [...s.tabs, ...autoTabs([side], size.w, size.h, n)] : s.tabs.filter((t) => t.side !== side);
    void edit(`Panel: ${on ? 'tabs' : 'no tabs'} on the ${side} side`, { tabs });
  }
  function setPerSide(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value;
    const on = PANEL_SIDES.filter((x) => sides.has(x));
    void edit(`Panel tabs: ${v === 'auto' ? 'by side length' : `${v} per side`}`, { tab_sides: on.length ? on : PANEL_SIDES, ...(v === 'auto' ? {} : { tabs_per_side: Number(v) }) });
  }
</script>

<h4>Panel</h4>
{#if !s || !panel}
  <p class="small muted">Make the board in a panel: copies in a frame, milled apart except at tabs with mouse bites. Defaults follow JLCPCB's rules for assembly.</p>
  <button class="btn wide" disabled={app.running} onclick={() => void edit('Panel 2 × 2', {})}>Make a 2 × 2 panel</button>
{:else}
  <p class="small mono">{panel.w} × {panel.h} mm · {panel.copies.length} boards · {panel.tabs.length} tabs · {panel.bites.length} holes</p>
  <div class="grid">
    <label for="pn-cols">Copies</label>
    <span class="pair">
      <input id="pn-cols" class="text num mono" type="number" min="1" max="20" step="1" value={s.cols} aria-label="Columns" onchange={(e) => void num(e, s.cols, (v) => `Panel ${v} × ${s.rows}`, (v) => ({ cols: v }))} />
      <span class="muted">×</span>
      <input class="text num mono" type="number" min="1" max="20" step="1" value={s.rows} aria-label="Rows" onchange={(e) => void num(e, s.rows, (v) => `Panel ${s.cols} × ${v}`, (v) => ({ rows: v }))} />
    </span>
    <label for="pn-gap">Gap</label>
    <input id="pn-gap" class="text num mono" type="number" min="1" max="10" step="0.1" value={s.gap} title="The milled channel between the boards and to the frame: the router's width" onchange={(e) => void num(e, s.gap, (v) => `Panel gap ${v} mm`, (v) => ({ gap_mm: v }))} />
    <label for="pn-rail">Rails</label>
    {#if sameRails}
      <input id="pn-rail" class="text num mono" type="number" min="0" max="30" step="0.5" value={s.rails.top} title="Frame width on every side (0 = no frame)" onchange={(e) => void num(e, s.rails.top, (v) => `Panel rails ${v} mm`, (v) => ({ rail_mm: v }))} />
    {:else}
      <span class="mono small r">{PANEL_SIDES.map((x) => s.rails[x]).join(' / ')}</span>
    {/if}
  </div>
  <button class="fold" aria-expanded={railsOpen} onclick={() => (railsOpen = !railsOpen)}><span class="chev">{railsOpen ? '▾' : '▸'}</span>Rails per side</button>
  {#if railsOpen}
    <div class="grid">
      {#each PANEL_SIDES as side (side)}
        <label for="pn-rail-{side}">{side[0]!.toUpperCase() + side.slice(1)}</label>
        <input id="pn-rail-{side}" class="text num mono" type="number" min="0" max="30" step="0.5" value={s.rails[side]} onchange={(e) => void num(e, s.rails[side], (v) => `Panel ${side} rail ${v} mm`, (v) => ({ rails_mm: { [side]: v } }))} />
      {/each}
    </div>
  {/if}

  <h4>Tabs <span class="muted small">mm</span></h4>
  <div class="sides" role="group" aria-label="Sides with tabs">
    {#each PANEL_SIDES as side (side)}
      <button class="side" aria-pressed={sides.has(side)} disabled={app.running} title="Tabs on the {side} side of every board (the sides without are milled through)" onclick={() => toggleSide(side)}>{side}</button>
    {/each}
  </div>
  <div class="grid">
    <label for="pn-per">Per side</label>
    <select id="pn-per" class="text sel" value={perSide} onchange={setPerSide}>
      <option value="auto">By length</option>
      {#if perSide === 'mixed'}<option value="mixed" disabled>As placed</option>{/if}
      {#each [1, 2, 3, 4] as n (n)}<option value={String(n)}>{n}</option>{/each}
    </select>
    <label for="pn-tw">Width</label>
    <input id="pn-tw" class="text num mono" type="number" min="2" max="20" step="0.5" value={s.tab.width} title="JLCPCB asks for at least 5 mm with mouse bites" onchange={(e) => void num(e, s.tab.width, (v) => `Panel tabs ${v} mm wide`, (v) => ({ tab_width_mm: v }))} />
  </div>
  <p class="small muted">Click a board edge in the panel to add a tab, drag one to move it, click one to remove it. Tabs are the same on every copy.</p>
  <button class="fold" aria-expanded={more} onclick={() => (more = !more)}><span class="chev">{more ? '▾' : '▸'}</span>Mouse bites and marks</button>
  {#if more}
    <div class="grid">
      <label for="pn-hole">Hole Ø</label>
      <input id="pn-hole" class="text num mono" type="number" min="0.3" max="1.2" step="0.05" value={s.tab.hole} onchange={(e) => void num(e, s.tab.hole, (v) => `Mouse bites Ø${v} mm`, (v) => ({ hole_mm: v }))} />
      <label for="pn-pitch">Pitch ≤</label>
      <input id="pn-pitch" class="text num mono" type="number" min="0.5" max="2" step="0.05" value={s.tab.pitch} onchange={(e) => void num(e, s.tab.pitch, (v) => `Mouse-bite pitch ${v} mm`, (v) => ({ hole_pitch_mm: v }))} />
    </div>
    <label class="chk" title="A row of holes where a tab meets the frame too, so the whole tab breaks out; between two boards there is always a row at each board"><input type="checkbox" checked={s.tab.frameSide !== false} disabled={app.running} onchange={(e) => void edit(e.currentTarget.checked ? 'Mouse bites on the frame side too' : 'Mouse bites at the board edge only', { frame_holes: e.currentTarget.checked })} />Holes on the frame side too</label>
    <label class="chk"><input type="checkbox" checked={s.fiducials} disabled={app.running} onchange={(e) => void edit(e.currentTarget.checked ? 'Panel fiducials' : 'No panel fiducials', { fiducials: e.currentTarget.checked })} />Fiducials (3 on the rails)</label>
    <label class="chk"><input type="checkbox" checked={s.toolingHoles} disabled={app.running} onchange={(e) => void edit(e.currentTarget.checked ? 'Panel tooling holes' : 'No panel tooling holes', { tooling_holes: e.currentTarget.checked })} />Tooling holes (4 × Ø2 mm)</label>
  {/if}
  <div class="row2">
    <button class="btn" title="Gerber, drill with the mouse bites and tooling holes, BOM and pick-and-place of every copy, as a .zip" onclick={onexport}>Panel files ⤓</button>
    <button class="btn" disabled={app.running} onclick={() => void edit('No panel', { none: true })}>Remove panel</button>
  </div>
{/if}

<style>
  h4 { margin: 12px 0 4px; font-size: 12px; display: flex; gap: 4px; align-items: center; }
  .small { font-size: 11.5px; margin: 2px 0 6px; }
  .wide { width: 100%; margin: 2px 0 4px; }
  .grid { display: grid; grid-template-columns: 1fr 116px; gap: 4px 6px; align-items: center; font-size: 12px; margin: 4px 0 6px; }
  .pair { display: flex; gap: 4px; align-items: center; }
  .num { width: 100%; padding: 2px 6px; text-align: right; }
  .sel { width: 100%; font-size: 12px; }
  .r { text-align: right; }
  .fold { display: flex; gap: 4px; align-items: center; border: 0; background: none; padding: 0; margin: 4px 0 2px; font: inherit; font-size: 12px; color: var(--txt-2); cursor: pointer; }
  .chev { width: 10px; color: var(--txt-3); }
  .sides { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; margin: 2px 0 6px; }
  .side { border: 1px solid var(--line-2); background: var(--panel); color: var(--txt-2); padding: 2px 0; font-size: 11.5px; cursor: pointer; }
  .side + .side { border-left: 0; }
  .side:first-child { border-radius: 6px 0 0 6px; }
  .side:last-child { border-radius: 0 6px 6px 0; }
  .side[aria-pressed='true'] { background: var(--accent-soft); color: var(--accent-txt); }
  .chk { display: flex; gap: 6px; align-items: center; font-size: 12px; padding: 2px 0; cursor: pointer; }
  .row2 { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
</style>
