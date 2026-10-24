<script lang="ts">
  import { STOCK_MARGIN } from '@4k7/schema';
  import { estimateLine, lineBlocks, lineIssues, lineNeedsAttention, type CostEstimate, type Saving, type StockLine } from '@4k7/parts';
  import type { SupplierPart } from '@4k7/schema';
  import { app } from '../app.svelte.ts';
  import { house } from '../sourcing.ts';

  /**
   * Before ordering: the stock check (every part looked up at the assembly house now, for a number of
   * boards, with replacements for the ones in trouble) and the cost check (what the order costs with
   * every fee, and what would make it cheaper).
   */
  const r = $derived(app.stockReport);
  const c = $derived(app.costReport);
  const showCost = $derived(app.sourcingShown === 'cost' && !!c);
  let error = $state<string | null>(null);
  let fineOpen = $state(false);

  async function run(check: () => Promise<unknown>) {
    error = null;
    try {
      await check();
    } catch (e) {
      error = (e as Error).message;
    }
  }
  function setBoards(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    const v = Math.round(Number(el.value));
    if (!(v >= 1)) {
      el.value = String(app.settings.buildBoards);
      return;
    }
    void app.updateSettings({ buildBoards: v });
  }

  const blocking = $derived(r ? r.lines.filter(lineBlocks) : []);
  const attention = $derived(r ? r.lines.filter((l) => !lineBlocks(l) && lineNeedsAttention(l)) : []);
  const fine = $derived(r ? r.lines.filter((l) => !lineNeedsAttention(l)) : []);
  const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  /** As the Checks list has them: E stops the order, W wants a look, I is a fee. */
  const severity = (l: StockLine) => (lineBlocks(l) ? 'err' : l.state !== 'ok' ? 'warn' : 'info');
  const short = (n: number | null) => (n === null ? '?' : n >= 1e6 ? `${Number((n / 1e6).toPrecision(3))}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n.toLocaleString('en-US'));
  const price = (p: SupplierPart) => (p.price[0] ? ` · $${p.price[0].usd < 1 ? Number(p.price[0].usd.toPrecision(2)) : p.price[0].usd.toFixed(2)}` : '');
  const usd = (v: number) => `$${v.toFixed(2)}`;
  const feesText = (e: CostEstimate) => [`parts ${usd(e.parts)}`, ...e.fees.map((f) => `${f.name} ${usd(f.usd)}`)].join(' · ');
  const savingAction = (s: Saving) => (s.to ? 'Use' : s.kind === 'side' ? 'Move to top' : 'Leave off');
  const savingTitle = (s: Saving) =>
    s.to ? `Use ${s.to.sku} for ${s.refs.join(', ')}` : s.kind === 'side' ? `Put ${s.refs.join(', ')} on the top side` : `Take the ${house.numberName} off ${s.refs.join(', ')}: they are left off the order, to solder by hand`;
  const savedInAll = $derived(c ? c.savings.reduce((n, s) => n + s.usd, 0) : 0);

  function ask(l: StockLine) {
    if (!r) return;
    void app.send(
      `${l.refs.join(', ')} (${l.sku}${l.part?.mpn ? ` ${l.part.mpn}` : ''}) at ${house.name}: ${lineIssues(l).join('; ')}. Find a replacement that is in stock for ${r.boards} boards ` +
        `(read the datasheet of any part you consider, keep the footprint where you can) and set it with set_param ${house.param}.`,
      { shown: `Find a replacement for ${l.refs.join(', ')} (${l.sku})` },
    );
  }
</script>

{#snippet alt(p: SupplierPart, title: string, onuse: () => unknown, adds?: number)}
  <li>
    <div class="grow" title={p.description}>
      <div class="trunc"><span class="mono">{p.sku}</span>{#if adds !== undefined}<b class="mono adds">+{usd(adds)}</b>{/if} <span class="muted">{p.mpn}</span></div>
      <div class="trunc muted">{#if p.tier}<span class="tag" class:ok={!p.fee}>{p.tier}</span> {/if}{short(p.stock)} in stock{p.live ? '' : ' (mirror)'}{adds === undefined ? price(p) : ''}</div>
    </div>
    <button class="btn" disabled={app.running || !!app.k?.proposal} {title} onclick={() => void onuse()}>Use</button>
  </li>
{/snippet}

<h4>Sourcing · {house.name}</h4>
<div class="row">
  <label for="src-boards" class="small muted">Boards</label>
  <input id="src-boards" class="text num mono" type="number" min="1" step="1" value={app.settings.buildBoards} title="How many boards will be assembled: the checks count the parts and fees for them" onchange={setBoards} />
  <button class="btn grow" disabled={app.stockBusy || !app.k?.summary.components.length} title="Look every part up at {house.name} now, for this many boards" onclick={() => void run(() => app.checkStock())}>Check stock</button>
  <button class="btn grow" disabled={app.stockBusy || !app.k?.summary.components.length} title="What the order costs at {house.name} with every fee, and what would make it cheaper" onclick={() => void run(() => app.checkCost())}>Check cost</button>
</div>
{#if app.stockBusy}<p class="small muted">Looking the parts up…</p>{/if}
{#if error}<p class="small bad">{error}</p>{/if}
{#if r && c}
  <div class="seg" role="tablist">
    <button role="tab" aria-selected={!showCost} onclick={() => (app.sourcingShown = 'stock')}>Stock</button>
    <button role="tab" aria-selected={showCost} onclick={() => (app.sourcingShown = 'cost')}>Cost</button>
  </div>
{/if}

{#if showCost && c}
  <p class="sum"><b>{estimateLine(c.estimates, c.boards)}</b></p>
  <p class="small muted">{time(c.at)}{#if !c.live}<span class="bad"> · not all live{c.note ? ` (${c.note})` : ''}</span>{/if}</p>
  <ul class="est">
    {#each c.estimates as e (e.service)}
      <li class:off={!!e.unavailable}>
        <div class="l1"><span>{e.service}</span><span class="mono">{e.unavailable ? '—' : usd(e.total)}</span></div>
        <div class="small muted">{e.unavailable ? `Cannot take this order: ${e.unavailable}.` : feesText(e)}{e.notCounted ? ` · not counted: ${e.notCounted}` : ''}</div>
        {#if e.needs}<div class="small bad">Needs {e.needs}.</div>{/if}
      </li>
    {/each}
  </ul>
  <p class="small muted">Not included: {house.notInEstimate}.{c.unpriced.length ? ` No price for ${c.unpriced.join(', ')}.` : ''} Fees from <a href={house.prices.url} target="_blank" rel="noopener noreferrer">{house.name}'s price page</a>, {house.prices.checked}.</p>
  {#if c.savings.length}
    <h5>Cheaper ({c.service}): up to {usd(savedInAll)}</h5>
    <ul class="lines">
      {#each c.savings as s, i (i)}
        <li class="sv">
          <button class="r" title="Select {s.refs.join(', ')}" onclick={() => (app.selection = [...s.refs])}>
            <span class="tag ok">−{usd(s.usd)}</span>
            <span class="grow">{s.what}</span>
          </button>
          <button class="btn" disabled={app.running || !!app.k?.proposal} title={savingTitle(s)} onclick={() => void app.applySaving(s)}>{savingAction(s)}</button>
        </li>
      {/each}
    </ul>
  {:else if c.service}
    <p class="small ok">Nothing found that would make it cheaper by $0.50 or more.</p>
  {/if}
  {#if c.unsourced.length || c.unmatched.length}
    <h5>No {house.numberName}: not on the order <span class="muted">(+ what a part adds to it)</span></h5>
    <ul class="lines">
      {#each c.unsourced as g (g.refs.join(' '))}
        <li>
          <div class="r static"><span class="grow"><b class="mono">{g.refs.join(' ')}</b> {g.what}{g.candidates.length ? '' : ': nothing in stock found'}</span></div>
          {#if g.candidates.length}
            <ul class="alts">
              {#each g.candidates as p (p.sku)}{@render alt(p, `Use ${p.sku} for ${g.refs.join(', ')}: it adds ${usd(g.adds[p.sku] ?? 0)} to the order (its pieces and any loading fee)`, () => app.useCandidate(g, p), g.adds[p.sku])}{/each}
            </ul>
          {/if}
        </li>
      {/each}
    </ul>
    {#if c.unmatched.length}<p class="small muted">Nothing to search by (no value and package, no part number): {c.unmatched.join(', ')}</p>{/if}
  {/if}
{:else if r}
  <p class="small muted">
    {r.lines.length} part number{r.lines.length === 1 ? '' : 's'} for {r.boards} board{r.boards === 1 ? '' : 's'} · {time(r.at)}
    {#if !r.live}<span class="bad"> · not all live{r.note ? ` (${r.note})` : ''}: mirror stock may be a day old or unknown</span>{/if}
  </p>
  {#if blocking.length || attention.length}
    <ul class="lines">
      {#each [...blocking, ...attention] as l (l.sku)}
        <li>
          <button class="r" title="Select {l.refs.join(', ')}" onclick={() => (app.selection = [...l.refs])}>
            <span class="tag {severity(l)}">{severity(l) === 'err' ? 'E' : severity(l) === 'warn' ? 'W' : 'I'}</span>
            <span class="grow"><b class="mono">{l.refs.join(' ')}</b> <span class="mono">{l.sku}</span>{l.part?.mpn ? ` ${l.part.mpn}` : ''}: {lineIssues(l).join('; ')}</span>
          </button>
          {#if l.replacements.length}
            <ul class="alts">
              {#each l.replacements as p (p.sku)}{@render alt(p, `Use ${p.sku} for ${l.refs.join(', ')}`, () => app.useReplacement(l, p))}{/each}
            </ul>
            <p class="small muted basis">{l.replacementBasis}</p>
          {:else if lineBlocks(l) || l.state === 'low'}
            <button class="more" disabled={app.running} onclick={() => ask(l)}>No like-for-like part: ask the agent</button>
          {/if}
        </li>
      {/each}
    </ul>
  {:else if r.lines.length}
    <p class="small ok">Every part is in stock with room to spare (≥ {STOCK_MARGIN} × what the boards need), with no fee.</p>
  {/if}
  {#if fine.length && (blocking.length || attention.length)}
    <button class="more" aria-expanded={fineOpen} onclick={() => (fineOpen = !fineOpen)}>{fineOpen ? 'Hide' : 'Show'} {fine.length} fine</button>
    {#if fineOpen}<p class="small muted mono">{fine.map((l) => `${l.sku} ${l.refs.join(' ')}`).join(' · ')}</p>{/if}
  {/if}
  {#if r.unsourced.length}
    <p class="small muted">No {house.numberName} (not assembled from {house.name}'s stock): {r.unsourced.join(', ')}</p>
  {/if}
  {#if r.estimates}
    <p class="small">The order {estimateLine(r.estimates, r.boards)}, fees included; not the bare boards, shipping or taxes. <button class="link" disabled={app.stockBusy} onclick={() => void run(() => app.checkCost())}>What it is made of, and what would make it cheaper</button></p>
  {:else if r.cost !== undefined}
    <p class="small muted">Parts ≈ ${r.cost.toFixed(2)} for {r.boards} board{r.boards === 1 ? '' : 's'} at today's prices, without fees{r.unpriced.length ? ` (no price for ${r.unpriced.join(', ')})` : ''}.</p>
  {/if}
{:else}
  <p class="small muted">Before you order: <b>Check stock</b> looks every part up at {house.name} now (out of stock, too few for the boards, low stock, gone from the catalogue, fees) and offers in-stock replacements. <b>Check cost</b> prices the order with every fee and finds what would make it cheaper.</p>
{/if}

<style>
  h4 { margin: 12px 0 4px; font-size: 12px; display: flex; gap: 4px; align-items: center; }
  h5 { margin: 8px 0 2px; font-size: 11.5px; color: var(--txt-2); }
  .small { font-size: 11.5px; margin: 2px 0 6px; }
  .sum { font-size: 12.5px; margin: 6px 0 0; }
  .row { display: flex; gap: 6px; align-items: center; margin: 2px 0 4px; }
  .num { width: 56px; padding: 2px 6px; text-align: right; }
  .grow { flex: 1; min-width: 0; }
  .bad { color: var(--warn); }
  .ok { color: var(--ok); }
  .seg { margin: 2px 0 4px; }
  .seg button[aria-selected='true'] { background: var(--panel); color: var(--txt); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); }
  .lines, .alts, .est { list-style: none; margin: 0; padding: 0; }
  .lines .r { display: flex; gap: 6px; align-items: flex-start; text-align: left; width: 100%; border: 0; background: none; padding: 3px 2px; font-size: 12px; color: var(--txt-2); cursor: pointer; border-radius: 4px; min-height: 0; }
  .lines .r:hover { background: var(--hover); }
  .lines .r.static { cursor: default; }
  .lines .r.static:hover { background: none; }
  .sv { display: flex; gap: 4px; align-items: flex-start; }
  .sv .r { flex: 1; min-width: 0; }
  .sv .btn { font-size: 11px; padding: 0 8px; margin-top: 3px; flex: none; }
  .est li { padding: 3px 0; border-bottom: 1px solid var(--line); }
  .est .l1 { display: flex; justify-content: space-between; font-size: 12px; }
  .est .off .l1 { color: var(--txt-3); }
  .est .small { margin: 1px 0 0; }
  .alts { margin: 0 0 2px 22px; }
  .alts li { display: flex; gap: 6px; align-items: center; font-size: 11.5px; padding: 2px 0; line-height: 1.35; }
  .alts .btn { font-size: 11px; padding: 0 8px; }
  .trunc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .adds { margin-left: 5px; }
  .basis { margin: 0 0 4px 22px; }
  .more { border: 0; background: none; color: var(--accent-txt); font-size: 11.5px; padding: 2px; margin-left: 20px; cursor: pointer; }
  .link { border: 0; background: none; color: var(--accent-txt); font-size: 11.5px; padding: 0; cursor: pointer; text-align: left; }
</style>
