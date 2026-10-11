/**
 * Application state (Svelte 5 runes). Owns the kernel worker, the agent and settings.
 */
import {
  Agent,
  AnthropicProvider,
  DEMO_FALLBACK,
  DEMO_SCRIPTS,
  ScriptedProvider,
  compactTx,
  costUsd,
  describeTx,
  formatDesignContext,
  optimizePrompt,
  runCalc,
  type AgentEvent,
  type Provider,
} from '@tracewise/agent';
import type { KernelState } from '@tracewise/kernel';
import { tick } from 'svelte';
import { ArtworkInput, CalcCall, DatasheetInput, ImportPartInput, PendingImportInput, DESIGN_FORMAT_VERSION, ImageInput, ProposeInput, WaitForReviewInput, boardSummary, type BoardDiagnostic, type BoardView, type BridgeContent, type Design, type PaperId, type PartCard, type Rect, type ScopeInfo, type TokenCount } from '@tracewise/schema';
import { bridge } from './bridge.svelte.ts';
import { createKernel } from './kernelClient.ts';
import { BoardClient, type BoardStage } from './boardClient.ts';
import { IngestState } from './ingest.svelte.ts';
import { ArtworkLibrary } from './artwork.svelte.ts';
import { renderSchematicPng } from './snapshot.ts';
import { jlcTool } from './jlc.ts';
import { fabRefreshPrompt } from './fabRefresh.ts';
import {
  DEFAULT_SETTINGS,
  deleteKeptProject,
  keepProject,
  loadApiKey,
  loadKeptProjects,
  loadProject,
  loadSettings,
  saveApiKey,
  saveProject,
  saveSettings,
  storageHealth,
  storagePersistent,
  type KeptProject,
  type Settings,
} from './persist.ts';

/** A pairing link (#pair=123456) opened from the terminal; read before the router rewrites the hash. */
const pairFromLink = /^#pair=(\d{6})$/.exec(location.hash)?.[1] ?? null;

export type View = 'sch' | 'lay' | 'parts' | 'set';
export type InspectorTab = 'issues' | 'ledger' | 'history' | 'sel';

export type Segment =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; label: string; ok: boolean; detail: string }
  | { type: 'verify'; round: number; errors: number; message: string }
  | { type: 'question'; question: string; options: string[]; answered?: string }
  | { type: 'error'; text: string };

export interface ChatItem {
  id: number;
  role: 'user' | 'agent';
  text?: string;
  refs?: string[];
  segments: Segment[];
  status: 'streaming' | 'done';
  /** External agent driving the app through the bridge (e.g. "Claude Code"). */
  source?: string;
  /** This turn produced the proposal that is currently pending (or was decided). */
  changeset?: { state: 'pending' | 'accepted' | 'rejected' | 'superseded'; note?: string };
  /** Tokens this turn used (live while it runs), with the cost: estimated, or as Claude Code reported it. */
  usage?: TokenCount & { costUsd: number; exact: boolean };
}

/** The API price of some token usage (0 for a model without a known price). */
export function tokenCost(t: TokenCount, fallbackModel: string): number {
  return costUsd(t.model ?? fallbackModel, { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite });
}

class AppState {
  view = $state<View>('sch');
  tab = $state<InspectorTab>('issues');
  k = $state<KernelState | null>(null);
  /** Part cards as the working copy has them (a footprint given in the design shows in Parts). */
  designParts = $state.raw<Record<string, PartCard>>({});
  chat = $state<ChatItem[]>([]);
  running = $state(false);
  selection = $state<string[]>([]);
  /** Optimize: the area the agent is restricted to while it works on it. */
  scope = $state.raw<ScopeInfo | null>(null);
  sheet = $state(0);
  hunkOff = $state<Record<string, boolean>>({});
  hoverHunk = $state<string | null>(null);
  showDiff = $state(true);
  chatOpen = $state(true);
  settings = $state<Settings>({ ...DEFAULT_SETTINGS });
  apiKey = $state('');
  spend = $state(0);
  lastModel = $state('');
  ready = $state(false);
  toast = $state<string | null>(null);
  input = $state('');
  persistent = $state<boolean | null>(null);
  /** Saved projects this version could not read, kept instead of being saved over. */
  keptProjects = $state.raw<KeptProject[]>([]);
  /** Board view of the working copy, computed when the Layout view is open. */
  board = $state.raw<BoardView | null>(null);
  boardBusy = $state(false);
  boardStage = $state<BoardStage>('placed');
  private boards = new BoardClient();
  /** Design revision (bumped on every refresh) and the revision the shown board was computed for. */
  private rev = 0;
  private boardRev = -1;

  private kernel = createKernel();
  /** Datasheet import (Parts view). */
  ingest = new IngestState(this.kernel);
  artwork = new ArtworkLibrary(this.kernel);
  private agent!: Agent;
  private abort: AbortController | null = null;
  private seq = 1;
  private reviewWaiters: ((result: string) => void)[] = [];
  /** The in-app agent is running (external agents must wait). */
  private inAppBusy = false;
  /** The saved project could not be read nor kept aside: do not save over it until the user replaces it. */
  private saveBlocked = false;
  /** Claude Code answering the app chat through the bridge: session and current run. */
  private claudeSession: string | null = null;
  private claudeRun: { id: string; item: ChatItem } | null = null;

