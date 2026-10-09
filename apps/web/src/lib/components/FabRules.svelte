<script lang="ts">
  import { fabPresets, ruleLimit, RULE_LABELS, type BoardRules, type FabProfile, type RuleKey } from '@tracewise/schema';
  import { app } from '../app.svelte.ts';

  /** The manufacturer the board is made by (its limits are checked) and the design rules, kept above those limits. */
  let { rules, fab, layers }: { rules: BoardRules; fab: FabProfile | undefined; layers: 2 | 4 } = $props();

  let open = $state(false);
  const presets = fabPresets();
  const houses = [...new Set(presets.map((p) => p.house))];
  const imported = $derived(fab && !presets.some((p) => p.id === fab.id) ? fab : null);

  const rows: { key: RuleKey; op: string; label: string }[] = [
    { key: 'clearance', op: 'clearance_mm', label: 'Clearance' },
    { key: 'track', op: 'track_mm', label: 'Track' },
    { key: 'powerTrack', op: 'power_track_mm', label: 'Power track' },
    { key: 'viaDrill', op: 'via_drill_mm', label: 'Via drill' },
    { key: 'viaPad', op: 'via_pad_mm', label: 'Via pad' },
    { key: 'edgeClearance', op: 'edge_clearance_mm', label: 'Edge clearance' },
  ];

  function choose(e: Event) {
    const id = (e.currentTarget as HTMLSelectElement).value;
    if (id === fab?.id || (!id && !fab)) return;
    void app.userEdit(id ? `Manufacturer: ${id}` : 'No manufacturer limits', [id ? { op: 'set_fab_profile', preset: id } : { op: 'set_fab_profile', none: true }]);
  }

  async function setRule(r: (typeof rows)[number], e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    const v = Number(el.value);
    if (!(v > 0) || v === rules[r.key]) {
      el.value = String(rules[r.key]);
      return;
    }
    // a rejected value (below the manufacturer's limit) is explained by the flash; the field goes back
    if (!(await app.userEdit(`${RULE_LABELS[r.key]} ${v} mm`, [{ op: 'set_board', [r.op]: v }]))) el.value = String(rules[r.key]);
  }

  const limitRows = $derived(
    fab
      ? ([
          ['Track / gap', `${fab.limits.track} / ${fab.limits.clearance}`],
          ['Via drill / pad', fab.limits.viaDrill !== undefined || fab.limits.viaPad !== undefined ? `${fab.limits.viaDrill ?? '–'} / ${fab.limits.viaPad ?? '–'}` : ''],
          ['Plated hole · ring', fab.limits.pthDrill !== undefined || fab.limits.annularRing !== undefined ? `${fab.limits.pthDrill ?? '–'} · ${fab.limits.annularRing ?? '–'}` : ''],
          ['Non-plated hole', fab.limits.npthDrill !== undefined ? `${fab.limits.npthDrill}` : ''],
          ['Hole to hole', fab.limits.holeToHole !== undefined ? `${fab.limits.holeToHole}${fab.limits.padHoleToHole !== undefined ? ` / ${fab.limits.padHoleToHole}` : ''}` : ''],
          ['Copper to edge', fab.limits.copperToEdge !== undefined ? `${fab.limits.copperToEdge}${fab.limits.copperToEdgeInner !== undefined ? ` / ${fab.limits.copperToEdgeInner} inner` : ''}` : ''],
          ['Silkscreen line / text', fab.limits.silkWidth !== undefined || fab.limits.silkHeight !== undefined ? `${fab.limits.silkWidth ?? '–'} / ${fab.limits.silkHeight ?? '–'}` : ''],
        ] as [string, string][]).filter(([, v]) => v)
      : [],
  );
  const host = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  };
</script>

<h4>Manufacturer</h4>
<select class="text sel" aria-label="Manufacturer" value={fab?.id ?? ''} onchange={choose}>
  <option value="">None · no limits checked</option>
  {#if imported}<option value={imported.id}>{imported.house} · {imported.tier} (imported)</option>{/if}
  {#each houses as h (h)}
    <optgroup label={h}>
      {#each presets.filter((p) => p.house === h) as p (p.id)}<option value={p.id}>{p.house} · {p.tier}</option>{/each}
    </optgroup>
  {/each}
</select>

<button class="fold" aria-expanded={open} onclick={() => (open = !open)}><span class="chev">{open ? '▾' : '▸'}</span>Details</button>
{#if open}
  {#if fab}
    <p class="small muted src">
      {fab.origin === 'imported' ? 'Imported from' : 'Source:'}
      <a href={fab.source.url} target="_blank" rel="noopener noreferrer">{host(fab.source.url)}</a>{fab.source.checked ? `, checked ${fab.source.checked}` : ''}.
      {#if !fab.layers.includes(layers)}<span class="bad">Not made with {layers} layers.</span>{/if}
    </p>
    <button class="btn wide" disabled={app.running} title="The agent reads the source page again and compares its limits with the stored ones; you review the change before it applies" onclick={() => app.refreshFabLimits()}>Update check</button>
    <dl class="lim">
      {#each limitRows as [k, v] (k)}<dt>{k}</dt><dd class="mono">{v}</dd>{/each}
    </dl>
    {#if fab.notes?.length}
      <ul class="notes">{#each fab.notes as n (n)}<li>{n}</li>{/each}</ul>
    {/if}
  {:else}
    <p class="small muted">Pick one to check tracks, vias, holes and board size against what it can make. The agent can import another manufacturer's limits.</p>
  {/if}

  <h4>Design rules <span class="muted small">mm</span></h4>
  <div class="rules">
    {#each rows as r (r.key)}
      {@const min = fab ? ruleLimit(fab, r.key, layers) : undefined}
      <label for="rule-{r.key}">{r.label}</label>
      <input id="rule-{r.key}" class="text num mono" type="number" step="0.01" min={min ?? 0.075} value={rules[r.key]} onchange={(e) => void setRule(r, e)} />
      <span class="min muted mono">{min !== undefined ? `≥ ${min}` : ''}</span>
    {/each}
  </div>
{/if}

<style>
  h4 { margin: 12px 0 4px; font-size: 12px; display: flex; gap: 4px; align-items: center; }
  .small { font-size: 11.5px; margin: 2px 0 6px; }
  .sel { width: 100%; font-size: 12px; }
  .wide { width: 100%; margin: 2px 0 4px; }
  .src a { color: var(--accent-txt); }
  .bad { color: var(--warn); }
  .fold { display: flex; gap: 4px; align-items: center; border: 0; background: none; padding: 0; margin: 8px 0 2px; font: inherit; font-size: 12px; color: var(--txt-2); cursor: pointer; }
  .chev { width: 10px; color: var(--txt-3); }
  .lim { display: grid; grid-template-columns: 1fr auto; gap: 1px 8px; margin: 4px 0; }
  .lim dt { color: var(--txt-3); }
  .lim dd { margin: 0; text-align: right; }
  .notes { margin: 4px 0 0; padding-left: 16px; color: var(--txt-3); font-size: 11.5px; }
  .notes li { margin: 2px 0; }
  .rules { display: grid; grid-template-columns: 1fr 64px 52px; gap: 4px 6px; align-items: center; font-size: 12px; margin: 4px 0 12px; }
  .num { width: 100%; padding: 2px 6px; text-align: right; }
  .min { font-size: 11px; }
</style>
