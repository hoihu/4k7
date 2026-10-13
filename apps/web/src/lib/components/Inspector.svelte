<script lang="ts">
  import type { ParamSpec } from '@4k7/schema';
  import { describeJlcPart, sourcingMismatch, type JlcPart } from '@4k7/parts';
  import { app, type InspectorTab } from '../app.svelte.ts';
  import { jlc } from '../jlc.ts';

  interface ComponentInfo {
    refdes: string;
    part: string;
    description?: string;
    category?: string;
    params: Record<string, string>;
    /** The board side the part is mounted on. */
    side?: 'top' | 'bottom';
    /** Every parameter the component may carry (the card's, then the universal lcsc). */
    specs: Record<string, ParamSpec>;
    /** Generic parts: the package in use, why, and the ones to pick from. */
    package?: { name: string; why: 'set' | 'default' | 'auto' | 'library'; reason?: string; options: string[] };
    pins?: { pin: string; name: string; type: string; net: string | null }[];
    constraints: { id: string; text: string; strength: string }[];
  }

  const sel = $derived(app.selection[0]);
  let info = $state<ComponentInfo | null>(null);
  /** Why the selected part could not be read (shown instead of a blank pane). */
  let infoError = $state<string | null>(null);

  $effect(() => {
    const ref = sel;
    void app.k; // refresh when the design changes
    if (!ref) {
      info = null;
      infoError = null;
      return;
    }
    app
      .queryComponent(ref)
      .then((r) => {
        if (app.selection[0] !== ref) return; // overtaken by a newer selection
        info = r && typeof r === 'object' && 'refdes' in r ? (r as ComponentInfo) : null;
        infoError = info ? null : String((r as { error?: unknown } | null)?.error ?? `${ref} could not be read.`);
      })
      .catch((e: Error) => {
        if (app.selection[0] !== ref) return;
        info = null;
        infoError = `${ref} could not be read: ${e.message}`;
      });
  });

  /** Pick a package for the selected part ('' = back to the design default). */
  function setPackage(name: string) {
    if (!info) return;
    void app.userEdit(name ? `Package ${info.refdes}: ${name}` : `Package ${info.refdes}: default`, [{ op: 'set_param', ref: info.refdes, params: { package: name || null } }]);
  }
  const whyText = (p: NonNullable<ComponentInfo['package']>) =>
    p.why === 'set' ? 'chosen for this part' : p.why === 'default' ? 'design default' : p.why === 'auto' ? `sized up: ${p.reason}` : 'library default';

  /* ---- parameters, edited in place (the same set_param op the agent uses) ---- */
  /** Parameter rows: the card's specs in order (package has its own picker, lcsc its own section), then stray params. */
  const paramKeys = $derived.by(() => {
    if (!info) return [] as string[];
    const keys = Object.keys(info.specs ?? {}).filter((k) => k !== 'lcsc' && !(info!.package && k === 'package'));
    for (const k of Object.keys(info.params)) if (!keys.includes(k) && k !== 'lcsc' && !(info!.package && k === 'package')) keys.push(k);
    return keys;
  });
  const EXAMPLES: Record<string, string> = { F: '100nF', 'Ω': '10k', H: '10uH', V: '25V', A: '2A', W: '0.25W' };
  const placeholder = (k: string) => {
    const spec = info?.specs?.[k];
    return spec?.unit ? EXAMPLES[spec.unit] ?? spec.unit : (spec?.description ?? '').replace(/^e\.g\. /, '').slice(0, 24);
  };
  async function setParam(key: string, raw: string) {
    if (!info) return;
    const ref = info.refdes;
    const value = raw.trim();
    if (value === (info.params[key] ?? '')) return;
    const ok = await app.userEdit(`${ref} ${key}: ${value || 'unset'}`, [{ op: 'set_param', ref, params: { [key]: value || null } }]);
    if (!ok) info = (await app.queryComponent(ref)) as ComponentInfo; // put the old value back in the field
  }

  /* ---- sourcing: the LCSC part behind this component ---- */
  /** The package the component really has: its pick or default for generics, the card's for imported parts. */
  const effPkg = $derived(info ? (info.package?.name ?? info.params.package ?? app.designParts[info.part]?.package) : undefined);
  let lcscPart = $state<JlcPart | null>(null);
  let lcscState = $state<'idle' | 'loading' | 'missing' | 'failed'>('idle');
  $effect(() => {
    const id = info?.params.lcsc;
    lcscPart = null;
    if (!id) {
      lcscState = 'idle';
      return;
    }
    lcscState = 'loading';
    jlc
      .lookup(id)
      .then((p) => {
        if (info?.params.lcsc !== id) return;
        lcscPart = p;
        lcscState = p ? 'idle' : 'missing';
      })
      .catch(() => info?.params.lcsc === id && (lcscState = 'failed'));
  });
  const mismatches = $derived(info && lcscPart ? sourcingMismatch({ category: (info.category ?? 'other') as never }, info.params, effPkg, lcscPart) : []);

  /** Text and package the catalogue search starts from: value + package for passives, the part number otherwise. */
  let jlcOpen = $state(false);
  let jlcText = $state('');
  let jlcPkg = $state('');
  let jlcBasic = $state(true);
  let jlcBusy = $state(false);
  let jlcError = $state<string | null>(null);
  let jlcResults = $state<JlcPart[] | null>(null);
  const passiveKind = $derived(info?.category === 'resistor' ? 'resistor' : info?.category === 'capacitor' ? 'capacitor' : null);
  /** Counts searches, so an answer overtaken by a newer search (or a new selection) is dropped. */
  let jlcSeq = 0;
  $effect(() => {
    void sel; // the search belongs to one component: another selection closes it
    jlcSeq++;
    jlcOpen = false;
    jlcResults = null;
    jlcError = null;
    jlcBusy = false;
  });
  function openJlc() {
    if (!info) return;
    const card = app.designParts[info.part];
    jlcText = passiveKind ? (info.params[passiveKind === 'resistor' ? 'resistance' : 'capacitance'] ?? '') : (info.params.mpn ?? card?.mpn ?? card?.title ?? info.description ?? '');
    jlcPkg = effPkg ?? '';
    jlcResults = null;
    jlcError = null;
    jlcOpen = true;
    void searchJlc();
  }
  async function searchJlc() {
    if (!info || !jlcText.trim()) return;
    const seq = ++jlcSeq;
    jlcBusy = true;
    jlcError = null;
    try {
      const found = await jlc.search({
        ...(passiveKind ? { kind: passiveKind, value: jlcText.trim() } : { text: jlcText.trim() }),
        ...(jlcPkg.trim() ? { package: jlcPkg.trim() } : {}),
        basicOnly: jlcBasic,
        limit: 10,
      });
      if (seq === jlcSeq) jlcResults = found;
    } catch (e) {
      if (seq !== jlcSeq) return;
      jlcResults = null;
      jlcError = (e as Error).message;
    } finally {
      if (seq === jlcSeq) jlcBusy = false;
    }
  }
  /** Take a search result: its number, and its package when the component's differs. */
  async function pickJlc(p: JlcPart) {
    if (!info) return;
    const ref = info.refdes;
    const pkgDiffers = !!p.package && !!info.package && (effPkg ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '') !== p.package.toUpperCase().replace(/[^A-Z0-9]/g, '');
    let ok = false;
    if (pkgDiffers) ok = await app.userEdit(`${ref}: ${p.lcsc} (${p.mpn}), package ${p.package}`, [{ op: 'set_param', ref, params: { lcsc: p.lcsc, package: p.package } }]);
    if (!ok) ok = await app.userEdit(`${ref}: ${p.lcsc} (${p.mpn})`, [{ op: 'set_param', ref, params: { lcsc: p.lcsc } }]);
    if (ok) jlcOpen = false;
  }
  /** Make the component say what the chosen part is (value, voltage, package). */
  function takePartValues() {
    if (!info || !lcscPart) return;
    const a = lcscPart.attributes;
    const params: Record<string, string> = {};
    if (passiveKind === 'resistor' && (a.Resistance ?? a.Value)) params.resistance = (a.Resistance ?? a.Value)!.replace(/Ω$/, '');
    if (passiveKind === 'capacitor' && (a.Capacitance ?? a.Value)) params.capacitance = (a.Capacitance ?? a.Value)!;
    if (passiveKind === 'capacitor' && a['Voltage Rated']) params.voltage = a['Voltage Rated'];
    if (lcscPart.package && info.package) params.package = lcscPart.package;
    if (!Object.keys(params).length) return;
    void app.userEdit(`${info.refdes}: values of ${lcscPart.lcsc}`, [{ op: 'set_param', ref: info.refdes, params }]);
  }
  const tierLabel = (t: JlcPart['tier']) => (t === 'basic' ? 'Basic' : t === 'preferred' ? 'Preferred' : 'Extended');
  const priceLabel = (p: JlcPart) => (p.price[0] ? `$${p.price[0].usd < 1 ? p.price[0].usd.toPrecision(2) : p.price[0].usd.toFixed(2)}` : '');
  const factsLabel = (p: JlcPart) => p.description || Object.entries(p.attributes).map(([k, v]) => (k === 'Value' ? v : `${k} ${v}`)).join(', ');

  /* a selected net: what it is, what it connects, and its track width on the board */
  interface NetInfo {
    id: string;
    name: string;
    kind: 'ground' | 'supply' | 'signal';
    attrs: { voltage?: number; maxCurrent?: number; external?: boolean; trackWidth?: number };
    pins: string[];
    track: { width_mm: number; why: string; suggested_mm?: number; for_current_a?: number; rules: { signal_mm: number; power_mm: number } };
  }
  let net = $state<NetInfo | null>(null);
  $effect(() => {
    const id = app.selectedNet;
    void app.k;
    if (!id) {
      net = null;
      return;
    }
    app
      .queryNet(id)
      // (an answer for a net no longer selected, overtaken by a quicker one, is dropped)
      .then((r) => app.selectedNet === id && (net = r && typeof r === 'object' && 'id' in r ? (r as NetInfo) : null))
      .catch(() => app.selectedNet === id && (net = null));
  });
  /** The net's pins, repeated ones (a big IC's many VDD pins) as one line with a count. */
  const netPins = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const p of net?.pins ?? []) counts.set(p, (counts.get(p) ?? 0) + 1);
    return [...counts.entries()];
  });
  const WIDTHS = [0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0, 1.5, 2.0, 3.0];
  function setTrack(v: string) {
    if (!net) return;
    void app.userEdit(`${net.name} track ${v ? `${v} mm` : 'default'}`, [{ op: 'set_net', net: net.name, track_mm: v ? Number(v) : null }]);
  }
  function setCurrent(v: string) {
    if (!net) return;
    const a = Number(v.replace(',', '.').replace(/\s*a$/i, ''));
    if (v.trim() && !(a > 0)) return;
    if ((net.attrs.maxCurrent ?? null) === (v.trim() ? a : null)) return;
    void app.userEdit(`${net.name} current ${v.trim() ? `${a} A` : 'unset'}`, [{ op: 'set_net', net: net.name, max_current: v.trim() ? a : null }]);
  }

  const diags = $derived(app.k?.diagnostics ?? []);
  const open = $derived(diags.filter((d) => !d.waivedBy));
  const waived = $derived(diags.filter((d) => d.waivedBy));

  const tabs: { id: InspectorTab; label: string }[] = [
    { id: 'issues', label: 'Issues' },
    { id: 'ledger', label: 'Ledger' },
    { id: 'history', label: 'History' },
    { id: 'sel', label: 'Selection' },
  ];

  function count(t: InspectorTab): string {
    if (t === 'issues') return String(open.length);
    if (t === 'ledger') return String(app.k?.ledger.length ?? 0);
    return '';
  }

  function fixWithAgent(d: (typeof diags)[number]) {
    app.chatOpen = true;
    void app.send(`Fix ${d.code} on ${d.entities.join(', ')}: ${d.message}`);
  }

  function hint(text: string) {
    app.chatOpen = true;
    app.input = text;
  }

  function selectEntities(entities: string[]) {
    const refs = entities.map((e) => e.split('.')[0]!).filter((e) => /^[A-Z]+\d+$/.test(e));
    app.selection = [...new Set(refs)];
  }
