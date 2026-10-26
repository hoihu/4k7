<script lang="ts">
  import { printFiles } from '@4k7/fab';
  import { enclosureKey, openQuestions, scriptInlays, scriptPieces, scriptPrintRotations, type BriefItem, type EnclosureGraphic } from '@4k7/schema';
  import { app } from '../app.svelte.ts';
  import Chat from './Chat.svelte';
  import Splitter from './Splitter.svelte';
  import Enclosure3DView from './Enclosure3DView.svelte';
  import { AXES, contentBox, extent, firstCut, liftStep, newSection, sectionLabel, sectionView, type Axis, type Section } from '../section.ts';

  /**
   * Enclosure workspace (docs/design/enclosure.md §6): the agent's chat, the box in 3D with the
   * board, and a side panel with the brief (the user answers its questions here), the report of the
   * last render, OpenSCAD on this computer, the script, and the downloads.
   */
  $effect(() => {
    void app.refreshEnclosure();
    void app.scadStatus();
  });

  const b = $derived(app.board);
  const enc = $derived(app.encDraft);
  const brief = $derived(enc?.brief);
  const script = $derived(enc?.script ?? null);
  const questions = $derived(openQuestions(brief));
  const graphics = $derived(enc?.graphics ?? []);
  // the last render, if it was made from the script (and graphics) as they are now
  const encKey = $derived(enclosureKey(enc));
  const last = $derived(app.enclosure && script && app.enclosure.report.key === encKey ? app.enclosure : null);
  const report = $derived(last?.report ?? null);
  const errors = $derived(report?.findings.filter((f) => f.severity === 'error') ?? []);
  const warnings = $derived(report?.findings.filter((f) => f.severity === 'warning') ?? []);

  /* render the script once it changed (and OpenSCAD is there); a failed render is not retried by itself */
  let tried = $state<string | null>(null);
  let renderError = $state<string | null>(null);
  $effect(() => {
    if (!script || last || app.enclosureBusy || tried === encKey || !app.scad?.available || !b) return;
    tried = encKey;
    void render();
  });
  async function render() {
    renderError = null;
    const r = await app.renderEnclosure();
    if ('error' in r) renderError = r.error;
  }

  /* the 3D view */
  let open = $state(false);
  let hidden = $state<Record<string, boolean>>({});
  /** The board with its parts, shown in the box (off: how the box holds it). */
  let pcb = $state(true);
  const pieces = $derived(report?.pieces ?? []);
  const printTurns = $derived(script ? scriptPrintRotations(script) : {});
  const inlays = $derived(script ? scriptInlays(script) : {});
  /** The pieces shown and hidden on their own: inlays come and go with their host. */
  const hosts = $derived(pieces.filter((p) => !inlays[p.name] || !pieces.some((h) => h.name === inlays[p.name]!.host)));
  const openings = $derived(brief?.openings ?? []);
  const scene = $derived(b && last ? { board: b, facts: last.facts, pieces, findings: last.report.findings, openings, inlays } : null);
  const options = $derived({ open: open ? 1 : 0, show: hosts.filter((p) => !hidden[p.name]).map((p) => p.name), marks: true, board: pcb });

  /*
   * The cut: a plane through the box, across x, y or z. It starts in the middle, the half the
   * camera looks from cut away; the slider or its frame in the view moves it, Flip shows the other
   * half.
   */
  const AXIS_TIPS: Record<string, string> = {
    x: "Across x: a cut parallel to the left and right walls (x from the board's left edge)",
    y: "Across y: a cut parallel to the front and back walls (y from the board's bottom edge)",
    z: "Across z: a level cut, parallel to the floor and the lid (z from the board's underside)",
  };
  let cut = $state<Section | null>(null);
  /** The cut before Whole: Cut brings it back. */
  let lastCut: Section | null = null;
  let view3d: Enclosure3DView | undefined = $state();
  /** What the cut goes through: the board and the pieces as shown (opened: the lifted ones too). */
  const cutBox = $derived(last ? contentBox(last.facts, pieces, open ? liftStep(pieces) * (hosts.length - 1) : 0) : null);
  /** Where the cut can go, on the slider's 0.1 mm steps. */
  const cutRange = $derived.by(() => {
    if (!cut || !cutBox) return null;
    const [lo, hi] = extent(cut.normal, cutBox);
    return [Math.floor(lo * 10) / 10, Math.ceil(hi * 10) / 10] as const;
  });
  const shownCut = $derived(cut && cutBox && cutRange ? { normal: cut.normal, at: Math.min(cutRange[1], Math.max(cutRange[0], cut.at)), flip: cut.flip, box: cutBox } : null);
  function cutBy(by: Axis) {
    if (cutBox) cut = newSection(by, cutBox, view3d?.eye());
  }
  function cutOpen() {
    if (cut) return;
    if (lastCut) cut = lastCut;
    else if (cutBox) cutBy(firstCut(cutBox));
  }
  function whole() {
    lastCut = cut ?? lastCut;
    cut = null;
  }
  // a message sent while the box is cut open tells the agent where (so "this wall" resolves)
  $effect(() => {
    app.enclosureCut = () => (cut && shownCut ? sectionView({ ...cut, at: shownCut.at }, open) : null);
    return () => (app.enclosureCut = null);
  });

  /* the brief's questions: the user's answers, sent to the agent as the next message */
  let picks = $state<Record<string, string>>({});
  let other = $state<Record<string, string>>({});
  const key = (i: BriefItem) => i.topic;
  const answerOf = (i: BriefItem) => (picks[key(i)] === '__other' ? (other[key(i)] ?? '').trim() : (picks[key(i)] ?? ''));
  const answered = $derived(questions.filter((q) => answerOf(q)).length);
  function sendAnswers() {
    const lines = questions.map((q) => `- ${q.topic}: ${answerOf(q) || `(no answer: your pick, ${q.options?.[0] ?? 'as you see fit'})`}`);
    void app.send(`Enclosure brief, my answers:\n${lines.join('\n')}\nSet them as decisions in the brief, then build the enclosure.`, { shown: `Answered the enclosure brief (${answered} of ${questions.length})` });
    picks = {};
    other = {};
  }
  function start() {
    void app.send('Design an enclosure for this board. Start with the brief: decide what you can and ask me the rest.');
  }

  /* the script, editable */
  let editing = $state(false);
  let draft = $state('');
  function edit() {
    draft = script ?? '';
    editing = true;
  }
  async function saveScript() {
    if (await app.userEdit('Edit the enclosure script', [{ op: 'set_enclosure_script', script: draft }])) editing = false;
  }

  /* graphics for the box: logos and icons, added from the artwork library (or by the agent) */
  let artPick = $state('');
  const gfxPath = (g: EnclosureGraphic) => g.polys.map((p) => `M${p.slice(0, 2).join(' ')}L${p.slice(2).join(' ')}Z`).join('');
  const gfxBox = (g: EnclosureGraphic) => {
    const pad = Math.max(g.w, g.h) * 0.08 + (g.mode === 'outline' ? (g.line ?? 0.2) : 0);
    return `${-g.w / 2 - pad} ${-g.h / 2 - pad} ${g.w + 2 * pad} ${g.h + 2 * pad}`;
  };
  /** A name the script can use for an artwork: letters, digits and _, unique among the graphics. */
  function gfxName(artName: string): string {
    let base = artName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'logo';
    if (!/^[a-z]/.test(base)) base = `g_${base}`;
    for (let i = 1; ; i++) {
      const name = i === 1 ? base : `${base}_${i}`;
      if (!graphics.some((g) => g.name === name)) return name;
    }
  }
  async function addGraphic() {
    const a = app.artwork.items.find((x) => x.id === artPick);
    if (!a) return;
    const name = gfxName(a.name);
    if (await app.userEdit(`Graphic "${name}" for the box`, [{ op: 'set_enclosure_graphic', name, artwork: a.name }])) artPick = '';
  }
  function removeGraphic(g: EnclosureGraphic) {
    void app.userEdit(`Remove the graphic "${g.name}" from the box`, [{ op: 'set_enclosure_graphic', name: g.name, remove: true }]);
  }

  /* OpenSCAD */
  let binInput = $state('');
  let binError = $state<string | null>(null);
  async function useBin(bin: string | null) {
    binError = await app.setScadBin(bin);
    if (!binError) binInput = '';
  }

  /* downloads */
  const projectName = () => (app.k?.summary.name && app.k.summary.name !== 'untitled' ? app.k.summary.name : '4k7-board').replace(/[^\w.-]+/g, '_');
  function download(blob: Blob, file: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  /** One piece as STL, turned for printing as the script says (print = …), on the bed. */
  function stl(name: string) {
    if (!report) return;
    const f = printFiles(report, projectName()).stl.find((x) => x.name === name);
    if (f) download(new Blob([f.data as BlobPart], { type: 'model/stl' }), `${projectName()}-${name}.stl`);
  }
  /** Every piece on one plate, turned for printing: a 3MF the slicers open as it is. */
  function plate3mf() {
    if (!report) return;
    download(new Blob([printFiles(report, projectName()).plate as BlobPart], { type: 'model/3mf' }), `${projectName()}-enclosure.3mf`);
  }
  /** The script with board.scad in it: one file that opens in OpenSCAD as it is. */
  async function scadFile() {
    const lib = await app.boardScadFile();
    if (!script || !lib) return;
    const one = script.replace(/^\s*include\s*<\s*board\.scad\s*>\s*;?/m, `// ---- board.scad (4k7) ----\n${lib.content}\n// ---- the enclosure ----`);
    download(new Blob([one], { type: 'text/plain' }), `${projectName()}-enclosure.scad`);
  }
  async function boardScad() {
    const lib = await app.boardScadFile();
    if (lib) download(new Blob([lib.content], { type: 'text/plain' }), lib.name);
  }
</script>

<section class="enc" class:nochat={!app.chatOpen}>
  <div class="col chatcol">{#if app.chatOpen}<Chat /><Splitter pane="chat" />{/if}</div>
  <div class="col canvas">
    {#if scene}
      <Enclosure3DView bind:this={view3d} {scene} {options} cut={shownCut} onmove={(at) => cut && (cut.at = at)} />
    {:else if b}
      <Enclosure3DView scene={{ board: b, facts: { thickness: 1.6, size: [b.outline.w, b.outline.h], outline: [], cutouts: [], holes: [], tallestTop: 0, lowestBottom: 0, parts: [] }, pieces: [], findings: [], openings: [] }} options={{ marks: false }} />
    {/if}
    <div class="top">
      <div class="tools">
        {#if !app.chatOpen}<button class="ib" onclick={() => (app.chatOpen = true)}>⟩ Agent</button>{/if}
        {#if pieces.length}
          <div class="seg"><button aria-pressed={!open} onclick={() => (open = false)}>Closed</button><button aria-pressed={open} onclick={() => (open = true)}>Opened</button></div>
          <div class="seg">
            <button aria-pressed={pcb} title="Show or hide the board with its parts (hide it to see how the box holds it)" onclick={() => (pcb = !pcb)}>PCB</button>
            {#each hosts as p (p.name)}<button aria-pressed={!hidden[p.name]} title="Show or hide the {p.name}" onclick={() => (hidden = { ...hidden, [p.name]: !hidden[p.name] })}>{p.name}</button>{/each}
          </div>
          <div class="seg">
            <button aria-pressed={!cut} title="The whole box" onclick={whole}>Whole</button>
            <button aria-pressed={!!cut} title="Cut the box open to see inside: a plane through its middle; move it with the slider or drag its frame in the view" onclick={cutOpen}>Cut</button>
          </div>
        {/if}
        {#if script}<button class="btn" disabled={app.enclosureBusy || !app.scad?.available} onclick={render}>{app.enclosureBusy ? 'Rendering…' : 'Render'}</button>{/if}
      </div>
      {#if app.k?.proposal}
        <div class="pend">
          <span class="pulse"></span>
          <span class="trunc"><b>{app.acceptedCount}</b> of {app.pendingCount} changes pending</span>
          <button class="btn pri" disabled={app.running || app.acceptedCount === 0} onclick={() => app.accept()}>Accept</button>
          <button class="btn" disabled={app.running} onclick={() => app.reject()}>Reject</button>
        </div>
      {/if}
      {#if pieces.length && cut && cutRange}
        <div class="cutbar">
          <div class="seg">
            {#each AXES as a (a)}<button aria-pressed={cut.by === a} title={AXIS_TIPS[a]} onclick={() => cutBy(a)}>{a}</button>{/each}
          </div>
          <label class="slide" title="Where the cut is (board.scad: x from the board's left edge, y from its bottom edge, z from its underside)">
            <input type="range" min={cutRange[0]} max={cutRange[1]} step="0.1" bind:value={cut.at} />
            <span class="mono">{sectionLabel(cut)}</span>
          </label>
          <div class="seg"><button title="Show the other half: cut away the side kept now" onclick={() => cut && (cut.flip = !cut.flip)}>Flip</button></div>
        </div>
      {/if}
    </div>
    {#if !brief && !script}
      <div class="blank">
        <div class="card">
          <p><b>No enclosure yet.</b> The agent designs the box for this board as an OpenSCAD script: first a brief with what it must do and the questions only you can answer, then the box, rendered with OpenSCAD on this computer and checked for collisions and blocked connectors.</p>
          <button class="btn pri" disabled={app.running || !b?.parts.length} onclick={start}>Design an enclosure</button>
        </div>
      </div>
    {/if}
    <div class="status">
      <span class="sp mono">
        {#if report?.size}Box {report.size.join(' × ')} mm<span class="dot">·</span>{/if}
        {#if b}Board {b.outline.w} × {b.outline.h} mm{/if}
        {#if report}<span class="dot">·</span><span class:ok={!errors.length} class:bad={errors.length}>{errors.length ? `${errors.length} finding${errors.length > 1 ? 's' : ''}` : 'checks clean'}</span>{/if}
      </span>
    </div>
  </div>
  <aside class="col side">
    <Splitter pane="side" />
    <div class="scroll">
      {#if brief}
        <h4>Brief {#if questions.length}<span class="tag warn">{questions.length} open</span>{/if}</h4>
        {#if questions.length}
          <p class="small muted">The agent needs your answers to these. Its pick is first.</p>
          {#each questions as q (key(q))}
            <fieldset class="q">
              <legend>{q.topic}</legend>
              <p class="small">{q.question}</p>
              {#each q.options ?? [] as o, i (o)}
                <label class="opt"><input type="radio" name={key(q)} value={o} bind:group={picks[key(q)]} />{o}{#if i === 0}<span class="muted"> (suggested)</span>{/if}</label>
              {/each}
              <label class="opt"><input type="radio" name={key(q)} value="__other" bind:group={picks[key(q)]} />Other:</label>
              {#if picks[key(q)] === '__other'}<input class="other" placeholder="Your answer" bind:value={other[key(q)]} />{/if}
            </fieldset>
          {/each}
          <button class="btn pri wide" disabled={app.running} title={answered < questions.length ? 'Questions without an answer are left to the agent (its pick)' : ''} onclick={sendAnswers}>Answer and build it</button>
        {/if}
        <ul class="items">
          {#each brief.items.filter((i) => i.decision) as i (key(i))}
            <li><b>{i.topic}</b>: {i.decision}{#if i.why}<span class="muted"> · {i.why}</span>{/if}</li>
          {/each}
        </ul>
        {#if brief.openings?.length}<p class="small">Openings for {brief.openings.join(', ')}{#if brief.max_size_mm} · at most {brief.max_size_mm.join(' × ')} mm{/if}</p>{/if}
      {/if}

      <h4>Graphics <span class="muted small">logos and icons for the box</span></h4>
      {#each graphics as g (g.name)}
        <div class="gfx">
          <svg class="thumb" viewBox={gfxBox(g)} aria-hidden="true"><path d={gfxPath(g)} fill-rule="evenodd" class={g.mode} stroke-width={g.mode === 'outline' ? Math.max(g.line ?? 0.2, Math.max(g.w, g.h) / 25) : undefined} /></svg>
          <span class="mono">{g.name}</span>
          <span class="muted small trunc" title={g.source}>{g.source ?? ''}</span>
          <button class="ib" disabled={app.running} title="Remove it (the script must not draw it any more)" onclick={() => removeGraphic(g)}>✕</button>
        </div>
      {/each}
      {#if app.artwork.items.length}
        <div class="row2">
          <select class="other" bind:value={artPick}>
            <option value="" disabled>From your artwork…</option>
            {#each app.artwork.items as a (a.id)}<option value={a.id}>{a.name} ({a.w} × {a.h} mm)</option>{/each}
          </select>
          <button class="btn" disabled={!artPick || app.running} onclick={addGraphic}>Add</button>
        </div>
      {/if}
      <p class="small muted">Import a logo in Parts → Artwork (an SVG, or a picture traced), add it here, and tell the agent where it goes. Port names and other text need nothing: ask for them ("label the USB port").</p>

      {#if script}
        <h4>Checks {#if report}<span class="tag err">{errors.length}</span> <span class="tag warn">{warnings.length}</span>{/if}</h4>
        {#if app.enclosureBusy}<p class="small muted">Rendering with OpenSCAD…</p>
        {:else if renderError}<p class="small bad">{renderError}</p>
        {:else if !report}<p class="small muted">Not rendered since the script changed.</p>
        {:else if !report.findings.length}<p class="small ok">No collisions, every opening clear, the board held.</p>{/if}
        {#if report}
          <ul class="findings">
            {#each report.findings as f, i (i)}
              <li><span class="tag {f.severity === 'error' ? 'err' : 'warn'}">{f.severity[0]!.toUpperCase()}</span><span class="msg">{f.message}</span></li>
            {/each}
          </ul>
          <p class="small muted">{report.pieces.length} piece{report.pieces.length === 1 ? '' : 's'} · rendered in {(report.ms / 1000).toFixed(1)} s of OpenSCAD</p>
        {/if}

        <h4>Files</h4>
        <div class="row2">
          <button class="btn" title="Every piece on one plate, turned for printing as the script says: a 3MF for the slicer" onclick={plate3mf}>Print plate .3mf ⤓</button>
          {#each pieces as p (p.name)}<button class="btn" title="The {p.name} as STL, {printTurns[p.name] ? `turned ${printTurns[p.name]!.join(', ')} for printing` : 'as built (the script gives no print orientation for it)'}, on the bed" onclick={() => stl(p.name)}>{p.name}.stl ⤓</button>{/each}
          <button class="btn" title="The script with board.scad in it: one file that opens in OpenSCAD" onclick={scadFile}>.scad ⤓</button>
          <button class="btn" title="The board as an OpenSCAD library (outline, holes, parts, plug paths)" onclick={boardScad}>board.scad ⤓</button>
        </div>

        <h4>Script <span class="muted small">{scriptPieces(script)?.join(', ')} · {script.split('\n').length} lines</span></h4>
        {#if editing}
          <textarea class="code" spellcheck="false" bind:value={draft}></textarea>
          <div class="row2"><button class="btn pri" disabled={app.running || draft === script} onclick={saveScript}>Save</button><button class="btn" onclick={() => (editing = false)}>Cancel</button></div>
        {:else}
          <pre class="code">{script}</pre>
          <button class="btn" disabled={app.running} title="Change the script yourself: it becomes a change like the agent's" onclick={edit}>Edit</button>
        {/if}
      {:else if b && !brief}
        <button class="btn wide" onclick={boardScad} title="The board as an OpenSCAD library (outline, holes, parts, plug paths), for your own box">board.scad ⤓</button>
      {/if}

      <h4>OpenSCAD</h4>
      {#if !app.scad}
        <p class="small muted">The 4k7 server on this computer runs OpenSCAD; it is not reachable (or older than the enclosure).</p>
      {:else if app.scad.available}
        <p class="small">OpenSCAD {app.scad.version}{app.scad.manifold ? '' : ' (no Manifold engine: slow; 2025 or later is much faster)'} <span class="muted mono" title={app.scad.path}>{app.scad.from === 'env' ? `from ${app.scad.env}` : app.scad.from === 'settings' ? 'chosen here' : 'found'}</span></p>
      {:else}
        <p class="small bad">{app.scad.reason}</p>
        <p class="small">Install <a href="https://openscad.org/downloads.html" target="_blank" rel="noreferrer">OpenSCAD</a> (2025 or later), then look again, or give its path.</p>
      {/if}
      {#if app.scad}
        <div class="row2">
          <input class="other mono" placeholder="/path/to/openscad" bind:value={binInput} />
          <button class="btn" disabled={!binInput.trim()} onclick={() => useBin(binInput)}>Use</button>
          <button class="btn" onclick={() => (app.scad?.from === 'settings' ? useBin(null) : app.scadStatus(true))}>Look again</button>
        </div>
        {#if binError}<p class="small bad">{binError}</p>{/if}
      {/if}
    </div>
  </aside>
</section>

<style>
  .enc { display: grid; grid-template-columns: var(--chat-col) minmax(0, 1fr) var(--side-col); gap: 1px; background: var(--line); height: 100%; min-height: 0; }
  .enc.nochat { grid-template-columns: 0 minmax(0, 1fr) var(--side-col); }
  .col { position: relative; background: var(--panel); min-height: 0; min-width: 0; display: flex; flex-direction: column; }
  .canvas { position: relative; background: var(--canvas); }
  .top { position: absolute; top: 8px; left: 8px; right: 8px; z-index: 2; display: flex; flex-wrap: wrap; gap: 6px; align-items: flex-start; pointer-events: none; }
  .top > * { pointer-events: auto; }
  .tools { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .seg { display: inline-flex; }
  .seg button { border: 1px solid var(--line-2); background: var(--panel); color: var(--txt-2); padding: 2px 10px; font-size: 12px; cursor: pointer; }
  .seg button + button { border-left: 0; }
  .seg button:first-child { border-radius: 6px 0 0 6px; }
  .seg button:last-child { border-radius: 0 6px 6px 0; }
  .seg button:only-child { border-radius: 6px; }
  .seg button[aria-pressed='true'] { background: var(--accent-soft); color: var(--accent-txt); }
  /* the cut's own controls, on a row of their own (only they take the pointer, not the row) */
  .cutbar { flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; pointer-events: none; }
  .cutbar > * { pointer-events: auto; }
  .slide { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line-2); border-radius: 6px; background: var(--panel); color: var(--txt-2); padding: 0 8px; height: 22px; box-sizing: border-box; }
  .slide input { width: 140px; margin: 0; accent-color: var(--accent); }
  .slide .mono { white-space: nowrap; }
  .pend { display: flex; gap: 6px; align-items: center; margin: 0 auto; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 4px 6px 4px 10px; box-shadow: var(--shadow); font-size: 12px; max-width: calc(100% - 24px); }
  .pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); flex: none; }
  .blank { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
  .card { pointer-events: auto; max-width: 400px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; color: var(--txt-2); box-shadow: var(--shadow); }
  .card p { margin: 0 0 10px; }
  .status { position: absolute; bottom: 0; left: 0; right: 0; display: flex; gap: 10px; padding: 3px 10px; font-size: 11px; color: var(--txt-3); background: color-mix(in srgb, var(--panel) 85%, transparent); border-top: 1px solid var(--line); }
  .status .sp { margin-left: auto; flex: none; white-space: nowrap; }
  .status .dot { margin: 0 4px; }
  .ok { color: var(--ok); }
  .bad { color: var(--err); }
  .side .scroll { padding: 8px 10px; }
  h4 { margin: 12px 0 4px; font-size: 12px; display: flex; gap: 6px; align-items: center; }
  .small { font-size: 11.5px; margin: 2px 0 6px; }
  .wide { width: 100%; margin: 4px 0; }
  .row2 { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin: 4px 0; }
  .q { border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px 6px; margin: 0 0 8px; }
  .q legend { font-size: 12px; font-weight: 600; padding: 0 4px; }
  .opt { display: flex; gap: 6px; align-items: baseline; font-size: 12px; padding: 2px 0; cursor: pointer; }
  .other { width: 100%; box-sizing: border-box; font-size: 12px; padding: 3px 6px; border: 1px solid var(--line-2); border-radius: 5px; background: var(--panel-2); color: var(--txt); }
  .row2 .other { flex: 1; width: auto; min-width: 0; }
  .gfx { display: flex; gap: 6px; align-items: center; font-size: 12px; padding: 2px 0; }
  .gfx .trunc { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .thumb { width: 28px; height: 20px; flex: none; background: var(--panel-2); border: 1px solid var(--line); border-radius: 4px; }
  .thumb path.fill { fill: var(--txt); }
  .thumb path.outline { fill: none; stroke: var(--txt); }
  .items { list-style: none; margin: 4px 0; padding: 0; font-size: 12px; color: var(--txt-2); }
  .items li { padding: 2px 0; }
  .findings { list-style: none; margin: 0; padding: 0; }
  .findings li { display: flex; gap: 6px; align-items: flex-start; font-size: 12px; padding: 3px 0; color: var(--txt-2); }
  .findings .msg { white-space: pre-wrap; overflow-wrap: anywhere; }
  .code { font-family: var(--mono); font-size: 11px; line-height: 1.4; background: var(--panel-2); border: 1px solid var(--line); border-radius: 6px; padding: 6px; max-height: 320px; overflow: auto; white-space: pre; margin: 4px 0; color: var(--txt); }
  textarea.code { width: 100%; box-sizing: border-box; min-height: 320px; resize: vertical; }
  @media (max-width: 900px) {
    .enc, .enc.nochat { grid-template-columns: minmax(0, 1fr); grid-template-rows: 60% 40%; }
    .chatcol { display: none; }
  }
</style>
