/**
 * Application state (Svelte 5 runes). Owns the kernel worker, the agent and settings.
 */
import {
  Agent,
  ScriptedProvider,
  apiProblem,
  apiProvider,
  costUsd,
  formatDesignContext,
  optimizePrompt,
  runKernelTool,
  unknownTool,
  type AgentEvent,
  type Provider,
  type ToolOutcome,
} from '@4k7/agent';
import type { KernelState } from '@4k7/kernel';
import { tick } from 'svelte';
import { ArtworkInput, HARNESSES, SERVER_ACCESS_KEY, DatasheetInput, ImportPartInput, PendingImportInput, DESIGN_FORMAT_VERSION, ImageInput, ProposeInput, WaitForReviewInput, boardSummary, type BoardDiagnostic, type BoardView, type ToolContent, type Design, type PaperId, type PartCard, type Rect, type ScopeInfo, type TokenCount } from '@4k7/schema';
import { server } from './server.svelte.ts';
import { currentChoice, effortLevels } from './models.ts';
import { createKernel } from './kernelClient.ts';
import { BoardClient, type BoardStage } from './boardClient.ts';
import { IngestState } from './ingest.svelte.ts';
import { ArtworkLibrary } from './artwork.svelte.ts';
import { renderSchematicPng } from './snapshot.ts';
import { jlcTool } from './jlc.ts';
import { fabRefreshPrompt } from './fabRefresh.ts';
import {
  DEFAULT_SETTINGS,
  browserData,
  loadApiKey,
  loadSettings,
  markMovedToDisk,
  movedToDisk,
  saveApiKey,
  saveSettings,
  storageHealth,
  storagePersistent,
  type Settings,
} from './persist.ts';
import { disk, type ProjectEntry } from './disk.svelte.ts';

/** A tool's answer before the chat's label is put on it. */
type ToolResult = Omit<ToolOutcome, 'label' | 'detail'>;

/**
 * The local server's access key, from the app's address (http://localhost:7777/<access-key>, as the server
 * opens it). `?port=7778` names the server to try first when the app is served by another one.
 */
const addressPath = /^\/([^/]+)\/?$/.exec(location.pathname)?.[1] ?? '';
const keyFromAddress = SERVER_ACCESS_KEY.test(addressPath) ? addressPath : null;
const portFromAddress = Number(new URLSearchParams(location.search).get('port')) || null;

/** How often to look for the server that keeps the files while it is not reachable. */
const DISK_RETRY_MS = 4000;

export type View = 'sch' | 'lay' | 'parts' | 'set';
export type InspectorTab = 'issues' | 'ledger' | 'history' | 'sel';

export type Segment =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; label: string; ok: boolean; detail: string }
  | { type: 'verify'; round: number; errors: number; message: string }
  | { type: 'question'; question: string; options: string[]; answered?: string }
  | { type: 'error'; text: string }
  /** Something the server says about the run (e.g. a setting the model does not take). */
  | { type: 'note'; text: string };

export interface ChatItem {
  id: number;
  role: 'user' | 'agent';
  text?: string;
  refs?: string[];
  segments: Segment[];
  status: 'streaming' | 'done';
  /** Coding agent answering through the server (e.g. "Claude Code", "OpenCode"). */
  source?: string;
  /** This turn produced the proposal that is currently pending (or was decided). */
  changeset?: { state: 'pending' | 'accepted' | 'rejected' | 'superseded'; note?: string };
  /** Tokens this turn used (live while it runs), with the cost: estimated, or as the coding agent reported it. */
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
  /** The open project's file in the projects folder (its name without .twd.json); null until it is first saved. */
  projectId = $state<string | null>(null);
  /** The project files, newest first. */
  projects = $state.raw<ProjectEntry[]>([]);
  /** Changes not written to the project file (the server is not reachable). */
  unsaved = $state(false);
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
  /** The files were read once the server was found (the project, libraries). */
  private diskLoaded = false;
  private diskTimer: ReturnType<typeof setTimeout> | null = null;
  private diskConnecting: Promise<void> | null = null;
  /** The design was renamed and its file not yet (the server was not reachable). */
  private renameFile = false;
  /** Writes to the project files, one after the other (a new project's file is created once). */
  private writes: Promise<unknown> = Promise.resolve();
  /** A coding agent answering the app chat through the server: its session and the current run. */
  private agentSession: { harness: string; id: string } | null = null;
  private agentRun: { id: string; item: ChatItem } | null = null;

