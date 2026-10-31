<script lang="ts">
  import { PAGE, type LabelView, type PageView, type PaperId, type PinView, type Prim, type Rect, type SheetView, type SymbolView } from '@4k7/schema';

  interface Props {
    sheet: SheetView | undefined;
    /** For the title block of each page. */
    designName?: string;
    /** Pages in the whole design (the "of N" in the title block); defaults to this sheet's count. */
    pageCount?: number;
    /** The paper the pages are cut for (default A4). */
    paper?: PaperId;
    /** componentId → overlay kind for pending changes */
    overlays?: Record<string, 'add' | 'change'>;
    hot?: string | null;
    showDiff?: boolean;
    selection?: string[];
    /** The selected net (id): its wires and labels are highlighted. */
    selectedNet?: string | null;
    onselect?: (refdes: string, additive: boolean) => void;
    /** A click on a wire or a net label. */
    onselectnet?: (netId: string) => void;
    onclear?: () => void;
    /** Optimize: the area the agent is working in, drawn as a frame. */
    scopeRect?: Rect | null;
    compact?: boolean;
    /**
     * Hand editing: drag a symbol or a part's name or value, swing a net label, R / F to turn or mirror the
     * selected symbol, Delete to take a picked wire or label (or the selected parts) away. Each gesture is one of the
     * agent's ops, issued by the app as the user's edit; the callbacks say whether it went through.
     */
    editable?: boolean;
    /** A symbol dragged: its centre's new page (as the design counts them) and place, in mils from the paper's top-left. */
    onmovesymbol?: (ref: string, spot: Spot) => Promise<boolean>;
    /** A part's name or value dragged (with Shift both): where it goes, in mils from the top-left of the paper the part stands on. */
    onmovetext?: (ref: string, at: { name?: { x: number; y: number }; value?: { x: number; y: number } }) => Promise<boolean>;
    /** R or F on the selected symbol, which stays where it is. */
    onturnsymbol?: (ref: string, spot: Spot, look: { orient?: 'upright' | 'lying'; mirror?: boolean; rotate?: 0 | 90 | 180 | 270 }) => Promise<boolean>;
    /** A net label swung round its pin: the pin ("U1.3"), the net's name and the way it points. */
    onlabeldir?: (pin: string, net: string, dir: Dir) => Promise<boolean>;
    /** Delete on a picked wire or label: the point on it that names it. */
    onerase?: (what: 'wire' | 'label', net: string, at: Spot) => Promise<boolean>;
    /** Delete on selected parts. */
    onremove?: (refs: string[]) => Promise<boolean>;
    /** A word to the user (a key that does nothing here). */
    onnote?: (msg: string) => void;
  }

  type Dir = 'left' | 'right' | 'up' | 'down';
  type Spot = { page: number; x: number; y: number };

  let { sheet, designName, pageCount, paper = 'A4', overlays = {}, hot = null, showDiff = true, selection = [], selectedNet = null, onselect, onselectnet, onclear, scopeRect = null, compact = false, editable = false, onmovesymbol, onmovetext, onturnsymbol, onlabeldir, onerase, onremove, onnote }: Props = $props();

  /** The layout's grid, in mils: a dragged symbol moves in whole steps of it (keep in sync with GRID in @4k7/parts). */
  const GRID = 100;
  /** A dragged name or value moves in whole steps of this, finer than the wires' grid so it fits between them. */
  const TEXT_STEP = 25;
  const canEdit = $derived(editable && !compact);

  /** Length of a supply symbol's stem, in mils (keep in sync with labelRect in the kernel). */
  const RAIL_STEM = 200;

  let svg: SVGSVGElement | undefined = $state();
  let vb = $state({ x: 0, y: 0, w: 1000, h: 1000 });
  let fittedFor = '';
  let zoomPct = $state(100);

  function fit() {
    if (!sheet) return;
    const b = sheet.bbox;
    vb = { x: b.x, y: b.y, w: Math.max(b.w, 2000), h: Math.max(b.h, 1400) };
    if (b.w < 2000) vb.x = b.x - (2000 - b.w) / 2;
    if (b.h < 1400) vb.y = b.y - (1400 - b.h) / 2;
    updateZoom();
  }

  /** Follow the design as it grows until the user pans or zooms; switching sheets always refits. */
  let userMoved = false;
  let lastSheet = '';
  $effect(() => {
    const key = sheet ? `${sheet.id}:${sheet.bbox.x},${sheet.bbox.y},${sheet.bbox.w},${sheet.bbox.h}` : '';
    if (sheet && sheet.id !== lastSheet) {
      lastSheet = sheet.id;
      userMoved = false;
    }
    if (key !== fittedFor && !userMoved) {
      fittedFor = key;
      fit();
    }
  });

  /** The area on screen, in sheet coordinates (the view box is fitted into the element, so one side shows more). */
  export function getVisibleRect(): Rect | null {
    const r = svg?.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return null;
    const aspect = r.width / r.height;
    const w = aspect > vb.w / vb.h ? vb.h * aspect : vb.w;
    const h = aspect > vb.w / vb.h ? vb.h : vb.w / aspect;
    return { x: Math.round(vb.x + vb.w / 2 - w / 2), y: Math.round(vb.y + vb.h / 2 - h / 2), w: Math.round(w), h: Math.round(h) };
  }

  function updateZoom() {
    if (!svg || !sheet) return;
    const r = svg.getBoundingClientRect();
    const scale = Math.min(r.width / vb.w, r.height / vb.h);
    zoomPct = Math.round(scale * 1000); // 100% = 1 px per mil × 10
  }

  function toSvg(e: { clientX: number; clientY: number }) {
    const m = svg!.getScreenCTM()!.inverse();
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m);
    return { x: p.x, y: p.y };
  }

  function onwheel(e: WheelEvent) {
    e.preventDefault();
    const p = toSvg(e);
    const f = Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 60) * 0.004);
    const w = Math.min(Math.max(vb.w * f, 300), 200000);
    const k = w / vb.w;
    vb = { x: p.x - (p.x - vb.x) * k, y: p.y - (p.y - vb.y) * k, w, h: vb.h * k };
    userMoved = true;
    updateZoom();
  }

  /** `ref`: the part under the pointer when the press began (once captured, events target the canvas itself). */
  let drag: { x: number; y: number; vx: number; vy: number; moved: boolean; ref: string | null; net: string | null; wire: number | null; at: { x: number; y: number } } | null = null;

  /* ---- hand editing: a press on a symbol, its text or a net label is an edit gesture, not a pan ---- */
  type TextPick = 'name' | 'value' | 'both';
  type Edit =
    | { kind: 'symbol'; ref: string; unit: string | undefined; sx: number; sy: number; cx: number; cy: number; dx: number; dy: number; moved: boolean }
    | { kind: 'text'; ref: string; unit: string | undefined; which: TextPick; sx: number; sy: number; cx: number; cy: number; dx: number; dy: number; moved: boolean }
    | { kind: 'label'; i: number; cx: number; cy: number; dir: Dir; moved: boolean };
  let edit = $state<Edit | null>(null);
  /** A symbol just dropped is shown there until the sheet arrives in which it has moved (the edit takes a moment). */
  let dropped = $state<{ ref: string; unit: string | undefined; x0: number; y0: number; dx: number; dy: number } | null>(null);
  /** A part's text just dropped, likewise, until the sheet arrives in which it stands somewhere else. */
  let droppedText = $state<{ ref: string; unit: string | undefined; which: TextPick; at: string; dx: number; dy: number } | null>(null);
  let droppedTimer: ReturnType<typeof setTimeout> | undefined;
  /** The wire or net label the last click picked: what Delete takes away. Cleared when the sheet changes (a wire's place is only good for the sheet it was picked on). */
  let picked = $state<{ kind: 'wire'; pts: number[]; at: { x: number; y: number }; net: string; name: string } | { kind: 'label'; x: number; y: number; net: string; name: string } | null>(null);

  const sameSym = (s: SymbolView, ref: string, unit: string | undefined) => s.refdes === ref && (s.unit ?? undefined) === unit;
  const dragged = (s: SymbolView) => (edit?.kind === 'symbol' && sameSym(s, edit.ref, edit.unit) ? edit : null);
  const droppedAt = (s: SymbolView) => (dropped && sameSym(s, dropped.ref, dropped.unit) && s.bbox.x === dropped.x0 && s.bbox.y === dropped.y0 ? dropped : null);
  /** Where a symbol is drawn: moved by the drag, or by the drop until the sheet shows it there. */
  const shift = (s: SymbolView) => dragged(s) ?? droppedAt(s);
  const textPlace = (s: SymbolView) => `${s.refPos.x},${s.refPos.y},${s.valuePos.x},${s.valuePos.y}`;
  const textDroppedAt = (s: SymbolView) => (droppedText && sameSym(s, droppedText.ref, droppedText.unit) && textPlace(s) === droppedText.at ? droppedText : null);
  /** How far a part's name or value is drawn from where it stands: moved by the drag, or by the drop until the sheet shows it there. */
  function textShift(s: SymbolView, which: 'name' | 'value') {
    const by = edit?.kind === 'text' && sameSym(s, edit.ref, edit.unit) ? edit : textDroppedAt(s);
    return by && (by.which === 'both' || by.which === which) ? by : null;
  }
  $effect(() => {
    void sheet;
    picked = null;
    if (dropped && !sheet?.symbols.some((s) => droppedAt(s))) dropped = null;
    if (droppedText && !sheet?.symbols.some((s) => textDroppedAt(s))) droppedText = null;
  });
  $effect(() => {
    if (picked && selectedNet !== picked.net) picked = null;
  });

  /** The page a point is on, else the nearest. */
  function pageAtPoint(x: number, y: number): PageView | undefined {
    const gap = (p: PageView) => Math.max(p.rect.x - x, 0, x - p.rect.x - p.rect.w) + Math.max(p.rect.y - y, 0, y - p.rect.y - p.rect.h);
    return sheet?.pages.reduce<PageView | undefined>((best, p) => (!best || gap(p) < gap(best) ? p : best), undefined);
  }
  /** A sheet point as a spot on its page, kept inside the page's drawing area if asked. */
  function spotAt(x: number, y: number, keepInside = false): Spot | null {
    const pg = pageAtPoint(x, y);
    if (!pg) return null;
    const m = PAGE.margin;
    const px = x - pg.rect.x;
    const py = y - pg.rect.y;
    return keepInside
      ? { page: pg.number, x: Math.min(Math.max(px, m), pg.rect.w - m), y: Math.min(Math.max(py, m), pg.rect.h - m - PAGE.title) }
      : { page: pg.number, x: px, y: py };
  }
  const centreOf = (s: SymbolView) => ({ x: s.bbox.x + s.bbox.w / 2, y: s.bbox.y + s.bbox.h / 2 });

  /** The pin a net label sits on: at its point, or at the far end of the short lead it stands on. */
  function pinOfLabel(l: LabelView): { ref: string; side: PinView['side']; x: number; y: number } | null {
    const at = (x: number, y: number) => {
      for (const s of sheet?.symbols ?? []) for (const p of s.pins) if (p.x === x && p.y === y) return { ref: `${s.refdes}.${p.number}`, side: p.side, x, y };
      return null;
    };
    const here = at(l.x, l.y);
    if (here) return here;
    for (const w of sheet?.wires ?? []) {
      if (w.pts.length !== 4) continue;
      const [x1, y1, x2, y2] = w.pts as [number, number, number, number];
      const far = x1 === l.x && y1 === l.y ? at(x2, y2) : x2 === l.x && y2 === l.y ? at(x1, y1) : null;
      if (far) return far;
    }
    return null;
  }
  const OUT: Record<PinView['side'], Dir> = { left: 'left', right: 'right', top: 'up', bottom: 'down' };
  const BACK: Record<Dir, Dir> = { left: 'right', right: 'left', up: 'down', down: 'up' };
  /** A net label that can be swung round its pin (not a supply symbol, nor one of the kernel's own, nor a name on a wire). */
  const swingable = (l: LabelView) => l.kind === 'net' && !l.auto && l.dir !== 'on' && !!pinOfLabel(l);
  /** The label as it is drawn while swung: at its pin, pointing where the pointer is. */
  function swung(l: LabelView, i: number): LabelView {
    if (edit?.kind !== 'label' || edit.i !== i || !edit.moved) return l;
    const pin = pinOfLabel(l);
    return pin ? { ...l, x: pin.x, y: pin.y, dir: edit.dir } : l;
  }

  /** The middle of the segment of a wire nearest to a point: a spot that names the wire (a wire runs between two joints). */
  function midOfNearest(pts: number[], p: { x: number; y: number }): { x: number; y: number } {
    let best = { x: pts[0]!, y: pts[1]!, d: Infinity };
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const [x1, y1, x2, y2] = [pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!];
      const len2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
      const t = len2 ? Math.min(1, Math.max(0, ((p.x - x1) * (x2 - x1) + (p.y - y1) * (y2 - y1)) / len2)) : 0;
      const d = Math.hypot(p.x - (x1 + t * (x2 - x1)), p.y - (y1 + t * (y2 - y1)));
      if (d < best.d) best = { x: (x1 + x2) / 2, y: (y1 + y2) / 2, d };
    }
    return { x: best.x, y: best.y };
  }
  const netName = (id: string) => sheet?.labels.find((l) => l.netId === id)?.text ?? '';

  /** A click on a wire or label picks it (Delete takes it away); its net is selected with it. Clicking it again lets go. */
  function pick(p: NonNullable<typeof picked>) {
    const same =
      picked?.kind === 'wire' && p.kind === 'wire'
        ? picked.pts.join() === p.pts.join() && picked.at.x === p.at.x && picked.at.y === p.at.y
        : picked?.kind === 'label' && p.kind === 'label' && picked.x === p.x && picked.y === p.y;
    if (same) {
      picked = null;
      onselectnet?.(p.net);
      return;
    }
    picked = p;
    if (selectedNet !== p.net) onselectnet?.(p.net);
  }

  function onpointerdown(e: PointerEvent) {
    if (e.button !== 0 && e.button !== 1) return;
    // the keys (R, F, Delete) go to the canvas once it is clicked
    if (e.button === 0 && canEdit) svg?.focus({ preventScroll: true });
    const t = e.target as Element;
    const symEl = t.closest('[data-ref]');
    const ref = symEl?.getAttribute('data-ref') ?? null;
    const net = t.closest('[data-net]')?.getAttribute('data-net') ?? null;
    const labelAt = t.closest('[data-label]')?.getAttribute('data-label');
    const wireAt = t.closest('[data-wire]')?.getAttribute('data-wire');
    const textAt = t.closest('[data-text]')?.getAttribute('data-text') as 'name' | 'value' | null | undefined;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (e.button === 0 && canEdit && ref) {
      const p = toSvg(e);
      if (textAt) {
        edit = { kind: 'text', ref, unit: symEl?.getAttribute('data-unit') ?? undefined, which: e.shiftKey ? 'both' : textAt, sx: p.x, sy: p.y, cx: e.clientX, cy: e.clientY, dx: 0, dy: 0, moved: false };
        return;
      }
      edit = { kind: 'symbol', ref, unit: symEl?.getAttribute('data-unit') ?? undefined, sx: p.x, sy: p.y, cx: e.clientX, cy: e.clientY, dx: 0, dy: 0, moved: false };
      return;
    }
    const li = labelAt != null ? Number(labelAt) : -1;
    const lbl = li >= 0 ? sheet?.labels[li] : undefined;
    if (e.button === 0 && canEdit && lbl && swingable(lbl)) {
      edit = { kind: 'label', i: li, cx: e.clientX, cy: e.clientY, dir: lbl.dir as Dir, moved: false };
      return;
    }
    drag = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y, moved: false, ref, net, wire: wireAt != null ? Number(wireAt) : null, at: toSvg(e) };
  }
  function onpointermove(e: PointerEvent) {
    if (edit) {
      if (Math.abs(e.clientX - edit.cx) + Math.abs(e.clientY - edit.cy) > 3) edit.moved = true;
      if (edit.kind === 'symbol' || edit.kind === 'text') {
        const p = toSvg(e);
        const step = edit.kind === 'text' ? TEXT_STEP : GRID;
        edit.dx = Math.round((p.x - edit.sx) / step) * step;
        edit.dy = Math.round((p.y - edit.sy) / step) * step;
      } else {
        // the label points where the pointer is, seen from its pin (never back into the part)
        const l = sheet?.labels[edit.i];
        const pin = l && pinOfLabel(l);
        if (pin) {
          const p = toSvg(e);
          const ex = p.x - pin.x;
          const ey = p.y - pin.y;
          if (Math.hypot(ex, ey) > 120) {
            const dir: Dir = Math.abs(ex) > Math.abs(ey) ? (ex > 0 ? 'right' : 'left') : ey > 0 ? 'down' : 'up';
            if (dir !== BACK[OUT[pin.side]]) edit.dir = dir;
          }
        }
      }
      return;
    }
    if (!drag || !svg) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = userMoved = true;
    const r = svg.getBoundingClientRect();
    const s = Math.max(vb.w / r.width, vb.h / r.height);
    vb = { ...vb, x: drag.vx - dx * s, y: drag.vy - dy * s };
  }
  function onpointerup(e: PointerEvent) {
    if (edit) {
      const d = edit;
      edit = null;
      if (d.kind === 'text') {
        const s = sheet?.symbols.find((x) => sameSym(x, d.ref, d.unit));
        if (!s) return;
        if (!d.moved || (d.dx === 0 && d.dy === 0)) {
          picked = null;
          onselect?.(d.ref, e.shiftKey || e.metaKey || e.ctrlKey);
          return;
        }
        // it stays inside the frame of the page its part stands on
        const c = centreOf(s);
        const pg = pageAtPoint(c.x, c.y);
        if (!pg) return;
        const m = PAGE.margin;
        const spot = (p: SymbolView['refPos'], lines: string[]) => {
          const b = textBox(p, lines);
          const [px, py] = [p.x - pg.rect.x, p.y - pg.rect.y];
          return { x: px + Math.min(Math.max(d.dx, pg.rect.x + m - b.x), pg.rect.x + pg.rect.w - m - b.x - b.width), y: py + Math.min(Math.max(d.dy, pg.rect.y + m - b.y), pg.rect.y + pg.rect.h - m - PAGE.title - b.y - b.height) };
        };
        droppedText = { ref: d.ref, unit: d.unit, which: d.which, at: textPlace(s), dx: d.dx, dy: d.dy };
        clearTimeout(droppedTimer);
        droppedTimer = setTimeout(() => (droppedText = dropped = null), 5000);
        // refused: it goes back at once
        void Promise.resolve(onmovetext?.(`${s.refdes}${s.unit ?? ''}`, { ...(d.which !== 'value' ? { name: spot(s.refPos, [`${s.refdes}${s.unit ?? ''}`]) } : {}), ...(d.which !== 'name' ? { value: spot(s.valuePos, s.valueLines ?? [s.value]) } : {}) })).then((went) => {
          if (!went) droppedText = null;
        });
      } else if (d.kind === 'symbol') {
        const s = sheet?.symbols.find((x) => sameSym(x, d.ref, d.unit));
        if (!s) return;
        if (!d.moved || (d.dx === 0 && d.dy === 0)) {
          picked = null;
          onselect?.(d.ref, e.shiftKey || e.metaKey || e.ctrlKey);
          return;
        }
        const c = centreOf(s);
        const spot = spotAt(c.x + d.dx, c.y + d.dy, true);
        if (!spot) return;
        dropped = { ref: d.ref, unit: d.unit, x0: s.bbox.x, y0: s.bbox.y, dx: d.dx, dy: d.dy };
        clearTimeout(droppedTimer);
        droppedTimer = setTimeout(() => (droppedText = dropped = null), 5000);
        if (!(selection.length === 1 && selection[0] === d.ref)) onselect?.(d.ref, false);
        // refused: it goes back at once
        void Promise.resolve(onmovesymbol?.(`${s.refdes}${s.unit ?? ''}`, spot)).then((went) => {
          if (!went) dropped = null;
        });
      } else {
        const l = sheet?.labels[d.i];
        const pin = l && pinOfLabel(l);
        if (!l || !pin) return;
        if (!d.moved || d.dir === l.dir) pick({ kind: 'label', x: l.x, y: l.y, net: l.netId, name: l.text });
        else void onlabeldir?.(pin.ref, l.text, d.dir);
      }
      return;
    }
    if (drag && !drag.moved) {
      const w = drag.wire != null ? sheet?.wires[drag.wire] : undefined;
      if (drag.ref) {
        picked = null;
        onselect?.(drag.ref, e.shiftKey || e.metaKey || e.ctrlKey);
      } else if (w && canEdit) pick({ kind: 'wire', pts: [...w.pts], at: midOfNearest(w.pts, drag.at), net: w.netId, name: netName(w.netId) });
      else if (drag.net && onselectnet) onselectnet(drag.net);
      else onclear?.();
    }
    drag = null;
  }

  function onkeydown(e: KeyboardEvent) {
    if (!canEdit || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    const k = e.key;
    if (k === 'Delete' || k === 'Backspace') {
      if (picked) {
        e.preventDefault();
        const p = picked;
        const at = p.kind === 'wire' ? spotAt(p.at.x, p.at.y) : spotAt(p.x, p.y);
        if (at) void onerase?.(p.kind, p.name, at);
        return;
      }
      const refs = selection.filter((r) => sheet?.symbols.some((s) => s.refdes === r));
      if (refs.length) {
        e.preventDefault();
        void onremove?.(refs);
      }
      return;
    }
    const turn = k === 'r' || k === 'R';
    const mirror = k === 'f' || k === 'F';
    if (!turn && !mirror) return;
    const refs = selection.filter((r) => sheet?.symbols.some((s) => s.refdes === r));
    if (refs.length !== 1) return;
    const s = sheet!.symbols.find((x) => x.refdes === refs[0])!;
    e.preventDefault();
    const c = centreOf(s);
    const spot = spotAt(c.x, c.y);
    if (!spot) return;
    // a two-pin part stands or lies and keeps which end is which, so turning it twice gives back what was there; the others go round by quarters
    const look = !turn ? { mirror: !s.mirrored } : s.twoPin ? { orient: s.rotation ? ('upright' as const) : ('lying' as const), mirror: !!s.mirrored } : { rotate: (((s.rotated ?? 0) + 90) % 360) as 0 | 90 | 180 | 270 };
    void onturnsymbol?.(`${s.refdes}${s.unit ?? ''}`, spot, look);
  }

  /** What takes a press on a part's text, between the letters too (keep in sync with textRect in the kernel). */
  function textBox(p: SymbolView['refPos'], lines: string[]) {
    const width = Math.max(...lines.map((l) => l.length)) * 50 + 20;
    return { x: p.anchor === 'end' ? p.x - width : p.anchor === 'middle' ? p.x - width / 2 : p.x, y: p.y - 80, width, height: 100 + 85 * (lines.length - 1) };
  }

  const pad = 70;
  /** Highlight frame: rotated symbols get a frame that follows their body. */
  const box = (s: SymbolView) =>
    s.rotation && s.origin
      ? { x: s.origin.x - 150, y: s.origin.y - 250, w: 300, h: 500, transform: `rotate(${s.rotation} ${s.origin.x} ${s.origin.y})` }
      : { x: s.bbox.x - pad, y: s.bbox.y - pad, w: s.bbox.w + 2 * pad, h: s.bbox.h + 2 * pad, transform: undefined };

  /**
   * Tag outline as [along, across] pairs, `along` counted from the wire. A signal into the part
   * (the default) gives a tag pointing at the pin, one out of the part points away from it and a
   * bidirectional one points both ways.
   */
  function outline(l: LabelView, len: number, h: number): [number, number][] {
    const t = 40;
    if (l.flow === 'out') return [[0, -h], [len - t, -h], [len, 0], [len - t, h], [0, h]];
    if (l.flow === 'io') return [[0, 0], [t, -h], [len - t, -h], [len, 0], [len - t, h], [t, h]];
    return [[0, 0], [t, -h], [len, -h], [len, h], [t, h]];
  }
  /** Outline of a signal tag, drawn along the lead: sideways for left/right, and for up/down the same tag turned by 90°. */
  function flag(l: LabelView): string {
    const len = l.text.length * 50 + 110;
    const pts = outline(l, len, 45);
    if (l.dir === 'up' || l.dir === 'down') {
      const s = l.dir === 'up' ? -1 : 1;
      return pts.map(([a, b]) => `${l.x + b},${l.y + s * a}`).join(' ');
    }
    const s = l.dir === 'left' ? -1 : 1;
    return pts.map(([a, b]) => `${l.x + s * a},${l.y + b}`).join(' ');
  }
  /** When the drawing was made, for the title block ("2026-10-09 22:54"). */
  const stamp = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  const date = `${stamp.getFullYear()}-${two(stamp.getMonth() + 1)}-${two(stamp.getDate())} ${two(stamp.getHours())}:${two(stamp.getMinutes())}`;
  /** The small cells of the title block, left to right, ending at the frame's right edge `right`. */
  function cells(right: number): { x: number; label: string; text: (p: PageView) => string }[] {
    const total = pageCount ?? sheet?.pages.length ?? 1;
    const defs = [
      { w: 2800, label: 'DESIGN / SHEET', text: () => [designName, sheet?.name].filter(Boolean).join(' / ') },
      { w: 2000, label: 'DATE', text: () => date },
      { w: 1000, label: 'PAGE', text: (p: PageView) => `${p.number}/${total}` },
    ];
    let x = right;
    return defs.reverse().map((d) => ({ x: (x -= d.w), label: d.label, text: d.text })).reverse();
  }
  /** The name inside the tag, from `gap` mils off the pin. Vertical tags read bottom to top. */
  function nameAt(l: LabelView): { transform: string; anchor: 'start' | 'end' } {
    const gap = l.flow === 'out' ? 30 : 60;
    if (l.dir === 'up') return { transform: `translate(${l.x} ${l.y - gap}) rotate(-90)`, anchor: 'start' };
    if (l.dir === 'down') return { transform: `translate(${l.x} ${l.y + gap}) rotate(-90)`, anchor: 'end' };
    const s = l.dir === 'left' ? -1 : 1;
    return { transform: `translate(${l.x + s * gap} ${l.y})`, anchor: l.dir === 'left' ? 'end' : 'start' };
  }
</script>

<!-- an interactive canvas: pointer and keyboard (R = turn, F = mirror, Delete) are the point -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<svg
  bind:this={svg}
  class="sch"
  class:compact
  viewBox="{vb.x} {vb.y} {vb.w} {vb.h}"
  data-bbox={sheet ? `${sheet.bbox.x},${sheet.bbox.y},${sheet.bbox.w},${sheet.bbox.h}` : undefined}
  preserveAspectRatio="xMidYMid meet"
  class:editable={canEdit}
  role="application"
  aria-label="Schematic"
  tabindex={canEdit ? 0 : undefined}
  {onwheel}
  {onpointerdown}
  {onpointermove}
  {onpointerup}
  {onkeydown}
>
  {#if sheet}
    <!-- pages: the paper, its frame and a title block (what is on the page, sheet, page n of N) -->
    {#each sheet.pages as p (p.number)}
      {@const m = PAGE.margin}
      {@const ty = p.rect.y + p.rect.h - m - PAGE.title}
      <g class="page">
        <rect class="paper" x={p.rect.x} y={p.rect.y} width={p.rect.w} height={p.rect.h} />
        <rect class="frame" x={p.rect.x + m} y={p.rect.y + m} width={p.rect.w - 2 * m} height={p.rect.h - 2 * m} />
        <line class="frame" x1={p.rect.x + m} y1={ty} x2={p.rect.x + p.rect.w - m} y2={ty} />
        <!-- title block: the title large, then design / sheet, date and page number in small cells -->
        {#each cells(p.rect.x + p.rect.w - m) as c, i (i)}
          <line class="frame" x1={c.x} y1={ty} x2={c.x} y2={ty + PAGE.title} />
          <text class="tb-label" x={c.x + 100} y={ty + 140}>{c.label}</text>
          <text class="tb-val" x={c.x + 100} y={ty + 380}>{c.text(p)}</text>
        {/each}
        <text class="tb-label" x={p.rect.x + m + 100} y={ty + 140}>TITLE</text>
        <text class="title" x={p.rect.x + m + 100} y={ty + 380}>{p.name}</text>
        {#if p.oversized}<text class="tb-label" x={p.rect.x + m + 900} y={ty + 140}>LARGER THAN {paper}, PRINTS SCALED</text>{/if}
      </g>
    {/each}

    <!-- functional blocks: a light frame with the block's title, behind the circuit -->
    {#each sheet.blocks ?? [] as b, i (i)}
      <g class="blk">
        <rect x={b.rect.x} y={b.rect.y} width={b.rect.w} height={b.rect.h} rx="40" />
        <text x={b.rect.x + 80} y={b.rect.y + 150}>{b.title.toUpperCase()}</text>
      </g>
    {/each}

    <!-- wires -->
    {#each sheet.wires as w, i (i)}
      <!-- (a wide invisible stroke makes the thin wire easy to click) -->
      <g class="net" class:hl={w.netId === selectedNet} data-net={w.netId} data-wire={i}>
        {#if onselectnet}<polyline class="wire-hit" points={w.pts.join(',')} />{/if}
        <polyline class="wire" points={w.pts.join(',')} />
      </g>
    {/each}
    {#each sheet.junctions as j, i (i)}
      <circle class="junction" cx={j.x} cy={j.y} r="24" />
    {/each}

    <!-- labels -->
    {#each sheet.labels as l0, i (i)}
      {@const l = swung(l0, i)}
      <g class="net" class:hl={l.netId === selectedNet} class:swing={canEdit && swingable(l0)} data-net={l.netId} data-label={i}>
      {#if l.kind === 'ground' || l.kind === 'rail'}
        <!-- supplies are always vertical; on a horizontal lead a stub comes first -->
        {@const sx = l.x + (l.stub === 'left' ? -1 : l.stub === 'right' ? 1 : 0) * (l.stubLen ?? 100)}
        {@const s = l.dir === 'up' ? -1 : 1}
        <!-- (rise: a longer stem, clearing symbols of neighbouring pins that point the other way) -->
        {@const r = l.rise ?? 0}
        {@const stem = RAIL_STEM + r}
        <g class="pwr">
          {#if sx !== l.x}<line x1={l.x} y1={l.y} x2={sx} y2={l.y} />{/if}
          {#if l.kind === 'ground'}
            <line x1={sx} y1={l.y} x2={sx} y2={l.y + s * (r + 80)} />
            <line x1={sx - 70} y1={l.y + s * (r + 80)} x2={sx + 70} y2={l.y + s * (r + 80)} />
            <line x1={sx - 45} y1={l.y + s * (r + 115)} x2={sx + 45} y2={l.y + s * (r + 115)} />
            <line x1={sx - 20} y1={l.y + s * (r + 150)} x2={sx + 20} y2={l.y + s * (r + 150)} />
          {:else}
            <!-- supply rail: a long stem ending in an arrow pointing away from the circuit -->
            <line x1={sx} y1={l.y} x2={sx} y2={l.y + s * stem} />
            <polygon class="arrow" points="{sx},{l.y + s * (stem + 70)} {sx - 45},{l.y + s * stem} {sx + 45},{l.y + s * stem}" />
            <text class="rail-t" x={sx} y={s < 0 ? l.y - stem - 100 : l.y + stem + 160} text-anchor="middle">{l.text}</text>
          {/if}
        </g>
      {:else if l.dir === 'on'}
        <text class="net-t" x={l.x} y={l.y - 30} text-anchor="middle">{l.text}</text>
      {:else}
        {@const n = nameAt(l)}
        <polygon class="flag" points={flag(l)} />
        <text class="net-t" transform={n.transform} y="25" text-anchor={n.anchor}>{l.text}</text>
      {/if}
      </g>
    {/each}

    {#each sheet.noConnects as p, i (i)}
      <g class="nc"><line x1={p.x - 40} y1={p.y - 40} x2={p.x + 40} y2={p.y + 40} /><line x1={p.x - 40} y1={p.y + 40} x2={p.x + 40} y2={p.y - 40} /></g>
    {/each}

    <!-- symbols -->
    {#each sheet.symbols as s (s.componentId + (s.unit ?? ""))}
      {@const sh = shift(s)}
      {@const nameBy = textShift(s, 'name')}
      {@const valueBy = textShift(s, 'value')}
      <g class="sym" class:dragging={!!dragged(s)} data-ref={s.refdes} data-unit={s.unit} transform={sh ? `translate(${sh.dx} ${sh.dy})` : undefined}>
        <rect class="hit" x={s.bbox.x} y={s.bbox.y} width={s.bbox.w} height={s.bbox.h} />
        <g transform={s.rotation && s.origin ? `rotate(${s.rotation} ${s.origin.x} ${s.origin.y})` : undefined}>
        {#each s.prims as p, i (i)}
          {@const q = p as Prim}
          {#if q.t === 'rect'}
            <rect class:filled={q.fill} x={q.x} y={q.y} width={q.w} height={q.h} />
          {:else if q.t === 'line'}
            <line x1={q.x1} y1={q.y1} x2={q.x2} y2={q.y2} />
          {:else if q.t === 'poly'}
            {#if q.closed}<polygon class:filled={q.fill} points={q.pts.join(',')} />{:else}<polyline points={q.pts.join(',')} />{/if}
          {:else if q.t === 'path'}
            <path d={q.d} />
          {:else if q.t === 'circle'}
            <circle class:filled={q.fill} cx={q.x} cy={q.y} r={q.r} />
          {:else if q.t === 'text'}
            <text class="sym-t" x={q.x} y={q.y} text-anchor="middle">{q.text}</text>
          {/if}
        {/each}
        </g>
        {#each s.pins as p (p.number)}
          <!-- a turned box has its side pins' close pitch on top and at the bottom: their text runs along them -->
          {@const along = (s.rotated === 90 || s.rotated === 270) && (p.side === 'top' || p.side === 'bottom')}
          {@const inward = p.side === 'top' ? 1 : -1}
          {#if p.showName}
            {#if along}<text class="pin-n" transform="rotate(-90 {p.x + 25} {p.y + inward * 230})" x={p.x + 25} y={p.y + inward * 230} text-anchor={p.side === 'top' ? 'end' : 'start'}>{p.name}</text>
            {:else if p.side === 'left'}<text class="pin-n" x={p.x + 230} y={p.y + 25}>{p.name}</text>
            {:else if p.side === 'right'}<text class="pin-n" x={p.x - 230} y={p.y + 25} text-anchor="end">{p.name}</text>
            {:else if p.side === 'top'}<text class="pin-n" x={p.x} y={p.y + 300} text-anchor="middle">{p.name}</text>
            {:else}<text class="pin-n" x={p.x} y={p.y - 250} text-anchor="middle">{p.name}</text>{/if}
          {/if}
          {#if p.showNumber}
            {#if along}<text class="pin-no" transform="rotate(-90 {p.x - 22} {p.y + inward * 100})" x={p.x - 22} y={p.y + inward * 100} text-anchor="middle">{p.number}</text>
            {:else if p.side === 'left'}<text class="pin-no" x={p.x + 100} y={p.y - 22} text-anchor="middle">{p.number}</text>
            {:else if p.side === 'right'}<text class="pin-no" x={p.x - 100} y={p.y - 22} text-anchor="middle">{p.number}</text>
            {:else if p.side === 'top'}<text class="pin-no" x={p.x + 22} y={p.y + 110}>{p.number}</text>
            {:else}<text class="pin-no" x={p.x + 22} y={p.y - 70}>{p.number}</text>{/if}
          {/if}
        {/each}
        <g data-text="name" class:moving={!!nameBy} transform={nameBy ? `translate(${nameBy.dx} ${nameBy.dy})` : undefined}>
          {#if canEdit}<rect class="text-hit" {...textBox(s.refPos, [`${s.refdes}${s.unit ?? ''}`])} />{/if}
          <text class="ref" x={s.refPos.x} y={s.refPos.y} text-anchor={s.refPos.anchor}>{s.refdes}{s.unit ?? ''}</text>
        </g>
        <g data-text="value" class:moving={!!valueBy} transform={valueBy ? `translate(${valueBy.dx} ${valueBy.dy})` : undefined}>
          {#if canEdit}<rect class="text-hit" {...textBox(s.valuePos, s.valueLines ?? [s.value])} />{/if}
          <text class="val" x={s.valuePos.x} y={s.valuePos.y} text-anchor={s.valuePos.anchor}>
            {#each s.valueLines ?? [s.value] as line, li (li)}<tspan x={s.valuePos.x} dy={li === 0 ? 0 : 85}>{line}</tspan>{/each}
          </text>
        </g>
      </g>
    {/each}

    <!-- overlays -->
    {#if showDiff}
      {#each sheet.symbols as s (s.componentId + (s.unit ?? ""))}
        {#if overlays[s.componentId]}
          {@const b = box(s)}
          <rect class="ov {overlays[s.componentId]}" class:hot={hot === s.componentId} x={b.x} y={b.y} width={b.w} height={b.h} rx="40" transform={b.transform} />
        {/if}
      {/each}
    {/if}
    {#each sheet.symbols as s (s.componentId + (s.unit ?? ""))}
      {#if selection.includes(s.refdes)}
        {@const b = box(s)}
        <rect class="selbox" x={b.x - 20} y={b.y - 20} width={b.w + 40} height={b.h + 40} rx="50" transform={b.transform} />
      {/if}
    {/each}
    {#if picked?.kind === 'wire'}
      <polyline class="picked" points={picked.pts.join(',')} />
    {:else if picked?.kind === 'label'}
      <circle class="picked" cx={picked.x} cy={picked.y} r="110" />
    {/if}
    {#if scopeRect}
      <rect class="scope" x={scopeRect.x} y={scopeRect.y} width={scopeRect.w} height={scopeRect.h} />
    {/if}
  {/if}
</svg>
{#if !compact}
  <div class="zoom mono">{zoomPct}% <button class="ib" onclick={() => { userMoved = false; fit(); }} title="Fit to view">⤢</button></div>
{/if}

<style>
  .sch { position: absolute; inset: 0; width: 100%; height: 100%; cursor: default; touch-action: none; -webkit-user-select: none; user-select: none; }
  .sch.compact { position: static; height: 100%; }
  /* the keys go to the canvas once it is clicked; the selection frames already show where they act */
  .sch:focus { outline: none; }
  .page .paper { fill: var(--paper); stroke: var(--grid); stroke-width: 12; }
  .page .frame { fill: none; stroke: var(--grid); stroke-width: 10; }
  .page .title { fill: var(--sch-txt); font-size: 170px; }
  .page .tb-label { fill: var(--pin-txt); font-size: 80px; letter-spacing: 8px; }
  .page .tb-val { fill: var(--pin-txt); font-size: 140px; }
  .blk rect { fill: none; stroke: var(--pin-txt); stroke-opacity: 0.55; stroke-width: 12; stroke-dasharray: 60 40; }
  .blk text { fill: var(--pin-txt); font-size: 100px; font-weight: 600; letter-spacing: 6px; }
  .wire { stroke: var(--wire); stroke-width: 14; fill: none; stroke-linecap: round; stroke-linejoin: round; }
  .wire-hit { stroke: transparent; stroke-width: 70; fill: none; pointer-events: stroke; cursor: pointer; }
  .net:hover .wire { stroke-width: 20; }
  /* the selected net: wires, supply symbols and labels in the accent colour */
  .net.hl .wire, .net.hl line { stroke: var(--accent); stroke-width: 22; }
  .net.hl .arrow { fill: var(--accent); stroke: var(--accent); }
  .net.hl .flag { stroke: var(--accent); }
  .net.hl text { fill: var(--accent); }
  .junction { fill: var(--wire); }
  .sym :global(line), .sym :global(path), .sym :global(polyline) { stroke: var(--sym); stroke-width: 12; fill: none; stroke-linecap: round; stroke-linejoin: round; }
  .sym rect, .sym polygon, .sym circle { stroke: var(--sym); stroke-width: 12; fill: none; }
  .sym .filled { fill: var(--sym-fill); }
  .sym polygon.filled { fill: var(--sym); }
  .sym .hit { fill: transparent; stroke: none; cursor: pointer; }
  .editable .sym .hit { cursor: grab; }
  .sym .text-hit { fill: transparent; stroke: none; }
  .editable .sym .text-hit { cursor: grab; }
  .sym .moving { opacity: 0.85; }
  .sym.dragging { opacity: 0.85; }
  .editable .sym.dragging .hit { cursor: grabbing; fill: rgba(111, 181, 255, 0.18); }
  .editable .net.swing { cursor: grab; }
  .picked { fill: none; stroke: var(--accent); stroke-width: 34; stroke-opacity: .55; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
  /* hover highlights the part itself: brighter, slightly bolder, a soft glow */
  .sym:hover { filter: drop-shadow(0 0 20px var(--sym-glow)); }
  .sym:hover :global(line), .sym:hover :global(path), .sym:hover :global(polyline),
  .sym:hover rect:not(.hit):not(.text-hit), .sym:hover polygon, .sym:hover circle { stroke: var(--sym-hover); stroke-width: 16; }
  .sym:hover .filled { fill: var(--sym-fill-hover); }
  .sym:hover polygon.filled { fill: var(--sym-hover); }
  .sym:hover .ref, .sym:hover .val, .sym:hover .sym-t { fill: var(--sym-hover); }
  text { font-family: var(--mono); }
  .ref { fill: var(--sym); font-size: 88px; font-weight: 700; }
  .sym-t { fill: var(--sym); font-size: 64px; }
  .val { fill: var(--sch-txt); font-size: 80px; }
  .pin-n { fill: var(--sch-txt); font-size: 70px; }
  .pin-no { fill: var(--pin-txt); font-size: 52px; }
  .pwr line { stroke: var(--wire); stroke-width: 14; stroke-linecap: round; }
  .pwr .arrow { fill: var(--wire); stroke: var(--wire); stroke-width: 8; stroke-linejoin: round; }
  .rail-t { fill: var(--wire); font-size: 78px; font-weight: 700; }
  .net-t { fill: var(--wire); font-size: 72px; font-weight: 600; }
  .flag { fill: var(--canvas); stroke: var(--wire); stroke-width: 10; }
  .nc line { stroke: var(--err); stroke-width: 12; }
  .ov { stroke-width: 14; stroke-dasharray: 60 36; transition: fill-opacity .15s, stroke-width .15s; pointer-events: none; }
  .ov.add { fill: var(--ok); fill-opacity: .08; stroke: var(--ok); }
  .ov.change { fill: var(--warn); fill-opacity: .1; stroke: var(--warn); }
  .ov.hot { fill-opacity: .25; stroke-width: 26; }
  .scope { fill: none; stroke: var(--accent); stroke-width: 24; stroke-dasharray: 120 70; pointer-events: none; }
  .selbox { fill: var(--accent); fill-opacity: .06; stroke: var(--accent); stroke-width: 16; stroke-dasharray: 50 30; pointer-events: none; }
  .zoom { position: absolute; right: 8px; bottom: 26px; font-size: 11px; color: var(--txt-3); display: flex; align-items: center; gap: 2px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 0 2px 0 8px; z-index: 2; }
</style>
