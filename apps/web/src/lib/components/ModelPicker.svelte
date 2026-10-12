<script lang="ts">
  import { API_SERVICES, apiService, listOpenAIModels, type ApiServiceId } from '@4k7/agent';
  import { HARNESSES } from '@4k7/schema';
  import { tick } from 'svelte';
  import { app } from '../app.svelte.ts';
  import { loadApiKey } from '../persist.ts';
  import { server } from '../server.svelte.ts';
  import { choiceKey, choicePatch, currentChoice, modelLabel, modelsOf, parseChoiceKey, sameSource, sourceMark, sourceName, type ModelChoice, type Source } from '../models.ts';

  /** Rail entry: the favorites, or a source. */
  type Tab = 'fav' | Source;
  /** A model in the list; `typed`: the id in the search box, offered as is. */
  type Row = ModelChoice & { typed?: boolean };

  let open = $state(false);
  let tab = $state<Tab>('fav');
  let query = $state('');
  let active = $state(0);
  /** API services with a saved key, found when the picker opens. */
  let keyed = $state<Set<ApiServiceId>>(new Set());
  /** Models an API listed (GET /models), per service, and the services being listed. */
  let listed = $state<Partial<Record<ApiServiceId, string[]>>>({});
  let listing = $state<Set<ApiServiceId>>(new Set());

  let root: HTMLDivElement | undefined = $state();
  let search: HTMLInputElement | undefined = $state();
  let list: HTMLDivElement | undefined = $state();
  let trigger: HTMLButtonElement | undefined = $state();
  /** The popup is fixed to the window (the chat column clips what overflows it), above the button. */
  let place = $state('');

  const current = $derived(currentChoice(app.settings));
  const favorites = $derived(app.settings.favoriteModels.map(parseChoiceKey).filter((c): c is ModelChoice => !!c));

  /** Every agent, then the APIs that are set up (a key, an address of their own, or chosen now). */
  const sources = $derived.by((): Source[] => [
    ...HARNESSES.map((h) => ({ kind: 'agent', id: h.id }) as const),
    ...API_SERVICES.filter((s) => keyed.has(s.id) || !!app.settings.apiUrls[s.id] || (current.source.kind === 'api' && current.source.id === s.id)).map((s) => ({ kind: 'api', id: s.id }) as const),
  ]);

  const items = $derived.by((): Row[] => {
    const q = query.trim().toLowerCase();
    const all: ModelChoice[] =
      tab === 'fav'
        ? favorites
        : modelsOf(tab, { harnesses: server.harnesses, listed: tab.kind === 'api' ? listed[tab.id] : undefined, current: sameSource(tab, current.source) ? current.model : undefined }).map((model) => ({ source: tab as Source, model }));
    const hits: Row[] = q ? all.filter((c) => `${modelLabel(c)} ${c.model} ${sourceName(c.source)}`.toLowerCase().includes(q)) : all;
    // any model id can be typed: agents and APIs take ids no list has
    if (q && tab !== 'fav' && !all.some((c) => c.model.toLowerCase() === q)) hits.push({ source: tab, model: query.trim(), typed: true });
    return hits;
  });

  /** Why an agent cannot answer now (shown on its rail entry and models), or ''. */
  function unavailable(src: Source): string {
    if (src.kind !== 'agent') return '';
    const cap = server.harnesses.find((h) => h.id === src.id);
    if (!cap) return server.status === 'connected' ? 'This server does not know it. Restart the server.' : 'The local server is not connected.';
    return cap.available ? '' : (cap.reason ?? 'Not found on this computer.');
  }

  async function toggle() {
    if (open) return close();
    const r = trigger!.getBoundingClientRect();
    place = `left: ${Math.max(8, Math.min(r.left - 4, innerWidth - 348))}px; bottom: ${innerHeight - r.top + 6}px;`;
    open = true;
    query = '';
    tab = favorites.some((f) => choiceKey(f) === choiceKey(current)) ? 'fav' : current.source;
    active = 0;
    await tick();
    search?.focus();
    scrollToCurrent();
    const found = new Set<ApiServiceId>();
    for (const s of API_SERVICES) if (s.keyHint && (await loadApiKey(s.id))) found.add(s.id);
    keyed = found;
    if (tab !== 'fav') void listApi(tab);
  }

  function close() {
    open = false;
  }

  async function pickTab(t: Tab) {
    tab = t;
    active = 0;
    search?.focus();
    if (t !== 'fav') void listApi(t);
    await tick();
    scrollToCurrent();
  }

  /** An OpenAI-format API lists its models the first time it is opened here. */
  async function listApi(src: Source) {
    if (src.kind !== 'api' || apiService(src.id).format !== 'openai' || listed[src.id] || listing.has(src.id)) return;
    listing = new Set([...listing, src.id]);
    try {
      const key = await loadApiKey(src.id);
      const ids = await listOpenAIModels(app.settings.apiUrls[src.id] || apiService(src.id).baseURL, key);
      listed = { ...listed, [src.id]: ids };
    } catch {
      listed = { ...listed, [src.id]: [] }; // unreachable or no key: the model can still be typed
    } finally {
      listing = new Set([...listing].filter((id) => id !== src.id));
    }
  }

  function scrollToCurrent() {
    const i = items.findIndex((c) => choiceKey(c) === choiceKey(current));
    if (i >= 0) active = i;
    list?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function choose(c: ModelChoice) {
    void app.updateSettings(choicePatch(c, app.settings));
    close();
  }

  function star(c: ModelChoice, e: Event) {
    e.stopPropagation();
    const k = choiceKey(c);
    const favs = app.settings.favoriteModels;
    void app.updateSettings({ favoriteModels: favs.includes(k) ? favs.filter((f) => f !== k) : [...favs, k] });
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      list?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const c = items[active];
      if (c) choose(c);
    }
  }

  function outside(e: PointerEvent) {
    if (open && root && !root.contains(e.target as Node)) close();
  }

  $effect(() => {
    void query;
    active = 0;
  });