  async init() {
    this.settings = await loadSettings();
    this.apiKey = await loadApiKey(this.settings.api);
    this.agent = new Agent({ provider: this.makeProvider(), kernel: this.kernel.port, fixBudget: this.settings.fixBudget, exec: (tool, input) => this.runTool(tool, input) });
    this.settingsChannel?.addEventListener('message', (e: MessageEvent<{ type: string; accessKey?: string }>) => {
      if (e.data?.type === 'server-held' && e.data.accessKey) server.heldElsewhere(e.data.accessKey);
      else void this.reloadSettings();
    });
    this.applyTheme();
    await this.refresh();
    server.init(
      (tool, input) => this.handleServerCall(tool, input),
      (accessKey, port) => {
        // connecting to a server that can run a coding agent makes it the chat provider, unless an API is set up
        const usable = server.harnesses.filter((h) => h.available);
        const agent = this.noModel ? (usable.find((h) => h.id === this.settings.harness) ?? usable[0]) : undefined;
        if (accessKey !== this.settings.serverAccessKey || port !== this.settings.serverPort || agent) {
          void this.updateSettings({ serverAccessKey: accessKey, serverPort: port, ...(agent ? { provider: 'agent' as const, harness: agent.id } : {}) });
        }
        this.settingsChannel?.postMessage({ type: 'server-held', accessKey });
        if (agent) this.flash(`Connected: the chat now runs on your ${agent.name}`);
        if (disk.status !== 'ok') void this.connectDisk(accessKey, port);
      },
      () => {
        // the external agent went away: close its open activity block
        for (const c of this.chat) if (c.source && c.status === 'streaming') c.status = 'done';
      },
      () => this.diagnostics(),
    );
    this.persistent = await storagePersistent();
    // the address's key wins over the saved one (the dev server's address carries none)
    const accessKey = keyFromAddress ?? this.settings.serverAccessKey;
    if (accessKey) {
      const silent = accessKey === this.settings.serverAccessKey;
      void server.connect(accessKey, { silent, preferPort: portFromAddress ?? this.settings.serverPort }).then((ok) => {
        if (!ok && !silent && server.error) this.flash(server.error);
      });
    }
    addEventListener('beforeunload', (e) => {
      if (this.unsaved) e.preventDefault();
    });
    await this.connectDisk();
    if (disk.status !== 'ok') this.flash(accessKey ? 'The 4k7 server is not running: nothing is saved until it is back.' : 'Open the app with the link the 4k7 server printed: nothing is saved without it.');
    this.ready = true;
  }

  /* ------------------------------ project files ----------------------------- */

  /**
   * Find the server that keeps the files (and keep looking while it is away). The first time, read
   * the project and the libraries; after an outage, write what could not be saved.
   */
  private connectDisk(accessKey?: string, port?: number): Promise<void> {
    this.diskConnecting ??= (async () => {
      if (this.diskTimer) clearTimeout(this.diskTimer);
      this.diskTimer = null;
      const ok = await disk.find(accessKey ?? keyFromAddress ?? this.settings.serverAccessKey, { sameOrigin: !!keyFromAddress, preferPort: port ?? portFromAddress ?? this.settings.serverPort });
      if (!ok) this.diskTimer = setTimeout(() => void this.connectDisk(), DISK_RETRY_MS);
      else if (!this.diskLoaded) await this.loadDisk();
      else if (this.unsaved) await this.persist();
    })().finally(() => (this.diskConnecting = null));
    return this.diskConnecting;
  }

