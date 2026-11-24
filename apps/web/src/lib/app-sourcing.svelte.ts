/**
 * Sourcing (Layout → Sourcing, and the agent's sourcing tool): the stock, cost and values checks
 * of the working copy at the chosen assembly house, the last reports, and the edits that take a
 * replacement, a saving or a candidate. The pure checks are in sourcing.ts. See docs/design/sourcing.md.
 */
import type { KernelState } from '@4k7/kernel';
import { ASSEMBLY_HOUSE, assemblyHouse, money, type AssemblyHouse, type BoardView, type PartCard, type ScopeInfo } from '@4k7/schema';
import { assemblyFacts, combineCosts, combineEstimates, mergeFacts, placedLand, type Saving, type SourcedComponent, type StockLine, type UnsourcedGroup } from '@4k7/parts';
import type { createKernel } from './kernelClient.ts';
import type { Settings } from './persist.ts';
import { checkDesignCost, checkDesignStock, checkDesignValues, type BoardFacts, type CostReport, type StockReport, type SupplierPart } from './sourcing.ts';

type KernelSourcing = Pick<ReturnType<typeof createKernel>, 'query' | 'boardPlacement' | 'boardPlacements'>;

/** What sourcing reads off the app, live (each call reads the app's state as it is now). */
export interface SourcingHost {
  k(): KernelState | null;
  settings(): Settings;
  designParts(): Record<string, PartCard>;
  board(): BoardView | null;
  userEdit(summary: string, ops: unknown[]): Promise<boolean>;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  send(text: string, opts: { shown?: string; scope?: ScopeInfo }): Promise<void>;
  flash(msg: string): void;
}

export class SourcingState {
  /** The last stock check and cost check of the chosen house (the Layout view shows them; the agent's land here too), and which one it shows. */
  private lastStock = $state.raw<StockReport | null>(null);
  private lastCost = $state.raw<CostReport | null>(null);
  get stockReport(): StockReport | null {
    return this.lastStock?.house === this.house.name ? this.lastStock : null;
  }
  get costReport(): CostReport | null {
    return this.lastCost?.house === this.house.name ? this.lastCost : null;
  }
  sourcingShown = $state<'stock' | 'cost'>('stock');
  stockBusy = $state(false);
  #kernel: KernelSourcing;
  #app: SourcingHost;

  constructor(kernel: KernelSourcing, app: SourcingHost) {
    this.#kernel = kernel;
    this.#app = app;
  }

  private get k() {
    return this.#app.k();
  }
  private get settings() {
    return this.#app.settings();
  }

