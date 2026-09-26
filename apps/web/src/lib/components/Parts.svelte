<script lang="ts">
  import { BUILTIN_PARTS, searchParts, symbolFor } from '@tracewise/parts';
  import type { PartCard, SheetView } from '@tracewise/schema';
  import { app } from '../app.svelte.ts';
  import FootprintView from './FootprintView.svelte';
  import SchematicCanvas from './SchematicCanvas.svelte';

  const ingest = app.ingest;
  let q = $state('');
  let current = $state<PartCard>(BUILTIN_PARTS.find((p) => p.id === 'ti:TPS54331DR') ?? BUILTIN_PARTS[0]!);
  /** 'import' shows the datasheet importer (form, progress, review) instead of a part. */
  let mode = $state<'part' | 'import'>(ingest.phase === 'idle' ? 'part' : 'import');
  let hoverPin = $state<string | null>(null);

  const userIds = $derived(new Set(ingest.library.map((p) => p.id)));
  const list = $derived(q.trim() ? searchParts(q) : [...ingest.library, ...BUILTIN_PARTS]);

  /* ---- import form ---- */
  let mpn = $state('');
  let url = $state('');
  let notes = $state('');
  let file = $state<File | null>(null);
  let model = $state('sonnet');
  let dragging = $state(false);
  let picker: HTMLInputElement | undefined = $state();

  function pick(f: File | undefined | null) {
    if (!f) return;
    file = f;
    url = '';
    // "stm32f777vi.pdf" is not an ordering code, but it's a useful hint
    if (!mpn) mpn = f.name.replace(/\.pdf$/i, '').toUpperCase();
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    pick([...(e.dataTransfer?.files ?? [])].find((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name)));
  }
  function startImport() {
    void ingest.start({ mpn, ...(file ? { file } : { url }), notes, model });
  }
  async function save() {
    const card = await ingest.save();
    if (card) {
      current = card;
      mode = 'part';
      app.flash(`${card.mpn ?? card.id} added to your library`);
    }
  }
  async function remove(card: PartCard) {
    await ingest.remove(card.id);
    current = BUILTIN_PARTS[0]!;
    app.flash(`Removed ${card.id}`);
  }

  /** Preview a generated symbol through the same renderer as the schematic. */
  function previewOf(card: PartCard): SheetView {
    const def = symbolFor(card);
    return {
      id: 'preview',
      name: card.id,
      bbox: { x: def.bbox.x - 300, y: def.bbox.y - 300, w: def.bbox.w + 600, h: def.bbox.h + 600 },
      symbols: [{ componentId: 'p', refdes: `${card.refPrefix}?`, value: card.mpn ?? card.id.split(':')[1]!, bbox: def.bbox, prims: def.prims, pins: def.pins, refPos: def.refPos, valuePos: def.valuePos }],
      wires: [],
      junctions: [],
      labels: [],
      noConnects: [],
    };
  }
  const big = (c: PartCard) => c.pins.length > 24;
</script>

