<script lang="ts">
  import { app, type InspectorTab } from '../app.svelte.ts';

  interface ComponentInfo {
    refdes: string;
    part: string;
    description?: string;
    params: Record<string, string>;
    pins?: { pin: string; name: string; type: string; net: string | null }[];
    constraints: { id: string; text: string; strength: string }[];
  }

  const sel = $derived(app.selection[0]);
  let info = $state<ComponentInfo | null>(null);

  $effect(() => {
    const ref = sel;
    void app.k; // refresh when the design changes
    if (!ref) {
      info = null;
      return;
    }
    void app.queryComponent(ref).then((r) => {
      info = r && typeof r === 'object' && 'refdes' in r ? (r as ComponentInfo) : null;
    });
  });

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
        {t.id === 'sel' && sel ? sel : t.label} <span class="cnt">{count(t.id)}</span>
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
      {#if !info}
        <div class="empty">Click a part on the canvas to see it here and reference it in the chat. Shift-click selects several.</div>
      {:else}
        <dl class="kv">
          <dt>Part</dt><dd title={info.description}>{info.part}</dd>
          {#each Object.entries(info.params) as [k, v] (k)}<dt>{k}</dt><dd>{v}</dd>{/each}
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
</style>
