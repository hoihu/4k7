/**
 * The design kernel: committed design + agent working copy (draft), transactions,
 * proposals (changesets), history. Synchronous and deterministic; the web app runs it
 * in a Web Worker. M0 is TypeScript; the Rust/WASM kernel will implement this same API.
 */
import {
  paramSpecs,
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
  type SchematicRule,
  SCHEMATIC_RULES,
  PAGE,
  boardSummary,
  parseSchematicRules,
  DEFAULT_BOARD,
  fabPresets,
  fabSummary,
  trackWidthFor,
} from '@4k7/schema';
import { packageChoice, packageOptions, searchParts } from '@4k7/parts';
import { applyOp, describeConstraint, descriptionView } from './apply.ts';
import { countDiagnostics, diagKey, runChecks, sortDiagnostics } from './checks.ts';
import { computeHunks, mergeHunks } from './diff.ts';
import { RejectError, applyWaivers, cardOf, clone, componentsSorted, findComponent, findNet, gcNets, gcParts, isGroundNet, isPowerNet, natCmp, netMembers, valueOf } from './doc.ts';
import { layoutSchematic } from './layout.ts';
import { layoutBoard, placeBoard } from './board.ts';
import { canonicalJson, migrate } from './canonical.ts';
import { MIN_FREE, circuitSignature, guardOp, measure, positions, resolveScope, ripple, widenScope, type ResolvedScope } from './scope.ts';
import { schematicChecks } from './schcheck.ts';

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
  private undoStack: { design: Design; entry: HistoryEntry }[] = [];
  /** Commits taken back by undo, newest last; any new commit clears it. */
  private redoStack: { design: Design; entry: HistoryEntry }[] = [];
  private history: HistoryEntry[] = [];
  private historySeq = 1;
  private pendingSummaries: string[] = [];
  /** The Optimize area while the agent works on it, with the state it started from. */
  private scoped: { sc: ResolvedScope; sheet: SheetView; pos: Map<string, readonly number[]>; circuit: string } | null = null;
  /** The schematic rules the SCH checks run with (setRules); the shipped default until the user edits them. */
  private rules: Record<string, SchematicRule> = parseSchematicRules(SCHEMATIC_RULES).rules;

  constructor(design?: Design) {
    this.committed = design ? migrate(clone(design)) : emptyDesign();
    this.draft = clone(this.committed);
  }

  /* ------------------------------ analysis -------------------------------- */

  private analyse(d: Design): Analysis {
    let a = this.cache.get(d);
    if (!a) {
      const view = layoutSchematic(d);
      const sch = schematicChecks(d, view, this.rules);
      applyWaivers(d, sch);
      a = { view, diagnostics: sortDiagnostics([...runChecks(d, view.constraintStatus, view.constraintWhy), ...sch]) };
      this.cache.set(d, a);
    }
    return a;
  }

  /** The schematic ruleset to check against (the markdown; null = the shipped default). Every analysis is redone. */
  setRules(md: string | null): void {
    this.rules = parseSchematicRules(md ?? SCHEMATIC_RULES).rules;
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

  /** Placement only (fast): parts, outline, ratsnest and placement checks. */
  boardPlacement(): BoardView {
    return placeBoard(this.draft, this.analyse(this.draft).view);
  }

  /** The board of the working copy: placement, routing and DRC (computed on demand, cached). */
  board(): BoardView {
    const d = this.draft;
    let b = this.boards.get(d);
    if (!b) {
      b = layoutBoard(d, this.analyse(d).view);
      this.boards.set(d, b);
    }
    return b;
  }

  /* ---------------------------- transactions ------------------------------ */

  /** Validate and apply a transaction to the working copy (or dry-run it). */
  transact(input: unknown): TransactionResult {
    const parsed = Transaction.safeParse(input);
    if (!parsed.success) {
      return this.rejected({ opIndex: indexOfIssue(parsed.error.issues), code: 'INVALID_OP', message: formatZod(parsed.error.issues) }, false);
    }
    const tx = parsed.data;
    const before = this.analyse(this.draft).diagnostics;
    const work = clone(this.draft);
    const results = [];
    for (let i = 0; i < tx.ops.length; i++) {
      try {
        if (this.scoped) guardOp(work, tx.ops[i]!, this.scoped.sc);
        results.push(applyOp(work, tx.ops[i]!));
      } catch (e) {
        if (e instanceof RejectError) return this.rejected({ opIndex: i, ...e.rejection }, !!tx.dry_run);
        throw e;
      }
    }
    gcNets(work);
    gcParts(work);
    if (this.scoped && circuitSignature(work) !== this.scoped.circuit) {
      return this.rejected({ opIndex: tx.ops.length - 1, code: 'OUT_OF_SCOPE', message: 'This would change the circuit (parts, values or connections). Optimize only changes how an area is drawn.' }, !!tx.dry_run);
    }
    const analysed = this.analyse(work);
    const after = analysed.diagnostics;
    if (!tx.dry_run) {
      this.draft = work;
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
    this.pendingSummaries = [];
    return { entry, notes };
  }

  reject(): void {
    this.draft = clone(this.committed);
    this.pendingSummaries = [];
  }

  undo(): HistoryEntry | null {
    const last = this.undoStack.pop();
    if (!last) return null;
    this.redoStack.push({ design: this.committed, entry: last.entry });
    this.committed = last.design;
    this.draft = clone(last.design);
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
          specs: card ? paramSpecs(card) : {},
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
        return { id: n.id, name: n.name, kind, attrs: n.attrs, pins, track };
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
        const placedBy = new Map(Object.values(d.ledger).filter((k) => k.kind === 'sch_position').map((k) => [`${k.a}${k.aUnit ?? ''}`, k.id]));
        const r = (v: number) => Math.round(v);
        return {
          coordinates: 'mils from the top-left corner of the page\'s paper, x to the right, y down; a symbol\'s x/y is its centre',
          drawing_area: { margin: PAGE.margin, title_block: `${PAGE.title} high, at the bottom` },
          pages: view.sheets.flatMap((s) =>
            s.pages.map((p) => ({ page: p.number, sheet: s.name, name: p.name, w: p.rect.w, h: p.rect.h, ...(p.oversized ? { oversized: true } : {}) })),
          ),
          symbols: view.sheets.flatMap((s) =>
            s.symbols.map((sym) => {
              const cx = sym.bbox.x + sym.bbox.w / 2;
              const cy = sym.bbox.y + sym.bbox.h / 2;
              const p = s.pages.find((pg) => cx >= pg.rect.x && cx <= pg.rect.x + pg.rect.w && cy >= pg.rect.y && cy <= pg.rect.y + pg.rect.h) ?? s.pages[0]!;
              const k = placedBy.get(`${sym.componentId}${sym.unit ?? ''}`);
              return { ref: `${sym.refdes}${sym.unit ?? ''}`, page: p.number, x: r(cx - p.rect.x), y: r(cy - p.rect.y), w: sym.bbox.w, h: sym.bbox.h, placed: k ? `by you (${k}, ${view.constraintStatus[k] ?? 'ok'})` : 'by the layout' };
            }),
          ),
        };
      }
      case 'get_board': {
        // routing is expensive: use it when it has been computed, otherwise placement only
        const routed = this.boards.get(d);
        return routed ? boardSummary(routed) : boardSummary(this.boardPlacement(), false);
      }
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
    }
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
    this.draft = clone(this.committed);
    this.undoStack = [];
    this.redoStack = [];
    this.history = [];
    this.pendingSummaries = [];
    this.scoped = null;
  }

  rename(name: string): void {
    this.committed.name = name;
    this.draft.name = name;
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

