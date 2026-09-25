<script lang="ts">
  import { BUILTIN_PARTS, searchParts, symbolFor } from '@tracewise/parts';
  import type { PartCard, SheetView } from '@tracewise/schema';
  import SchematicCanvas from './SchematicCanvas.svelte';

  let q = $state('');
  let current = $state<PartCard>(BUILTIN_PARTS.find((p) => p.id === 'ti:TPS54331DR') ?? BUILTIN_PARTS[0]!);
  const list = $derived(q.trim() ? searchParts(q) : BUILTIN_PARTS);

  /** Preview the generated symbol through the same renderer as the schematic. */
  const preview = $derived.by((): SheetView => {
    const def = symbolFor(current);
    return {
      id: 'preview',
      name: current.id,
      bbox: { x: def.bbox.x - 300, y: def.bbox.y - 300, w: def.bbox.w + 600, h: def.bbox.h + 600 },
      symbols: [{ componentId: 'p', refdes: `${current.refPrefix}?`, value: current.mpn ?? current.id.split(':')[1]!, bbox: def.bbox, prims: def.prims, pins: def.pins, refPos: def.refPos, valuePos: def.valuePos }],
      wires: [],
      junctions: [],
      labels: [],
      noConnects: [],
    };
  });
</script>

<div class="parts">
  <div class="pane list">
    <div class="ph"><b>Library</b><span class="grow"></span><span class="muted">{BUILTIN_PARTS.length}</span></div>
    <div class="search"><input class="text" placeholder="Search parts…" bind:value={q} /></div>
    <div class="drop" title="Arrives in M1">Drop a datasheet PDF<br /><span>AI extracts parameters, generators build the part (M1)</span></div>
    <div class="scroll">
      <ul class="rows">
        {#each list as p (p.id)}
          <li>
            <button class="r item" aria-current={p.id === current.id} onclick={() => (current = p)}>
              <span class="grow">
                <span class="mono">{p.mpn ?? p.id}</span>
                <span class="sub trunc">{p.description}</span>
              </span>
              <span class="tag">{p.category}</span>
            </button>
          </li>
        {/each}
      </ul>
    </div>
  </div>

  <div class="pane detail">
    <div class="ph">
      <b class="mono">{current.id}</b>
      {#if current.package}<span class="tag">{current.package}</span>{/if}
      <span class="tag warn" title={current.provenance.note}>{current.provenance.source}</span>
      <span class="grow"></span>
      {#if current.datasheet}<a class="muted" href={current.datasheet} target="_blank" rel="noreferrer">datasheet ↗</a>{/if}
    </div>
    <div class="scroll body">
      <p class="desc">{current.description}{#if current.manufacturer} · {current.manufacturer}{/if}</p>
      <div class="grid">
        <div class="sym"><SchematicCanvas sheet={preview} compact /></div>
        <div>
          <table class="pins">
            <thead><tr><th>Pin</th><th>Name</th><th>Type</th><th>Max</th></tr></thead>
            <tbody>
              {#each current.pins as p (p.number)}
                <tr><td class="mono">{p.number}</td><td class="mono">{p.name}</td><td>{p.type}</td><td class="mono">{p.maxVoltage ? `${p.maxVoltage} V` : ''}</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
      {#if current.requirements?.length}
        <h4>Datasheet requirements <span class="muted">(checked by semantic ERC)</span></h4>
        <ul class="plain">
          {#each current.requirements as r, i (i)}
            <li>
              {#if r.kind === 'cap_between'}{r.value} capacitor between {r.pins[0]} and {r.pins[1]}
              {:else if r.kind === 'decouple'}≥ {r.min} decoupling on {r.pin}
              {:else}pull-{r.direction} on {r.pin}{/if}
              {#if r.src?.note}<span class="muted"> · {r.src.note}</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#if Object.keys(current.params).length}
        <h4>Parameters</h4>
        <ul class="plain">
          {#each Object.entries(current.params) as [k, s] (k)}<li><span class="mono">{k}</span>{#if s.unit} ({s.unit}){/if}{#if s.required} · required{/if}{#if s.description} · <span class="muted">{s.description}</span>{/if}</li>{/each}
        </ul>
      {/if}
      {#if current.notes?.length}
        <h4>Notes for the agent</h4>
        <ul class="plain">{#each current.notes as n, i (i)}<li>{n}</li>{/each}</ul>
      {/if}
    </div>
  </div>
</div>

<style>
  .parts { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 1px; background: var(--line); height: 100%; min-height: 0; }
  .list, .detail { min-height: 0; }
  .search { padding: 6px 8px; border-bottom: 1px solid var(--line); }
  .search input { width: 100%; }
  .drop { margin: 8px; border: 1.5px dashed var(--line-2); border-radius: 8px; padding: 8px; text-align: center; color: var(--txt-3); font-size: 12px; }
  .drop span { font-size: 11px; }
  .item { width: 100%; border: 0; background: transparent; text-align: left; padding: 4px 8px 4px 10px; }
  .item[aria-current="true"] { background: var(--accent-soft); }
  .sub { display: block; font-size: 11px; color: var(--txt-3); max-width: 170px; }
  .body { padding: 10px 14px; }
  .desc { margin: 0 0 10px; color: var(--txt-2); }
  .grid { display: grid; grid-template-columns: minmax(240px, 1fr) minmax(260px, 1fr); gap: 12px; align-items: start; }
  .sym { height: 280px; background: var(--canvas); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; position: relative; }
  .pins { width: 100%; border-collapse: collapse; font-size: 12px; }
  .pins th { text-align: left; font-weight: 500; color: var(--txt-3); font-size: 11px; padding: 3px 6px; border-bottom: 1px solid var(--line); }
  .pins td { padding: 3px 6px; border-bottom: 1px solid var(--line); }
  h4 { margin: 14px 0 4px; font-size: 12px; }
  .plain { margin: 0; padding-left: 18px; color: var(--txt-2); }
  .plain li { margin: 2px 0; }
  @media (max-width: 760px) {
    .parts { grid-template-columns: minmax(0, 1fr); grid-template-rows: 40% 60%; }
    .grid { grid-template-columns: minmax(0, 1fr); }
  }
</style>
