/**
 * The design kernel: committed design + agent working copy (draft), transactions,
 * proposals (changesets), history. Synchronous and deterministic; the web app runs it
 * in a Web Worker. M0 is TypeScript; the Rust/WASM kernel will implement this same API.
 */
import {
  QueryOp,
  Transaction,
  emptyDesign,
  type Design,
  type DesignSummary,
  type Diagnostic,
  type DiagnosticCounts,
  type HistoryEntry,
  type Proposal,
  type Rejection,
  type OptimizeScope,
  type SchematicView,
  type ScopeInfo,
  type ScopeOutcome,
  type TransactionResult,
  type BoardView,
  type DescriptionView,
  type SheetView,
  type StoredCopper,
  type SchematicRule,
  PAGE,
  boardSummary,
  resolveChecks,
  type CheckSettings,
  DEFAULT_BOARD,
  fabPresets,
  fabSummary,
  trackWidthFor,
  viaCurrentFor,
  viasForCurrent,
  enclosureGraphicsInfo,
  boardStackup,
} from '@4k7/schema';
import { packageChoice, packageOptions, searchParts } from '@4k7/parts';
import { applyOp, describeConstraint, descriptionView } from './apply.ts';
import { countDiagnostics, diagKey, runChecks, sortDiagnostics } from './checks.ts';
import { computeHunks, mergeHunks } from './diff.ts';
import { RejectError, applyWaivers, cardOf, clone, componentsSorted, findComponent, findNet, gcNets, gcParts, isGroundNet, isPowerNet, natCmp, netMembers, paramsOf, valueOf } from './doc.ts';
import { schematicView, syncDrawing } from './drawing.ts';
import { blockAssignment } from './layout.ts';
import { copperKey, layoutBoard, placeBoard, planePlan } from './board.ts';
import type { RouteProgress } from './router.ts';
import { DRAWING_OPS, HELPER_TX_MS, annotateChecks, followParts, movesParts, placementOf, type HelperHooks } from './copperops.ts';
import { canonicalJson, migrate } from './canonical.ts';
import { MIN_FREE, circuitSignature, guardOp, measure, positions, resolveScope, ripple, widenScope, type ResolvedScope } from './scope.ts';
import { schematicChecks } from './schcheck.ts';
import { tryPlacements } from './trial.ts';
import { suggestMoves } from './suggest.ts';
import { impedanceText, resolveRule } from './lines.ts';
import { lineBoard } from './lineops.ts';

interface Analysis {
  view: SchematicView;
  diagnostics: Diagnostic[];
}

export interface KernelState {
  /** The design the UI shows: the draft while a proposal is pending, else committed. */
  view: SchematicView;
  diagnostics: Diagnostic[];
  counts: DiagnosticCounts;
  proposal: Proposal | null;
  ledger: { id: string; text: string; strength: 'hard' | 'soft'; quote?: string; status: string }[];
  history: HistoryEntry[];
  canUndo: boolean;
  canRedo: boolean;
  /** The commit redo would re-apply, or null. (The one undo would take back is `history[0]`.) */
  nextRedo: HistoryEntry | null;
  summary: DesignSummary;
  /** The design description (describe), or null while none is written. */
  description: DescriptionView | null;
}

export class Kernel {
  private committed: Design;
  private draft: Design;
  private cache = new WeakMap<Design, Analysis>();
  private boards = new WeakMap<Design, BoardView>();
  /** Bumped whenever the working copy changes (not by copper kept as a cache): what the route helper's results are for. */
  private rev = 0;
  private undoStack: { design: Design; entry: HistoryEntry }[] = [];
  /** Commits taken back by undo, newest last; any new commit clears it. */
  private redoStack: { design: Design; entry: HistoryEntry }[] = [];
  private history: HistoryEntry[] = [];
  private historySeq = 1;
  private pendingSummaries: string[] = [];
  /** The Optimize area while the agent works on it, with the state it started from. */
  private scoped: { sc: ResolvedScope; sheet: SheetView; pos: Map<string, readonly number[]>; circuit: string } | null = null;
  /** The SCH checks with the levels they run at (setChecks); the shipped levels until the user changes them. */
  private rules: Record<string, SchematicRule> = resolveChecks();