  private async loadDisk() {
    try {
      await this.moveBrowserData();
      this.projects = await disk.listProjects();
      // changes made before the server answered get a project of their own: no file is replaced
      if (!this.unsaved) {
        const id = this.projects.some((p) => p.id === this.settings.project) ? this.settings.project : this.projects[0]?.id;
        if (id) await this.openProject(id);
      }
      await this.ingest.init().catch((e: Error) => this.flash(`Could not load imported parts: ${e.message}`));
      await this.artwork.init().catch((e: Error) => this.flash(`Could not load the artwork library: ${e.message}`));
      const newer = this.ingest.newer + this.artwork.newer;
      if (newer) this.flash(`${newer} saved ${newer === 1 ? 'library item was' : 'library items were'} written by a newer version of the app and not loaded`);
      await this.ingest.adoptFootprints(JSON.parse(await this.kernel.exportDesign()) as Design).catch(() => {});
      this.diskLoaded = true;
    } catch (e) {
      this.flash(`Could not read the project files: ${(e as Error).message}`);
      this.diskTimer = setTimeout(() => void this.connectDisk(), DISK_RETRY_MS);
      return;
    }
    if (this.unsaved) await this.persist();
  }

  /**
   * Versions before the files kept the project and the libraries in this browser: write them to
   * files once (a library item already on disk is left as it is). The browser's copy stays.
   */
  private async moveBrowserData() {
    if (await movedToDisk()) return;
    const data = await browserData().catch(() => null);
    if (!data) return;
    let project: string | null = null;
    if (data.project) project = await disk.createProject(data.project);
    for (const k of data.kept) await disk.createProject(k.json, `unreadable ${new Date(k.at).toISOString().slice(0, 10)}`);
    for (const r of data.library) if ((r as { id?: string }).id) await disk.putRecord('library', (r as { id: string }).id, r, true);
    for (const r of data.artwork) if ((r as { id?: string }).id) await disk.putRecord('artwork', (r as { id: string }).id, r, true);
    for (const d of data.datasheets) if (d.sheet?.data) await disk.putDatasheet(d.hash, d.sheet, true);
    await markMovedToDisk();
    if (project) {
      await this.updateSettings({ project });
      this.flash(`Your project is now a file: ${disk.projectsDir}/${project}.twd.json`);
    }
  }

  /** Open a project file. False (and the open project stays) when it cannot be read. */
  async openProject(id: string): Promise<boolean> {
    if (this.running) {
      this.flash('Wait for the agent to finish first.');
      return false;
    }
    // in the write queue: a save running now writes the design it exported to the file it belongs to
    const design = await this.queueWrite(async () => {
      try {
        const text = await disk.loadProject(id);
        if (text === undefined) {
          this.flash(`${id} is no longer in the projects folder.`);
          await this.refreshProjects();
          return null;
        }
        const d = JSON.parse(text) as Design;
        await this.kernel.load(d);
        this.projectId = id;
        this.unsaved = false;
        this.renameFile = false;
        return d;
      } catch (e) {
        // a newer version's file, or a broken one: it is left as it is
        this.flash(`Could not open ${id}: ${(e as Error).message}. The file is left as it is.`);
        return null;
      }
    });
    if (!design) return false;
    this.agent.reset();
    this.chat = [];
    this.hunkOff = {};
    if (this.settings.project !== id) void this.updateSettings({ project: id });
    await this.ingest.adoptFootprints(design).catch(() => {});
    await this.refresh();
    return true;
  }

  async refreshProjects() {
    this.projects = await disk.listProjects().catch(() => this.projects);
  }

  /** Show the projects folder in the file manager. */
  revealProjects() {
    disk.reveal().catch((e: Error) => this.flash(`Could not open the folder: ${e.message}`));
  }