  /**
   * The working copy's components as the stock check sees them: what each is, its values, its
   * package, and its land as it lies on the board (held against the house's footprint for the part).
   */
  private async sourcedComponents(): Promise<SourcedComponent[]> {
    type Info = { refdes: string; part: string; category?: SourcedComponent['category']; params: Record<string, string>; package?: { name: string }; dnp?: boolean; padOnly?: boolean };
    const refs = this.k?.summary.components.map((c) => c.refdes) ?? [];
    const [infos, board] = await Promise.all([
      Promise.all(refs.map((ref) => this.#kernel.query({ op: 'get_component', ref }))) as Promise<(Info | { error: string })[]>,
      this.#kernel.boardPlacements().catch(() => null),
    ]);
    // every board's parts (several boards: each part is on one)
    const placed = new Map((board ?? []).flatMap((b) => b.parts).map((p) => [p.refdes, p]));
    return infos.flatMap((c) => {
      if (!('refdes' in c)) return [];
      const card = this.#app.designParts()[c.part];
      const pkg = c.package?.name ?? c.params.package ?? card?.package;
      const mpn = c.params.mpn ?? card?.mpn;
      const p = placed.get(c.refdes);
      const land = p && card ? placedLand(p, (pin) => card.pins.find((x) => x.number === pin)?.name) : undefined;
      return [{ refdes: c.refdes, ...(c.category ? { category: c.category } : {}), params: c.params, ...(pkg ? { pkg } : {}), ...(mpn ? { mpn } : {}), ...(land ? { land } : {}), ...(c.dnp || c.padOnly ? { dnp: true } : {}) }];
    });
  }

  /**
   * What the assembly fees depend on, read off the working copy's placed board (joints, sides,
   * size); null when it cannot be placed. Several boards and none named: all of them as one (for
   * the values check, which compares parts by their fees; the stock and cost checks go board by
   * board, see perBoard).
   */
  private async boardFacts(board?: string): Promise<BoardFacts | null> {
    try {
      if (board === undefined && (this.k?.boards.length ?? 1) > 1) {
        const all = await this.#kernel.boardPlacements();
        return (assembled, kinds) => mergeFacts(all.map((b) => assemblyFacts(b, assembled, kinds)));
      }
      const b = await this.#kernel.boardPlacement(board);
      return (assembled, kinds) => assemblyFacts(b, assembled, kinds);
    } catch {
      return null;
    }
  }

  /**
   * A design of several boards: each board's components and facts, for an order per board at the
   * one house (docs/design/multi-board.md §5); null with one board.
   */
  private async perBoard(components: SourcedComponent[]): Promise<{ name: string; components: SourcedComponent[]; facts: BoardFacts }[] | null> {
    const boards = this.k?.boards ?? [];
    if (boards.length < 2) return null;
    const on = new Map(this.k!.summary.components.map((c) => [c.refdes, c.board]));
    return Promise.all(
      boards.map(async (b) => {
        const facts = await this.boardFacts(b.id);
        if (!facts) throw new Error(`board "${b.name}" could not be placed, so its assembly fees cannot be counted`);
        return { name: b.name, components: components.filter((c) => on.get(c.refdes) === b.name), facts };
      }),
    );
  }

  /** The assembly house the checks run for: the user's pick (Layout → Sourcing), else the board's manufacturer when it assembles, else the default. */
  get house(): AssemblyHouse {
    return assemblyHouse(this.settings.assemblyHouse) ?? assemblyHouse(this.#app.board()?.fab?.house) ?? ASSEMBLY_HOUSE;
  }

  /** Source at another house (the Layout view shows a report only for the house it was made for). */
  chooseHouse(id: string) {
    return this.#app.updateSettings({ assemblyHouse: id });
  }

  /** Check the stock of every part for `boards` boards (default: the number set in the Layout view) at a house, with the order's estimate; the Layout view shows the chosen house's report. */
  async checkStock(boards?: number, house: AssemblyHouse = this.house): Promise<StockReport> {
    this.stockBusy = true;
    try {
      const components = await this.sourcedComponents();
      const per = await this.perBoard(components).catch(() => null);
      const n = boards ?? this.settings.buildBoards;
      // several boards: the stock for every board together, the order board by board
      const report = await checkDesignStock(components, n, per ? undefined : ((await this.boardFacts()) ?? undefined), house);
      if (per) {
        const each = await Promise.all(per.map(async (b) => ({ name: b.name, estimates: (await checkDesignStock(b.components, n, b.facts, house)).estimates ?? [] })));
        report.estimates = combineEstimates(each);
      }
      if (house.id === this.house.id) {
        this.lastStock = report;
        this.sourcingShown = 'stock';
      }
      return report;
    } finally {
      this.stockBusy = false;
    }
  }

  /** The cost check for `boards` boards at a house: the estimate at each service and what would make the order cheaper; the Layout view shows the chosen house's. */
  async checkCost(boards?: number, house: AssemblyHouse = this.house): Promise<CostReport> {
    this.stockBusy = true;
    try {
      const components = await this.sourcedComponents();
      const n = boards ?? this.settings.buildBoards;
      const per = await this.perBoard(components);
      let report: CostReport;
      if (per) {
        // several boards: an order per board at the one house, added up; the stock for them all together
        const [stock, ...each] = await Promise.all([checkDesignStock(components, n, undefined, house), ...per.map((b) => checkDesignCost(b.components, n, b.facts, house))]);
        report = combineCosts(per.map((b, i) => ({ name: b.name, report: each[i]! })), stock);
      } else {
        const facts = await this.boardFacts();
        if (!facts) throw new Error('the board could not be placed, so the assembly fees cannot be counted');
        report = await checkDesignCost(components, n, facts, house);
      }
      if (house.id === this.house.id) {
        this.lastCost = report;
        this.lastStock = report.stock;
        this.sourcingShown = 'cost';
      }
      return report;
    } finally {
      this.stockBusy = false;
    }
  }

  /** The values check for `boards` boards at a house (for the agent): cheaper ways to make each resistor and capacitor value. */
  async checkValues(boards?: number, house: AssemblyHouse = this.house) {
    const [components, facts] = await Promise.all([this.sourcedComponents(), this.boardFacts()]);
    if (!facts) throw new Error('the board could not be placed, so the assembly fees cannot be counted');
    return checkDesignValues(components, boards ?? this.settings.buildBoards, facts, house);
  }

  /** Hand the design to the agent to make it cheaper to make, for the boards set in the Layout view (it follows the cost guide). */
  optimizeCost() {
    const n = this.costReport?.boards ?? this.settings.buildBoards;
    void this.#app.send(
      `Make this design cheaper to make at ${this.house.name} for ${n} boards, without changing what it does. Read design_query get_guide topic "cost" first and follow it: ` +
        'measure with sourcing cost and sourcing values, decide part by part by what each does in the circuit, ask me before a change I may care about, ' +
        'make the rest in one changeset, check again with sourcing cost and sourcing check, and tell me the total before and after, what each change saves, and what you left as it was and why.',
      { shown: `Optimize the cost for ${n} boards` },
    );
  }

  /** Make a sourcing change (the user's), then run the check shown again. */
  private async sourcingEdit(summary: string, ops: unknown[]): Promise<boolean> {
    const ok = ops.length > 0 && (await this.#app.userEdit(summary, ops));
    if (ok) {
      const again = this.sourcingShown === 'cost' ? this.checkCost(this.costReport?.boards) : this.checkStock(this.stockReport?.boards);
      void again.catch((e: Error) => this.#app.flash(`The check failed: ${e.message}`));
    }
    return ok;
  }

  /** The ops that set the chosen house's part number on components (null: take it off them); none at a house without its own numbers. */
  private partOps(refs: string[], sku: string | null) {
    const param = this.house.param;
    return param ? refs.map((ref) => ({ op: 'set_param', ref, params: { [param]: sku } })) : [];
  }

  /** Take a replacement on every component of a stock check line. */
  useReplacement(line: StockLine, p: SupplierPart): Promise<boolean> {
    return this.sourcingEdit(`${line.refs.join(', ')}: ${p.sku} (${p.mpn}) instead of ${line.sku}`, this.partOps(line.refs, p.sku));
  }

  /** Take a saving of the cost check: its part; every part on the top side; or the hand-soldered parts off the order. */
  applySaving(s: Saving): Promise<boolean> {
    const saves = `saves ${money(s.saves, this.house)}`;
    if (s.to) return this.sourcingEdit(`${s.refs.join(', ')}: ${s.to.sku} (${s.to.mpn}) instead of ${s.from}, ${saves}`, this.partOps(s.refs, s.to.sku));
    if (s.kind === 'side') {
      const ops = (this.k?.ledger ?? []).filter((x) => s.refs.some((ref) => x.text.startsWith(`layer(${ref}) =`))).map((x) => ({ op: 'remove_constraint', id: x.id }));
      return this.sourcingEdit(`${s.refs.join(', ')} on the top side, ${saves}`, ops);
    }
    return this.sourcingEdit(`${s.refs.join(', ')} off the assembly order (soldered by hand), ${saves}`, this.partOps(s.refs, null));
  }

  /** Give components that had no part number one of the cost check's candidates. */
  useCandidate(g: UnsourcedGroup, p: SupplierPart): Promise<boolean> {
    return this.sourcingEdit(`${g.refs.join(', ')}: ${p.sku} (${p.mpn})`, this.partOps(g.refs, p.sku));
  }
}
