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
  type LabelView,
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
  type BoardPlace,
  type BoardView,
  type BringUpPlan,
  type DescriptionView,
  type SheetView,
  type StoredCopper,
  type SchematicRule,
  PAGE,
  boardSummary,
  type DrcFilter,
  resolveChecks,
  type CheckSettings,
  DEFAULT_BOARD,
  countDiagnostics,
  fabPresets,
  fabSummary,
  trackWidthFor,
  viaCurrentFor,
  viasForCurrent,
  enclosureAnswer,
  enclosureGraphicsInfo,
  boardStackup,
  COPPER_ORDER,
  type SymbolView,
} from '@4k7/schema';
import { packageChoice, packageOf, packageOptions, searchParts } from '@4k7/parts';
import { applyOp } from './apply.ts';
import { describeConstraint } from './netops.ts';
import { descriptionView } from './sheetops.ts';
import { diagKey, runChecks, sortDiagnostics } from './checks.ts';
import { crossChecks } from './xcheck.ts';
import { computeHunks, mergeHunks } from './diff.ts';
import { RejectError, applyWaivers, cardOf, clone, componentsSorted, findComponent, findNet, gcNets, gcParts, isGroundNet, isPowerNet, natCmp, netMembers, paramsOf, valueOf, workCopy } from './doc.ts';
import { Memo, drawingInputs } from './derive.ts';
import { syncDrawing, viewOf } from './drawing.ts';
import { keepForcedNets } from './netdraw.ts';
import { blockAssignment } from './layout.ts';
import { copperKey, layoutBoard, placedOf, planePlan } from './board.ts';
import { currentCheck, currentMapAnswer, currentRise, layerCopper } from './current.ts';
import { powerTreeAnswer } from './powertree.ts';
import { bringUpPlan } from './bringup.ts';
import type { RouteProgress } from './router.ts';
import type { ImportSources } from './importops.ts';
import { HELPER_TX_MS, annotateChecks, drawsCopper, followParts, movesParts, type HelperHooks } from './copperops.ts';
import { canonicalJson, migrate } from './canonical.ts';
import { MIN_FREE, circuitSignature, guardOp, measure, positions, resolveScope, ripple, widenScope, type ResolvedScope } from './scope.ts';
import { schematicChecks } from './schcheck.ts';
import { tryPlacements } from './trial.ts';
import { suggestMoves } from './suggest.ts';
import { impedanceText, resolveRule } from './lines.ts';
import { lineBoard } from './lineops.ts';
import { boardList, boardOf, commitFocus, findBoard, focusBoard, multiBoard, settingsOf } from './boards.ts';
import { matePairs, pairsText } from './mates.ts';
import { assemblyOf } from './assembly.ts';
import { FIRST_BOARD } from '@4k7/schema';
import { opBoard } from './apply.ts';

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
  /** The boards (id, name), first board first: one unless the design has several (add_board). */
  boards: { id: string; name: string }[];
}

/** The SCH checks read the drawing and nothing of the board: a part moved there leaves them as they were. */
const schematicFindings = new Memo<Diagnostic[]>('schematic checks', 4);