  /** Run a write to the project files (or a switch to another project) after the ones before it. */
  private queueWrite<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writes.then(fn);
    this.writes = run.catch(() => {});
    return run;
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
  private async importPart(args: { mpn: string; datasheet_url: string; notes?: string; timeout_s: number }): Promise<ToolResult> {
    const text = (content: string, isError = false): ToolResult => ({ content, isError });
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
  private async readDatasheet(args: { part: string; page?: number; find?: string; region?: [number, number, number, number] }): Promise<ToolResult> {
    const text = (content: string, isError = false): ToolResult => ({ content, isError });
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
        content: `${card.id} datasheet, page ${args.page} of ${n}${args.region ? ` (region ${args.region.join(', ')})` : ''}:\n${body}`,
        images: [{ data: src.slice(src.indexOf(',') + 1), mimeType: 'image/jpeg' }],
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

  /** What this tab reports about itself (Settings → Diagnostics, and to the server log). */
  diagnostics() {
    return {
      origin: location.origin,
      build: __BUILD_ID__,
      userAgent: navigator.userAgent,
      provider: this.settings.provider === 'agent' ? this.settings.harness : `${this.settings.api}${this.apiProblem ? ` (${this.apiProblem})` : ''}`,
      storage: disk.status === 'ok' ? storageHealth : `project files: server ${disk.status}`,
      persistent: this.persistent,
    };
  }

  /* ---------------------------- external agents ---------------------------- */

  /** The chat item that collects an external agent's activity; one per burst of work. */
  private externalItem(): ChatItem {
    if (this.agentRun) return this.agentRun.item; // tool calls of the chat turn in progress
    const agent = server.agent ?? 'External agent';
    const last = this.chat[this.chat.length - 1];
    if (last?.role === 'agent' && last.source === agent && last.status === 'streaming') return last;
    this.chat.push({ id: this.seq++, role: 'agent', source: agent, segments: [], status: 'streaming' });
    return this.chat[this.chat.length - 1]!;
  }

  /**
   * Run one agent tool. The in-app agent and the coding agents through the server share this executor;
   * how a turn starts and ends (get_context, propose, wait_for_review, ask_user) is up to each.
   */
  async runTool(tool: string, input: unknown): Promise<ToolOutcome> {
    const fail = (label: string, detail: string): ToolOutcome => ({ content: detail, isError: true, label, detail });
    const first = (t: string) => t.split('\n')[0]!;
    switch (tool) {
      case 'design_query': {
        if ((input as { op?: string })?.op !== 'get_board') break;
        // routed in the board worker, so the kernel stays responsive
        const b = await this.routedBoard();
        if (!b) return fail('query · get_board', 'The board could not be computed.');
        return { content: JSON.stringify(boardSummary(b)), isError: false, label: 'query · get_board', detail: `${b.stats.routed}/${b.stats.nets} nets routed` };
      }
      case 'jlc_search':
        return jlcTool(input);
      case 'import_part': {
        const args = ImportPartInput.safeParse(input);
        if (!args.success) return fail('import', args.error.message);
        const out = await this.importPart(args.data);
        return { ...out, label: `import · ${args.data.mpn}`, detail: first(out.content) };
      }
      case 'artwork': {
        const args = ArtworkInput.safeParse(input);
        if (!args.success) return fail('artwork', args.error.message);
        try {
          return await this.artworkTool(args.data);
        } catch (e) {
          return fail(`artwork · ${args.data.action}`, (e as Error).message);
        }
      }
      case 'pending_import': {
        const args = PendingImportInput.safeParse(input);
        if (!args.success) return fail('import review', args.error.message);
        const out = await this.ingest.agentEdit(args.data);
        if (args.data.action === 'save' && !out.isError) this.flash(first(out.text));
        return { content: out.text, isError: out.isError, label: `import review · ${args.data.action}`, detail: first(out.text).slice(0, 120) };
      }
      case 'read_datasheet': {
        const args = DatasheetInput.safeParse(input);
        if (!args.success) return fail('datasheet', args.error.message);
        const out = await this.readDatasheet(args.data);
        return { ...out, label: `datasheet · ${args.data.part}${args.data.page ? ` p.${args.data.page}` : args.data.find ? ` "${args.data.find}"` : ''}`, detail: out.isError ? first(out.content) : 'ok' };
      }
      case 'get_schematic_image': {
        const parsed = ImageInput.safeParse(input ?? {});
        if (!parsed.success) return fail('schematic image', parsed.error.message);
        const args = parsed.data;
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
          if (i < 0) return fail('schematic image', `There is no page ${args.page}: the design has ${sheets.reduce((n, s) => n + s.pages.length, 0)} page(s).`);
          this.sheet = i;
          await tick();
          frame = sheets[i]!.pages.find((p) => p.number === args.page)!.rect;
        }
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const img = await renderSchematicPng(args.width, frame);
        const shown = sheets[this.sheet];
        return {
          content: !frame && shown && shown.pages.length > 1 ? `Sheet ${shown.name} is ${shown.pages.length} pages: ${shown.pages.map((p) => `${p.number} ${p.name}`).join('; ')}. Pass page: n to see one at full size.` : '',
          images: [img],
          isError: false,
          label: 'schematic image',
          detail: `${args.width}px${args.area && frame ? ' · the area' : frame ? ` · page ${args.page}` : ''}`,
        };
      }
    }
    return (await runKernelTool(this.kernel.port, tool, input)) ?? unknownTool(tool);
  }

  /** The artwork tool: the saved silkscreen graphics. */
  private async artworkTool(a: ArtworkInput): Promise<ToolOutcome> {
    const ok = (label: string, detail: string, content: string): ToolOutcome => ({ content, isError: false, label: `artwork · ${label}`, detail });
    const fail = (content: string): ToolOutcome => ({ content, isError: true, label: `artwork · ${a.action}`, detail: content });
    switch (a.action) {
      case 'list': {
        const items = this.artwork.items;
        return ok('list', `${items.length} saved`, items.length ? items.map((x) => `- "${x.name}": ${x.w} × ${x.h} mm, ${x.mode === 'fill' ? 'filled' : `outlines ${x.line} mm`}, ${x.polys.length} figure(s)${x.source ? ` (from ${x.source})` : ''}`).join('\n') : 'The artwork library is empty.');
      }
      case 'save': {
        const design = await this.kernel.draftDesign();
        const g = design.board?.graphics?.find((x) => x.id.toUpperCase() === a.graphic.toUpperCase());
        if (!g) return fail(`No silkscreen graphic "${a.graphic}" on the board (${(design.board?.graphics ?? []).map((x) => x.id).join(', ') || 'none'}).`);
        const saved = await this.artwork.saveGraphic(g, a.name.trim());
        this.flash(`Saved "${saved.name}" to the artwork library`);
        return ok('save', `${g.id} as "${saved.name}"`, `Saved ${g.id} as "${saved.name}" (${saved.w} × ${saved.h} mm). Place it with add_graphic artwork: "${saved.name}".`);
      }
      case 'rename': {
        const x = this.artwork.find(a.name);
        if (!x) return fail(`No saved artwork "${a.name}".`);
        await this.artwork.rename(x.id, a.to.trim());
        return ok('rename', `"${a.name}" → "${a.to}"`, `Renamed "${a.name}" to "${a.to}".`);
      }
      case 'delete': {
        const x = this.artwork.find(a.name);
        if (!x) return fail(`No saved artwork "${a.name}".`);
        await this.artwork.remove(x.id);
        return ok('delete', `"${x.name}"`, `Deleted "${x.name}" from the library; boards that use it keep their copy.`);
      }
    }
  }

  /** Execute one tool call forwarded by the local server: the turn tools here, the design tools in runTool. */
  async handleServerCall(tool: string, input: unknown): Promise<{ isError: boolean; content: ToolContent[] }> {
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
        if (this.agentRun?.item !== it) it.status = 'done';
        it.changeset = { state: 'pending' };
        if (this.settings.mode === 'auto') {
          await this.accept();
          return text(`Committed (autonomy is Auto): ${p.hunks.length} changes.`);
        }
        this.flash(`${server.agent ?? 'External agent'} proposed ${p.hunks.length} changes`);
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
    }
    if (tool === 'import_part') log('import', true, 'reading the datasheet…'); // takes minutes
    const out = await this.runTool(tool, input);
    log(out.label, !out.isError, out.detail);
    if (tool === 'design_edit') await this.refresh();
    return {
      isError: out.isError,
      content: [...(out.images ?? []).map((i) => ({ type: 'image' as const, ...i })), ...(out.content ? [{ type: 'text' as const, text: out.content }] : [])],
    };
  }