  constructor(design?: Design) {
    this.committed = design ? migrate(clone(design)) : emptyDesign();
    syncDrawing(this.committed);
    this.draft = clone(this.committed);
  }

  /* ------------------------------ analysis -------------------------------- */

  private analyse(d: Design): Analysis {
    let a = this.cache.get(d);
    if (!a) {
      const view = schematicView(d);
      const sch = schematicChecks(d, view, this.rules);
      applyWaivers(d, sch);
      a = { view, diagnostics: sortDiagnostics([...runChecks(d, view.constraintStatus, view.constraintWhy), ...sch]) };
      this.cache.set(d, a);
    }
    return a;
  }

  /** The user's levels and limits for the SCH checks (null = the shipped ones). Every analysis is redone. */
  setChecks(checks: CheckSettings | null): void {
    this.rules = resolveChecks(checks);
    this.cache = new WeakMap();
  }

  private invalidate(d: Design) {
    this.cache.delete(d);
    this.boards.delete(d);
  }

  /** The working copy as a design (for the board worker, which computes the board separately). */
  draftDesign(): Design {
    return clone(this.draft);
  }

  /** The working copy and its revision, together (for the route helper's worker: see HelperHooks.rev). */
  draftSnapshot(): { design: Design; rev: number } {
    return { design: clone(this.draft), rev: this.rev };
  }

  /** Placement only (fast): parts, outline, ratsnest and placement checks. */
  boardPlacement(): BoardView {
    return placeBoard(this.draft, this.analyse(this.draft).view);
  }

  /** The board of the working copy: placement, routing and DRC (computed on demand, cached). `follow` follows the routing, if it routes (see layoutBoard). */
  board(follow: { onProgress?: (p: RouteProgress) => void; onBest?: (c: StoredCopper) => void } = {}): BoardView {
    const d = this.draft;
    let b = this.boards.get(d);
    if (!b) {
      b = layoutBoard(d, this.analyse(d).view, follow);
      this.boards.set(d, b);
    }
    return b;
  }

  /**
   * Keep copper routed elsewhere (the board worker) with the designs it was routed for: the
   * working copy, and the committed design if its board is the same. A cache, not a change.
   * Returns whether the committed design took it (then it should be saved).
   */
  keepCopper(copper: StoredCopper): boolean {
    let committed = false;
    for (const d of this.draft === this.committed ? [this.draft] : [this.draft, this.committed]) {
      if (!d.board || copperKey(d, this.analyse(d).view) !== copper.key) continue;
      d.board.copper = copper;
      this.boards.delete(d);
      if (d === this.committed) committed = true;
    }
    return committed;
  }

  /* ---------------------------- transactions ------------------------------ */

