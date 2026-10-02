<script lang="ts">
  import { app, type InspectorTab } from '../app.svelte.ts';

  interface ComponentInfo {
    refdes: string;
    part: string;
    description?: string;
    params: Record<string, string>;
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
        {#each open as d (d.code + d.entities.join())}
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
        {#each waived as d (d.code + d.entities.join())}
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
          {#each Object.entries(info.params).filter(([k]) => !(info?.package && k === 'package')) as [k, v] (k)}<dt>{k}</dt><dd>{v}</dd>{/each}
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
        </dl>
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
</style>