{#snippet detail(card: PartCard)}
  <p class="desc">{card.description}{#if card.manufacturer} · {card.manufacturer}{/if}</p>
  <div class="grid" class:big={big(card)}>
    <div class="sym"><SchematicCanvas sheet={previewOf(card)} compact /></div>
    {#if card.packageInfo}<div class="fp"><FootprintView {card} bind:hover={hoverPin} /></div>{/if}
  </div>
  <table class="pins">
    <thead><tr><th>Pin</th><th>Name</th><th>Type</th><th>Max</th><th>Functions</th></tr></thead>
    <tbody>
      {#each card.pins as p (p.number)}
        <tr class:on={hoverPin === p.number} onmouseenter={() => (hoverPin = p.number)} onmouseleave={() => (hoverPin = null)}>
          <td class="mono">{p.number}</td><td class="mono">{p.name}</td><td>{p.type}</td><td class="mono">{p.maxVoltage ? `${p.maxVoltage} V` : ''}</td>
          <td class="fn" title={p.description}>{p.description ?? ''}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if card.requirements?.length}
    <h4>Datasheet requirements <span class="muted">(checked by semantic ERC)</span></h4>
    <ul class="plain">
      {#each card.requirements as r, i (i)}
        <li>
          {#if r.kind === 'cap_between'}{r.value} capacitor between {r.pins[0]} and {r.pins[1]}
          {:else if r.kind === 'decouple'}≥ {r.min} decoupling on {r.pin}
          {:else}pull-{r.direction} on {r.pin}{/if}
          {#if r.note ?? r.src?.note}<span class="muted"> · {r.note ?? r.src?.note}</span>{/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if Object.keys(card.params).length}
    <h4>Parameters</h4>
    <ul class="plain">
      {#each Object.entries(card.params) as [k, s] (k)}<li><span class="mono">{k}</span>{#if s.unit} ({s.unit}){/if}{#if s.required} · required{/if}{#if s.description} · <span class="muted">{s.description}</span>{/if}</li>{/each}
    </ul>
  {/if}
  {#if card.notes?.length}
    <h4>Notes for the agent</h4>
    <ul class="plain">{#each card.notes as n, i (i)}<li>{n}</li>{/each}</ul>
  {/if}
{/snippet}

{#snippet issueList()}
  {#if ingest.issues.length}
    <ul class="issues">
      {#each ingest.issues as i, n (n)}<li class={i.severity}><span class="tag {i.severity === 'error' ? 'err' : 'warn'}">{i.severity}</span> {i.message}</li>{/each}
    </ul>
  {/if}
{/snippet}

<div class="parts">
  <div class="pane list">
    <div class="ph"><b>Library</b><span class="grow"></span><span class="muted">{ingest.library.length + BUILTIN_PARTS.length}</span></div>
    <div class="search"><input class="text" placeholder="Search parts…" bind:value={q} /></div>
    <button class="btn imp" aria-current={mode === 'import'} onclick={() => (mode = 'import')}>
      Import from datasheet…
      {#if ingest.phase === 'running'}<span class="tag info">running</span>{:else if ingest.phase === 'review'}<span class="tag warn">review</span>{/if}
    </button>
    <div class="scroll">
      <ul class="rows">
        {#each list as p (p.id)}
          <li>
            <button class="r item" aria-current={mode === 'part' && p.id === current.id} onclick={() => ((current = p), (mode = 'part'))}>
              <span class="grow">
                <span class="mono">{p.mpn ?? p.id}</span>
                <span class="sub trunc">{p.description}</span>
              </span>
              <span class="tag" class:ok={userIds.has(p.id)}>{userIds.has(p.id) ? 'mine' : p.category}</span>
            </button>
          </li>
        {/each}
      </ul>
    </div>
  </div>

  <div class="pane detail">
    {#if mode === 'part'}
      <div class="ph">
        <b class="mono">{current.id}</b>
        {#if current.package}<span class="tag">{current.package}</span>{/if}
        <span class="tag warn" title={current.provenance.note}>{current.provenance.source}{#if current.provenance.page}&nbsp;p.{current.provenance.page}{/if}</span>
        <span class="grow"></span>
        {#if current.datasheet}<a class="muted" href={current.datasheet} target="_blank" rel="noreferrer">datasheet ↗</a>{/if}
        {#if userIds.has(current.id)}<button class="btn" onclick={() => remove(current)}>Remove</button>{/if}
      </div>
      <div class="scroll body">{@render detail(current)}</div>
    {:else if ingest.phase === 'review' && ingest.card}
      {@const card = ingest.card}
      <div class="ph">
        <b>Review import</b>
        <span class="mono">{card.id}</span>
        <span class="tag">{card.package}</span>
        <span class="tag">{card.pins.length} pins</span>
        <span class="grow"></span>
        {#if ingest.costUsd !== null}<span class="muted">${ingest.costUsd.toFixed(2)}</span>{/if}
        <button class="btn" onclick={() => ingest.discard()}>Discard</button>
        <button class="btn pri" onclick={save}>Add to library</button>
      </div>
      <div class="scroll body">
        <p class="hint">Claude Code extracted the pins and package from the datasheet; the symbol and footprint are generated from them. Check pin numbers against the datasheet before using the part on a board.</p>
        {@render issueList()}
        {@render detail(card)}
      </div>
    {:else}
      <div class="ph">
        <b>Import from datasheet</b>
        <span class="grow"></span>
        {#if ingest.phase === 'running'}<button class="btn" onclick={() => ingest.cancel()}>Stop</button>{/if}
      </div>
      <div class="scroll body">
        {#if ingest.phase === 'running'}
          <p class="desc"><b class="mono">{ingest.request?.mpn}</b> · {ingest.request?.source}</p>
          <ol class="log">
            {#each ingest.log as l, i (i)}<li class:last={i === ingest.log.length - 1}>{l}</li>{/each}
          </ol>
          {@render issueList()}
          {#if ingest.reply}<p class="reply">{ingest.reply}</p>{/if}
        {:else}
          {#if !ingest.available}
            <p class="notice">The import runs on your local Claude Code. Pair the bridge in <button class="link" onclick={() => (app.view = 'set')}>Settings</button> first.</p>
          {/if}
          <form class="form" onsubmit={(e) => (e.preventDefault(), startImport())}>
            <label>Part number <span class="muted">(full ordering code: it selects the package)</span>
              <input class="text mono" placeholder="STM32F777VIT6" bind:value={mpn} />
            </label>
            <div
              class="drop"
              class:on={dragging}
              role="button"
              tabindex="0"
              ondragover={(e) => (e.preventDefault(), (dragging = true))}
              ondragleave={() => (dragging = false)}
              ondrop={onDrop}
              onclick={() => picker?.click()}
              onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && picker?.click()}
            >
              {#if file}<b>{file.name}</b> <span class="muted">{(file.size / 1048576).toFixed(1)} MB</span>
              {:else}Drop the datasheet PDF here, or click to choose{/if}
            </div>
            <input bind:this={picker} type="file" accept="application/pdf,.pdf" hidden onchange={(e) => pick(e.currentTarget.files?.[0])} />
            <label>…or its link
              <input class="text" placeholder="https://www.st.com/resource/en/datasheet/stm32f777vi.pdf" bind:value={url} oninput={() => (file = null)} />
            </label>
            <div class="row">
              <label>Model
                <select class="text" bind:value={model}>
                  <option value="sonnet">Sonnet (recommended)</option>
                  <option value="opus">Opus (most careful)</option>
                  <option value="haiku">Haiku (cheapest)</option>
                  <option value="">Claude Code default</option>
                </select>
              </label>
            </div>
            <label>Notes <span class="muted">(optional)</span>
              <textarea class="text" rows="2" placeholder="e.g. use the LQFP100 pinout, name pins by their reset function" bind:value={notes}></textarea>
            </label>
            {#if ingest.error}<p class="err">{ingest.error}</p>{/if}
            {@render issueList()}
            <div><button class="btn pri" type="submit" disabled={!ingest.available || !mpn.trim() || (!file && !url.trim())}>Import</button></div>
          </form>
          <p class="hint">Claude Code reads the datasheet text (only that file) and extracts the pin table and package dimensions. The app checks every submission (pin count, numbering, ball names, footprint) and sends problems back until it is consistent; the symbol and footprint are generated deterministically. Large datasheets take a few minutes.</p>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .parts { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 1px; background: var(--line); height: 100%; min-height: 0; }
  .list, .detail { min-height: 0; }
  .search { padding: 6px 8px; border-bottom: 1px solid var(--line); }
  .search input { width: 100%; }
  .imp { margin: 6px 8px; display: flex; gap: 6px; align-items: center; justify-content: center; }
  .imp[aria-current="true"] { border-color: var(--accent); color: var(--accent-txt); }
  .item { width: 100%; border: 0; background: transparent; text-align: left; padding: 4px 8px 4px 10px; }
  .item[aria-current="true"] { background: var(--accent-soft); }
  .sub { display: block; font-size: 11px; color: var(--txt-3); max-width: 170px; }
  .body { padding: 10px 14px; }
  .desc { margin: 0 0 10px; color: var(--txt-2); }
  .grid { display: grid; grid-template-columns: minmax(240px, 1fr) minmax(240px, 1fr); gap: 12px; align-items: stretch; margin-bottom: 10px; }
  .sym, .fp { height: 300px; background: var(--canvas); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; position: relative; }
  .grid.big .sym, .grid.big .fp { height: min(62vh, 560px); }
  .pins { width: 100%; border-collapse: collapse; font-size: 12px; }
  .pins th { text-align: left; font-weight: 500; color: var(--txt-3); font-size: 11px; padding: 3px 6px; border-bottom: 1px solid var(--line); }
  .pins td { padding: 2px 6px; border-bottom: 1px solid var(--line); }
  .pins tr.on td { background: var(--accent-soft); }
  .fn { color: var(--txt-3); font-size: 11px; max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  h4 { margin: 14px 0 4px; font-size: 12px; }
  .plain { margin: 0; padding-left: 18px; color: var(--txt-2); }
  .plain li { margin: 2px 0; }
  .form { display: flex; flex-direction: column; gap: 8px; max-width: 560px; }
  .form label { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--txt-2); }
  .form .row { display: flex; gap: 8px; flex-wrap: wrap; }
  .drop { border: 1.5px dashed var(--line-2); border-radius: 8px; padding: 14px 8px; text-align: center; color: var(--txt-3); font-size: 12px; cursor: pointer; }
  .drop.on, .drop:hover { border-color: var(--accent); color: var(--txt-2); }
  .hint { color: var(--txt-3); font-size: 11.5px; max-width: 640px; }
  .notice { background: var(--info-soft); color: var(--info); padding: 6px 10px; border-radius: 6px; font-size: 12px; max-width: 560px; }
  .link { border: 0; background: none; padding: 0; color: inherit; text-decoration: underline; cursor: pointer; font: inherit; }
  .err { color: var(--err); margin: 0; font-size: 12px; }
  .log { margin: 0 0 8px; padding-left: 20px; font-size: 12px; color: var(--txt-3); }
  .log li.last { color: var(--txt); }
  .log li.last::after { content: ' …'; }
  .issues { list-style: none; margin: 0 0 10px; padding: 0; font-size: 12px; display: flex; flex-direction: column; gap: 3px; }
  .reply { color: var(--txt-2); white-space: pre-wrap; font-size: 12px; }
  @media (max-width: 760px) {
    .parts { grid-template-columns: minmax(0, 1fr); grid-template-rows: 40% 60%; }
    .grid { grid-template-columns: minmax(0, 1fr); }
  }
</style>