  /**
   * Validate and apply a transaction to the working copy (or dry-run it). `by`: who asked for it,
   * the agent unless the app says the user. `helper`: the route helper's results computed elsewhere
   * (a worker), or hooks to follow it while it routes here (drawn copper, see copperops.ts).
   */
  transact(input: unknown, by: 'user' | 'agent' = 'agent', helper?: HelperHooks): TransactionResult {
    const parsed = Transaction.safeParse(input);
    if (!parsed.success) {
      return this.rejected({ opIndex: indexOfIssue(parsed.error.issues), code: 'INVALID_OP', message: formatZod(parsed.error.issues) }, false);
    }
    const tx = parsed.data;
    if (helper?.rev !== undefined && helper.rev !== this.rev) {
      return this.rejected({ opIndex: 0, code: 'STALE', message: 'The design changed while the route helper searched; search again on it as it is now.' }, !!tx.dry_run);
    }
    const before = this.analyse(this.draft).diagnostics;
    const work = clone(this.draft);
    const results = [];
    // drawn copper: what each op drew, edited or moved, checked once the transaction is applied
    const drawn = new Map<number, string[]>();
    const deadline = Date.now() + HELPER_TX_MS;
    // the placement after the last op that may move parts (copper ops in between do not move any)
    let placedNow: BoardView | null = null;
    for (let i = 0; i < tx.ops.length; i++) {
      const op = tx.ops[i]!;
      try {
        if (this.scoped) guardOp(work, op, this.scoped.sc);
        // (drawn copper follows the parts an op moves)
        const placed = work.board?.drawn && movesParts(op) ? (placedNow ?? placementOf(work)) : null;
        if (!work.board?.drawn) placedNow = null;
        const r = applyOp(work, op, by, { index: i, deadline, ...(helper ? { helper } : {}) });
        if (placed) {
          placedNow = placementOf(work);
          const f = followParts(work, placed, placedNow);
          if (f) {
            if (f.note) r.effect += `; ${f.note}`;
            drawn.set(i, f.ids);
          }
        } else if (work.board?.drawn && DRAWING_OPS.has(op.op)) drawn.set(i, (r.ids ?? []).filter((id) => /^[tv]\d+$/.test(id)));
        results.push(r);
      } catch (e) {
        if (e instanceof RejectError) return this.rejected({ opIndex: i, ...e.rejection }, !!tx.dry_run);
        throw e;
      }
    }
    gcNets(work);
    gcParts(work);
    syncDrawing(work);
    if (drawn.size) annotateChecks(work, results, drawn);
    if (this.scoped && circuitSignature(work) !== this.scoped.circuit) {
      return this.rejected({ opIndex: tx.ops.length - 1, code: 'OUT_OF_SCOPE', message: 'This would change the circuit (parts, values or connections). Optimize only changes how an area is drawn.' }, !!tx.dry_run);
    }
    const analysed = this.analyse(work);
    const after = analysed.diagnostics;
    if (!tx.dry_run) {
      this.draft = work;
      this.rev++;
      this.pendingSummaries.push(tx.summary);
    }
    const beforeKeys = new Set(before.filter((x) => !x.waivedBy).map(diagKey));
    const afterKeys = new Set(after.filter((x) => !x.waivedBy).map(diagKey));
    const diff = this.diffSummary(work);
    return {
      status: 'ok',
      dryRun: !!tx.dry_run,
      results,
      diff,
      counts: countDiagnostics(after),
      introduced: after.filter((x) => !x.waivedBy && !beforeKeys.has(diagKey(x))),
      resolved: before.filter((x) => !x.waivedBy && !afterKeys.has(diagKey(x))),
      ...(this.scoped ? { scope: this.scopeOutcome(analysed.view) } : {}),
    };
  }

  /* ---------------------------- optimize scope ---------------------------- */

  /**
   * Restrict the agent to an area (Optimize) until `setScope(null)`: edits that move parts outside
   * it, or change the circuit, are refused, and every result reports ripple and measures.
   */
  setScope(scope: OptimizeScope | null): ScopeInfo | { error: string } | null {
    if (!scope) {
      this.scoped = null;
      return null;
    }
    const view = this.analyse(this.draft).view;
    let sc = resolveScope(this.draft, view, scope);
    if ('error' in sc) return sc;
    if (sc.free.size < MIN_FREE) {
      // zoomed onto a wire or a label: work on the parts the view is about
      const wide = widenScope(this.draft, view, scope);
      const again = wide ? resolveScope(this.draft, view, wide) : null;
      if (!again || 'error' in again || again.free.size < MIN_FREE) {
        return { error: 'There are no parts or connections in this view to optimize. Move the view over some parts.' };
      }
      again.info.widened = { asked: scope.rect };
      sc = again;
    }
    const sheet = view.sheets.find((x) => x.id === sc.scope.sheet)!;
    this.scoped = { sc, sheet, pos: positions(sheet), circuit: circuitSignature(this.draft) };
    return sc.info;
  }

  private scopeOutcome(view: SchematicView): ScopeOutcome {
    const s = this.scoped!;
    const sheet = view.sheets.find((x) => x.id === s.sc.scope.sheet);
    return {
      ripple: sheet ? ripple(s.sheet, s.pos, sheet, s.sc) : [],
      measures: sheet ? measure(sheet, s.sc.nets) : s.sc.info.measures,
      baseline: s.sc.info.measures,
    };
  }

  private rejected(r: Rejection, dryRun: boolean): TransactionResult {
    return {
      status: 'rejected',
      dryRun,
      results: [],
      rejection: r,
      diff: this.diffSummary(this.draft),
      counts: countDiagnostics(this.analyse(this.draft).diagnostics),
      introduced: [],
      resolved: [],
    };
  }

  private diffSummary(d: Design) {
    const hunks = computeHunks(this.committed, d);
    const pick = (c: string) => hunks.filter((h) => h.change === c).map((h) => h.title);
    return { added: pick('add'), removed: pick('remove'), changed: pick('change') };
  }