export class Kernel {
  private committed: Design;
  private draft: Design;
  private cache = new WeakMap<Design, Analysis>();
  /** Each design's boards as laid out (routing included), by board id. */
  private boardViews = new WeakMap<Design, Map<string, BoardView>>();
  /** Each design's board focuses (boards.ts) the views are computed from, by board id. */
  private focuses = new WeakMap<Design, Map<string, Design>>();
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
    this.draft = this.committed;
  }

  /* ------------------------------ analysis -------------------------------- */

  private analyse(d: Design): Analysis {
    let a = this.cache.get(d);
    if (!a) {
      const view = viewOf(d);
      // (copies: the waivers are marked on them)
      const sch = schematicFindings.get(`${JSON.stringify(this.rules)}|${drawingInputs(d)}|${JSON.stringify(d.drawing ?? null)}`, () => schematicChecks(d, view, this.rules)).map((x) => ({ ...x }));
      applyWaivers(d, sch);
      a = { view, diagnostics: sortDiagnostics([...runChecks(d, view.constraintStatus, view.constraintWhy), ...crossChecks(d), ...sch]) };
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
    this.boardViews.delete(d);
    this.focuses.delete(d);
  }

  /** Board `id` of `d` as a design of its own (boards.ts), kept for the views: not to change. */
  private focus(d: Design, id: string = FIRST_BOARD): Design {
    if (!multiBoard(d)) return d;
    let m = this.focuses.get(d);
    if (!m) this.focuses.set(d, (m = new Map()));
    let f = m.get(id);
    if (!f) m.set(id, (f = focusBoard(d, id)));
    return f;
  }

  private viewOfBoard(d: Design, id: string): BoardView | undefined {
    return this.boardViews.get(d)?.get(id);
  }

  private keepView(d: Design, id: string, b: BoardView) {
    let m = this.boardViews.get(d);
    if (!m) this.boardViews.set(d, (m = new Map()));
    m.set(id, b);
  }

  /** The design's boards (id, name), first board first. */
  boardList(): { id: string; name: string }[] {
    return boardList(this.draft).map((b) => ({ id: b.id, name: b.name }));
  }

  /** The working copy as a design (for the board worker, which computes the board separately). */
  draftDesign(): Design {
    return clone(this.draft);
  }

  /** The working copy's part cards. */
  draftParts(): Design['parts'] {
    return clone(this.draft.parts);
  }

  /** The working copy and its revision, together (for the route helper's worker: see HelperHooks.rev). */
  draftSnapshot(): { design: Design; rev: number } {
    return { design: clone(this.draft), rev: this.rev };
  }

  /** The working copy's bring-up sheet, for the design document (bringup.ts): of board `board` (several boards). */
  bringUp(board: string = FIRST_BOARD): BringUpPlan {
    return bringUpPlan(this.focus(this.draft, board));
  }

  /** Placement only (fast): parts, outline, ratsnest and placement checks. */
  boardPlacement(board: string = FIRST_BOARD): BoardView {
    return placedOf(this.focus(this.draft, board));
  }

  /** Where every board of the working copy stands (stacked by its mates, else beside), first board first. See docs/design/multi-board.md §6. */
  assembly(): BoardPlace[] {
    return assemblyOf(this.draft, new Map(boardList(this.draft).map((b) => [b.id, this.boardPlacement(b.id)])));
  }

  /** What the board worker lays the board from (layoutBoard): to send on, not to change. */
  boardRequest(board: string = FIRST_BOARD): { design: Design; placed: BoardView } {
    const f = this.focus(this.draft, board);
    return { design: f, placed: placedOf(f) };
  }

  /**
   * The working copy's board where it is routed and computing it routes nothing (copper kept for
   * this placement, or drawn): for queries that read the copper.
   */
  private routedNow(d: Design, id: string = FIRST_BOARD): BoardView | undefined {
    const had = this.viewOfBoard(d, id);
    const f = this.focus(d, id);
    const b = had ?? (d === this.draft && (f.board?.drawn || (f.board?.copper && f.board.copper.key === copperKey(f))) ? this.board({}, id) : undefined);
    return b?.routing === 'done' ? b : undefined;
  }

  /**
   * The board DRC's copper-to-copper findings (pads, tracks, vias and pours of two nets touching or
   * too close), for get_diagnostics: from the copper where it is routed or drawn, else from the
   * placement (pads that touch). The board's other findings are the layout's. See docs/design/layout.md.
   */
  private copperShorts(d: Design): Diagnostic[] {
    return boardList(d).flatMap(({ id }) => {
      const b = this.routedNow(d, id) ?? placedOf(this.focus(d, id));
      return b.diagnostics.filter((x) => x.code === 'DRC.SHORT' || x.code === 'DRC.CLEARANCE');
    });
  }

  /**
   * The copper findings at the parts whose footprint an edit changed (a value that sizes a part up
   * picks a bigger package), on a board whose copper is current: the land against the tracks and
   * vias already there. The transaction's own checks are the schematic's; without this an edit that
   * puts a pad over a via reported nothing until the board was looked at again. Not new ones only:
   * of `before`'s board where it was routed too. See docs/design/layout.md.
   */
  private landFindings(before: Design, work: Design): Diagnostic[] {
    const grown = Object.values(work.components).filter((c) => {
      const was = before.components[c.id];
      const card = cardOf(work, c.part);
      const cardWas = was && cardOf(before, was.part);
      return was && card && cardWas && packageOf(card, c.params, work.packageDefaults)?.name !== packageOf(cardWas, was.params, before.packageDefaults)?.name;
    });
    if (!grown.length) return [];
    return boardList(work).flatMap(({ id }) => {
      const f = this.focus(work, id);
      const mine = grown.filter((c) => f.components[c.id]);
      if (!mine.length || !f.board || !(f.board.drawn || (f.board.copper && f.board.copper.key === copperKey(f)))) return [];
      const b = layoutBoard(f, placedOf(f));
      this.keepView(work, id, b);
      if (b.routing !== 'done') return [];
      const refs = new Set(mine.map((c) => c.refdes));
      const at = (x: Diagnostic) => (x.code === 'DRC.SHORT' || x.code === 'DRC.CLEARANCE' || x.code === 'DRC.VIA_IN_PAD') && !x.waivedBy && x.entities.some((e) => refs.has(e));
      const had = new Set((this.routedNow(before, id)?.diagnostics ?? []).filter(at).map(diagKey));
      return b.diagnostics.filter((x) => at(x) && !had.has(diagKey(x)));
    });
  }

  /** The board of the working copy: placement, routing and DRC (computed on demand, cached). `follow` follows the routing, if it routes (see layoutBoard). */
  board(follow: { onProgress?: (p: RouteProgress) => void; onBest?: (c: StoredCopper) => void } = {}, id: string = FIRST_BOARD): BoardView {
    const d = this.draft;
    let b = this.viewOfBoard(d, id);
    if (!b) {
      const f = this.focus(d, id);
      b = layoutBoard(f, placedOf(f), follow);
      this.keepView(d, id, b);
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
      for (const { id } of boardList(d)) {
        const s = settingsOf(d, id);
        if (!s || copperKey(this.focus(d, id)) !== copper.key) continue;
        s.copper = copper; // (the focus shares the settings: it has the copper too)
        this.boardViews.get(d)?.delete(id);
        if (d === this.committed) committed = true;
      }
    }
    return committed;
  }

  /* ---------------------------- transactions ------------------------------ */

  /**
   * Validate and apply a transaction to the working copy (or dry-run it). `by`: who asked for it,
   * the agent unless the app says the user. `helper`: the route helper's results computed elsewhere
   * (a worker), or hooks to follow it while it routes here (drawn copper, see copperops.ts).
   * `sources`: the stored projects the app read for its import_block ops (importops.ts).
   */
  transact(input: unknown, by: 'user' | 'agent' = 'agent', helper?: HelperHooks, sources?: ImportSources): TransactionResult {
    const parsed = Transaction.safeParse(input);
    if (!parsed.success) {
      return this.rejected({ opIndex: indexOfIssue(parsed.error.issues), code: 'INVALID_OP', message: formatZod(parsed.error.issues) }, false);
    }
    const tx = parsed.data;
    if (helper?.rev !== undefined && helper.rev !== this.rev) {
      return this.rejected({ opIndex: 0, code: 'STALE', message: 'The design changed while the route helper searched; search again on it as it is now.' }, !!tx.dry_run);
    }
    const before = this.analyse(this.draft).diagnostics;
    const work = workCopy(this.draft);
    const results = [];
    // drawn copper, per board: what each op drew, edited or moved, checked once the transaction is applied
    const drawn = new Map<string, Map<number, string[]>>();
    const drawnOn = (b: string) => drawn.get(b) ?? drawn.set(b, new Map()).get(b)!;
    const deadline = Date.now() + HELPER_TX_MS;
    // per board, the placement after the last op that may move parts (copper ops in between do not move any)
    const placedNow = new Map<string, BoardView>();
    for (let i = 0; i < tx.ops.length; i++) {
      const op = tx.ops[i]!;
      try {
        if (this.scoped) guardOp(work, op, this.scoped.sc);
        // (drawn copper follows the parts an op moves: on its board, or on every board for an op on the design)
        const target = opBoard(work, op);
        const on = target ? [target] : boardList(work).map((b) => b.id);
        const placed = new Map<string, BoardView>();
        for (const b of boardList(work)) if (!settingsOf(work, b.id)?.drawn) placedNow.delete(b.id);
        if (movesParts(op)) for (const b of on) if (settingsOf(work, b)?.drawn) placed.set(b, placedNow.get(b) ?? placedOf(focusBoard(work, b)));
        const r = applyOp(work, op, by, { index: i, deadline, ...(helper ? { helper } : {}), ...(sources ? { sources } : {}) });
        for (const [b, before] of placed) {
          const f = focusBoard(work, b);
          const now = placedOf(f);
          placedNow.set(b, now);
          const fo = followParts(f, before, now);
          commitFocus(work, b, f);
          if (fo) {
            if (fo.note) r.effect += `; ${fo.note}`;
            drawnOn(b).set(i, fo.ids);
          }
        }
        if (!placed.size && drawsCopper(op)) for (const b of on) if (settingsOf(work, b)?.drawn) drawnOn(b).set(i, (r.ids ?? []).filter((id) => /^[tv]\d+$/.test(id)));
        results.push(r);
      } catch (e) {
        if (e instanceof RejectError) return this.rejected({ opIndex: i, ...e.rejection }, !!tx.dry_run);
        throw e;
      }
    }
    gcNets(work);
    gcParts(work);
    syncDrawing(work);
    keepForcedNets(work);
    for (const [b, m] of drawn) {
      const f = focusBoard(work, b);
      annotateChecks(f, results, m);
      commitFocus(work, b, f);
    }
    if (this.scoped && circuitSignature(work) !== this.scoped.circuit) {
      return this.rejected({ opIndex: tx.ops.length - 1, code: 'OUT_OF_SCOPE', message: 'This would change the circuit (parts, values or connections). Optimize only changes how an area is drawn.' }, !!tx.dry_run);
    }
    const analysed = this.analyse(work);
    const after = analysed.diagnostics;
    const land = this.landFindings(this.draft, work);
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
      introduced: [...after.filter((x) => !x.waivedBy && !beforeKeys.has(diagKey(x))), ...land],
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
      measures: sheet ? measure(sheet, s.sc.nets, s.sc.free) : s.sc.info.measures,
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
    const hunks = d === this.committed ? [] : computeHunks(this.committed, d);
    const pick = (c: string) => hunks.filter((h) => h.change === c).map((h) => h.title);
    return { added: pick('add'), removed: pick('remove'), changed: pick('change') };
  }

  /* ------------------------------ proposals ------------------------------- */

  /** What is pending. (With nothing pending the working copy is the committed design: an edit works on a copy, so neither changes under the other.) */
  private hunks() {
    return this.draft === this.committed ? [] : computeHunks(this.committed, this.draft);
  }

  hasPending(): boolean {
    return this.hunks().length > 0;
  }

  proposal(): Proposal | null {
    const hunks = this.hunks();
    if (!hunks.length) return null;
    return {
      hunks,
      before: countDiagnostics(this.analyse(this.committed).diagnostics),
      after: countDiagnostics(this.analyse(this.draft).diagnostics),
    };
  }

  /** Commit the pending changes. `hunkIds` selects a subset; omitted = all. */
  accept(hunkIds?: string[], by: 'user' | 'agent' = 'agent', summary?: string): { entry: HistoryEntry | null; notes: string[] } {
    const hunks = this.hunks();
    if (!hunks.length) return { entry: null, notes: [] };
    const ids = new Set(hunkIds ?? hunks.map((h) => h.id));
    const selected = hunks.filter((h) => ids.has(h.id));
    let next: Design;
    let notes: string[] = [];
    if (selected.length === hunks.length) {
      next = this.draft;
    } else {
      ({ design: next, notes } = mergeHunks(this.committed, this.draft, ids));
      syncDrawing(next);
      keepForcedNets(next);
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
    this.draft = next;
    this.rev++;
    this.pendingSummaries = [];
    return { entry, notes };
  }

  reject(): void {
    this.draft = this.committed;
    this.rev++;
    this.pendingSummaries = [];
  }

  undo(): HistoryEntry | null {
    const last = this.undoStack.pop();
    if (!last) return null;
    this.redoStack.push({ design: this.committed, entry: last.entry });
    this.committed = last.design;
    this.draft = last.design;
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
    this.draft = next.design;
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
    const all = this.draft;
    // a board query reads one board: the design as if it were the only one
    let bid = FIRST_BOARD;
    const onBoard = q.op === 'get_board' || q.op === 'get_copper' || q.op === 'get_current_map' || q.op === 'try_placements' || q.op === 'suggest_moves';
    if (onBoard) {
      const ref = (q as { board?: string }).board;
      if (ref !== undefined) {
        const b = findBoard(all, ref);
        if (!b) return { error: `No board "${ref}".`, boards: boardList(all).map((x) => x.name) };
        bid = b.id;
      } else if (multiBoard(all) && q.op !== 'get_board') {
        return { error: `The design has ${boardList(all).length} boards: say which with board.`, boards: boardList(all).map((x) => x.name) };
      }
    }
    if (q.op === 'get_board' && (q as { board?: string }).board === undefined && multiBoard(all)) {
      const at = new Map(this.assembly().map((p) => [p.board, p]));
      return {
        boards: boardList(all).map((b) => {
          const { board: _b, name: _n, ...place } = at.get(b.id)!;
          return { board: b.name, id: b.id, assembly: place, ...this.boardAnswer(all, b.id, q.drc) };
        }),
        assembly_frame: 'the first board\'s: x right, y down from its top-left corner, z up from its top surface (mm); a board\'s point (u, v) is at rot·(flipped ? −u : u, v) + (x, y)',
      };
    }
    const d = onBoard ? this.focus(all, bid) : all;
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
          ...(c.dnp ? { dnp: true } : {}),
          ...(card?.padOnly ? { padOnly: true } : {}),
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
        const members = netMembers(d).get(n.id) ?? [];
        const pins = members.map((m) => `${m.comp.refdes}.${m.pin.name} (${m.pin.type})`);
        // several boards: the board facts below are those of the board of its first pin
        const on = [...new Set(members.map((m) => boardOf(d, m.comp)))];
        const nbid = on[0] ?? FIRST_BOARD;
        const nd = this.focus(d, nbid);
        const onBoards = multiBoard(d) ? { boards: on.map((id) => d.boards![id]!.name), board_facts_for: d.boards![nbid]!.name } : {};
        // the track it gets on the board: its own width, else the rules' power or signal width
        const rules = (nd.board ?? DEFAULT_BOARD).rules;
        const kind = isGroundNet(n) ? 'ground' : isPowerNet(n) ? 'supply' : 'signal';
        const width = n.attrs.trackWidth ?? (kind === 'signal' ? rules.track : rules.powerTrack);
        // the width its current needs, per layer: each layer's copper from the stack-up, at the board's allowed heating
        const settings = nd.board ?? DEFAULT_BOARD;
        const stack = boardStackup(settings);
        const copper = layerCopper({ layers: COPPER_ORDER[settings.layers], stackup: stack });
        const rise = currentRise(rules);
        const amps = n.attrs.maxCurrent;
        const track = {
          width_mm: width,
          why: n.attrs.trackWidth ? 'set for this net' : kind === 'signal' ? 'signal width (rules)' : 'power width (rules)',
          ...(amps ? { suggested_mm: Object.fromEntries(Object.entries(copper).map(([l, um]) => [l, trackWidthFor(amps, rise, um)])), for_current_a: amps, copper_um: copper, rise_c: rise } : {}),
          rules: { signal_mm: rules.track, power_mm: rules.powerTrack },
          ...(n.attrs.routeFirst ? { routed_first: true } : {}),
          ...(n.attrs.layer ? { keeps_to: n.attrs.layer } : {}),
        };
        // how its copper on the board carries that current (get_current_map has the pieces)
        const routedNow = this.routedNow(d, nbid);
        const checked = routedNow ? (routedNow.current ?? currentCheck(nd, routedNow)).nets.find((x) => x.netId === n.id) : undefined;
        const current = {
          status: !amps && !checked ? 'unknown' : !routedNow ? 'not checked: not routed yet' : (checked?.status ?? 'no copper yet'),
          ...(checked && checked.status !== 'unknown' ? { basis: checked.basis } : {}),
          ...(checked?.worst !== undefined ? { worst_ratio: checked.worst } : {}),
          ...(checked?.loads !== undefined ? { loads_a: checked.loads } : {}),
          ...(checked?.unplaced !== undefined ? { unplaced_a: checked.unplaced } : {}),
          rise_c: rise,
          note: !amps && !checked
            ? 'No max_current: the current check cannot tell whether its copper carries its current. Set it on a net that carries real current.'
            : checked?.basis === 'split'
              ? 'Split: each track and via is checked for its share of the loads stated (set_net loads), plus what of max_current no load places (over: too small for its share). get_current_map lists the pieces.'
              : `Every track and every via that is the only way between two layers is checked for all of max_current (unverified: some copper carries less; whether that much flows there is not known: say what the pins draw with set_net loads).${checked?.why ? ` Loads not split: ${checked.why}.` : ''} get_current_map lists the pieces.`,
        };
        // the vias its pads drop onto its plane with: one each, those the agent placed (add_vias drop)
        const perVia = viaCurrentFor(rules.viaDrill);
        const drops = (nd.board?.vias ?? []).filter((g) => g.kind === 'drop' && g.netId === n.id);
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
        const rule = nd.board?.impedance?.find((r) => r.nets.includes(n.id));
        const impedance = rule ? { impedance: impedanceText(resolveRule(rule, lineBoard(nd)), (id) => d.nets[id]?.name ?? id) } : {};
        return { id: n.id, name: n.name, kind, attrs: n.attrs, pins, ...onBoards, track, current, ...impedance, ...vias };
      }
      case 'get_diagnostics':
        return [...this.analyse(d).diagnostics, ...this.copperShorts(d)];
      case 'get_current_map': {
        const b = this.routedNow(all, bid);
        if (!b) return { routed: false, note: 'The board is not routed (or its routing is out of date): route it first, then ask again.' };
        return currentMapAnswer(d, b, q);
      }
      case 'get_power_tree':
        return powerTreeAnswer(d);
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
        /** The pin a label stands on ("U1.3"), if any, and its page. */
        const where = (s: SheetView, l: LabelView) => {
          const sym = s.symbols.find((x) => x.pins.some((p) => p.x === l.x && p.y === l.y));
          const pin = sym?.pins.find((p) => p.x === l.x && p.y === l.y);
          const pg = s.pages.find((p) => l.x >= p.rect.x && l.x <= p.rect.x + p.rect.w && l.y >= p.rect.y && l.y <= p.rect.y + p.rect.h) ?? s.pages[0]!;
          return { pin: sym && pin ? `${sym.refdes}${sym.unit ?? ''}.${pin.name === pin.number ? pin.number : pin.name}` : undefined, pg };
        };
        const forced = Object.values(d.nets).filter((n) => n.attrs.drawAs).map((n) => ({ net: n.name, draw_as: n.attrs.drawAs }));
        return {
          coordinates: 'mils from the top-left corner of the page\'s paper, x to the right, y down; a symbol\'s x/y is its centre',
          labels_note: 'net labels; auto: true is a connection your drawing does not show, labelled by the kernel until you wire it (wire) or label it (label)',
          supplies_note: 'supply symbols; auto: true is one the kernel draws at pins your drawing leaves loose, one for neighbouring pins on one supply (on a wire along their ends, shown but not stored). move_supply or label makes it yours',
          symbols_note: 'mirrored: true is how the symbol stands now (its left pins on the right; a two-pin part with pin 1 at the bottom or, lying, on the right); to swap it, give place_symbol mirror the opposite of this. rotated: degrees clockwise from how it is usually drawn (place_symbol rotate), lying: a two-pin part lying (place_symbol orient). text_user_placed: the user put its name or value where they stand. With texts: true, name and value say where its text stands (place_text moves them): y is the baseline, anchor which part of the text stands at x',
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
              const text = (t: SymbolView['refPos']) => ({ x: r(t.x - p.rect.x), y: r(t.y - p.rect.y), anchor: t.anchor });
              return { ref: `${sym.refdes}${sym.unit ?? ''}`, page: p.number, x: r(cx - p.rect.x), y: r(cy - p.rect.y), w: sym.bbox.w, h: sym.bbox.h, ...(sym.rotation ? { lying: true } : {}), ...(sym.rotated ? { rotated: sym.rotated } : {}), ...(sym.mirrored ? { mirrored: true } : {}), ...(sym.by ? { user_placed: true } : {}), ...(sym.textBy ? { text_user_placed: true } : {}), ...(q.texts ? { name: text(sym.refPos), value: text(sym.valuePos) } : {}) };
            }),
          ),
          // net labels, at the pin they sit on; auto: a connection the drawing does not show yet
          labels: view.sheets.flatMap((s) =>
            s.labels
              .filter((l) => l.kind === 'net')
              .map((l) => {
                const { pin, pg } = where(s, l);
                const at = pin ?? `page ${pg.number} (${r(l.x - pg.rect.x)}, ${r(l.y - pg.rect.y)})`;
                return { net: l.text, at, dir: l.dir, ...(l.auto ? { auto: true } : {}) };
              }),
          ),
          // supply symbols, where they stand (move_supply)
          supplies: view.sheets.flatMap((s) =>
            s.labels
              .filter((l) => l.kind !== 'net')
              .map((l) => {
                const { pin, pg } = where(s, l);
                return { net: l.text, page: pg.number, x: r(l.x - pg.rect.x), y: r(l.y - pg.rect.y), ...(pin ? { at: pin } : {}), ...(l.auto ? { auto: true } : {}) };
              }),
          ),
          ...(forced.length ? { forced_nets: forced } : {}),
        };
      }
      case 'get_copper': {
        const b = this.board({}, bid);
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
      case 'get_board':
        return this.boardAnswer(all, bid, q.drc);
      case 'try_placements':
        return tryPlacements(d, this.analyse(all).view, q.candidates, !!q.route, this.viewOfBoard(all, bid), q.explore !== false);
      case 'suggest_moves':
        return suggestMoves(d, this.analyse(all).view, this.board({}, bid), q);
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
      // the app answers these with the board's facts and the guide; the kernel alone knows the design's part
      case 'get_enclosure':
        return enclosureAnswer({ brief: d.enclosure?.brief ?? null, script: d.enclosure?.script ?? null, graphics: enclosureGraphicsInfo(d.enclosure?.graphics) }, q);
      case 'get_guide':
        return { error: 'The guides are served by the app.' };
      case 'list_blocks':
        return { error: 'list_blocks is answered by the app, which reads the projects folder.' };
    }
  }

  /** get_board for one board: routing is expensive, so the routed board where it has been computed, otherwise placement only (drawn copper routes nothing: always computed). */
  private boardAnswer(all: Design, id: string, drc?: DrcFilter) {
    const d = this.focus(all, id);
    const routed = d.board?.drawn ? this.board({}, id) : this.viewOfBoard(all, id);
    const b = routed ?? this.boardPlacement(id);
    return { ...boardSummary(b, !!routed, drc), plane_plan: planePlan(d, b) };
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
    const multi = multiBoard(d);
    const bname = (id: string) => d.boards?.[id]?.name ?? id;
    return {
      name: d.name,
      sheets: Object.values(d.sheets).sort((a, b) => a.order - b.order).map((s) => s.name),
      pages: this.analyse(d).view.sheets.reduce((n, s) => n + s.pages.length, 0),
      ...(multi
        ? {
            boards: boardList(d).map((b) => ({
              name: b.name,
              id: b.id,
              sheets: Object.values(d.sheets).filter((s) => (s.board && d.boards![s.board] ? s.board : FIRST_BOARD) === b.id).sort((x, y) => x.order - y.order).map((s) => s.name),
              parts: Object.values(d.components).filter((c) => boardOf(d, c) === b.id).length,
            })),
          }
        : {}),
      ...(d.mates && Object.keys(d.mates).length
        ? {
            mates: Object.values(d.mates).map((m) => {
              const { pairs, fit } = matePairs(d, m);
              return { id: m.id, a: d.components[m.a]?.refdes ?? '?', b: d.components[m.b]?.refdes ?? '?', kind: m.kind + (m.cable === 'reversed' ? ' (reversed)' : ''), pins: pairsText(d, m, pairs), ...(m.height_mm !== undefined ? { height_mm: m.height_mm } : {}), ...(fit ? { fit } : {}) };
            }),
          }
        : {}),
      components: componentsSorted(d).map((c) => ({ refdes: c.refdes, part: c.part, value: valueOf(d, c), sheet: d.sheets[c.sheet]?.name ?? '?', ...(multi ? { board: bname(boardOf(d, c)) } : {}) })),
      nets: Object.values(d.nets)
        .sort((a, b) => natCmp(a.name, b.name))
        .map((n) => {
          const on = multi ? [...new Set((members.get(n.id) ?? []).map((m) => bname(boardOf(d, m.comp))))] : [];
          return {
            name: n.name,
            pins: members.get(n.id)?.length ?? 0,
            ...(n.attrs.voltage !== undefined ? { voltage: n.attrs.voltage } : {}),
            ...(n.attrs.external ? { external: true } : {}),
            ...(on.length > 1 ? { boards: on } : {}),
          };
        }),
      counts: countDiagnostics(this.analyse(d).diagnostics),
      ledger: Object.keys(d.ledger).length,
      waivers: Object.keys(d.waivers).length,
      ...(d.description ? { description: { blocks: d.description.blocks.length, undescribed: descriptionView(d)!.undescribed } } : {}),
      ...(d.valueSeries ? { valueSeries: { ...d.valueSeries } } : {}),
      stackup: (({ name, copper, dielectric, mask }) => ({ name, copper, dielectric, ...(mask ? { mask } : {}) }))(boardStackup(d.board ?? DEFAULT_BOARD)),
      ...(d.board?.rules.currentRise ? { currentRise: d.board.rules.currentRise } : {}),
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
      boards: this.boardList(),
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
    this.draft = this.committed;
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