</script>

<svelte:window onpointerdown={outside} />

<div class="picker" bind:this={root}>
  <button bind:this={trigger} type="button" class="trigger" aria-haspopup="dialog" aria-expanded={open} title={`${sourceName(current.source)}${current.model ? ` · ${current.model}` : ''}`} onclick={toggle}>
    <span class="mark" data-src={current.source.id}>{sourceMark(current.source)}</span>
    <span class="name">{modelLabel(current)}</span>
    <span class="chev">▾</span>
  </button>

  {#if open}
    <div class="pop" style={place} role="dialog" aria-label="Choose the model">
      <nav class="rail" aria-label="Sources">
        <button type="button" class="src" aria-pressed={tab === 'fav'} title="Favorites" onclick={() => pickTab('fav')}><span class="mark fav">★</span></button>
        <span class="sep"></span>
        {#each sources as s (choiceKey({ source: s, model: '' }))}
          <button type="button" class="src" class:off={!!unavailable(s)} aria-pressed={tab !== 'fav' && sameSource(tab, s)} title={`${sourceName(s)}${s.kind === 'agent' ? ' (on this computer)' : ' (API key)'}${unavailable(s) ? `: ${unavailable(s)}` : ''}`} onclick={() => pickTab(s)}>
            <span class="mark" data-src={s.id}>{sourceMark(s)}</span>
          </button>
        {/each}
        <span class="grow"></span>
        <button type="button" class="src" title="Set up agents and APIs (Settings)" onclick={() => { close(); app.view = 'set'; }}><span class="mark gear">⚙</span></button>
      </nav>
      <div class="main">
        <div class="search">
          <span class="muted">⌕</span>
          <input bind:this={search} bind:value={query} {onkeydown} placeholder={tab === 'fav' ? 'Search favorites…' : `Search or type a model id…`} spellcheck="false" autocomplete="off" aria-label="Search models" />
        </div>
        <div class="head">
          {#if tab === 'fav'}Favorites{:else}{sourceName(tab)}{#if tab.kind === 'api' && listing.has(tab.id)}<span class="muted"> · listing…</span>{/if}{/if}
        </div>
        {#if tab !== 'fav' && unavailable(tab)}<div class="warn">{unavailable(tab)}</div>{/if}
        <div class="list" bind:this={list} role="listbox" aria-label="Models">
          {#each items as c, i (choiceKey(c))}
            {@const fav = app.settings.favoriteModels.includes(choiceKey(c))}
            <!-- svelte-ignore a11y_click_events_have_key_events (the search box drives the keyboard) -->
            <div class="item" role="option" tabindex="-1" data-i={i} aria-selected={choiceKey(c) === choiceKey(current)} class:active={i === active} onclick={() => choose(c)} onpointermove={() => (active = i)}>
              <div class="lbl">
                <span class="mname">{c.typed ? `Use “${c.model}”` : modelLabel(c)}</span>
                <span class="sub"><span class="mark sm" data-src={c.source.id}>{sourceMark(c.source)}</span> {sourceName(c.source)}{#if c.model && modelLabel(c) !== c.model}<span class="mono"> · {c.model}</span>{/if}</span>
              </div>
              {#if c.model || c.source.kind === 'agent'}
                <button type="button" class="star" class:on={fav} title={fav ? 'Remove from favorites' : 'Add to favorites'} aria-pressed={fav} onclick={(e) => star(c, e)}>{fav ? '★' : '☆'}</button>
              {/if}
            </div>
          {:else}
            <div class="empty">{tab === 'fav' ? 'Star models to find them here.' : 'No models listed. Type a model id.'}</div>
          {/each}
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .picker { position: relative; min-width: 0; }
  .trigger { display: flex; align-items: center; gap: 5px; border: 0; background: none; color: var(--txt-2); padding: 2px 5px; border-radius: 5px; font-size: 12px; min-width: 0; max-width: 100%; }
  .trigger:hover, .trigger[aria-expanded="true"] { background: var(--hover); color: var(--txt); }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chev { font-size: 9px; color: var(--txt-3); }

  .mark { display: inline-grid; place-items: center; min-width: 16px; height: 16px; padding: 0 2px; box-sizing: border-box; border-radius: 4px; font-size: 9px; font-weight: 700; line-height: 1; background: var(--panel-2); color: var(--txt-2); flex: none; }
  .mark[data-src="claude-code"], .mark[data-src="anthropic"], .mark[data-src="anthropic-compatible"] { background: none; color: #d97757; font-size: 15px; }
  .mark.fav { background: none; color: var(--txt); font-size: 14px; }
  .mark.gear { background: none; font-size: 13px; color: var(--txt-3); }
  .mark.sm { min-width: 13px; height: 13px; font-size: 8px; }
  .mark.sm[data-src="claude-code"], .mark.sm[data-src="anthropic"], .mark.sm[data-src="anthropic-compatible"] { font-size: 12px; }

  .pop { position: fixed; z-index: 50; display: flex; width: min(340px, calc(100vw - 16px)); height: min(360px, 60vh); background: var(--panel); border: 1px solid var(--line-2); border-radius: 9px; box-shadow: 0 8px 28px rgb(0 0 0 / .35); overflow: hidden; }
  .rail { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 6px 4px; border-right: 1px solid var(--line); background: var(--panel-2); overflow-y: auto; scrollbar-width: none; }
  .rail .sep { width: 18px; border-top: 1px solid var(--line-2); margin: 2px 0; }
  .rail .grow { flex: 1; }
  .src { position: relative; display: grid; place-items: center; width: 30px; height: 28px; border: 0; border-radius: 6px; background: none; padding: 0; }
  .src:hover { background: var(--hover); }
  .src[aria-pressed="true"] { background: var(--hover); }
  .src[aria-pressed="true"]::before { content: ''; position: absolute; left: -4px; top: 6px; bottom: 6px; width: 3px; border-radius: 2px; background: var(--accent); }
  .src.off .mark { opacity: .4; }

  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .search { display: flex; align-items: center; gap: 6px; padding: 7px 9px; border-bottom: 1px solid var(--accent); }
  .search input { flex: 1; min-width: 0; border: 0; background: none; outline: none; font-size: 12.5px; color: var(--txt); }
  .head { font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--txt-3); padding: 7px 10px 3px; }
  .warn { font-size: 11px; color: var(--warn); padding: 0 10px 4px; }
  .list { flex: 1; overflow-y: auto; padding: 2px 4px 6px; scrollbar-width: thin; }
  .item { display: flex; align-items: center; gap: 6px; padding: 5px 6px; border-radius: 6px; cursor: pointer; }
  .item.active { background: var(--hover); }
  .item[aria-selected="true"] .mname { color: var(--accent-txt); font-weight: 600; }
  .lbl { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .mname { font-size: 12.5px; color: var(--txt); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sub { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--txt-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sub .mono { font-family: var(--mono); font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; }
  .star { border: 0; background: none; color: var(--txt-3); font-size: 14px; padding: 0 3px; visibility: hidden; }
  .item.active .star, .star.on { visibility: visible; }
  .star.on { color: var(--warn); }
  .star:hover { color: var(--txt); }
  .empty { font-size: 12px; color: var(--txt-3); padding: 10px 6px; }
</style>