  /* ------------------------------ proposals ------------------------------- */

  hasPending(): boolean {
    return computeHunks(this.committed, this.draft).length > 0;
  }

  proposal(): Proposal | null {
    const hunks = computeHunks(this.committed, this.draft);
    if (!hunks.length) return null;
    return {
      hunks,
      before: countDiagnostics(this.analyse(this.committed).diagnostics),
      after: countDiagnostics(this.analyse(this.draft).diagnostics),
    };
  }

  /** Commit the pending changes. `hunkIds` selects a subset; omitted = all. */
  accept(hunkIds?: string[], by: 'user' | 'agent' = 'agent', summary?: string): { entry: HistoryEntry | null; notes: string[] } {
    const hunks = computeHunks(this.committed, this.draft);
    if (!hunks.length) return { entry: null, notes: [] };
    const ids = new Set(hunkIds ?? hunks.map((h) => h.id));
    const selected = hunks.filter((h) => ids.has(h.id));
    let next: Design;
    let notes: string[] = [];
    if (selected.length === hunks.length) {
      next = clone(this.draft);
    } else {
      ({ design: next, notes } = mergeHunks(this.committed, this.draft, ids));
      syncDrawing(next);
    }
    const entry: HistoryEntry = {
      id: this.historySeq++,
      summary: summary ?? (this.pendingSummaries.join('; ') || 'Edit'),
      by,
      time: new Date().toISOString(),
      hunks: selected.length,
    };
    this.undoStack.push({ design: this.committed, entry });
    this.redoStack = [];
    this.history.push(entry);
    this.committed = next;
    this.draft = clone(next);
    this.rev++;
    this.pendingSummaries = [];
    return { entry, notes };
  }

  reject(): void {
    this.draft = clone(this.committed);
    this.rev++;
    this.pendingSummaries = [];
  }

  undo(): HistoryEntry | null {
    const last = this.undoStack.pop();
    if (!last) return null;
    this.redoStack.push({ design: this.committed, entry: last.entry });
    this.committed = last.design;
    this.draft = clone(last.design);
    this.rev++;
    this.pendingSummaries = [];
    this.history = this.history.filter((h) => h.id !== last.entry.id);
    return last.entry;
  }

