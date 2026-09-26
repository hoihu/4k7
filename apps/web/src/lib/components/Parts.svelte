<script lang="ts">
  import { BUILTIN_PARTS, planUnits, searchParts, symbolFor, unitCount } from '@tracewise/parts';
  import type { PartCard, PartPin, SheetView, SymbolView } from '@tracewise/schema';
  import { app } from '../app.svelte.ts';
  import type { Datasheet } from '../ingest.svelte.ts';
  import Body3DView from './Body3DView.svelte';
  import DatasheetView from './DatasheetView.svelte';
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
  let verify = $state(true);
  /** Footprint or 3D body next to the symbol. */
  let mech = $state<'fp' | '3d'>('fp');

  /* ---- datasheet pane: the page a value was read from ---- */
  let sheetDoc = $state.raw<Datasheet | null>(null);
  let dsPage = $state(1);
  let dsTerms = $state<string[]>([]);
  let dsLabel = $state('');
  /** The part shown in the detail pane (the one under review, or the selected library part). */
  const shown = $derived(mode === 'import' ? ingest.card : current);
  $effect(() => {
    const card = shown;
    let stale = false;
    if (!card || card.provenance.source !== 'datasheet') {
      sheetDoc = null;
      return;
    }
    void ingest.datasheetFor(card).then((d) => {
      if (stale) return;
      sheetDoc = d;
      dsPage = card.provenance.page ?? 1;
      dsTerms = [];
      dsLabel = '';
    });
    return () => (stale = true);
  });
  const baseName = (n: string) => n.split(/[-/ (]/)[0]!;
  function showPin(p: PartPin) {
    if (!p.page) return;
    dsPage = p.page;
    dsTerms = [p.number, baseName(p.name)];
    dsLabel = `pin ${p.number} ${p.name}`;
  }
  function showPackage(card: PartCard) {
    if (!card.packageInfo?.page) return;
    dsPage = card.packageInfo.page;
    dsTerms = [];
    dsLabel = `package ${card.packageInfo.name}`;
  }
  async function toggleSplit(card: PartCard) {
    if (mode === 'import') {
      ingest.split = !ingest.split;
      return;
    }
    const next: PartCard = card.units?.length ? { ...card, units: undefined } : { ...card, units: planUnits(card.pins) };
    if (!next.units) delete next.units;
    await ingest.update(next);
    current = ingest.library.find((p) => p.id === card.id) ?? next;
  }
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
    void ingest.start({ mpn, ...(file ? { file } : { url }), notes, model, verify });
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

  /** Preview a generated symbol (all units side by side) through the same renderer as the schematic. */
  function previewOf(card: PartCard): SheetView {
    const symbols: SymbolView[] = [];
    let x = 0;
    for (let u = 0; u < unitCount(card); u++) {
      const def = symbolFor(card, false, card.units?.length ? { unit: u } : {});
      const dx = x - def.bbox.x;
      const move = <T extends { x: number; y: number }>(p: T): T => ({ ...p, x: p.x + dx });
      symbols.push({
        componentId: 'p',
        refdes: `${card.refPrefix}?`,
        ...(card.units?.[u] ? { unit: card.units[u]!.name } : {}),
        value: card.mpn ?? card.id.split(':')[1]!,
        bbox: { ...def.bbox, x: def.bbox.x + dx },
        prims: def.prims.map((p) => shift(p, dx)),
        pins: def.pins.map(move),
        refPos: move(def.refPos),
        valuePos: move(def.valuePos),
      });
      x += def.bbox.w + 500;
    }
    const minY = Math.min(...symbols.map((s) => s.bbox.y));
    const maxY = Math.max(...symbols.map((s) => s.bbox.y + s.bbox.h));
    return { id: 'preview', name: card.id, bbox: { x: -300, y: minY - 300, w: x + 100, h: maxY - minY + 600 }, symbols, wires: [], junctions: [], labels: [], noConnects: [] };
  }
  function shift(p: SymbolView['prims'][number], dx: number): SymbolView['prims'][number] {
    switch (p.t) {
      case 'line':
        return { ...p, x1: p.x1 + dx, x2: p.x2 + dx };
      case 'rect':
        return { ...p, x: p.x + dx };
      case 'poly':
        return { ...p, pts: p.pts.map((v, i) => (i % 2 ? v : v + dx)) };
      case 'circle':
        return { ...p, x: p.x + dx };
      default:
        return p; // paths only occur in two-pin symbols, which have a single unit
    }
  }
  const big = (c: PartCard) => c.pins.length > 24;
  const unitName = (card: PartCard, pin: string) => card.units?.find((u) => Object.values(u.layout).some((side) => (side as (string[] | null)[]).some((e) => e?.includes(pin))))?.name ?? '';
</script>

{#snippet detail(card: PartCard)}
  <p class="desc">{card.description}{#if card.manufacturer} · {card.manufacturer}{/if}</p>
  {#if card.pins.length > 24}
    <div class="tools">
      <span class="muted">Symbol</span>
      <div class="seg">
        <button aria-pressed={!card.units?.length} onclick={() => card.units?.length && toggleSplit(card)}>Single</button>
        <button aria-pressed={!!card.units?.length} onclick={() => !card.units?.length && toggleSplit(card)}>Split into units</button>
      </div>
      {#if card.units?.length}<span class="muted">{card.units.map((u) => `${u.name}: ${u.title}`).join(' · ')}</span>{/if}
    </div>
  {/if}
  <div class="grid" class:big={big(card)}>
    <div class="sym"><SchematicCanvas sheet={previewOf(card)} compact /></div>
    {#if card.packageInfo}
      <div class="fp">
        <div class="tabs">
          <button aria-pressed={mech === 'fp'} onclick={() => (mech = 'fp')}>Footprint</button>
          <button aria-pressed={mech === '3d'} onclick={() => (mech = '3d')}>3D</button>
          <span class="grow"></span>
          {#if card.packageInfo.page && sheetDoc}<button class="link" onclick={() => showPackage(card)}>drawing p. {card.packageInfo.page}</button>{/if}
        </div>
        <div class="mech">
          {#if mech === 'fp'}<FootprintView {card} bind:hover={hoverPin} />{:else}<Body3DView {card} />{/if}
        </div>
      </div>
    {/if}
  </div>
  <table class="pins">
    <thead><tr><th>Pin</th>{#if card.units?.length}<th>Unit</th>{/if}<th>Name</th><th>Type</th><th>Max</th><th>Functions</th>{#if sheetDoc}<th>Page</th>{/if}</tr></thead>
    <tbody>
      {#each card.pins as p (p.number)}
        <tr
          class:on={hoverPin === p.number}
          class:clickable={!!(sheetDoc && p.page)}
          onmouseenter={() => (hoverPin = p.number)}
          onmouseleave={() => (hoverPin = null)}
          onclick={() => sheetDoc && showPin(p)}
        >
          <td class="mono">{p.number}</td>{#if card.units?.length}<td class="mono">{unitName(card, p.number)}</td>{/if}<td class="mono">{p.name}</td><td>{p.type}</td><td class="mono">{p.maxVoltage ? `${p.maxVoltage} V` : ''}</td>
          <td class="fn" title={p.description}>{p.description ?? ''}</td>
          {#if sheetDoc}<td class="mono muted">{p.page ?? ''}</td>{/if}
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

{#snippet issueList(issues: { severity: 'error' | 'warning'; message: string }[])}
  {#if issues.length}
    <ul class="issues">
      {#each issues as i, n (n)}<li class={i.severity}><span class="tag {i.severity === 'error' ? 'err' : 'warn'}">{i.severity}</span> {i.message}</li>{/each}
    </ul>
  {/if}
{/snippet}

{#snippet crossCheck()}
  {#if ingest.passes > 1}
    {#if ingest.secondPassFailed}
      <p class="notice warn">The second pass did not finish ({ingest.secondPassFailed}), so nothing was cross-checked. Check the pins against the datasheet yourself.</p>
    {:else if !ingest.disagreements.length}
      <p class="notice ok">Two independent passes agree on all {ingest.card?.pins.length} pins and the package dimensions.</p>
    {:else}
      <div class="notice warn">
        <b>The two passes disagree on {ingest.disagreements.length} {ingest.disagreements.length === 1 ? 'fact' : 'facts'}.</b> Pick the right value (click a pin row to see its datasheet page).
      </div>
      <table class="pins diff">
        <thead><tr><th></th><th>Pass 1</th><th>Pass 2</th></tr></thead>
        <tbody>
          {#each ingest.disagreements as d (d.key)}
            {@const pin = d.key.startsWith('pin:') ? ingest.card?.pins.find((p) => p.number.toUpperCase() === d.key.slice(4)) : undefined}
            <tr class:clickable={!!pin} onclick={() => pin && sheetDoc && showPin(pin)}>
              <td class="mono">{d.label}</td>
              <td><label><input type="radio" name={d.key} checked={!ingest.takeB[d.key]} onchange={() => (ingest.takeB[d.key] = false)} /> <span class="mono">{d.a}</span></label></td>
              <td><label><input type="radio" name={d.key} checked={!!ingest.takeB[d.key]} onchange={() => (ingest.takeB[d.key] = true)} /> <span class="mono">{d.b}</span></label></td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  {/if}
{/snippet}

<div class="parts" class:withds={!!sheetDoc && !!shown && (mode === 'part' || ingest.phase === 'review')}>
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
        <p class="hint">Claude Code extracted the pins and package from the datasheet; the symbol, footprint and 3D body are generated from them.{#if sheetDoc}&nbsp;Click a pin to see the table row it was read from.{/if}</p>
        {@render crossCheck()}
        {@render issueList(ingest.issues)}
        {@render detail(card)}
      </div>
    {:else if ingest.phase === 'review'}
      <div class="ph"><b>Review import</b><span class="grow"></span><button class="btn" onclick={() => ingest.discard()}>Discard</button></div>
      <div class="scroll body">
        <p class="err">The chosen combination of values does not pass the checks:</p>
        {@render issueList(ingest.issues)}
        {@render crossCheck()}
      </div>
    {:else}
      <div class="ph">
        <b>Import from datasheet</b>
        <span class="grow"></span>
        {#if ingest.phase === 'running'}<button class="btn" onclick={() => ingest.cancel()}>Stop</button>{/if}
      </div>
      <div class="scroll body">
        {#if ingest.phase === 'running'}
          <p class="desc"><b class="mono">{ingest.request?.mpn}</b> · {ingest.request?.source}{#if ingest.passes > 1} · pass {ingest.pass} of {ingest.passes}{/if}</p>
          <ol class="log">
            {#each ingest.log as l, i (i)}<li class:last={i === ingest.log.length - 1}>{l}</li>{/each}
          </ol>
          {@render issueList(ingest.lastIssues)}
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
              <label class="check"><input type="checkbox" bind:checked={verify} /> Verify with a second, independent pass <span class="muted">(about twice the time and cost)</span></label>
            </div>
            <label>Notes <span class="muted">(optional)</span>
              <textarea class="text" rows="2" placeholder="e.g. use the LQFP100 pinout, name pins by their reset function" bind:value={notes}></textarea>
            </label>
            {#if ingest.error}<p class="err">{ingest.error}</p>{/if}
            {@render issueList(ingest.lastIssues)}
            <div><button class="btn pri" type="submit" disabled={!ingest.available || !mpn.trim() || (!file && !url.trim())}>Import</button></div>
          </form>
          <p class="hint">Claude Code reads the datasheet text (only that file) and extracts the pin table and package dimensions. The app checks every submission (pin count, numbering, ball names, footprint) and sends problems back until it is consistent. With verification, a second session extracts everything again without seeing the first, and you decide wherever the two differ. Symbol, footprint and 3D body are generated deterministically. Large datasheets take a few minutes per pass.</p>
        {/if}
      </div>
    {/if}
  </div>

  {#if sheetDoc && shown && (mode === 'part' || ingest.phase === 'review')}
    <div class="pane dspane">
      <DatasheetView sheet={sheetDoc} bind:page={dsPage} terms={dsTerms} label={dsLabel} />
    </div>
  {/if}
</div>

<style>
  .parts { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 1px; background: var(--line); height: 100%; min-height: 0; }
  .parts.withds { grid-template-columns: 240px minmax(0, 1fr) minmax(320px, 40%); }
  .dspane { min-height: 0; }
  .tools { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; font-size: 12px; flex-wrap: wrap; }
  .seg, .tabs { display: inline-flex; gap: 0; }
  .seg button, .tabs button { border: 1px solid var(--line-2); background: var(--panel); padding: 2px 10px; font-size: 12px; color: var(--txt-2); cursor: pointer; }
  .seg button:first-child, .tabs button:first-child { border-radius: 6px 0 0 6px; }
  .seg button:last-child, .tabs button:nth-child(2) { border-radius: 0 6px 6px 0; border-left: 0; }
  .seg button[aria-pressed="true"], .tabs button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent-txt); }
  .tabs { display: flex; align-items: center; padding: 4px 6px; border-bottom: 1px solid var(--line); }
  .fp { display: flex; flex-direction: column; }
  .mech { flex: 1; min-height: 0; }
  .pins tr.clickable { cursor: pointer; }
  .pins tr.clickable:hover td { background: var(--hover); }
  .diff { margin-bottom: 12px; }
  .diff label { display: flex; gap: 6px; align-items: center; cursor: pointer; }
  .check { flex-direction: row !important; align-items: center; gap: 6px !important; }
  .notice.ok { background: var(--ok-soft); color: var(--ok); }
  .notice.warn { background: var(--warn-soft); color: var(--warn); max-width: none; }
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
  .link { border: 0; background: none; padding: 0; color: var(--accent-txt); text-decoration: underline; cursor: pointer; font: inherit; }
  .notice .link { color: inherit; }
  .err { color: var(--err); margin: 0; font-size: 12px; }
  .log { margin: 0 0 8px; padding-left: 20px; font-size: 12px; color: var(--txt-3); }
  .log li.last { color: var(--txt); }
  .log li.last::after { content: ' …'; }
  .issues { list-style: none; margin: 0 0 10px; padding: 0; font-size: 12px; display: flex; flex-direction: column; gap: 3px; }
  .reply { color: var(--txt-2); white-space: pre-wrap; font-size: 12px; }
  @media (max-width: 760px) {
    .parts, .parts.withds { grid-template-columns: minmax(0, 1fr); grid-template-rows: 40% 60%; }
    .dspane { display: none; }
    .grid { grid-template-columns: minmax(0, 1fr); }
  }
</style>