  /** Write the design to its project file (a new file the first time); without the server, mark it unsaved. */
  private persist(): Promise<void> {
    return this.queueWrite(async () => {
      const json = await this.kernel.exportDesign();
      await this.ingest.adoptFootprints(JSON.parse(json) as Design).catch(() => {});
      if (disk.status !== 'ok' || !this.diskLoaded) {
        this.unsaved = true;
        if (disk.status !== 'connecting') void this.connectDisk();
        return;
      }
      try {
        if (this.projectId) await disk.saveProject(this.projectId, json);
        else {
          this.projectId = await disk.createProject(json);
          this.renameFile = false; // named after the design already
          void this.updateSettings({ project: this.projectId });
          await this.refreshProjects();
        }
        this.unsaved = false;
        if (this.renameFile) await this.renameProjectFile((JSON.parse(json) as Design).name);
      } catch (e) {
        this.unsaved = true;
        if (disk.status === 'ok') this.flash(`Saving failed: ${(e as Error).message}`);
        else void this.connectDisk();
      }
    });
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

  /** Open a design as a new project (its own file, named after the design). */
  async importDesign(d: Design) {
    if (this.running) {
      this.flash('Wait for the agent to finish first.');
      return;
    }
    await this.queueWrite(async () => {
      await this.kernel.load(d);
      this.projectId = null;
      this.renameFile = false;
    });
    this.agent.reset();
    this.chat = [];
    this.hunkOff = {};
    await this.persist();
    await this.refresh();
  }

  async newProject(name = 'untitled') {
    await this.importDesign({
      format: DESIGN_FORMAT_VERSION,
      name,
      seq: 2,
      parts: {},
      components: {},
      nets: {},
      sheets: { s_1: { id: 's_1', name: 'Main', order: 0 } },
      ledger: {},
      waivers: {},
    });
  }

  /** Rename the design, and its file after it (on the next save that reaches the server). */
  async renameProject(name: string) {
    await this.kernel.rename(name);
    this.renameFile = true;
    await this.persist();
    await this.refresh();
  }

  /** Name the open project's file after the design (in the write queue, after a save). */
  private async renameProjectFile(name: string) {
    const id = this.projectId;
    if (!id) return;
    try {
      this.projectId = await disk.renameProject(id, name);
      this.renameFile = false;
      if (this.projectId !== id) void this.updateSettings({ project: this.projectId });
      await this.refreshProjects();
    } catch (e) {
      this.flash(`The file keeps its name: ${(e as Error).message}`);
    }
  }

  /* -------------------------------- agent --------------------------------- */

  /** The API the chat uses when the provider is 'api': the service, its address, key and model. */
  get apiChoice() {
    const s = this.settings;
    return { service: s.api, baseURL: s.apiUrls[s.api] ?? '', apiKey: this.apiKey, model: s.apiModels[s.api] ?? '', effort: s.effort };
  }

  /** What the API setup still lacks ('no key', 'no model', 'no address'), or null. */
  get apiProblem() {
    return apiProblem(this.apiChoice);
  }

  private makeProvider(): Provider {
    if (this.settings.provider === 'api' && !this.apiProblem) return apiProvider(this.apiChoice);
    return new ScriptedProvider([], { fallback: 'No chat provider is set up. Connect a coding agent or set up an API in Settings.', label: 'No model' });
  }

  /** The coding agent chosen for the chat. */
  get harness() {
    const id = this.settings.harness;
    return server.harnesses.find((h) => h.id === id) ?? { id, name: HARNESSES.find((h) => h.id === id)?.name ?? id, available: false };
  }

  get providerLabel() {
    if (this.settings.provider === 'agent') return this.harness.name;
    return this.agent?.provider.label ?? '';
  }

  /** An API chosen but not set up: there is nothing to chat with. */
  get noModel() {
    return this.settings.provider === 'api' && !!this.apiProblem;
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
    const viaAgent = this.settings.provider === 'agent';
    this.chat.push({ id: this.seq++, role: 'agent', segments: [], status: 'streaming', ...(viaAgent ? { source: this.harness.name } : {}) });
    const item = this.chat[this.chat.length - 1]!;

    this.running = true;
    try {
      if (viaAgent) {
        await this.runCodingAgent(trimmed, item);
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
      this.agentRun = null;
      this.abort = null;
      await this.refresh();
      if (this.k?.proposal) {
        item.changeset = { state: 'pending' };
        if (this.settings.mode === 'auto' && this.k.counts.errors === 0) await this.accept();
      }
    }
  }

  stop() {
    if (this.agentRun) server.cancelChat(this.agentRun.id);
    this.abort?.abort();
  }

  /** One chat turn answered by a coding agent on this computer (Claude Code, Copilot, OpenCode) through the server. */
  private async runCodingAgent(text: string, item: ChatItem): Promise<void> {
    const fail = (t: string) => item.segments.push({ type: 'error', text: t });
    const h = this.harness;
    if (server.status !== 'connected') {
      fail(__APP_RUN__ ? `${h.name} is not connected. Open ${__SERVER_RUN__} again.` : `${h.name} is not connected. Start the server (${__SERVER_RUN__}) and open the app with the link it prints.`);
      return;
    }
    if (!h.available) {
      fail(server.harnesses.length ? (h.reason ?? `This server cannot run ${h.name}.`) : `This server cannot run ${h.name} for the chat. Update the server (restart it).`);
      return;
    }
    const id = crypto.randomUUID();
    const model = this.settings.harnessModels[h.id] ?? '';
    const effort = effortLevels(currentChoice(this.settings)) ? this.settings.harnessEfforts[h.id] : undefined;
    // a conversation belongs to one agent: switching starts a new one
    if (this.agentSession?.harness !== h.id) this.agentSession = null;
    this.agentRun = { id, item };
    await new Promise<void>((resolve) => {
      const sent = server.sendChat(
        {
          id,
          text,
          session: this.agentSession?.id ?? null,
          // older servers know only Claude Code and take a missing harness for it
          ...(h.id !== 'claude-code' ? { harness: h.id } : {}),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          autonomy: this.settings.mode,
          web: this.settings.agentWeb,
        },
        (e) => {
          const last = item.segments[item.segments.length - 1];
          switch (e.kind) {
            case 'session':
              this.agentSession = { harness: h.id, id: e.session };
              break;
            case 'status':
              item.segments.push({ type: 'note', text: e.text });
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
              item.usage = { ...e.tokens, costUsd: tokenCost(e.tokens, model), exact: false };
              if (e.tokens.model) this.lastModel = e.tokens.model;
              break;
            case 'done': {
              if (e.session) this.agentSession = { harness: h.id, id: e.session };
              if (e.tokens || e.costUsd !== undefined) {
                const t = e.tokens ?? item.usage ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
                const cost = e.costUsd ?? tokenCost(t, model);
                item.usage = { ...t, costUsd: cost, exact: e.costUsd !== undefined };
                if (t.model) this.lastModel = t.model;
                this.spend += cost;
              }
              if (!e.ok && e.error) {
                // agents print API errors as their reply too: show them once, as an error
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
        fail('The server connection is not open.');
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
        this.spend += costUsd(e.model ?? this.apiChoice.model, e.usage);
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

  /** Change settings; `apiKey` is the key of the API service chosen after the change. */
  async updateSettings(patch: Partial<Settings>, apiKey?: string) {
    const service = this.settings.api;
    this.settings = { ...this.settings, ...patch };
    await saveSettings(this.settings);
    if (apiKey !== undefined) {
      this.apiKey = apiKey.trim();
      await saveApiKey(this.settings.api, this.apiKey);
    } else if (this.settings.api !== service) {
      this.apiKey = await loadApiKey(this.settings.api); // each service has its own key
    }
    this.agent?.setProvider(this.makeProvider());
    this.applyTheme();
    this.settingsChannel?.postMessage({ type: 'settings' });
  }

  /** Save (or with '' remove) the key of an API service, whether or not the chat uses it now. */
  async saveApiKeyFor(service: Settings['api'], key: string) {
    await saveApiKey(service, key.trim());
    if (service === this.settings.api) {
      this.apiKey = key.trim();
      this.agent?.setProvider(this.makeProvider());
    }
    this.settingsChannel?.postMessage({ type: 'settings' });
  }

  /** Tabs of the app tell each other about settings changes and who holds the server. */
  private settingsChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('4k7-settings') : null;

  private async reloadSettings() {
    this.settings = await loadSettings();
    this.apiKey = await loadApiKey(this.settings.api);
    this.agent?.setProvider(this.makeProvider());
    this.applyTheme();
  }

  clearChat() {
    this.agentSession = null;
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