  redo(): HistoryEntry | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push({ design: this.committed, entry: next.entry });
    this.committed = next.design;
    this.draft = clone(next.design);
    this.rev++;
    this.pendingSummaries = [];
    this.history.push(next.entry);
    return next.entry;
  }

  /* -------------------------------- queries ------------------------------- */

  query(input: unknown): unknown {
    const parsed = QueryOp.safeParse(input);
    if (!parsed.success) return { error: formatZod(parsed.error.issues) };
    const q = parsed.data;
    const d = this.draft;
    switch (q.op) {
      case 'get_summary':
        return this.summary(d);
      case 'find': {
        const t = (q.text ?? '').toLowerCase();
        const comps = componentsSorted(d)
          .filter((c) => {
            const card = cardOf(d, c.part);
            if (q.category && card?.category !== q.category) return false;
            if (!t) return true;
            return [c.refdes, c.part, valueOf(d, c), ...Object.values(c.pins).map((n) => d.nets[n]?.name ?? '')]
              .some((s) => s.toLowerCase().includes(t));
          })
          .map((c) => ({ refdes: c.refdes, part: c.part, value: valueOf(d, c) }));
        const nets = Object.values(d.nets)
          .filter((n) => !t || n.name.toLowerCase().includes(t))
          .map((n) => n.name)
          .sort(natCmp);
        return { components: comps, nets };
      }
      case 'get_component': {
        const c = findComponent(d, q.ref);
        if (!c) return { error: `No component ${q.ref}` };
        const card = cardOf(d, c.part);
        return {
          refdes: c.refdes,
          part: c.part,
          description: card?.description,
          category: card?.category,
          params: c.params,
          /** The board side it is mounted on (a layer constraint; top unless told otherwise). */
          side: Object.values(d.ledger).some((k) => k.kind === 'layer' && k.a === c.id && k.value === 'bottom') ? 'bottom' : 'top',
          /** Every parameter this component may carry (the card's and the universal lcsc), for editors. */
          specs: card ? paramsOf(card) : {},
          ...(card && packageOptions(card).length ? { package: { ...packageChoice(card, c.params, d.packageDefaults), options: packageOptions(card) } } : {}),
          pins: card?.pins.map((p) => ({
            pin: p.number,
            name: p.name,
            type: p.type,
            net: c.pins[p.number] ? d.nets[c.pins[p.number]!]?.name : c.noConnect.includes(p.number) ? '(no-connect)' : null,
          })),
          constraints: Object.values(d.ledger).filter((k) => k.a === c.id || k.b === c.id).map((k) => ({ id: k.id, text: describeConstraint(d, k), strength: k.strength })),
        };
      }
      case 'get_net': {
        const n = findNet(d, q.net);
        if (!n) return { error: `No net ${q.net}`, nets: Object.values(d.nets).map((x) => x.name).sort(natCmp) };
        const pins = (netMembers(d).get(n.id) ?? []).map((m) => `${m.comp.refdes}.${m.pin.name} (${m.pin.type})`);
        // the track it gets on the board: its own width, else the rules' power or signal width
        const rules = (d.board ?? DEFAULT_BOARD).rules;
        const kind = isGroundNet(n) ? 'ground' : isPowerNet(n) ? 'supply' : 'signal';
        const width = n.attrs.trackWidth ?? (kind === 'signal' ? rules.track : rules.powerTrack);
        const track = {
          width_mm: width,
          why: n.attrs.trackWidth ? 'set for this net' : kind === 'signal' ? 'signal width (rules)' : 'power width (rules)',
          ...(n.attrs.maxCurrent ? { suggested_mm: trackWidthFor(n.attrs.maxCurrent), for_current_a: n.attrs.maxCurrent } : {}),
          rules: { signal_mm: rules.track, power_mm: rules.powerTrack },
        };
        // the vias its pads drop onto its plane with: one each, those the agent placed (add_vias drop)
        const perVia = viaCurrentFor(rules.viaDrill);
        const drops = (d.board?.vias ?? []).filter((g) => g.kind === 'drop' && g.netId === n.id);
        const asked = drops.map((g) => {
          const c = d.components[g.pad!.componentId];
          const amps = g.amps ?? n.attrs.maxCurrent;
          return { pad: `${c?.refdes ?? '?'}.${g.pad!.number}`, vias: g.offsets?.length ?? 0, ...(amps ? { for_a: amps, wants: viasForCurrent(amps, g.drill ?? rules.viaDrill) } : {}), group: g.id };
        });
        const vias = {
          plane_vias: {
            each_pad: 1,
            ...(asked.length ? { asked_for: asked } : {}),
            per_via_a: Math.round(perVia * 10) / 10,
            ...(n.attrs.maxCurrent ? { for_max_current: viasForCurrent(n.attrs.maxCurrent, rules.viaDrill) } : {}),
            note: 'Each pad drops onto its plane with one via of the router\'s. On the pads the current flows through (trace the path: where it comes in, the regulator or switch, the inductor, the bulk and output caps, where it goes out, and the ground return of each), place as many as that current needs yourself: add_vias kind drop (ref, pad, at: each via\'s centre, in a row right beside the pad on the side facing away from the part, half a via plus the clearance off its edge; each gets its own short stub to the pad), then look at them (get_board_image region round the pad). Not on pads no current to speak of flows through (a switch, an LED, a pull-up, an IC\'s logic pins).',
          },
        };
        // a line at a set impedance: its rule worked out for the board
        const rule = d.board?.impedance?.find((r) => r.nets.includes(n.id));
        const impedance = rule ? { impedance: impedanceText(resolveRule(rule, lineBoard(d)), (id) => d.nets[id]?.name ?? id) } : {};
        return { id: n.id, name: n.name, kind, attrs: n.attrs, pins, track, ...impedance, ...vias };
      }
      case 'get_diagnostics':
        return this.analyse(d).diagnostics;
      case 'get_fab_profiles': {
        const layers = d.board?.layers ?? 2;
        const cur = d.board?.fab;
        return {
          current: cur ? { id: cur.id, summary: fabSummary(cur), origin: cur.origin, source: cur.source, limits: cur.limits, ...(cur.notes?.length ? { notes: cur.notes } : {}) } : 'none',
          presets: fabPresets().map((p) => ({ id: p.id, house: p.house, tier: p.tier, layers: p.layers, summary: fabSummary(p), source: p.source.url, checked: p.source.checked })),
          how: `set_fab_profile preset: "jlcpcb" (or a tier id above); a bare house takes the tier for this board's ${layers} layers (Eurocircuits: 6C; any pattern class 3–9 with drill class A–E works, e.g. "eurocircuits/5C"). For another manufacturer, or newer numbers, read its capabilities page and import: house, tier, source_url, checked and limits in mm; never guess a number.`,
        };
      }
      case 'get_schematic': {
        // what the agent needs to place parts: each page's paper and where every symbol stands on it
        const view = this.analyse(d).view;
        const r = (v: number) => Math.round(v);
        return {
          coordinates: 'mils from the top-left corner of the page\'s paper, x to the right, y down; a symbol\'s x/y is its centre',
          labels_note: 'net labels; auto: true is a connection your drawing does not show, labelled by the kernel until you wire it (wire) or label it (label)',
          drawing_area: { margin: PAGE.margin, title_block: `${PAGE.title} high, at the bottom` },
          pages: view.sheets.flatMap((s) =>
            s.pages.map((p) => ({ page: p.number, sheet: s.name, name: p.name, w: p.rect.w, h: p.rect.h, ...(p.oversized ? { oversized: true } : {}), drawn: d.drawing?.[s.id] ? 'as you arranged it' : 'by the auto-layout, afresh after every change' })),
          ),
          ...this.schematicBlocks(d, view),
          symbols: view.sheets.flatMap((s) =>
            s.symbols.map((sym) => {
              const cx = sym.bbox.x + sym.bbox.w / 2;
              const cy = sym.bbox.y + sym.bbox.h / 2;
              const p = s.pages.find((pg) => cx >= pg.rect.x && cx <= pg.rect.x + pg.rect.w && cy >= pg.rect.y && cy <= pg.rect.y + pg.rect.h) ?? s.pages[0]!;
              return { ref: `${sym.refdes}${sym.unit ?? ''}`, page: p.number, x: r(cx - p.rect.x), y: r(cy - p.rect.y), w: sym.bbox.w, h: sym.bbox.h, ...(sym.rotation ? { lying: true } : {}) };
            }),
          ),
          // net labels (supply symbols left out), at the pin they sit on; auto: a connection the drawing does not show yet
          labels: view.sheets.flatMap((s) =>
            s.labels
              .filter((l) => l.kind === 'net')
              .map((l) => {
                const sym = s.symbols.find((x) => x.pins.some((p) => p.x === l.x && p.y === l.y));
                const pin = sym?.pins.find((p) => p.x === l.x && p.y === l.y);
                const pg = s.pages.find((p) => l.x >= p.rect.x && l.x <= p.rect.x + p.rect.w && l.y >= p.rect.y && l.y <= p.rect.y + p.rect.h) ?? s.pages[0]!;
                const at = sym && pin ? `${sym.refdes}${sym.unit ?? ''}.${pin.name === pin.number ? pin.number : pin.name}` : `page ${pg.number} (${r(l.x - pg.rect.x)}, ${r(l.y - pg.rect.y)})`;
                return { net: l.text, at, dir: l.dir, ...(l.auto ? { auto: true } : {}) };
              }),
          ),
        };
      }
      case 'get_copper': {
        const b = this.board();
        if (!b.drawn) return { copper: 'the router\'s (set_copper_mode drawn makes it yours)', tracks: b.tracks.length, vias: b.vias.length };
        const nets = q.nets ? new Set(q.nets.map((n) => findNet(d, n)?.id ?? n)) : null;
        const r = q.rect;
        const inRect = (x: number, y: number) => !r || (x >= r.x_mm && y >= r.y_mm && x <= r.x_mm + r.width_mm && y <= r.y_mm + r.height_mm);
        const ref = (a?: { componentId: string; pad: string }) => (a ? `${d.components[a.componentId]?.refdes ?? a.componentId}.${a.pad}` : undefined);
        const name = (id: string) => d.nets[id]?.name ?? id;
        return {
          tracks: b.drawn.tracks
            .filter((t) => (!nets || nets.has(t.netId)) && t.pts.some((v, i) => i % 2 === 0 && inRect(v, t.pts[i + 1]!)))
            .map((t) => ({ id: t.id, net: name(t.netId), layer: t.layer, width: t.width, pts: Array.from({ length: t.pts.length / 2 }, (_, i) => [t.pts[2 * i]!, t.pts[2 * i + 1]!]), ...(t.from ? { from: ref(t.from) } : {}), ...(t.to ? { to: ref(t.to) } : {}), ...(t.by ? { by: t.by } : {}) })),
          vias: b.drawn.vias.filter((v) => (!nets || nets.has(v.netId)) && inRect(v.x, v.y)).map((v) => ({ id: v.id, net: name(v.netId), at: [v.x, v.y], drill: v.drill, size: v.pad, ...(v.by ? { by: v.by } : {}) })),
        };
      }
      case 'get_board': {
        // routing is expensive: use it when it has been computed, otherwise placement only (drawn
        // copper routes nothing: always computed)
        const routed = d.board?.drawn ? this.board() : this.boards.get(d);
        const b = routed ?? this.boardPlacement();
        return { ...boardSummary(b, !!routed), plane_plan: planePlan(d, b) };
      }
      case 'try_placements':
        return tryPlacements(d, this.analyse(d).view, q.candidates, !!q.route, this.boards.get(d), q.explore !== false);
      case 'suggest_moves':
        return suggestMoves(d, this.analyse(d).view, this.board(), q);
      case 'get_description':
        return descriptionView(d) ?? { description: null, hint: 'No description yet: write one with design_edit describe (overview and blocks).', parts: componentsSorted(d).map((c) => c.refdes) };
      case 'get_ledger':
        return Object.values(d.ledger).map((k) => ({ id: k.id, text: describeConstraint(d, k), strength: k.strength, quote: k.source.quote }));
      case 'search_parts':
        return searchParts(q.text, Object.values(d.parts)).slice(0, 12).map((p) => ({
          id: p.id,
          description: p.description,
          package: p.package,
          params: Object.keys(p.params),
        }));
      case 'get_part': {
        const p = cardOf(d, q.id);
        return p ?? { error: `No part ${q.id}`, candidates: searchParts(q.id).slice(0, 5).map((x) => x.id) };
      }
      // the app answers these with board.scad, OpenSCAD and the guide; the kernel alone knows the design's part
      case 'get_enclosure':
        return { brief: d.enclosure?.brief ?? null, script: d.enclosure?.script ?? null, graphics: enclosureGraphicsInfo(d.enclosure?.graphics) };
      case 'get_guide':
        return { error: 'The guides are served by the app.' };
    }
  }

  /**
   * The functional blocks as get_schematic shows them: per sheet each block's frame (page, centre
   * and size, in page mils), its parts, the parts the layout put with it (in no block yet), and
   * whether the agent placed it; the parts in no block at all.
   */
  private schematicBlocks(d: Design, view: SchematicView): Record<string, unknown> {
    if (!d.description?.blocks.length) {
      return { blocks_note: 'No functional blocks yet: group the parts with describe blocks (a title and the parts of each, in reading order). Each block is then drawn as one framed unit, wired inside, labels only for the nets that leave it; place_block moves one. get_guide topic "schematic" says how.' };
    }
    const r = Math.round;
    const ref = (id: string) => d.components[id]?.refdes ?? id;
    const blocks: Record<string, unknown>[] = [];
    const loose: string[] = [];
    for (const s of view.sheets) {
      const groups = blockAssignment(d, s.id);
      if (!groups) continue;
      loose.push(...groups.loose.map(ref));
      for (const b of groups.blocks) {
        const frames = (s.blocks ?? []).filter((f) => f.title === b.title || f.title === `${b.title} (continued)`);
        const where = frames.map((f) => {
          const cx = f.rect.x + f.rect.w / 2;
          const cy = f.rect.y + f.rect.h / 2;
          const pg = s.pages.find((p) => cx >= p.rect.x && cx <= p.rect.x + p.rect.w && cy >= p.rect.y && cy <= p.rect.y + p.rect.h) ?? s.pages[0]!;
          return { page: pg.number, x: r(cx - pg.rect.x), y: r(cy - pg.rect.y), w: f.rect.w, h: f.rect.h };
        });
        const placed = Object.values(d.ledger).some((k) => k.kind === 'sch_block' && k.key === b.title && k.sheet === s.id);
        blocks.push({
          block: b.title,
          sheet: s.name,
          ...(where.length === 1 ? where[0] : where.length ? { frames: where } : { frame: d.drawing?.[s.id] ? 'none: its parts do not stand together (place_block draws it afresh in one place)' : 'none' }),
          parts: b.ids.map(ref).sort(natCmp),
          ...(b.guessed.length ? { guessed: b.guessed.map(ref).sort(natCmp) } : {}),
          ...(placed ? { placed: true } : {}),
        });
      }
    }
    return {
      blocks_note: 'x/y: the centre of the block\'s frame (place_block moves it there); guessed: parts in no block that the layout drew with this one (describe puts them in a block for good); a block taller than a page continues on the next (frames)',
      blocks,
      ...(loose.length ? { not_in_a_block: loose.sort(natCmp) } : {}),
    };
  }

  summary(d: Design = this.draft): DesignSummary {
    const members = netMembers(d);
    return {
      name: d.name,
      sheets: Object.values(d.sheets).sort((a, b) => a.order - b.order).map((s) => s.name),
      pages: this.analyse(d).view.sheets.reduce((n, s) => n + s.pages.length, 0),
      components: componentsSorted(d).map((c) => ({ refdes: c.refdes, part: c.part, value: valueOf(d, c), sheet: d.sheets[c.sheet]?.name ?? '?' })),
      nets: Object.values(d.nets)
        .sort((a, b) => natCmp(a.name, b.name))
        .map((n) => ({
          name: n.name,
          pins: members.get(n.id)?.length ?? 0,
          ...(n.attrs.voltage !== undefined ? { voltage: n.attrs.voltage } : {}),
          ...(n.attrs.external ? { external: true } : {}),
        })),
      counts: countDiagnostics(this.analyse(d).diagnostics),
      ledger: Object.keys(d.ledger).length,
      waivers: Object.keys(d.waivers).length,
      ...(d.description ? { description: { blocks: d.description.blocks.length, undescribed: descriptionView(d)!.undescribed } } : {}),
      ...(d.valueSeries ? { valueSeries: { ...d.valueSeries } } : {}),
      stackup: (({ name, copper, dielectric, mask }) => ({ name, copper, dielectric, ...(mask ? { mask } : {}) }))(boardStackup(d.board ?? DEFAULT_BOARD)),
    };
  }

  /** Everything the UI needs in one call. */
  state(): KernelState {
    const d = this.draft;
    const a = this.analyse(d);
    return {
      view: a.view,
      diagnostics: a.diagnostics,
      counts: countDiagnostics(a.diagnostics),
      proposal: this.proposal(),
      ledger: Object.values(d.ledger)
        .sort((x, y) => natCmp(x.id, y.id))
        .map((k) => ({
          id: k.id,
          text: describeConstraint(d, k),
          strength: k.strength,
          ...(k.source.quote ? { quote: k.source.quote } : {}),
          status: a.view.constraintStatus[k.id] ?? (k.kind === 'param' ? 'ok' : 'n/a'),
        })),
      history: [...this.history].reverse(),
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      nextRedo: this.redoStack.at(-1)?.entry ?? null,
      summary: this.summary(d),
      description: descriptionView(d),
    };
  }

  /* ------------------------------ persistence ----------------------------- */

  exportDesign(): string {
    return canonicalJson(this.committed);
  }

  committedDesign(): Design {
    return clone(this.committed);
  }

  load(design: Design): void {
    this.committed = migrate(clone(design));
    syncDrawing(this.committed);
    this.draft = clone(this.committed);
    this.rev++;
    this.undoStack = [];
    this.redoStack = [];
    this.history = [];
    this.pendingSummaries = [];
    this.scoped = null;
  }

  rename(name: string): void {
    this.committed.name = name;
    this.draft.name = name;
    this.rev++;
    this.invalidate(this.committed);
    this.invalidate(this.draft);
  }
}

/* --------------------------------- helpers -------------------------------- */

type Issue = { path: PropertyKey[]; message: string };

function formatZod(issues: Issue[]): string {
  return issues
    .slice(0, 5)
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

function indexOfIssue(issues: Issue[]): number {
  const p = issues[0]?.path;
  return p && p[0] === 'ops' && typeof p[1] === 'number' ? p[1] : -1;
}