  async init() {
    this.settings = await loadSettings();
    this.apiKey = await loadApiKey('anthropic');
    const saved = await loadProject();
    if (saved) {
      try {
        await this.kernel.load(JSON.parse(saved) as Design);
      } catch (e) {
        // the next save would replace it: keep it aside first
        const reason = (e as Error).message;
        this.saveBlocked = !(await keepProject(saved, reason));
        this.flash(`Could not load the saved project: ${reason}. ${this.saveBlocked ? 'Nothing is saved until you start or import a project.' : 'It is kept under Settings → Project.'}`);
      }
    }
    this.keptProjects = await loadKeptProjects();
    await this.ingest.init().catch((e: Error) => this.flash(`Could not load imported parts: ${e.message}`));
    await this.artwork.init().catch((e: Error) => this.flash(`Could not load the artwork library: ${e.message}`));
    const newer = this.ingest.newer + this.artwork.newer;
    if (newer) this.flash(`${newer} saved ${newer === 1 ? 'library item was' : 'library items were'} written by a newer version of the app and not loaded`);
    await this.ingest.adoptFootprints(JSON.parse(await this.kernel.exportDesign()) as Design).catch(() => {});
    this.agent = new Agent({ provider: this.makeProvider(), kernel: this.kernel.port, fixBudget: this.settings.fixBudget, tools: { jlc_search: jlcTool } });
    this.settingsChannel?.addEventListener('message', (e: MessageEvent<{ type: string; code?: string }>) => {
      if (e.data?.type === 'bridge-held' && e.data.code) bridge.heldElsewhere(e.data.code);
      else void this.reloadSettings();
    });
    this.applyTheme();
    await this.refresh();
    bridge.init(
      (tool, input) => this.handleBridgeCall(tool, input),
      (code, port) => {
        // pairing with a bridge that can run Claude Code makes it the chat provider, unless the user has an API key set up
        // "no real model configured" = offline demo, or Anthropic chosen without a key
        const noModel = this.settings.provider === 'demo' || (this.settings.provider === 'anthropic' && !this.apiKey);
        const useClaude = bridge.chat?.available && noModel;
        void this.updateSettings({ bridgeCode: code, bridgePort: port, ...(useClaude ? { provider: 'claude-code' as const } : {}) });
        this.settingsChannel?.postMessage({ type: 'bridge-held', code });
        if (useClaude) this.flash('Paired: the chat now runs on your Claude Code');
      },
      () => {
        // the external agent went away: close its open activity block
        for (const c of this.chat) if (c.source && c.status === 'streaming') c.status = 'done';
      },
      () => this.diagnostics(),
    );
    this.persistent = await storagePersistent();
    if (pairFromLink) {
      history.replaceState(null, '', '#sch');
      void bridge.connect(pairFromLink).then((ok) => this.flash(ok ? `Paired with ${bridge.agent ?? 'the bridge'}` : (bridge.error ?? 'Pairing failed')));
    } else if (this.settings.bridgeCode) {
      void bridge.connect(this.settings.bridgeCode, { silent: true, preferPort: this.settings.bridgePort });
    }
    this.ready = true;
  }

  /* -------------------------------- kernel -------------------------------- */

  async refresh() {
    this.rev++;
    this.k = await this.kernel.state();
    this.designParts = await this.kernel.designParts();
    const ids = new Set(this.k.proposal?.hunks.map((h) => h.id) ?? []);
    for (const id of Object.keys(this.hunkOff)) if (!ids.has(id)) delete this.hunkOff[id];
    if (this.sheet >= (this.k.view.sheets.length || 1)) this.sheet = 0;
    if (this.view === 'lay') void this.refreshBoard();
  }

  /** Recompute the board in the board worker: placement first (fast), then routing and DRC. */
  async refreshBoard() {
    const rev = this.rev;
    const design = await this.kernel.draftDesign();
    this.boardBusy = true;
    this.boardStage = 'placed';
    this.boards.compute(
      design,
      (stage, board) => {
        this.board = board;
        this.boardStage = stage;
        if (stage === 'routed') {
          this.boardBusy = false;
          this.boardRev = rev;
        }
      },
      (msg) => {
        this.boardBusy = false;
        this.flash(`Board layout failed: ${msg}`);
      },
    );
  }

  /** The routed board of the current design, for agents (computed if needed). */
  private async routedBoard(): Promise<BoardView | null> {
    if (!this.boards.busy && this.board && this.boardStage === 'routed' && this.boardRev === this.rev) return this.board;
    const next = this.boards.next();
    if (!this.boards.busy) void this.refreshBoard();
    return next;
  }

  get pendingCount() {
    return this.k?.proposal?.hunks.length ?? 0;
  }

  get acceptedCount() {
    return (this.k?.proposal?.hunks ?? []).filter((h) => !this.hunkOff[h.id]).length;
  }

  async accept() {
    const p = this.k?.proposal;
    if (!p) return;
    const ids = p.hunks.filter((h) => !this.hunkOff[h.id]).map((h) => h.id);
    const res = await this.kernel.accept(ids, 'user');
    this.markChangeset('accepted', `${ids.length} of ${p.hunks.length} committed as #${res.entry?.id ?? '?'}` + (res.notes.length ? ` · ${res.notes.join('; ')}` : ''));
    this.hunkOff = {};
    await this.persist();
    await this.refresh();
  }

  async reject() {
    await this.kernel.reject();
    this.markChangeset('rejected', 'Rejected. Tell the agent what to change.');
    this.hunkOff = {};
    await this.refresh();
  }

  async undo() {
    const e = await this.kernel.undo();
    if (e) this.flash(`Undid #${e.id} ${e.summary}`);
    await this.persist();
    await this.refresh();
  }