</script>

<div class="pane insp">
  <div class="tabs" role="tablist">
    {#each tabs as t (t.id)}
      <button role="tab" aria-selected={app.tab === t.id} onclick={() => (app.tab = t.id)}>
        {t.id === 'sel' && sel ? sel : t.id === 'sel' && net ? net.name : t.label} <span class="cnt">{count(t.id)}</span>
      </button>
    {/each}
  </div>
  <div class="scroll">
    {#if app.tab === 'issues'}
      {#if open.length === 0}
        <div class="empty">{app.k?.summary.components.length ? 'No open issues.' : 'Nothing to check yet.'}</div>
      {/if}
      <ul class="rows">
        {#each open as d, i (i)}
          <li>
            <details class="row">
              <summary class="r">
                <span class="sev {d.severity}">{d.severity === 'error' ? 'E' : d.severity === 'warning' ? 'W' : 'i'}</span>
                <span class="grow trunc">{d.message}</span>
              </summary>
              <div class="more">
                <code>{d.code}</code> · {d.entities.join(', ')}
                {#if d.source}<div class="muted">source: {d.source}</div>{/if}
                {#if d.fixHints?.length}<pre class="hints">{d.fixHints.map((h) => JSON.stringify(h)).join('\n')}</pre>{/if}
                <div class="acts">
                  <button class="btn pri" disabled={app.running} onclick={() => fixWithAgent(d)}>Ask agent to fix</button>
                  <button class="btn" onclick={() => selectEntities(d.entities)}>Select</button>
                </div>
              </div>
            </details>
          </li>
        {/each}
        {#each waived as d, i (i)}
          <li class="r" title="waived by {d.waivedBy}"><span class="sev info">w</span><span class="grow trunc muted">{d.code} · {d.entities.join(', ')}</span></li>
        {/each}
      </ul>
      {#if app.k && app.k.summary.components.length}
        <div class="foot">
          <span class="n" class:e={app.k.counts.errors > 0} class:ok={app.k.counts.errors === 0}><i></i></span>
          {app.k.counts.errors} errors · {app.k.counts.warnings} warnings · {app.k.summary.nets.length} nets · {app.k.summary.components.length} parts
          {#if app.k.proposal}<span class="tag warn">draft</span>{/if}
        </div>
      {/if}
    {:else if app.tab === 'ledger'}
      {#if !app.k?.ledger.length}
        <div class="empty">No constraints yet. Hints you give (“put C1 left of U1”, “make C2 100µF”) are recorded here and respected on every re-layout.</div>
      {/if}
      <ul class="rows">
        {#each app.k?.ledger ?? [] as k (k.id)}
          <li class="r" title={k.quote ? `“${k.quote}”` : k.id}>
            <span class="grow trunc mono">{k.text}</span>
            {#if k.status === 'violated'}<span class="tag err">violated</span>{/if}
            <span class="tag" class:hard={k.strength === 'hard'}>{k.strength}</span>
            <button class="ib x" aria-label="Remove {k.text}" onclick={() => app.userEdit(`Remove constraint ${k.text}`, [{ op: 'remove_constraint', id: k.id }])}>✕</button>
          </li>
        {/each}
      </ul>
    {:else if app.tab === 'history'}
      <div class="foot"><button class="btn" disabled={!app.k?.canUndo || !!app.k?.proposal} onclick={() => app.undo()}>Undo last</button></div>
      {#if app.k?.proposal}
        <ul class="rows"><li class="r"><span class="grow trunc">Pending changeset · {app.k.proposal.hunks.length} changes</span><span class="tag warn">pending</span></li></ul>
      {/if}
      <ul class="rows">
        {#each app.k?.history ?? [] as h (h.id)}
          <li class="r" title={h.time}>
            <span class="grow trunc"><b>#{h.id}</b> {h.summary}</span>
            <span class="tag" class:info={h.by === 'user'}>{h.by === 'user' ? 'you' : 'agent'}</span>
            <span class="muted mono">{h.hunks}</span>
          </li>
        {/each}
      </ul>
      {#if !app.k?.history.length && !app.k?.proposal}<div class="empty">No commits yet.</div>{/if}
    {:else}
      {#if !sel && net}
        <dl class="kv">
          <dt>Net</dt><dd><b>{net.name}</b> <span class="tag">{net.kind}</span></dd>
          {#if net.attrs.voltage !== undefined}<dt>voltage</dt><dd>{net.attrs.voltage} V{net.attrs.external ? ' · from outside' : ''}</dd>{/if}
          <dt>current</dt>
          <dd>
            <input class="cur mono" placeholder="max A" value={net.attrs.maxCurrent ?? ''} disabled={!!app.k?.proposal} title="The most current this net carries; it suggests the track width" onchange={(e) => setCurrent((e.currentTarget as HTMLInputElement).value)} /> A
          </dd>
          <dt>track</dt>
          <dd>
            <select class="pkgsel mono" value={net.attrs.trackWidth ? String(net.attrs.trackWidth) : ''} disabled={!!app.k?.proposal} title={app.k?.proposal ? 'Review the pending changes first' : 'Track width on the board'} onchange={(e) => setTrack((e.currentTarget as HTMLSelectElement).value)}>
              <option value="">{net.kind === 'signal' ? net.track.rules.signal_mm : net.track.rules.power_mm} mm · {net.kind === 'signal' ? 'signal' : 'power'} default</option>
              {#each [...new Set([...WIDTHS, ...(net.track.suggested_mm ? [net.track.suggested_mm] : []), ...(net.attrs.trackWidth ? [net.attrs.trackWidth] : [])])].sort((a, b) => a - b) as w (w)}
                <option value={String(w)}>{w} mm{w === net.track.suggested_mm ? ` · suggested for ${net.track.for_current_a} A` : ''}</option>
              {/each}
            </select>
          </dd>
        </dl>
        {#if net.track.suggested_mm && net.track.suggested_mm > net.track.width_mm}
          <p class="note warn">For {net.track.for_current_a} A this net needs about {net.track.suggested_mm} mm (1 oz copper, 10 °C rise); it has {net.track.width_mm} mm.
            <button class="link" disabled={!!app.k?.proposal} onclick={() => setTrack(String(net!.track.suggested_mm))}>Use {net.track.suggested_mm} mm</button></p>
        {:else if !net.attrs.maxCurrent}
          <p class="note">Enter the current it carries to get a suggested width.</p>
        {/if}
        <div class="sect">Connections · {net.pins.length}</div>
        <ul class="rows">
          {#each netPins as [p, n], i (i)}
            <li class="r"><button class="link mono" onclick={() => app.toggleSelect(p.split('.')[0]!, false)}>{p}</button>{#if n > 1}<span class="muted mono"> ×{n}</span>{/if}</li>
          {/each}
        </ul>
      {:else if !info && infoError}
        <div class="empty err">{infoError}</div>
      {:else if !info}
        <div class="empty">Click a part on the canvas to see it here and reference it in the chat. Shift-click selects several.</div>
      {:else}
        <dl class="kv">
          <dt>Part</dt><dd title={info.description}>{info.part}</dd>
          {#each paramKeys as k (k)}
            <dt title={info.specs?.[k]?.description}>{k}{info.specs?.[k]?.required ? ' *' : ''}</dt>
            <dd><input class="pv mono" value={info.params[k] ?? ''} placeholder={placeholder(k)} disabled={!!app.k?.proposal} title={app.k?.proposal ? 'Review the pending changes first' : (info.specs?.[k]?.description ?? k)} onchange={(e) => void setParam(k, (e.currentTarget as HTMLInputElement).value)} /></dd>
          {/each}
          {#if info.package}
            <dt>package</dt>
            <dd>
              <select class="pkgsel mono" value={info.package.why === 'set' ? info.package.name : ''} disabled={!!app.k?.proposal} title={app.k?.proposal ? 'Review the pending changes first' : 'The footprint of this part'} onchange={(e) => setPackage((e.currentTarget as HTMLSelectElement).value)}>
                <option value="">{info.package.why === 'set' ? 'default' : info.package.name} · {info.package.why === 'set' ? 'design default' : whyText(info.package)}</option>
                {#each info.package.options as o (o)}<option value={o}>{o}</option>{/each}
                {#if info.package.why === 'set' && !info.package.options.includes(info.package.name)}<option value={info.package.name}>{info.package.name}</option>{/if}
              </select>
            </dd>
          {/if}
          <dt title="The side of the board the part is mounted on">board side</dt>
          <dd>
            <select class="pkgsel mono" value={info.side ?? 'top'} disabled={!!app.k?.proposal} title={app.k?.proposal ? 'Review the pending changes first' : 'Bottom: the footprint is mirrored and its SMD pads are on the bottom copper; it may sit under SMD parts on the top side'} onchange={(e) => void app.setSide(info!.refdes, (e.currentTarget as HTMLSelectElement).value as 'top' | 'bottom')}>
              <option value="top">top</option>
              <option value="bottom">bottom</option>
            </select>
          </dd>
        </dl>
        <div class="sect">Sourcing · JLCPCB</div>
        <dl class="kv">
          <dt title="LCSC / JLCPCB part number of the exact part to assemble">LCSC</dt>
          <dd class="src">
            <input class="pv mono" value={info.params.lcsc ?? ''} placeholder="C25804" disabled={!!app.k?.proposal} onchange={(e) => void setParam('lcsc', (e.currentTarget as HTMLInputElement).value)} />
            <button class="btn" disabled={!!app.k?.proposal} title="Search JLCPCB's catalogue for this part" onclick={() => (jlcOpen ? (jlcOpen = false) : openJlc())}>{jlcOpen ? 'Close' : 'Find on JLCPCB'}</button>
          </dd>
        </dl>
        {#if lcscState === 'loading'}
          <p class="note">Looking up {info.params.lcsc}…</p>
        {:else if lcscState === 'missing'}
          <p class="note warn">{info.params.lcsc} is not in JLCPCB's catalogue. Check the number.</p>
        {:else if lcscState === 'failed'}
          <p class="note warn">The catalogue could not be reached; the number is kept as typed.</p>
        {:else if lcscPart}
          <p class="note">{describeJlcPart(lcscPart)} <a href={lcscPart.url} target="_blank" rel="noopener">page</a>{#if lcscPart.datasheet} · <a href={lcscPart.datasheet} target="_blank" rel="noopener">datasheet</a>{/if}</p>
          {#if mismatches.length}
            <p class="note warn">This part does not match {info.refdes}: {mismatches.join('; ')}.
              <button class="link" disabled={!!app.k?.proposal} onclick={takePartValues}>Take the part's values</button></p>
          {/if}
        {/if}
        {#if jlcOpen}
          <div class="jlc">
            <div class="q">
              <input class="pv" bind:value={jlcText} placeholder={passiveKind ? (passiveKind === 'resistor' ? '10k' : '100nF') : 'words of the catalogue description'} onkeydown={(e) => e.key === 'Enter' && void searchJlc()} />
              <input class="pv pk mono" bind:value={jlcPkg} placeholder="package" onkeydown={(e) => e.key === 'Enter' && void searchJlc()} />
              <button class="btn" disabled={jlcBusy || !jlcText.trim()} onclick={() => void searchJlc()}>Search</button>
            </div>
            <label class="opt"><input type="checkbox" bind:checked={jlcBasic} onchange={() => void searchJlc()} /> Basic and Preferred only (no loading fee)</label>
            {#if jlcBusy}
              <p class="note">Searching…</p>
            {:else if jlcError}
              <p class="note warn">{jlcError}</p>
            {:else if jlcResults && !jlcResults.length}
              <p class="note">Nothing found. Try other words, or without the package.</p>
            {:else if jlcResults}
              <ul class="rows">
                {#each jlcResults as p (p.lcsc)}
                  <li class="r jl" title={factsLabel(p)}>
                    <div class="grow">
                      <div class="l1"><b class="mono">{p.lcsc}</b> <span class="mono">{p.mpn}</span> <span class="tag" class:ok={p.tier !== 'extended'}>{tierLabel(p.tier)}</span></div>
                      <div class="l2 muted">{p.package}{p.package ? ' · ' : ''}{priceLabel(p)} · {p.stock.toLocaleString('en-US')} in stock{factsLabel(p) ? ` · ${factsLabel(p)}` : ''}</div>
                    </div>
                    <button class="btn pri" disabled={!!app.k?.proposal} onclick={() => void pickJlc(p)}>Use</button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
        <div class="sect">Pins</div>
        <dl class="kv">
          {#each info.pins ?? [] as p (p.pin)}<dt>{p.pin} {p.name !== p.pin ? p.name : ''}</dt><dd class:muted={!p.net}>{p.net ?? '—'}</dd>{/each}
        </dl>
        {#if info.constraints.length}
          <div class="sect">Constraints</div>
          <ul class="rows">{#each info.constraints as c (c.id)}<li class="r"><span class="grow mono trunc">{c.text}</span><span class="tag" class:hard={c.strength === 'hard'}>{c.strength}</span></li>{/each}</ul>
        {/if}
        <div class="sect">Hints</div>
        <div class="sugg">
          {#if info.refdes.startsWith('C')}<button onclick={() => hint(`make ${info!.refdes} 100uF`)}>value…</button>{/if}
          <button onclick={() => hint(`put ${info!.refdes} left of `)}>left of…</button>
          <button onclick={() => hint(`Why is ${info!.refdes} there?`)}>why?</button>
          <button onclick={() => hint(`Remove ${info!.refdes}`)}>remove</button>
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .insp { height: 100%; }
  .tabs { display: flex; border-bottom: 1px solid var(--line); flex: none; height: 32px; padding: 0 4px; }
  .tabs button { border: 0; background: transparent; padding: 0 8px; font-size: 12px; color: var(--txt-3); border-bottom: 2px solid transparent; display: flex; align-items: center; gap: 4px; }
  .tabs button[aria-selected="true"] { color: var(--txt); border-bottom-color: var(--accent); font-weight: 600; }
  .cnt { font-family: var(--mono); font-size: 10.5px; color: var(--txt-3); font-weight: 400; }
  .foot { padding: 6px 10px; font-size: 11.5px; color: var(--txt-3); display: flex; gap: 6px; align-items: center; }
  .hints { font-size: 10.5px; white-space: pre-wrap; margin: 4px 0 0; color: var(--txt-2); }
  .kv { display: grid; grid-template-columns: 96px 1fr; font-size: 12px; margin: 0; }
  .kv > * { padding: 3px 10px; border-bottom: 1px solid var(--line); min-width: 0; margin: 0; }
  .kv dt { color: var(--txt-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kv dd { font-family: var(--mono); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sect { padding: 8px 10px 3px; font-size: 11px; color: var(--txt-3); text-transform: uppercase; letter-spacing: .04em; }
  .sugg { display: flex; gap: 4px; flex-wrap: wrap; padding: 2px 10px 10px; }
  .sugg button { border: 1px solid var(--line); background: var(--panel-2); border-radius: 99px; padding: 0 8px; font-size: 11.5px; line-height: 20px; color: var(--txt-2); }
  .pkgsel { font-size: 11px; padding: 1px 2px; max-width: 100%; background: var(--panel); color: var(--txt); border: 1px solid var(--line-2); border-radius: 4px; }
  .empty.err { color: var(--err); }
  .cur { width: 60px; font-size: 11px; padding: 1px 4px; background: var(--panel); color: var(--txt); border: 1px solid var(--line-2); border-radius: 4px; }
  .note { margin: 4px 10px 8px; font-size: 11px; color: var(--txt-3); }
  .note.warn { color: var(--warn); }
  .link { border: 0; background: none; padding: 0; color: var(--accent-txt); cursor: pointer; font: inherit; text-decoration: underline; }
  .pv { width: 100%; min-width: 0; font-size: 11.5px; padding: 1px 4px; background: var(--panel); color: var(--txt); border: 1px solid var(--line-2); border-radius: 4px; }
  .pv::placeholder { color: var(--txt-3); opacity: .7; }
  .kv dd.src { display: flex; gap: 4px; align-items: center; white-space: normal; }
  .kv dd.src .btn { flex: none; font-size: 11px; padding: 1px 6px; }
  .note a { color: var(--accent-txt); }
  .jlc { padding: 2px 10px 8px; }
  .jlc .q { display: flex; gap: 4px; align-items: center; }
  .jlc .pk { width: 72px; flex: none; }
  .jlc .btn { flex: none; font-size: 11px; padding: 1px 6px; }
  .jlc .opt { display: flex; gap: 4px; align-items: center; font-size: 11px; color: var(--txt-3); margin: 4px 0; }
  .jlc .rows { margin: 0 -10px; }
  .jl .l1 { font-size: 11.5px; display: flex; gap: 6px; align-items: center; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .jl .l2 { font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .jl .grow { min-width: 0; }
  .tag.ok { color: var(--ok, var(--accent-txt)); border-color: currentColor; }
</style>
