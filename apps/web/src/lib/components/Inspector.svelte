<script lang="ts">
  import { ASSEMBLY_HOUSES, currencySymbol, drawingFinding, feeFreeTiers, whose, type ParamSpec, type SupplierPart } from '@4k7/schema';
  import { canPackage, describePart, lifecycleWarning, samePackage, sourcingMismatch, stockState } from '@4k7/parts';
  import { app, type InspectorTab } from '../app.svelte.ts';
  import { catalogueOf } from '../sourcing.ts';

  interface ComponentInfo {
    refdes: string;
    part: string;
    description?: string;
    category?: string;
    params: Record<string, string>;
    /** The board side the part is mounted on. */
    side?: 'top' | 'bottom';
    /** Every parameter the component may carry (the card's, then the universal ones such as lcsc). */
    specs: Record<string, ParamSpec>;
    /** Generic parts: the package in use, why, and the ones to pick from. */
    package?: { name: string; why: 'set' | 'default' | 'auto' | 'library'; reason?: string; options: string[] };
    pins?: { pin: string; name: string; type: string; net: string | null }[];
    constraints: { id: string; text: string; strength: string }[];
  }

  /** The parameters that hold a house's part number. */
  const SOURCING_PARAMS = new Set(ASSEMBLY_HOUSES.flatMap((h) => (h.param ? [h.param] : [])));

  const sel = $derived(app.selection[0]);
  /** The assembly house chosen in Layout → Sourcing: whose part number and catalogue this section shows. */
  const house = $derived(app.house);
  const catalogue = $derived(catalogueOf(house));
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
  /** Parameter rows: the card's specs in order (package has its own picker, the house's part number its own section), then stray params. */
  const paramKeys = $derived.by(() => {
    if (!info) return [] as string[];
    // every house's number belongs to the Sourcing section: the chosen house's there, another's here only when it has one
    const own = (k: string) => k === house.param || (SOURCING_PARAMS.has(k) && !info!.params[k]) || (!!info!.package && k === 'package');
    const keys = Object.keys(info.specs ?? {}).filter((k) => !own(k));
    for (const k of Object.keys(info.params)) if (!keys.includes(k) && !own(k)) keys.push(k);
    return keys;
  });
  const EXAMPLES: Record<string, string> = { F: '100nF', 'Ω': '10k', H: '10uH', V: '25V', A: '2A', W: '0.25W' };
  const placeholder = (k: string) => {
    const spec = info?.specs?.[k];
    if (spec?.values) return spec.values.join(' / ');
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

  /* ---- sourcing: the assembly house's part behind this component ---- */
  /** The package the component really has: its pick or default for generics, the card's for imported parts. */
  const effPkg = $derived(info ? (info.package?.name ?? info.params.package ?? app.designParts[info.part]?.package) : undefined);
  /** The component's manufacturer part number (its own, else its part's). */
  const mpnOf = $derived(info ? (info.params.mpn ?? app.designParts[info.part]?.mpn) : undefined);
  /** The number the house orders it by: the house's parameter, else (at a house that buys by the maker's number) the MPN. */
  const ownNumber = $derived(info && house.param ? info.params[house.param] : undefined);
  const orderNumber = $derived(ownNumber || (house.byMpn ? mpnOf : undefined));
  let sourcePart = $state<SupplierPart | null>(null);
  let sourceState = $state<'idle' | 'loading' | 'missing' | 'failed'>('idle');
  $effect(() => {
    const id = house.noCatalogue ? undefined : orderNumber;
    const cat = catalogue;
    sourcePart = null;
    if (!id) {
      sourceState = 'idle';
      return;
    }
    sourceState = 'loading';
    cat
      .lookup(id)
      .then((p) => {
        if (orderNumber !== id || catalogue !== cat) return;
        sourcePart = p;
        sourceState = p ? 'idle' : 'missing';
      })
      .catch(() => orderNumber === id && catalogue === cat && (sourceState = 'failed'));
  });
  const mismatches = $derived(info && sourcePart ? sourcingMismatch({ category: (info.category ?? 'other') as never }, info.params, effPkg, sourcePart) : []);
  /** How the chosen part's stock stands against the boards the stock check counts for (this component alone). */
  const sourceStock = $derived(sourcePart ? stockState(sourcePart.stock, app.settings.buildBoards, sourcePart.supply) : null);
  const sourceLife = $derived(sourcePart ? lifecycleWarning(sourcePart.lifecycle) : null);

  /** Text and package the catalogue search starts from: value + package for passives, the part number otherwise. */
  let findOpen = $state(false);
  let findText = $state('');
  let findPkg = $state('');
  let findNoFee = $state(true);
  let findBusy = $state(false);
  let findError = $state<string | null>(null);
  let findResults = $state<SupplierPart[] | null>(null);
  const passiveKind = $derived(info?.category === 'resistor' ? 'resistor' : info?.category === 'capacitor' ? 'capacitor' : null);
  /** Counts searches, so an answer overtaken by a newer search (or a new selection) is dropped. */
  let findSeq = 0;
  $effect(() => {
    void sel; // the search belongs to one component: another selection closes it
    findSeq++;
    findOpen = false;
    findResults = null;
    findError = null;
    findBusy = false;
  });
  function openFind() {
    if (!info) return;
    const card = app.designParts[info.part];
    findText = passiveKind ? (info.params[passiveKind === 'resistor' ? 'resistance' : 'capacitance'] ?? '') : (info.params.mpn ?? card?.mpn ?? card?.title ?? info.description ?? '');
    findPkg = effPkg ?? '';
    findResults = null;
    findError = null;
    findOpen = true;
    void search();
  }
  async function search() {
    if (!info || !findText.trim()) return;
    const seq = ++findSeq;
    findBusy = true;
    findError = null;
    try {
      const found = await catalogue.search({
        ...(passiveKind ? { kind: passiveKind, value: findText.trim() } : { text: findText.trim() }),
        ...(findPkg.trim() ? { package: findPkg.trim() } : {}),
        noFee: findNoFee,
        limit: 10,
      });
      if (seq === findSeq) findResults = found;
    } catch (e) {
      if (seq !== findSeq) return;
      findResults = null;
      findError = (e as Error).message;
    } finally {
      if (seq === findSeq) findBusy = false;
    }
  }
  /** Take a search result: its number, and its package when the component's differs (an electrolytic's can as the package that fits it). */
  async function pick(p: SupplierPart) {
    const param = house.param;
    if (!info || !param) return;
    const ref = info.refdes;
    const theirs = canPackage(p.package) ?? p.package;
    const pkgDiffers = !!theirs && !!info.package && !samePackage(effPkg ?? '', theirs);
    const what = p.mpn !== p.sku ? `${p.sku} (${p.mpn})` : p.sku;
    let ok = false;
    if (pkgDiffers) ok = await app.userEdit(`${ref}: ${what}, package ${theirs}`, [{ op: 'set_param', ref, params: { [param]: p.sku, package: theirs } }]);
    if (!ok) ok = await app.userEdit(`${ref}: ${what}`, [{ op: 'set_param', ref, params: { [param]: p.sku } }]);
    if (ok) findOpen = false;
  }
  /** Make the component say what the chosen part is (value, voltage, package). */
  function takePartValues() {
    if (!info || !sourcePart) return;
    const a = sourcePart.attributes;
    const params: Record<string, string> = {};
    if (passiveKind === 'resistor' && (a.Resistance ?? a.Value)) params.resistance = (a.Resistance ?? a.Value)!.replace(/Ω$/, '');
    if (passiveKind === 'capacitor' && (a.Capacitance ?? a.Value)) params.capacitance = (a.Capacitance ?? a.Value)!;
    if (passiveKind === 'capacitor' && a['Voltage Rated']) params.voltage = a['Voltage Rated'];
    if (sourcePart.package && info.package) params.package = canPackage(sourcePart.package) ?? sourcePart.package;
    if (!Object.keys(params).length) return;
    void app.userEdit(`${info.refdes}: values of ${sourcePart.sku}`, [{ op: 'set_param', ref: info.refdes, params }]);
  }
  const priceLabel = (p: SupplierPart) => {
    const each = p.price[0]?.each;
    if (each === undefined) return 'no price';
    return p.price.every((b) => b.each === 0) ? 'free' : `${currencySymbol(house)}${each < 1 ? each.toPrecision(2) : each.toFixed(2)}`;
  };
  const factsLabel = (p: SupplierPart) => p.description || Object.entries(p.attributes).map(([k, v]) => (k === 'Value' ? v : `${k} ${v}`)).join(', ');
  const stockLabel = (p: SupplierPart) =>
    `${p.stock !== null ? `${p.stock.toLocaleString('en-US')} in stock` : p.supply === 'stock' ? 'kept in stock' : p.supply === 'order' ? 'bought for the order' : 'stock unknown'}${p.live ? '' : ' (mirror)'}`;
  /** Fewer than the stock check's margin for the boards counted (this component alone). */
  const scarce = (p: SupplierPart) => p.stock !== null && stockState(p.stock, app.settings.buildBoards) !== 'ok';

  /* a selected net: what it is, what it connects, and its track width on the board */
  interface NetInfo {
    id: string;
    name: string;
    kind: 'ground' | 'supply' | 'signal';
    attrs: { voltage?: number; maxCurrent?: number; external?: boolean; trackWidth?: number; drawAs?: 'label' | 'wire' };
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

  /** Force how the schematic draws it: labels, wires, or back to what draws best. */
  function setDrawAs(v: string) {
    if (!net) return;
    void app.userEdit(`${net.name}: ${v === 'label' ? 'labels, no wires' : v === 'wire' ? 'wires, no labels' : 'label automatic'}`, [{ op: 'set_net', net: net.name, draw_as: v || null }]);
  }
  /** Forced to wires, and a label shows all the same: no wire can go there. */
  const labelStays = $derived(!!net && net.attrs.drawAs === 'wire' && net.kind === 'signal' && !!app.k?.view.sheets.some((s) => s.labels.some((l) => l.netId === net!.id)));

  // (how the sheet is drawn is the agent's to look at, not an issue: the counts leave it out too)
  const diags = $derived((app.k?.diagnostics ?? []).filter((d) => !drawingFinding(d)));
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
          <dt title="Whether the schematic shows this net by labels or by wires">label</dt>
          <dd>
            <select class="pkgsel mono" value={net.attrs.drawAs ?? ''} disabled={!!app.k?.proposal || app.running} title={app.k?.proposal ? 'Review the pending changes first' : app.running ? 'The agent is working' : 'Label: a label or supply symbol at every pin, no wires between them. No label: wires, and a label only where no wire can go. A sheet with such a net is kept as drawn, and the net stays that way.'} onchange={(e) => setDrawAs((e.currentTarget as HTMLSelectElement).value)}>
              <option value="">automatic</option>
              <option value="label">label · no wires</option>
              <option value="wire">no label · wires</option>
            </select>
          </dd>
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
        {#if labelStays}
          <p class="note">A label stays where no wire can go: another page or sheet, or no clear path.</p>
        {:else if net.attrs.drawAs === 'wire' && net.kind !== 'signal'}
          <p class="note">A supply keeps one symbol on each wired piece.</p>
        {/if}
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
        <div class="sect">Sourcing · {house.name}</div>
        {#if house.param}
          {@const param = house.param}
          <dl class="kv">
            <dt title="{whose(house)} part number ({house.numberName}) of the exact part to assemble">{house.numberLabel}</dt>
            <dd class="src">
              <input class="pv mono" value={info.params[param] ?? ''} placeholder={house.byMpn && mpnOf ? mpnOf : house.example} disabled={!!app.k?.proposal} onchange={(e) => void setParam(param, (e.currentTarget as HTMLInputElement).value)} />
              <button class="btn" disabled={!!app.k?.proposal} title="Search {whose(house)} catalogue for this part" onclick={() => (findOpen ? (findOpen = false) : openFind())}>{findOpen ? 'Close' : 'Find…'}</button>
            </dd>
          </dl>
          {#if !ownNumber && orderNumber}<p class="note">Without its own number, {house.name} orders it by the manufacturer part number.</p>{/if}
        {:else}
          <p class="note">{orderNumber ? `${house.name} buys it for the order by its manufacturer part number, ${orderNumber}` : passiveKind ? `${house.name} buys resistors and capacitors by value and package` : `No manufacturer part number: ${house.name} needs one to buy it`}. {house.noCatalogue ? `${house.noCatalogue[0]!.toUpperCase()}${house.noCatalogue.slice(1)}.` : ''}</p>
        {/if}
        {#if sourceState === 'loading'}
          <p class="note">Looking up {orderNumber}…</p>
        {:else if sourceState === 'missing'}
          <p class="note warn">{orderNumber} is not in {whose(house)} catalogue (gone, or a wrong number).
            <button class="link" disabled={!!app.k?.proposal} onclick={openFind}>Find another part</button></p>
        {:else if sourceState === 'failed'}
          <p class="note warn">The catalogue could not be reached; the number is kept as typed.</p>
        {:else if sourcePart}
          <p class="note">{describePart(sourcePart, house)} <a href={sourcePart.url} target="_blank" rel="noopener">page</a>{#if sourcePart.datasheet} · <a href={sourcePart.datasheet} target="_blank" rel="noopener">datasheet</a>{/if}</p>
          {#if sourceStock === 'out' || sourceStock === 'short' || sourceStock === 'low'}
            <p class="note warn">{sourceStock === 'out' ? `Out of stock at ${house.name} now.` : `Only ${sourcePart.stock?.toLocaleString('en-US')} in stock: ${sourceStock === 'short' ? 'too few' : 'tight'} for ${app.settings.buildBoards} boards.`}
              <button class="link" disabled={!!app.k?.proposal} onclick={openFind}>Find another part</button></p>
          {:else if sourceLife}
            <p class="note warn">The part is {sourceLife}.
              <button class="link" disabled={!!app.k?.proposal} onclick={openFind}>Find another part</button></p>
          {/if}
          {#if mismatches.length}
            <p class="note warn">This part does not match {info.refdes}: {mismatches.join('; ')}.
              <button class="link" disabled={!!app.k?.proposal} onclick={takePartValues}>Take the part's values</button></p>
          {/if}
        {/if}
        {#if findOpen}
          <div class="find">
            <div class="q">
              <input class="pv" bind:value={findText} placeholder={passiveKind ? (passiveKind === 'resistor' ? '10k' : '100nF') : 'words of the catalogue description'} onkeydown={(e) => e.key === 'Enter' && void search()} />
              <input class="pv pk mono" bind:value={findPkg} placeholder="package" onkeydown={(e) => e.key === 'Enter' && void search()} />
              <button class="btn" disabled={findBusy || !findText.trim()} onclick={() => void search()}>Search</button>
            </div>
            <label class="opt"><input type="checkbox" bind:checked={findNoFee} onchange={() => void search()} /> {feeFreeTiers(house)} only (no fee)</label>
            {#if findBusy}
              <p class="note">Searching…</p>
            {:else if findError}
              <p class="note warn">{findError}</p>
            {:else if findResults && !findResults.length}
              <p class="note">Nothing in stock found. Try other words, or without the package.</p>
            {:else if findResults}
              <ul class="rows">
                {#each findResults as p (p.sku)}
                  <li class="r jl" title={factsLabel(p)}>
                    <div class="grow">
                      <div class="l1"><b class="mono">{p.sku}</b> {#if p.mpn !== p.sku}<span class="mono">{p.mpn}</span> {/if}{#if p.tier}<span class="tag" class:ok={!p.fee}>{p.tier}</span>{/if}{#if scarce(p)} <span class="tag warn" title="Fewer than {app.settings.buildBoards * 5} in stock: it may be gone before the order goes in">few left</span>{/if}</div>
                      <div class="l2 muted">{p.package}{p.package ? ' · ' : ''}{priceLabel(p)} · {stockLabel(p)}{factsLabel(p) ? ` · ${factsLabel(p)}` : ''}</div>
                    </div>
                    <button class="btn pri" disabled={!!app.k?.proposal} onclick={() => void pick(p)}>Use</button>
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
  .kv dd.src .pv { min-width: 7em; }
  .note a { color: var(--accent-txt); }
  .find { padding: 2px 10px 8px; }
  .find .q { display: flex; gap: 4px; align-items: center; }
  .find .pk { width: 72px; flex: none; }
  .find .btn { flex: none; font-size: 11px; padding: 1px 6px; }
  .find .opt { display: flex; gap: 4px; align-items: center; font-size: 11px; color: var(--txt-3); margin: 4px 0; }
  .find .rows { margin: 0 -10px; }
  .jl .l1 { font-size: 11.5px; display: flex; gap: 6px; align-items: center; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .jl .l2 { font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .jl .grow { min-width: 0; }
  .tag.ok { color: var(--ok, var(--accent-txt)); border-color: currentColor; }
</style>
