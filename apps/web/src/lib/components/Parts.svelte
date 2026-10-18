<script lang="ts">
  import { BUILTIN_PARTS, footprintFor, isModule, packageOf, partTitle, planUnits, searchParts, symbolFor, unitCount } from '@4k7/parts';
  import type { PartCard, PartPin, SheetView, SymbolView } from '@4k7/schema';
  import { app, tokenCost } from '../app.svelte.ts';
  import { USAGE_TITLE, usageLine } from '../usage.ts';
  import type { Datasheet } from '../ingest.svelte.ts';
  import type { TopView } from '../three-body.ts';
  import { artworkSvg, keepPicture, rasterize, type RasterOptions } from '../artwork.svelte.ts';
  import type { Artwork } from '@4k7/schema';
  import Body3DView from './Body3DView.svelte';
  import DatasheetView from './DatasheetView.svelte';
  import FootprintView from './FootprintView.svelte';
  import SchematicCanvas from './SchematicCanvas.svelte';

  const ingest = app.ingest;
  let q = $state('');
  let current = $state<PartCard>(BUILTIN_PARTS.find((p) => p.id === 'ti:TPS54331DR') ?? BUILTIN_PARTS[0]!);
  /** 'import' shows the datasheet importer (form, progress, review) instead of a part. */
  let mode = $state<'part' | 'import' | 'art' | 'raster'>(ingest.phase === 'idle' ? 'part' : 'import');
  let hoverPin = $state<string | null>(null);

  const userIds = $derived(new Set(ingest.library.map((p) => p.id)));
  /*
   * The library list, grouped by what matters now: the parts this design uses, the user's own
   * imports, the basics (generic passives and headers, as chips) and the reference ICs.
   */
  type Cat = 'ic' | 'conn' | 'disc' | 'other';
  const CATS: [Cat, string][] = [['ic', 'IC'], ['conn', 'Connector'], ['disc', 'Discrete'], ['other', 'Other']];
  const catOf = (p: PartCard): Cat =>
    p.category === 'ic' ? 'ic' : p.category === 'connector' ? 'conn' : ['resistor', 'capacitor', 'inductor', 'diode', 'led', 'transistor', 'crystal'].includes(p.category) ? 'disc' : 'other';
  let cat = $state<Cat | null>(null);
  const shownCat = (p: PartCard) => !cat || catOf(p) === cat;
  /** Every known part once: the user's library first, then the built-ins, then cards only the design has. */
  const all = $derived.by(() => {
    const seen = new Map<string, PartCard>();
    for (const p of [...ingest.library, ...BUILTIN_PARTS, ...Object.values(app.designParts)]) if (!seen.has(p.id)) seen.set(p.id, p);
    return seen;
  });
  /** Which components of the open design use each part. */
  const usedBy = $derived.by(() => {
    const m = new Map<string, string[]>();
    for (const c of app.k?.summary.components ?? []) m.set(c.part, [...(m.get(c.part) ?? []), c.refdes]);
    return m;
  });
  const inDesign = $derived([...usedBy.keys()].map((id) => all.get(id)).filter((p): p is PartCard => !!p && shownCat(p)).sort((a, b) => (usedBy.get(a.id)![0]!).localeCompare(usedBy.get(b.id)![0]!, 'en', { numeric: true })));
  const mine = $derived(ingest.library.filter(shownCat));
  const basics = $derived(BUILTIN_PARTS.filter((p) => p.id.startsWith('generic:') && shownCat(p)));
  const refICs = $derived(BUILTIN_PARTS.filter((p) => !p.id.startsWith('generic:') && shownCat(p)));
  const results = $derived(q.trim() ? searchParts(q).filter(shownCat) : []);
  const pkgName = (p: PartCard) => packageOf(p)?.name ?? '';
  /** Something to look at: no footprint can be made from the package data. */
  const noFootprint = (p: PartCard) => {
    const pkg = packageOf(p);
    return !pkg || !footprintFor(pkg, p.pins.map((x) => x.number)).ok;
  };
  const chipLabel = (p: PartCard) => p.id.replace(/^generic:/, '').replace(/^CONN_1x(\d+)$/, '1×$1');
  let open = $state<Record<string, boolean>>(loadOpen());
  function loadOpen(): Record<string, boolean> {
    try {
      return { design: true, mine: true, basics: true, ref: false, art: true, ...JSON.parse(localStorage.getItem('tw.parts.open') ?? '{}') };
    } catch {
      return { design: true, mine: true, basics: true, ref: false, art: true };
    }
  }
  function toggle(k: string) {
    open = { ...open, [k]: !open[k] };
    try {
      localStorage.setItem('tw.parts.open', JSON.stringify(open));
    } catch {
      /* a convenience only */
    }
  }
  const select = (p: PartCard) => ((current = p), (mode = 'part'), (editing = null));

  /* the artwork library: saved silkscreen graphics, SVG import and export */
  const arts = $derived(app.artwork.items);
  let artId = $state<string | null>(null);
  const art = $derived(arts.find((a) => a.id === artId) ?? null);
  let artName = $state<string | null>(null);
  let svgPicker: HTMLInputElement | undefined = $state();
  const artPath = (a: Artwork) => a.polys.map((p) => `M${p.slice(0, 2).join(' ')}L${p.slice(2).join(' ')}Z`).join('');
  const artBox = (a: Artwork, m = 0.08) => {
    const pad = Math.max(a.w, a.h) * m + (a.mode === 'outline' ? (a.line ?? 0.2) : 0);
    return `${-a.w / 2 - pad} ${-a.h / 2 - pad} ${a.w + 2 * pad} ${a.h + 2 * pad}`;
  };
  async function importSvg(f: File | undefined | null) {
    if (!f) return;
    try {
      const a = await app.artwork.importSvg(f);
      artId = a.id;
      mode = 'art';
      app.flash(`Imported "${a.name}" (${a.w} × ${a.h} mm)`);
    } catch (e) {
      app.flash((e as Error).message);
    }
    if (svgPicker) svgPicker.value = '';
  }
  function exportSvg(a: Artwork) {
    const url = URL.createObjectURL(new Blob([artworkSvg(a)], { type: 'image/svg+xml' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${a.name.replace(/[^\w.-]+/g, '_')}.svg`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  /* a picture (PNG, JPG …) as black-and-white dots, previewed live, then traced into artwork */
  let imgPicker: HTMLInputElement | undefined = $state();
  /** The picture being turned into dots; `replace`: adjusting that saved artwork. */
  let raster = $state<{ name: string; file: string; img: ImageBitmap; src: string; o: RasterOptions; replace?: string } | null>(null);
  let rasterCanvas: HTMLCanvasElement | undefined = $state();
  let rasterBusy = $state(false);
  const rasterGrid = $derived(raster ? rasterize(raster.img, raster.o) : null);
  $effect(() => {
    const g = rasterGrid;
    const c = rasterCanvas;
    if (!g || !c) return;
    c.width = g.cols;
    c.height = g.rows;
    const ctx = c.getContext('2d')!;
    const im = ctx.createImageData(g.cols, g.rows);
    for (let i = 0; i < g.ink.length; i++) {
      const v = g.ink[i] ? 20 : 235;
      im.data.set([v, v, v, 255], i * 4);
    }
    ctx.putImageData(im, 0, 0);
  });
  async function pickImage(f: File | undefined | null) {
    if (imgPicker) imgPicker.value = '';
    if (!f) return;
    try {
      const img = await createImageBitmap(f);
      raster = { name: f.name.replace(/\.[a-z0-9]+$/i, ''), file: f.name, img, src: keepPicture(img), o: { widthMm: 20, dotMm: 0.2, threshold: 128, invert: false, dither: false } };
      mode = 'raster';
    } catch {
      app.flash('That picture could not be read (PNG, JPG, GIF, WebP or BMP).');
    }
  }
  async function saveRaster() {
    if (!raster || !rasterGrid) return;
    rasterBusy = true;
    try {
      const a = await app.artwork.saveRaster(raster.name.trim() || raster.file, rasterGrid, $state.snapshot(raster.o), raster.file, raster.src, raster.replace);
      raster.img.close();
      raster = null;
      artId = a.id;
      mode = 'art';
      app.flash(`Saved "${a.name}" (${a.w} × ${a.h} mm, ${a.polys.length} shapes)`);
    } catch (e) {
      app.flash((e as Error).message);
    } finally {
      rasterBusy = false;
    }
  }
  /** Reopen a traced picture with its settings; saving replaces the artwork. */
  async function adjustArt(a: Artwork) {
    if (!a.raster) return;
    try {
      const img = await createImageBitmap(await (await fetch(a.raster.src)).blob());
      const { src, ...o } = a.raster;
      raster = { name: a.name, file: a.source ?? a.name, img, src, o, replace: a.id };
      mode = 'raster';
    } catch {
      app.flash('The stored picture could not be read.');
    }
  }
  async function commitArtName() {
    const a = art;
    const name = artName?.trim();
    artName = null;
    if (!a || !name || name === a.name) return;
    try {
      await app.artwork.rename(a.id, name);
    } catch (e) {
      app.flash((e as Error).message);
    }
  }
  async function removeArt(a: Artwork) {
    await app.artwork.remove(a.id);
    artId = null;
    mode = 'part';
    app.flash(`Deleted "${a.name}"; boards that use it keep their copy`);
  }

  /* renaming an imported part: its title or part number changes, its id (what designs refer to) stays */
  let editing = $state<'title' | 'mpn' | null>(null);
  let nameDraft = $state('');
  async function commitName() {
    const field = editing;
    if (!field) return;
    editing = null;
    const lib = ingest.library.find((p) => p.id === part.id);
    const name = nameDraft.trim();
    if (!lib || (field === 'mpn' && (!name || name === lib.mpn)) || (field === 'title' && name === (lib.title ?? partTitle(lib)))) return;
    const label = field === 'title' ? `title of ${lib.mpn ?? lib.id}` : (lib.mpn ?? lib.id);
    // the open design keeps its own copy of the part: change it there too (a commit of its own)
    if (usedBy.has(lib.id) && !(await app.userEdit(`Rename ${label} → ${name || '(none)'}`, [{ op: 'rename_part', part: lib.id, [field]: name }]))) return;
    const next = { ...$state.snapshot(lib) } as PartCard;
    if (field === 'mpn') next.mpn = name;
    else if (name) next.title = name;
    else delete next.title;
    await ingest.update(next);
    app.flash(`Renamed ${label} to ${name || '(description)'}`);
  }

  /* ---- import form ---- */
  let mpn = $state('');
  let url = $state('');
  let notes = $state('');
  let file = $state<File | null>(null);
  let model = $state('sonnet');
  let verify = $state(true);
  /** Footprint or 3D body next to the symbol. */
  let mech = $state<'fp' | '3d'>('fp');
  // switching: 3D starts from the footprint's top-down view and flies into 3D; back, it flies to
  // straight above the footprint's view and the footprint takes over (as in the layout view)
  let fpView: FootprintView | undefined = $state();
  let bodyView: Body3DView | undefined = $state();
  let from2d = $state<TopView | null>(null);
  let show2d = $state(true);
  let switching = false;
  function to3d() {
    if (mech === '3d' || switching) return;
    from2d = fpView?.getView() ?? null;
    show2d = true;
    mech = '3d';
  }
  async function toFootprint() {
    if (mech === 'fp' || switching) return;
    switching = true;
    await bodyView?.flyToTop(fpView?.getView() ?? undefined);
    show2d = true;
    mech = 'fp';
    switching = false;
  }

  /* ---- datasheet pane: the page a value was read from ---- */
  let sheetDoc = $state.raw<Datasheet | null>(null);
  let dsPage = $state(1);
  let dsTerms = $state<string[]>([]);
  let dsLabel = $state('');
  /** The part shown in the detail pane (the one under review, or the selected library part). */
  /** The selected part as the library has it now (the agent may have given it a footprint since). */
  const part = $derived.by(() => {
    const lib = ingest.library.find((p) => p.id === current.id) ?? current;
    // a footprint given in the design (set_footprint), even before it is committed
    const pkg = app.designParts[lib.id]?.packageInfo;
    return pkg?.pads?.length && JSON.stringify(pkg) !== JSON.stringify(lib.packageInfo) ? { ...lib, packageInfo: pkg, package: pkg.name } : lib;
  });
  const shown = $derived(mode === 'import' ? ingest.card : part);
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
  /** The design sections the importer noted, in reading order. */
  const SECTIONS = [
    ['application', 'typical application'],
    ['design', 'design procedure'],
    ['layout', 'layout guidelines'],
  ] as const;
  function showSection(label: string, page: number) {
    dsPage = page;
    dsTerms = [];
    dsLabel = label;
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
  /*
   * A picture of the part from the datasheet (a module's top view): drag a rectangle round it on
   * the datasheet page; it is cropped, stored with the part and shown on its 3D body.
   */
  let picking = $state(false);
  function startPicking() {
    picking = true;
    mech = '3d';
    dsTerms = [];
    dsLabel = 'drag a rectangle round the part in a picture (top view, pin 1 top left if you can)';
  }
  async function takePicture(card: PartCard, page: number, box: [number, number, number, number]) {
    picking = false;
    dsLabel = '';
    if (!sheetDoc) return;
    const { openPdf, cropPage } = await import('../pdf.ts');
    const src = await cropPage(await openPdf(sheetDoc.hash, sheetDoc.data), page, box);
    await setPicture(card, { src, page, rot: 0 });
  }
  async function setPicture(card: PartCard, pic: PartCard['topImage']) {
    const next: PartCard = { ...card, ...(pic ? { topImage: pic } : {}) };
    if (!pic) delete next.topImage;
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
    return { id: 'preview', name: card.id, bbox: { x: -300, y: minY - 300, w: x + 100, h: maxY - minY + 600 }, pages: [], symbols, wires: [], junctions: [], labels: [], noConnects: [] };
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

{#snippet nameField(field: 'title' | 'mpn', value: string, hint: string, cls: string)}
  {#if editing === field}
    <!-- svelte-ignore a11y_autofocus -->
    <input class="text rename {cls}" bind:value={nameDraft} autofocus onblur={() => void commitName()} onkeydown={(e) => (e.key === 'Enter' ? void commitName() : e.key === 'Escape' && (editing = null))} />
  {:else}
    <button class="namebtn {cls}" class:sub2={field === 'mpn'} title={hint} onclick={() => ((nameDraft = field === 'title' ? (part.title ?? partTitle(part)) : (part.mpn ?? '')), (editing = field))}>{value}<span class="pen">✎</span></button>
  {/if}
{/snippet}

{#snippet head(key: string, label: string, n: number)}
  <button class="sec" aria-expanded={!!open[key]} onclick={() => toggle(key)}>
    <span class="caret">{open[key] ? '▾' : '▸'}</span>{label}<span class="muted">{n}</span>
  </button>
{/snippet}

{#snippet row(p: PartCard, refs?: string[])}
  <li>
    <button class="r item" aria-current={mode === 'part' && p.id === current.id} title="{p.description}{pkgName(p) ? ` · ${pkgName(p)}` : ''}" onclick={() => select(p)}>
      <span class="trunc name">{partTitle(p)}</span>
      <span class="pkg mono trunc">{p.mpn ?? p.id.replace(/^[a-z-]+:/, '')}</span>
      <span class="grow"></span>
      {#if noFootprint(p)}<span class="tag warn" title="No footprint can be made from its package data">no footprint</span>{/if}
      {#if refs}<span class="refs mono trunc" title={refs.join(', ')}>{refs.length > 3 ? `${refs.slice(0, 3).join(' ')} +${refs.length - 3}` : refs.join(' ')}</span>{/if}
    </button>
  </li>
{/snippet}

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
  {#if sheetDoc && SECTIONS.some(([k]) => card.datasheetPages?.[k]?.length)}
    <div class="sections">
      <span class="muted">Datasheet</span>
      {#each SECTIONS as [k, label] (k)}
        {@const first = card.datasheetPages?.[k]?.[0]}
        {#if first}<button class="link" onclick={() => showSection(label, first)}>{label} p. {first}</button>{/if}
      {/each}
    </div>
  {/if}
  <div class="grid" class:big={big(card)}>
    <div class="sym"><SchematicCanvas sheet={previewOf(card)} compact /></div>
    {#if card.packageInfo}
      <div class="fp">
        <div class="tabs">
          <button aria-pressed={mech === 'fp'} onclick={toFootprint}>Footprint</button>
          <button aria-pressed={mech === '3d'} onclick={to3d}>3D</button>
          <span class="grow"></span>
          {#if mech === '3d' && sheetDoc && mode === 'part' && userIds.has(card.id) && isModule(card.packageInfo)}
            {#if picking}<button class="link" onclick={() => ((picking = false), (dsLabel = ''))}>cancel</button>
            {:else}<button class="link" title="Take the part's picture from the datasheet for the 3D view" onclick={startPicking}>{card.topImage ? 'other picture' : 'picture from datasheet'}</button>{/if}
            {#if card.topImage && !picking}
              <button class="link" title="Turn the picture a quarter clockwise" onclick={() => setPicture(card, { ...card.topImage!, rot: ((card.topImage!.rot + 90) % 360) as 0 | 90 | 180 | 270 })}>rotate</button>
              <button class="link" onclick={() => setPicture(card, undefined)}>remove picture</button>
            {/if}
          {/if}
          {#if card.packageInfo.page && sheetDoc}<button class="link" onclick={() => showPackage(card)}>drawing p. {card.packageInfo.page}</button>{/if}
        </div>
        <div class="mech">
          <!-- the footprint stays underneath (it frames the switch); 3D lies over it once drawn -->
          <div class="layer" class:hidden={mech === '3d' && !show2d}><FootprintView bind:this={fpView} {card} bind:hover={hoverPin} /></div>
          {#if mech === '3d'}<div class="layer over"><Body3DView bind:this={bodyView} {card} from={from2d} onready={() => (show2d = false)} /></div>{/if}
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
    <div class="ph">
      <b>Library</b><span class="muted">{all.size}</span><span class="grow"></span>
      <button class="btn sm" aria-current={mode === 'import'} title="Import a part from its datasheet" onclick={() => (mode = 'import')}>+ Import</button>
    </div>
    <div class="search">
      <input class="text" placeholder="Search parts…" bind:value={q} />
      <div class="cats">
        {#each CATS as [c, label] (c)}<button class="chip" aria-pressed={cat === c} onclick={() => (cat = cat === c ? null : c)}>{label}</button>{/each}
      </div>
    </div>
    <div class="scroll">
      {#if q.trim()}
        <ul class="rows">
          {#each results as p (p.id)}{@render row(p)}{:else}<li class="none">No part matches “{q}”.</li>{/each}
        </ul>
      {:else}
        {#if inDesign.length}
          {@render head('design', 'In this design', inDesign.length)}
          {#if open.design}<ul class="rows">{#each inDesign as p (p.id)}{@render row(p, usedBy.get(p.id))}{/each}</ul>{/if}
        {/if}
        {@render head('mine', 'My parts', mine.length + (ingest.phase === 'running' || ingest.phase === 'review' ? 1 : 0))}
        {#if open.mine}
          <ul class="rows">
            {#if ingest.phase === 'running' || ingest.phase === 'review'}
              <li>
                <button class="r item" aria-current={mode === 'import'} onclick={() => (mode = 'import')}>
                  <span class="mono grow trunc">{ingest.request?.mpn ?? 'Import'}</span>
                  <span class="tag" class:info={ingest.phase === 'running'} class:warn={ingest.phase === 'review'}>{ingest.phase === 'running' ? 'importing' : 'review'}</span>
                </button>
              </li>
            {/if}
            {#each mine as p (p.id)}{@render row(p)}{/each}
            {#if !mine.length && ingest.phase !== 'running' && ingest.phase !== 'review'}<li class="none">Parts you import from datasheets appear here.</li>{/if}
          </ul>
        {/if}
        {#if basics.length}
          {@render head('basics', 'Basics', basics.length)}
          {#if open.basics}
            <div class="chips">
              {#each basics as p (p.id)}
                <button class="chip mono" aria-pressed={mode === 'part' && current.id === p.id} title={p.description} onclick={() => select(p)}>{chipLabel(p)}</button>
              {/each}
            </div>
          {/if}
        {/if}
        {#if refICs.length}
          {@render head('ref', 'Reference ICs', refICs.length)}
          {#if open.ref}<ul class="rows">{#each refICs as p (p.id)}{@render row(p)}{/each}</ul>{/if}
        {/if}
        <div class="sechead">
          {@render head('art', 'Artwork', arts.length)}
          <button class="link imp-svg" title="Import a logo or clipart from an SVG file" onclick={() => svgPicker?.click()}>+ SVG</button>
          <button class="link imp-svg" title="A picture (PNG, JPG …) as black-and-white dots" onclick={() => imgPicker?.click()}>+ Image</button>
        </div>
        <input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/bmp" hidden bind:this={imgPicker} onchange={(e) => void pickImage((e.currentTarget as HTMLInputElement).files?.[0])} />
        <input type="file" accept=".svg,image/svg+xml" hidden bind:this={svgPicker} onchange={(e) => void importSvg((e.currentTarget as HTMLInputElement).files?.[0])} />
        {#if open.art}
          <ul class="rows">
            {#each arts as a (a.id)}
              <li>
                <button class="r item" aria-current={mode === 'art' && artId === a.id} title="{a.name} · {a.w} × {a.h} mm" onclick={() => ((artId = a.id), (mode = 'art'), (artName = null))}>
                  <svg class="thumb" viewBox={artBox(a)} aria-hidden="true">
                    <path d={artPath(a)} fill-rule="evenodd" class={a.mode} stroke-width={a.mode === 'outline' ? Math.max(a.line ?? 0.2, Math.max(a.w, a.h) / 25) : undefined} />
                  </svg>
                  <span class="trunc name">{a.name}</span>
                  <span class="pkg mono">{a.w}×{a.h}</span>
                </button>
              </li>
            {:else}
              <li class="none">Logos and clipart for the silkscreen and the enclosure: saved by the agent, or imported from an SVG or a picture.</li>
            {/each}
          </ul>
        {/if}
      {/if}
    </div>
  </div>

  <div class="pane detail">
    {#if mode === 'raster' && raster}
      <div class="ph">
        <b>Picture to silkscreen</b><span class="muted">{raster.file}</span><span class="grow"></span>
        <button class="btn" onclick={() => { const back = raster?.replace; raster?.img.close(); raster = null; if (back) { artId = back; mode = 'art'; } else mode = 'part'; }}>Cancel</button>
        <button class="btn pri" disabled={rasterBusy} onclick={() => void saveRaster()}>{raster.replace ? 'Update artwork' : 'Save to artwork'}</button>
      </div>
      <div class="scroll body">
        <div class="rasterctl">
          <label>Name <input class="text" bind:value={raster.name} /></label>
          <label>Width <input class="text mono num" type="number" min="2" max="200" step="1" bind:value={raster.o.widthMm} /> mm</label>
          <label>Dot <input class="text mono num" type="number" min="0.1" max="1" step="0.05" bind:value={raster.o.dotMm} /> mm</label>
          <label class="wide" title={raster.o.dither ? 'Darker or lighter (128 = as it is)' : 'How dark a dot must be to become ink'}>{raster.o.dither ? 'Darkness' : 'Threshold'} <input type="range" min="1" max="254" bind:value={raster.o.threshold} /> <span class="mono">{raster.o.threshold}</span></label>
          <label class="check"><input type="checkbox" bind:checked={raster.o.invert} /> Invert</label>
          <label class="check"><input type="checkbox" bind:checked={raster.o.dither} /> Dither (photos)</label>
        </div>
        {#if rasterGrid}
          <p class="desc">{rasterGrid.cols} × {rasterGrid.rows} dots · {Math.round(raster.o.widthMm * 10) / 10} × {Math.round(rasterGrid.rows * raster.o.dotMm * 10) / 10} mm{raster.o.dotMm < 0.15 ? ' · dots under 0.15 mm may not print' : ''}</p>
        {/if}
        <div class="artview raster"><canvas bind:this={rasterCanvas}></canvas></div>
        <p class="hint">Dark parts become ink. Logos and line art look best without dithering; for photos, turn dithering on and use dots of 0.2 mm or more. The result is saved as artwork; ask the agent to place it.</p>
      </div>
    {:else if mode === 'art' && art}
      <div class="ph">
        {#if artName !== null}
          <!-- svelte-ignore a11y_autofocus -->
          <input class="text rename" bind:value={artName} autofocus onblur={() => void commitArtName()} onkeydown={(e) => (e.key === 'Enter' ? void commitArtName() : e.key === 'Escape' && (artName = null))} />
        {:else}
          <button class="namebtn" title="Rename" onclick={() => (artName = art.name)}>{art.name}<span class="pen">✎</span></button>
        {/if}
        <span class="muted mono">artwork</span>
        <span class="grow"></span>
        {#if art.raster}<button class="btn" title="Change dithering, threshold, size … of the picture" onclick={() => void adjustArt(art)}>Adjust…</button>{/if}
        <button class="btn" onclick={() => exportSvg(art)}>Export SVG</button>
        <button class="btn" onclick={() => void removeArt(art)}>Delete</button>
      </div>
      <div class="scroll body">
        <p class="desc">{art.w} × {art.h} mm · {art.mode === 'fill' ? 'filled' : `outlines ${art.line} mm`} · {art.polys.length} figure{art.polys.length === 1 ? '' : 's'}{art.source ? ` · from ${art.source}` : ''}</p>
        <div class="artview">
          <svg viewBox={artBox(art, 0.12)} role="img" aria-label={art.name}>
            <path d={artPath(art)} fill-rule="evenodd" class={art.mode} stroke-width={art.mode === 'outline' ? (art.line ?? 0.2) : undefined} />
          </svg>
        </div>
        <p class="hint">Ask the agent to place it, e.g. “put {art.name} at the top right, 10 mm wide”. Boards keep their own copy, so changing or deleting it here does not change them.</p>
      </div>
    {:else if mode === 'part'}
      <div class="ph">
        {#if userIds.has(part.id)}
          {@render nameField('title', partTitle(part), 'The name people know it by (shown in the parts list)', '')}
          {@render nameField('mpn', part.mpn ?? part.id, 'The part number (ordering code) on the symbol and in the BOM', 'mono')}
          <span class="muted mono idtag" title="The part id designs refer to; it stays">{part.id}</span>
        {:else}
          <b>{partTitle(part)}</b>
          <span class="mono muted">{part.mpn ?? part.id}</span>
        {/if}
        {#if part.package}<span class="tag">{part.package}</span>{/if}
        <span class="tag warn" title={part.provenance.note}>{part.provenance.source}{#if part.provenance.page}&nbsp;p.{part.provenance.page}{/if}</span>
        <span class="grow"></span>
        {#if part.datasheet}<a class="muted" href={part.datasheet} target="_blank" rel="noreferrer">datasheet ↗</a>{/if}
        {#if userIds.has(part.id)}<button class="btn" onclick={() => remove(part)}>Remove</button>{/if}
      </div>
      <div class="scroll body">{@render detail(part)}</div>
    {:else if ingest.phase === 'review' && ingest.card}
      {@const card = ingest.card}
      <div class="ph">
        <b>Review import</b>
        <span class="mono">{card.id}</span>
        <span class="tag">{card.package}</span>
        <span class="tag">{card.pins.length} pins</span>
        <span class="grow"></span>
        {#if ingest.tokens}<span class="usage" title={USAGE_TITLE}>{usageLine(ingest.tokens, ingest.costUsd ?? tokenCost(ingest.tokens, ''), ingest.costUsd !== null)}</span>
        {:else if ingest.costUsd !== null}<span class="muted">${ingest.costUsd.toFixed(2)}</span>{/if}
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
          {#if ingest.tokens}<p class="usage" title={USAGE_TITLE}>{usageLine(ingest.tokens, tokenCost(ingest.tokens, ''))}</p>{/if}
          <ol class="log">
            {#each ingest.log as l, i (i)}<li class:last={i === ingest.log.length - 1}>{l}</li>{/each}
          </ol>
          {@render issueList(ingest.lastIssues)}
          {#if ingest.reply}<p class="reply">{ingest.reply}</p>{/if}
        {:else}
          {#if !ingest.available}
            <p class="notice">The import runs on your local Claude Code. Start the local server and connect it in <button class="link" onclick={() => (app.view = 'set')}>Settings</button> first.</p>
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
      <DatasheetView sheet={sheetDoc} bind:page={dsPage} terms={dsTerms} label={dsLabel} onpick={picking && shown ? (page, box) => takePicture(shown, page, box) : undefined} />
    </div>
  {/if}
</div>

<style>
  .parts { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 1px; background: var(--line); height: 100%; min-height: 0; }
  .parts.withds { grid-template-columns: 240px minmax(0, 1fr) minmax(320px, 40%); }
  .dspane { min-height: 0; }
  .sections { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; margin: 0 0 8px; }
  .tools { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; font-size: 12px; flex-wrap: wrap; }
  .seg, .tabs { display: inline-flex; gap: 0; }
  .seg button, .tabs button { border: 1px solid var(--line-2); background: var(--panel); padding: 2px 10px; font-size: 12px; color: var(--txt-2); cursor: pointer; }
  .seg button:first-child, .tabs button:first-child { border-radius: 6px 0 0 6px; }
  .seg button:last-child, .tabs button:nth-child(2) { border-radius: 0 6px 6px 0; border-left: 0; }
  .seg button[aria-pressed="true"], .tabs button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent-txt); }
  .tabs { display: flex; align-items: center; padding: 4px 6px; border-bottom: 1px solid var(--line); }
  .fp { display: flex; flex-direction: column; }
  .mech { flex: 1; min-height: 0; position: relative; }
  .layer { position: absolute; inset: 0; display: flex; flex-direction: column; }
  .layer > :global(*) { flex: 1; min-height: 0; }
  .layer.hidden { visibility: hidden; }
  .layer.over { z-index: 1; }
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
  .btn.sm { padding: 2px 8px; font-size: 12px; }
  .sechead { display: flex; align-items: center; }
  .sechead > :global(.sec) { flex: 1; }
  .link.imp-svg { margin-right: 10px; font-size: 11px; }
  .thumb { width: 18px; height: 18px; flex: none; }
  .thumb path, .artview path { fill: var(--txt); }
  .thumb path.outline, .artview path.outline { fill: none; stroke: var(--txt); stroke-linejoin: round; }
  .artview { height: min(56vh, 480px); background: var(--canvas); border: 1px solid var(--line); border-radius: 8px; display: grid; padding: 16px; margin-bottom: 10px; }
  .artview svg { width: 100%; height: 100%; }
  .artview.raster { position: relative; }
  .artview.raster canvas { position: absolute; inset: 16px; width: calc(100% - 32px); height: calc(100% - 32px); object-fit: contain; image-rendering: pixelated; }
  .rasterctl { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; margin-bottom: 8px; font-size: 12px; }
  .rasterctl label { display: inline-flex; align-items: center; gap: 6px; }
  .rasterctl .num { width: 64px; }
  .rasterctl .wide input { width: 140px; }
  .namebtn { border: 1px solid transparent; background: none; padding: 1px 4px; border-radius: 5px; font-weight: 700; color: var(--txt); cursor: text; display: inline-flex; gap: 6px; align-items: center; }
  .namebtn:hover { border-color: var(--line-2); }
  .namebtn .pen { font-weight: 400; color: var(--txt-3); opacity: 0; font-size: 11px; }
  .namebtn:hover .pen { opacity: 1; }
  .rename { font-weight: 700; padding: 1px 4px; min-width: 200px; }
  .namebtn.sub2 { font-weight: 400; color: var(--txt-2); }
  .idtag { font-size: 11px; }
  .btn.sm[aria-current="true"] { border-color: var(--accent); color: var(--accent-txt); }
  .cats, .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .cats { margin-top: 6px; }
  .chips { padding: 2px 10px 8px; }
  .chip { border: 1px solid var(--line-2); background: var(--panel); color: var(--txt-2); border-radius: 999px; padding: 1px 8px; font-size: 11px; cursor: pointer; }
  .chip[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent-txt); border-color: var(--accent); }
  .sec { display: flex; align-items: center; gap: 6px; width: 100%; border: 0; background: transparent; padding: 8px 10px 3px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--txt-3); cursor: pointer; text-align: left; }
  .sec .muted { font-weight: 400; }
  .caret { width: 10px; }
  .none { padding: 4px 10px 8px; font-size: 12px; color: var(--txt-3); }
  .item { width: 100%; border: 0; background: transparent; text-align: left; padding: 3px 8px 3px 26px; display: flex; align-items: center; gap: 8px; min-width: 0; }
  .item .name { flex: none; max-width: 60%; }
  .pkg { font-size: 11px; color: var(--txt-3); min-width: 0; }
  .refs { font-size: 11px; color: var(--accent-txt); flex: none; max-width: 40%; }
  .item[aria-current="true"] { background: var(--accent-soft); }
  .sub { display: block; font-size: 11px; color: var(--txt-3); max-width: 170px; }
  .body { padding: 10px 14px; }
  .desc { margin: 0 0 10px; color: var(--txt-2); }
  .usage { font-family: var(--mono); font-size: 11px; color: var(--txt-3); margin: -6px 0 10px; }
  .ph .usage { margin: 0; }
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