  async redo() {
    const e = await this.kernel.redo();
    if (e) this.flash(`Redid #${e.id} ${e.summary}`);
    await this.persist();
    await this.refresh();
  }

  /** The paper size of the schematic pages (A4, A3…). */
  setPaper(size: PaperId) {
    return this.userEdit(`Schematic paper ${size}`, [{ op: 'set_paper', size }]);
  }

  /** A direct user edit (e.g. removing a ledger entry) commits immediately, attributed to the user. */
  async userEdit(summary: string, ops: unknown[]): Promise<boolean> {
    if (this.k?.proposal) {
      this.flash('Review the pending changes first.');
      return false;
    }
    const r = await this.kernel.transact({ summary, ops });
    if (r.status !== 'ok') {
      this.flash(r.rejection?.message ?? 'Rejected');
      return false;
    }
    await this.kernel.accept(undefined, 'user', summary);
    await this.persist();
    await this.refresh();
    return true;
  }

  /** Mark a board check as intended ("not a problem"): a waiver, so it drops out of the checks and stays out. */
  waiveCheck(d: BoardDiagnostic): Promise<boolean> {
    return this.userEdit(`Not a problem: ${d.code} on ${d.entities.join(', ')}`, [{ op: 'add_waiver', code: d.code, entities: d.entities, reason: 'Marked as intended in the layout checks' }]);
  }

  /** Bring a waived board check back. */
  restoreCheck(waiverId: string): Promise<boolean> {
    return this.userEdit(`Check back on (${waiverId})`, [{ op: 'remove_waiver', id: waiverId }]);
  }

  /** Put a part on the bottom or the top side of the board (a layer constraint; top is the default, so none). */
  setSide(ref: string, side: 'top' | 'bottom'): Promise<boolean> {
    const old = (this.k?.ledger ?? []).filter((x) => x.text.startsWith(`layer(${ref}) =`)).map((x) => ({ op: 'remove_constraint', id: x.id }));
    return this.userEdit(`${ref} on the ${side} side`, [...old, ...(side === 'bottom' ? [{ op: 'constrain', kind: 'layer', a: ref, value: 'bottom' }] : [])]);
  }

  /**
   * The import_part tool: the datasheet import of the Parts view, started by the agent. A clean
   * result (accepted, both passes agree) goes straight into the library; disagreements between
   * the passes wait for the user's review in Parts.
   */
  private async importPart(args: { mpn: string; datasheet_url: string; notes?: string; timeout_s: number }): Promise<{ isError: boolean; content: BridgeContent[] }> {
    const text = (t: string, isError = false) => ({ isError, content: [{ type: 'text' as const, text: t }] });
    const ing = this.ingest;
    const same = ing.request?.mpn.toLowerCase() === args.mpn.trim().toLowerCase();
    const known = ing.library.find((p) => p.mpn?.toLowerCase() === args.mpn.trim().toLowerCase());
    if (known && !(same && ing.phase !== 'idle')) return text(`${args.mpn} is already in the library as ${known.id}; add it with add_part.`);
    if (ing.phase === 'running' && !same) return text(`Another import (${ing.request?.mpn}) is running; try again when it has finished.`, true);
    if (ing.phase === 'review' && !same) return text(`The import of ${ing.request?.mpn} is waiting for the user's review in Parts; ask them to save or discard it first.`, true);
    if (ing.phase !== 'running' && !(same && ing.phase === 'review')) {
      await ing.start({ mpn: args.mpn, url: args.datasheet_url, ...(args.notes ? { notes: args.notes } : {}), model: 'sonnet', verify: true });
      this.flash(`Importing ${args.mpn} from its datasheet`);
    }
    const until = Date.now() + args.timeout_s * 1000;
    while (ing.phase === 'running' && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
    if (ing.phase === 'running') return text(`Still importing ${args.mpn} (${ing.log.at(-1) ?? 'working'}). Call import_part again with the same mpn to keep waiting.`);
    if (ing.phase === 'failed') return text(`The import of ${args.mpn} failed: ${ing.error ?? 'unknown error'}`, true);
    const card = ing.card;
    const warnings = ing.issues.filter((i) => i.severity === 'warning').map((i) => `- ${i.message}`);
    if (!card) return text(`The import of ${args.mpn} produced no usable part:\n${ing.issues.map((i) => `- ${i.message}`).join('\n')}`, true);
    if (ing.disagreements.length || ing.secondPassFailed || warnings.length) {
      const why = [
        ing.secondPassFailed && `the cross-check pass did not finish (${ing.secondPassFailed})`,
        ing.disagreements.length && `the two independent passes read ${ing.disagreements.length} fact(s) differently`,
        warnings.length && `the checks raised ${warnings.length} warning(s)`,
      ].filter(Boolean).join(', and ');
      this.flash(`${args.mpn}: import waiting for review`);
      return text(
        `${card.id} was extracted, but ${why}; it is not in the library yet. Settle it with pending_import (get, then pick or correct pins/package from the datasheet with read_datasheet, then save), ` +
          `or leave it to the user in Parts.\n${ing.agentSummary()}`,
      );
    }
    const saved = await ing.save();
    if (!saved) return text(`Saving ${args.mpn} failed.`, true);
    this.flash(`${saved.mpn ?? saved.id} added to your library`);
    return text(
      `Imported ${saved.id}: ${saved.pins.length} pins, package ${saved.package ?? '?'}, both passes agree; it is in the library now (add_part part "${saved.id}").` +
        (warnings.length ? `\nWarnings (the user can check them in Parts):\n${warnings.join('\n')}` : ''),
    );
  }

  /** The read_datasheet tool: page index, text search, or one page (text and picture). */
  private async readDatasheet(args: { part: string; page?: number; find?: string; region?: [number, number, number, number] }): Promise<{ isError: boolean; content: BridgeContent[] }> {
    const text = (t: string, isError = false) => ({ isError, content: [{ type: 'text' as const, text: t }] });
    let id = args.part;
    const comp = (await this.kernel.query({ op: 'get_component', ref: args.part })) as { part?: string };
    if (comp?.part) id = comp.part;
    const pending = this.ingest.card;
    const card =
      this.designParts[id] ??
      this.ingest.library.find((p) => p.id === id) ??
      (pending && (pending.id === id || pending.mpn?.toLowerCase() === args.part.toLowerCase()) ? pending : undefined);
    if (!card) return text(`No part or component "${args.part}".`, true);
    const ds = await this.ingest.datasheetFor(card);
    if (!ds) return text(`${card.id} has no stored datasheet (only parts imported from a PDF keep theirs)${card.datasheet ? `; its datasheet link: ${card.datasheet}` : ''}.`, true);
    const { openPdf, pageText, pageCount, cropPage } = await import('./pdf.ts');
    const doc = await openPdf(ds.hash, ds.data);
    const n = pageCount(doc);
    if (args.page) {
      if (args.page > n) return text(`The datasheet has ${n} pages.`, true);
      const body = await pageText(doc, args.page);
      const src = await cropPage(doc, args.page, args.region ?? [0, 0, 1, 1], args.region ? 1600 : 1400);
      return {
        isError: false,
        content: [
          { type: 'text', text: `${card.id} datasheet, page ${args.page} of ${n}${args.region ? ` (region ${args.region.join(', ')})` : ''}:\n${body}` },
          { type: 'image', data: src.slice(src.indexOf(',') + 1), mimeType: 'image/jpeg' },
        ],
      };
    }
    const pages = await Promise.all(Array.from({ length: n }, (_, i) => pageText(doc, i + 1)));
    if (args.find) {
      const q = args.find.toLowerCase();
      const hits = pages.flatMap((t, i) => {
        const line = t.split('\n').find((l) => l.toLowerCase().includes(q));
        return line ? [`p.${i + 1}: ${line.slice(0, 160)}`] : [];
      });
      return text(hits.length ? hits.join('\n') : `"${args.find}" is not in the datasheet text (drawings may hold it as a picture: read the page).`);
    }
    const index = pages.map((t, i) => `p.${i + 1}: ${t.split('\n').find((l) => l.trim().length > 3)?.slice(0, 100) ?? '(no text: a picture)'}`);
    const refs = [card.packageInfo?.page && `package drawing p.${card.packageInfo.page}`, card.provenance.page && `pinout p.${card.provenance.page}`].filter(Boolean);
    return text(`${card.id} datasheet ${ds.name}, ${n} pages${refs.length ? ` (${refs.join(', ')})` : ''}:\n${index.join('\n')}`);
  }

  async queryNet(net: string): Promise<unknown> {
    return this.kernel.query({ op: 'get_net', net });
  }

  async queryComponent(ref: string): Promise<unknown> {
    return this.kernel.query({ op: 'get_component', ref });
  }

  private markChangeset(state: 'accepted' | 'rejected', note: string) {
    const item = [...this.chat].reverse().find((c) => c.changeset?.state === 'pending');
    if (item) item.changeset = { state, note };
    const waiters = this.reviewWaiters.splice(0);
    for (const w of waiters) w(state === 'accepted' ? `accepted: ${note}` : 'rejected by the user. Ask them what to change.');
  }

  /** What this tab reports about itself (Settings → Diagnostics, and to the bridge log). */
  diagnostics() {
    return {
      origin: location.origin,
      build: __BUILD_ID__,
      userAgent: navigator.userAgent,
      provider: this.settings.provider + (this.settings.provider === 'anthropic' && !this.apiKey ? ' (no key)' : ''),
      storage: storageHealth,
      persistent: this.persistent,
    };
  }

  /* ---------------------------- external agents ---------------------------- */

  /** The chat item that collects an external agent's activity; one per burst of work. */
  private externalItem(): ChatItem {
    if (this.claudeRun) return this.claudeRun.item; // tool calls of the chat turn in progress
    const agent = bridge.agent ?? 'External agent';
    const last = this.chat[this.chat.length - 1];
    if (last?.role === 'agent' && last.source === agent && last.status === 'streaming') return last;
    this.chat.push({ id: this.seq++, role: 'agent', source: agent, segments: [], status: 'streaming' });
    return this.chat[this.chat.length - 1]!;
  }

  /** Execute one tool call forwarded by the local bridge. */
  async handleBridgeCall(tool: string, input: unknown): Promise<{ isError: boolean; content: BridgeContent[] }> {
    const text = (t: string, isError = false) => ({ isError, content: [{ type: 'text' as const, text: t }] });
    if (tool === 'submit_part') return this.ingest.submit(input); // datasheet import, not a design change
    if (this.inAppBusy) return text('The in-app agent is working on this design right now. Try again when it has finished.', true);

    // the activity block is created lazily, so waiting for review does not open a new one
    let current: ChatItem | null = null;
    const item = () => (current ??= this.externalItem());
    const log = (label: string, ok: boolean, detail: string) => item().segments.push({ type: 'tool', label, ok, detail });

    switch (tool) {
      case 'get_context': {
        const snap = await this.kernel.port.snapshot();
        const p = this.k?.proposal;
        const pending = p ? `\n<pending_changeset hunks="${p.hunks.length}">${p.hunks.map((h) => `${h.change} ${h.title}`).join('; ')}</pending_changeset>` : '';
        log('context', true, `${snap.summary.components.length} parts · ${snap.counts.errors}E ${snap.counts.warnings}W`);
        return text(formatDesignContext({ ...snap, selection: this.selection, scope: this.scope }) + pending + `\nautonomy: ${this.settings.mode}`);
      }
      case 'design_query': {
        if ((input as { op?: string })?.op === 'get_board') {
          // routed in the board worker, so the kernel stays responsive
          const b = await this.routedBoard();
          log('query · get_board', !!b, b ? `${b.stats.routed}/${b.stats.nets} nets routed` : 'failed');
          return b ? text(JSON.stringify(boardSummary(b))) : text('The board could not be computed.', true);
        }
        const out = await this.kernel.query(input);
        const isError = !!(out && typeof out === 'object' && 'error' in out);
        log(`query · ${(input as { op?: string })?.op ?? '?'}`, !isError, isError ? String((out as { error: unknown }).error) : 'ok');
        return text(JSON.stringify(out), isError);
      }
      case 'design_edit': {
        const r = await this.kernel.transact(input);
        const tx = input as { summary?: string; ops?: unknown[]; dry_run?: boolean };
        log(`${tx.dry_run ? 'dry-run' : 'edit'} · ${tx.ops?.length ?? 0} ops · ${tx.summary ?? ''}`, r.status === 'ok', describeTx(r));
        await this.refresh();
        return text(JSON.stringify(compactTx(r)), r.status !== 'ok');
      }
      case 'calc': {
        const parsed = CalcCall.safeParse(input);
        if (!parsed.success) return text(`Invalid calc input: ${parsed.error.message}`, true);
        try {
          const out = runCalc(parsed.data, (await this.kernel.port.snapshot()).summary.valueSeries);
          log(`calc · ${parsed.data.fn}`, true, Object.entries(out).filter(([k]) => k !== 'note').map(([k, v]) => `${k}=${v}`).join(', '));
          return text(JSON.stringify(out));
        } catch (e) {
          return text((e as Error).message, true);
        }
      }
      case 'jlc_search': {
        const out = await jlcTool(input);
        log(out.label, !out.isError, out.detail);
        return text(out.content, out.isError);
      }
      case 'import_part': {
        const args = ImportPartInput.safeParse(input);
        if (!args.success) return text(args.error.message, true);
        log(`import · ${args.data.mpn}`, true, 'reading the datasheet…');
        const out = await this.importPart(args.data);
        log(`import · ${args.data.mpn}`, !out.isError, out.content[0]?.type === 'text' ? out.content[0].text.split('\n')[0]! : '');
        return out;
      }
      case 'artwork': {
        const args = ArtworkInput.safeParse(input);
        if (!args.success) return text(args.error.message, true);
        const a = args.data;
        try {
          switch (a.action) {
            case 'list': {
              const items = this.artwork.items;
              log('artwork · list', true, `${items.length} saved`);
              return text(items.length ? items.map((x) => `- "${x.name}": ${x.w} × ${x.h} mm, ${x.mode === 'fill' ? 'filled' : `outlines ${x.line} mm`}, ${x.polys.length} figure(s)${x.source ? ` (from ${x.source})` : ''}`).join('\n') : 'The artwork library is empty.');
            }
            case 'save': {
              const design = await this.kernel.draftDesign();
              const g = design.board?.graphics?.find((x) => x.id.toUpperCase() === a.graphic.toUpperCase());
              if (!g) return text(`No silkscreen graphic "${a.graphic}" on the board (${(design.board?.graphics ?? []).map((x) => x.id).join(', ') || 'none'}).`, true);
              const saved = await this.artwork.saveGraphic(g, a.name.trim());
              log('artwork · save', true, `${g.id} as "${saved.name}"`);
              this.flash(`Saved "${saved.name}" to the artwork library`);
              return text(`Saved ${g.id} as "${saved.name}" (${saved.w} × ${saved.h} mm). Place it with add_graphic artwork: "${saved.name}".`);
            }
            case 'rename': {
              const x = this.artwork.find(a.name);
              if (!x) return text(`No saved artwork "${a.name}".`, true);
              await this.artwork.rename(x.id, a.to.trim());
              log('artwork · rename', true, `"${a.name}" → "${a.to}"`);
              return text(`Renamed "${a.name}" to "${a.to}".`);
            }
            case 'delete': {
              const x = this.artwork.find(a.name);
              if (!x) return text(`No saved artwork "${a.name}".`, true);
              await this.artwork.remove(x.id);
              log('artwork · delete', true, `"${x.name}"`);
              return text(`Deleted "${x.name}" from the library; boards that use it keep their copy.`);
            }
          }
        } catch (e) {
          return text((e as Error).message, true);
        }
        break;
      }
      case 'pending_import': {
        const args = PendingImportInput.safeParse(input);
        if (!args.success) return text(args.error.message, true);
        const out = await this.ingest.agentEdit(args.data);
        if (args.data.action === 'save' && !out.isError) this.flash(out.text.split('\n')[0]!);
        log(`import review · ${args.data.action}`, !out.isError, out.text.split('\n')[0]!.slice(0, 120));
        return text(out.text, out.isError);
      }
      case 'read_datasheet': {
        const args = DatasheetInput.safeParse(input);
        if (!args.success) return text(args.error.message, true);
        const out = await this.readDatasheet(args.data);
        log(`datasheet · ${args.data.part}${args.data.page ? ` p.${args.data.page}` : args.data.find ? ` "${args.data.find}"` : ''}`, !out.isError, out.isError ? 'failed' : 'ok');
        return out;
      }
      case 'get_schematic_image': {
        const args = ImageInput.parse(input ?? {});
        if (this.view !== 'sch') {
          this.view = 'sch';
          await tick();
        }
        const sheets = this.k?.view.sheets ?? [];
        if (args.sheet) {
          const i = sheets.findIndex((s) => s.name.toLowerCase() === args.sheet!.toLowerCase());
          if (i >= 0) this.sheet = i;
          await tick();
        }
        // one page: frame on its paper (pages are numbered through the whole design)
        let frame: Rect | undefined;
        if (args.area && this.scope) {
          const i = sheets.findIndex((s) => s.id === this.scope!.scope.sheet);
          if (i >= 0) this.sheet = i;
          await tick();
          frame = this.scope.scope.rect;
        } else if (args.page !== undefined) {
          const i = sheets.findIndex((s) => s.pages.some((p) => p.number === args.page));
          if (i < 0) return text(`There is no page ${args.page}: the design has ${sheets.reduce((n, s) => n + s.pages.length, 0)} page(s).`, true);
          this.sheet = i;
          await tick();
          frame = sheets[i]!.pages.find((p) => p.number === args.page)!.rect;
        }
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const img = await renderSchematicPng(args.width, frame);
        log('schematic image', true, `${args.width}px${args.area && frame ? ' · the area' : frame ? ` · page ${args.page}` : ''}`);
        const content: BridgeContent[] = [{ type: 'image', ...img }];
        const shown = sheets[this.sheet];
        if (!frame && shown && shown.pages.length > 1) {
          content.push({ type: 'text', text: `Sheet ${shown.name} is ${shown.pages.length} pages: ${shown.pages.map((p) => `${p.number} ${p.name}`).join('; ')}. Pass page: n to see one at full size.` });
        }
        return { isError: false, content };
      }
      case 'propose': {
        const args = ProposeInput.safeParse(input);
        if (!args.success) return text(args.error.message, true);
        await this.refresh();
        const p = this.k?.proposal;
        if (!p) return text('Nothing to propose: the working copy has no changes.', true);
        const errors = this.k!.diagnostics.filter((d) => d.severity === 'error' && !d.waivedBy);
        if (errors.length) {
          log('propose', false, `refused: ${errors.length} open error(s)`);
          return text(
            `Refused: the design has ${errors.length} open error(s). Fix them (or waive intended ones with a reason) first:\n` +
              errors.map((d) => `- ${d.code} ${d.entities.join(',')}: ${d.message}`).join('\n'),
            true,
          );
        }
        const it = item();
        it.segments.push({ type: 'text', text: args.data.summary + (args.data.message ? `\n${args.data.message}` : '') });
        if (this.claudeRun?.item !== it) it.status = 'done';
        it.changeset = { state: 'pending' };
        if (this.settings.mode === 'auto') {
          await this.accept();
          return text(`Committed (autonomy is Auto): ${p.hunks.length} changes.`);
        }
        this.flash(`${bridge.agent ?? 'External agent'} proposed ${p.hunks.length} changes`);
        return text(`Proposed ${p.hunks.length} changes for review. Call wait_for_review to get the user's decision.`);
      }
      case 'wait_for_review': {
        const args = WaitForReviewInput.parse(input ?? {});
        if (!this.k?.proposal) return text('Nothing is pending review.');
        const result = await new Promise<string>((resolve) => {
          const timer = setTimeout(() => {
            this.reviewWaiters = this.reviewWaiters.filter((w) => w !== done);
            resolve('still pending: the user has not decided yet. Call wait_for_review again or continue talking to the user.');
          }, args.timeout_s * 1000);
          const done = (r: string) => {
            clearTimeout(timer);
            resolve(r);
          };
          this.reviewWaiters.push(done);
        });
        return text(result);
      }
      default:
        return text(`Unknown tool ${tool}`, true);
    }
  }

  private async persist() {
    const json = await this.kernel.exportDesign();
    if (!this.saveBlocked) await saveProject(json);
    await this.ingest.adoptFootprints(JSON.parse(json) as Design).catch(() => {});
  }

  /** The design document is being put together (the board may have to be routed first). */
  docBusy = $state(false);

  /**
   * The design document through the print dialog: the description, each block with its
   * schematic and its place on the board, layout, assembly drawing, BOM and schematic pages.
   */
  async designDocument() {
    if (!this.k || this.docBusy) return;
    this.docBusy = true;
    try {
      const board = this.k.summary.components.length ? await this.routedBoard() : null;
      const { printDesignDocument } = await import('./designdoc.ts');
      const k = this.k;
      await printDesignDocument({ name: k.summary.name, view: k.view, summary: k.summary, counts: k.counts, description: k.description, board, pending: !!k.proposal });
    } catch (e) {
      this.flash(`The design document failed: ${(e as Error).message}`);
    } finally {
      this.docBusy = false;
    }
  }

  /** Ask the agent to re-read the manufacturer page the board's fab limits came from, and import them again. */
  refreshFabLimits() {
    const fab = this.board?.fab;
    if (!fab) return;
    this.chatOpen = true;
    void this.send(fabRefreshPrompt(fab, new Date().toISOString().slice(0, 10)));
  }

  /** Ask the agent for the words of the design document (it writes them with the describe op). */
  describeDesign() {
    this.chatOpen = true;
    void this.send(
      this.k?.description
        ? 'Update the design description for the design document so it matches the design as it is now: the overview and every functional block (design_edit describe).'
        : 'Write the design description for the design document: an overview, then the functional blocks with their parts and how each works (design_edit describe).',
    );
  }

  async exportJson(): Promise<string> {
    return this.kernel.exportDesign();
  }

  async importDesign(d: Design) {
    await this.kernel.load(d);
    this.agent.reset();
    this.chat = [];
    this.saveBlocked = false; // the user chose to replace the project
    await this.persist();
    await this.refresh();
  }

  async newProject() {
    await this.importDesign({
      format: DESIGN_FORMAT_VERSION,
      name: 'untitled',
      seq: 2,
      parts: {},
      components: {},
      nets: {},
      sheets: { s_1: { id: 's_1', name: 'Main', order: 0 } },
      ledger: {},
      waivers: {},
    });
  }

  async deleteKeptProject(key: string) {
    await deleteKeptProject(key);
    this.keptProjects = await loadKeptProjects();
  }

  async renameProject(name: string) {
    await this.kernel.rename(name);
    await this.persist();
    await this.refresh();
  }

  /* -------------------------------- agent --------------------------------- */

  private makeProvider(): Provider {
    if (this.settings.provider === 'anthropic' && this.apiKey) {
      return new AnthropicProvider({ apiKey: this.apiKey, model: this.settings.model, effort: this.settings.effort });
    }
    return new ScriptedProvider(DEMO_SCRIPTS, { fallback: DEMO_FALLBACK, label: 'Offline demo', streamDelayMs: 12 });
  }

  get providerLabel() {
    if (this.settings.provider === 'claude-code') return 'Claude Code';
    return this.agent?.provider.label ?? '';
  }

  get isDemo() {
    if (this.settings.provider === 'claude-code') return false;
    return !(this.settings.provider === 'anthropic' && this.apiKey);
  }

  /**
   * Optimize the zoomed area (`rect`, sheet coordinates): the kernel restricts the agent to it for
   * the length of the run, and it works as in any chat turn (the changeset waits for review).
   */
  async optimize(rect: Rect, goal?: string) {
    const sheet = this.k?.view.sheets[this.sheet];
    if (this.running || !sheet) return;
    const g = goal?.trim();
    const info = await this.kernel.setScope({ view: 'schematic', sheet: sheet.id, rect, ...(g ? { goal: g } : {}) });
    if (!info || 'error' in info) {
      this.flash(info ? info.error : 'Nothing to optimize here.');
      return;
    }
    this.scope = info;
    try {
      await this.send(optimizePrompt(info), { shown: `Optimize ${info.free.length} parts on ${info.sheetName}${info.widened ? ' (widened to what the wires lead to)' : ''}${g ? `: ${g}` : ''}`, scope: info });
    } finally {
      this.scope = null;
      await this.kernel.setScope(null);
    }
  }

  async send(text: string, opts: { shown?: string; scope?: ScopeInfo } = {}) {
    const trimmed = text.trim();
    if (!trimmed || this.running) return;
    if (this.k?.proposal) {
      // New instructions while a proposal is pending: the agent keeps building on the same
      // working copy and the next turn shows the combined changeset.
      const pending = [...this.chat].reverse().find((c) => c.changeset?.state === 'pending');
      if (pending) pending.changeset = { state: 'superseded', note: 'Continued below; review the combined changeset there.' };
    }
    const refs = opts.scope ? [] : [...this.selection];
    this.chat.push({ id: this.seq++, role: 'user', text: opts.shown ?? trimmed, refs, segments: [], status: 'done' });
    for (const q of this.chat) for (const s of q.segments) if (s.type === 'question' && !s.answered) s.answered = opts.shown ?? trimmed;
    const viaClaude = this.settings.provider === 'claude-code';
    this.chat.push({ id: this.seq++, role: 'agent', segments: [], status: 'streaming', ...(viaClaude ? { source: 'Claude Code' } : {}) });
    const item = this.chat[this.chat.length - 1]!;

    this.running = true;
    try {
      if (viaClaude) {
        await this.runClaudeCode(trimmed, item);
      } else {
        this.inAppBusy = true;
        this.abort = new AbortController();
        await this.agent.run(trimmed, { selection: refs, scope: opts.scope ?? null }, (e) => this.onEvent(item, e), this.abort.signal);
      }
    } catch (e) {
      item.segments.push({ type: 'error', text: (e as Error).message });
    } finally {
      item.status = 'done';
      this.running = false;
      this.inAppBusy = false;
      this.claudeRun = null;
      this.abort = null;
      await this.refresh();
      if (this.k?.proposal) {
        item.changeset = { state: 'pending' };
        if (this.settings.mode === 'auto' && this.k.counts.errors === 0) await this.accept();
      }
    }
  }

  stop() {
    if (this.claudeRun) bridge.cancelChat(this.claudeRun.id);
    this.abort?.abort();
  }

  /** One chat turn answered by the local Claude Code through the bridge. */
  private async runClaudeCode(text: string, item: ChatItem): Promise<void> {
    const fail = (t: string) => item.segments.push({ type: 'error', text: t });
    if (bridge.status !== 'connected') {
      fail(`Claude Code is not connected. Start the bridge (${__BRIDGE_RUN__}) and pair this tab under Settings → Local bridge.`);
      return;
    }
    if (!bridge.chat?.available) {
      fail(bridge.chat?.reason ?? 'This bridge cannot run Claude Code for the chat. Update the bridge (restart it).');
      return;
    }
    const id = crypto.randomUUID();
    this.claudeRun = { id, item };
    await new Promise<void>((resolve) => {
      const sent = bridge.sendChat(
        {
          id,
          text,
          session: this.claudeSession,
          ...(this.settings.claudeModel ? { model: this.settings.claudeModel } : {}),
          autonomy: this.settings.mode,
          web: this.settings.claudeWeb,
        },
        (e) => {
          const last = item.segments[item.segments.length - 1];
          switch (e.kind) {
            case 'session':
              this.claudeSession = e.session;
              break;
            case 'text':
              if (last?.type === 'text') last.text += e.text;
              else if (e.text.trim()) item.segments.push({ type: 'text', text: e.text.replace(/^\s+/, '') });
              break;
            case 'thinking':
              if (last?.type === 'thinking') last.text += e.text;
              else item.segments.push({ type: 'thinking', text: e.text });
              break;
            case 'tokens':
              item.usage = { ...e.tokens, costUsd: tokenCost(e.tokens, this.settings.claudeModel ?? ''), exact: false };
              if (e.tokens.model) this.lastModel = e.tokens.model;
              break;
            case 'done': {
              if (e.session) this.claudeSession = e.session;
              if (e.tokens || e.costUsd !== undefined) {
                const t = e.tokens ?? item.usage ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
                const cost = e.costUsd ?? tokenCost(t, this.settings.claudeModel ?? '');
                item.usage = { ...t, costUsd: cost, exact: e.costUsd !== undefined };
                if (t.model) this.lastModel = t.model;
                this.spend += cost;
              }
              if (!e.ok && e.error) {
                // Claude Code prints API errors as its reply too: show them once, as an error
                const dup = item.segments.findLastIndex((x) => x.type === 'text' && x.text.trim() === e.error!.trim());
                if (dup >= 0) item.segments.splice(dup, 1);
                fail(e.error);
              }
              resolve();
              break;
            }
          }
        },
      );
      if (!sent) {
        fail('The bridge connection is not open.');
        resolve();
      }
    });
  }

  private onEvent(item: ChatItem, e: AgentEvent) {
    const last = item.segments[item.segments.length - 1];
    switch (e.type) {
      case 'text':
        if (last?.type === 'text') last.text += e.delta;
        else item.segments.push({ type: 'text', text: e.delta });
        break;
      case 'thinking':
        if (last?.type === 'thinking') last.text += e.delta;
        else item.segments.push({ type: 'thinking', text: e.delta });
        break;
      case 'tool':
        item.segments.push({ type: 'tool', label: e.label, ok: e.ok, detail: e.detail });
        if (e.name === 'design_edit') void this.refresh();
        break;
      case 'verify':
        item.segments.push({ type: 'verify', round: e.round, errors: e.errors, message: e.message });
        break;
      case 'question':
        item.segments.push({ type: 'question', question: e.question, options: e.options });
        break;
      case 'usage':
        this.spend += costUsd(e.model ?? this.settings.model, e.usage);
        if (e.model) this.lastModel = e.model;
        break;
      case 'done':
        if (e.reason === 'error' || e.reason === 'refusal' || e.reason === 'max_tokens' || e.reason === 'budget') {
          item.segments.push({ type: 'error', text: e.message ?? e.reason });
        } else if (e.reason === 'aborted') {
          item.segments.push({ type: 'error', text: 'Stopped.' });
        } else if (e.message) {
          item.segments.push({ type: 'error', text: e.message });
        }
        break;
    }
  }

  /* ------------------------------- settings ------------------------------- */

  async updateSettings(patch: Partial<Settings>, apiKey?: string) {
    this.settings = { ...this.settings, ...patch };
    await saveSettings(this.settings);
    if (apiKey !== undefined) {
      this.apiKey = apiKey.trim();
      await saveApiKey('anthropic', this.apiKey);
    }
    this.agent?.setProvider(this.makeProvider());
    this.applyTheme();
    this.settingsChannel?.postMessage({ type: 'settings' });
  }

  /** Tabs of the app tell each other about settings changes and who holds the bridge. */
  private settingsChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('tracewise-settings') : null;

  private async reloadSettings() {
    this.settings = await loadSettings();
    this.apiKey = await loadApiKey('anthropic');
    this.agent?.setProvider(this.makeProvider());
    this.applyTheme();
  }

  clearChat() {
    this.claudeSession = null;
    this.agent.reset();
    this.chat = [];
  }

  private applyTheme() {
    const t = this.settings.theme;
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  }

  /* --------------------------------- misc --------------------------------- */

  /** A net selected in the schematic (its id): highlighted, its details in the Selection tab. */
  selectedNet = $state<string | null>(null);

  selectNet(netId: string) {
    this.selection = [];
    this.selectedNet = this.selectedNet === netId ? null : netId;
    if (this.selectedNet) this.tab = 'sel';
  }

  clearSelection() {
    this.selection = [];
    this.selectedNet = null;
  }

  toggleSelect(refdes: string, additive: boolean) {
    this.selectedNet = null;
    if (additive) {
      this.selection = this.selection.includes(refdes) ? this.selection.filter((r) => r !== refdes) : [...this.selection, refdes];
    } else {
      this.selection = this.selection.length === 1 && this.selection[0] === refdes ? [] : [refdes];
    }
    if (this.selection.length === 1) this.tab = 'sel';
  }

  flash(msg: string) {
    this.toast = msg;
    setTimeout(() => {
      if (this.toast === msg) this.toast = null;
    }, 3500);
  }
}

export const app = new AppState();
