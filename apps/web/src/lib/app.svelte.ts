/**
 * Application state (Svelte 5 runes). Owns the kernel worker, the agent and settings.
 */
import {
  Agent,
  ScriptedProvider,
  apiProblem,
  apiProvider,
  boardViewInfo,
  costUsd,
  formatDesignContext,
  optimizePrompt,
  runKernelTool,
  schematicViewInfo,
  unknownTool,
  type AgentEvent,
  type KernelPort,
  type Provider,
  type ToolOutcome,
} from '@4k7/agent';
import type { KernelState } from '@4k7/kernel';
import { tick } from 'svelte';
import { ASSEMBLY_HOUSE, assemblyHouse, countDiagnostics, type DiagnosticCounts, money, type AssemblyHouse, RenderEnclosureInput, openQuestions, enclosureKey, enclosureGraphicsInfo, scriptInlays, type EnclosureSettings, ArtworkInput, AttachmentInput, HARNESSES, SERVER_ACCESS_KEY, DatasheetInput, BoardImageInput, mustFix, ImportPartInput, PendingImportInput, DESIGN_FORMAT_VERSION, ImageInput, ProposeInput, WaitForReviewInput, boardSummary, CONVERSATION_FORMAT, type Diagnostic, type BoardView, type ToolContent, type Design, type ChatFile, type ChatItem, type Conversation, type ConversationSession, type ProjectFile, type PaperId, type PartCard, type Rect, type RouteHelperResult, type ScopeInfo, type TokenCount, type TransactionResult, type EnclosureViewInfo, type ViewInfo } from '@4k7/schema';
import { enclosureApiSummary, enclosureFacts, reportText, boardScad, type EnclosureFacts, type EnclosureReport } from '@4k7/fab';
import { renderScript } from './enclosureClient.ts';
import mechanicsGuide from '../../../../docs/design/mechanics.md?raw';
import costGuide from '../../../../docs/design/cost.md?raw';
import highSpeedGuide from '../../../../docs/design/high-speed.md?raw';
import schematicGuide from '../../../../docs/design/schematic.md?raw';
import { server } from './server.svelte.ts';
import { currentChoice, effortLevels } from './models.ts';
import { createKernel } from './kernelClient.ts';
import { BoardClient, type BoardStage, type RouteProgress } from './boardClient.ts';
import { IngestState } from './ingest.svelte.ts';
import { assemblyFacts, describeDatasheetPages, findDesignSections, getBuiltinPart, placedLand, type Saving, type SourcedComponent, type StockLine, type UnsourcedGroup } from '@4k7/parts';
import { ArtworkLibrary } from './artwork.svelte.ts';
import { renderBoardPng, renderSchematicPng } from './snapshot.ts';
import { checkDesignCost, checkDesignStock, checkDesignValues, sourcingTool, type BoardFacts, type CostReport, type StockReport, type SupplierPart } from './sourcing.ts';
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
import { fitConversation, projectJson, readProject, restoredSessions } from './conversation.ts';

/** A tool's answer before the chat's label is put on it. */
type ToolResult = Omit<ToolOutcome, 'label' | 'detail'>;

/**
 * The local server's access key, from the app's address (http://localhost:7777/<access-key>, as the server
 * opens it). `?port=7778` names the server to try first when the app is served by another one.
 */
/** base64 of some bytes (in chunks: spreading a large array into String.fromCharCode overflows the stack). */
function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** pdf.js keeps an open PDF by key: a chat attachment's, from what it is. */
const chatPdfKey = (name: string, data: string) => `chat:${name}:${data.length}:${data.slice(-64)}`;

/** A region of a picture (fractions x0, y0, x1, y1) as a JPEG data URL, its long side `px` at most (and at most 2× the source). */
async function cropImage(url: string, box: [number, number, number, number], px: number): Promise<string> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const [x0, y0, x1, y1] = box;
  const sw = (x1 - x0) * img.naturalWidth;
  const sh = (y1 - y0) * img.naturalHeight;
  const scale = Math.min(px / Math.max(sw, sh, 1), 2);
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(sw * scale));
  out.height = Math.max(1, Math.round(sh * scale));
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#fff'; // transparent screenshots read as white paper
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, x0 * img.naturalWidth, y0 * img.naturalHeight, sw, sh, 0, 0, out.width, out.height);
  return out.toDataURL('image/jpeg', 0.9);
}

const addressPath = /^\/([^/]+)\/?$/.exec(location.pathname)?.[1] ?? '';
const keyFromAddress = SERVER_ACCESS_KEY.test(addressPath) ? addressPath : null;
const portFromAddress = Number(new URLSearchParams(location.search).get('port')) || null;

/** How often to look for the server that keeps the files while it is not reachable. */
const DISK_RETRY_MS = 4000;

export type View = 'sch' | 'lay' | 'enc' | 'parts' | 'set';
export type InspectorTab = 'issues' | 'ledger' | 'history' | 'sel';

export type { ChatFile, ChatItem, Segment } from '@4k7/schema';

/** What the chat takes: pictures and PDFs, up to this size. */
export const CHAT_FILE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'];
const MAX_CHAT_FILE_BYTES = 20 * 1024 * 1024;

/** The API price of some token usage (0 for a model without a known price). */
export function tokenCost(t: TokenCount, fallbackModel: string): number {
  return costUsd(t.model ?? fallbackModel, { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite });
}

/** An op of a transaction, as far as the route helper's worker needs to know it (see transactEdit). */
type RouteAsk = { op?: string; nets?: string[]; from?: string; to?: string; fresh?: boolean };

class AppState {
  view = $state<View>('sch');
  tab = $state<InspectorTab>('issues');
  k = $state<KernelState | null>(null);
  /** Part cards as the working copy has them (a footprint given in the design shows in Parts). */
  designParts = $state.raw<Record<string, PartCard>>({});
  chat = $state<ChatItem[]>([]);
  /** The project file keeps the conversation (the user opted in, per project). */
  keepConversation = $state(false);
  /** Earlier conversations the project file keeps (before the chat was cleared or the project reopened); the agent does not see them. */
  chatArchive = $state.raw<ConversationSession[]>([]);
  running = $state(false);
  selection = $state<string[]>([]);
  /** Files waiting in the composer, sent with the next message. */
  attachments = $state<Omit<ChatFile, 'n'>[]>([]);
  /** Optimize: the area the agent is restricted to while it works on it. */
  scope = $state.raw<ScopeInfo | null>(null);
  /** The canvases on screen say which area they show (schematic: sheet mils, board: mm); null when closed. */
  visibleArea: { sch: (() => Rect | null) | null; board: (() => Rect | null) | null } = { sch: null, board: null };
  /** The Enclosure view says which cut through the box it shows (null: none, or closed). */
  enclosureCut: (() => EnclosureViewInfo | null) | null = null;
  /** What the user had on screen when they sent the message being answered (the agent may switch views meanwhile). */
  private turnView: ViewInfo | null = null;
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
  /** What the board's checks found, once it is laid for the design as it is now (the header counts them with the schematic's). */
  boardCounts = $state<DiagnosticCounts | null>(null);
  /** The Layout view's list of checks is open. */
  checksOpen = $state(false);
  /** Routing under way (the copper laid so far is drawn over the placed board), else null. */
  routeProgress = $state.raw<RouteProgress | null>(null);
  private boards = new BoardClient();
  /** The route helper searching in its worker (drawn copper): what for, and the copper laid so far. */
  helperRun = $state.raw<{ what: string; progress: RouteProgress | null } | null>(null);
  private helperStop: (() => void) | null = null;
  /** The last enclosure render (the report, its pieces, the board facts it was measured against). */
  enclosure = $state.raw<{ report: EnclosureReport; facts: EnclosureFacts } | null>(null);
  enclosureBusy = $state(false);
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
  /** The working copy's enclosure (brief and script), kept while the Enclosure view is open. */
  encDraft = $state.raw<EnclosureSettings | null>(null);
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
    await this.kernel.setChecks($state.snapshot(this.settings.schematicChecks));
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
      await this.ingest.adoptParts(JSON.parse(await this.kernel.exportDesign()) as Design).catch(() => {});
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
      this.flash(`Your project is now a file: ${disk.projectFile(project)}`);
    }
  }

  /** Open a project file. False (and the open project stays) when it cannot be read. */
  async openProject(id: string): Promise<boolean> {
    if (this.running) {
      this.flash('Wait for the agent to finish first.');
      return false;
    }
    this.flushConversation();
    // in the write queue: a save running now writes the design it exported to the file it belongs to
    const design = await this.queueWrite(async () => {
      try {
        const text = await disk.loadProject(id);
        if (text === undefined) {
          this.flash(`${id} is no longer in the projects folder.`);
          await this.refreshProjects();
          return null;
        }
        const { design: d, conversation } = readProject(JSON.parse(text) as ProjectFile);
        await this.kernel.load(d);
        this.projectId = id;
        this.unsaved = false;
        this.renameFile = false;
        this.restoreConversation(conversation);
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
    await this.ingest.adoptParts(design).catch(() => {});
    await this.refresh();
    return true;
  }

  /** The conversation a project file keeps, as earlier conversations; the chat starts afresh, as the agent does. */
  private restoreConversation(c: Conversation | null) {
    this.keepConversation = !!c;
    this.chatArchive = restoredSessions(c);
    this.conversationOmitted = 0;
  }

  /** The conversation for the project file: the earlier ones and the chat. */
  private conversation(): Conversation {
    const chat = $state.snapshot(this.chat) as ChatItem[];
    return { format: CONVERSATION_FORMAT, sessions: [...this.chatArchive, ...(chat.length ? [{ items: chat }] : [])] };
  }

  /** Attachments the project file left out last time it was written (the user is told when it grows). */
  private conversationOmitted = 0;

  /** The design's file text: the design, and the conversation when the project keeps it. */
  private projectText(designJson: string): string {
    if (!this.keepConversation) return designJson;
    const { conversation, omitted } = fitConversation(this.conversation());
    if (omitted > this.conversationOmitted) this.flash(`The conversation is large: the project file keeps its ${omitted} oldest attachment${omitted === 1 ? '' : 's'} by name only.`);
    this.conversationOmitted = omitted;
    return projectJson(designJson, conversation);
  }

  /** Keep the conversation in the project file, or (off) remove it from there. */
  async setKeepConversation(on: boolean) {
    this.keepConversation = on;
    if (!on) this.chatArchive = [];
    await this.persist();
    if (!this.unsaved) this.flash(on ? 'The conversation is now kept in the project file.' : 'The conversation was removed from the project file.');
  }

  /** The chat changed: write it to the project file soon, when the project keeps it (one write for a burst of changes). */
  private conversationChanged() {
    if (!this.keepConversation) return;
    if (this.conversationTimer) clearTimeout(this.conversationTimer);
    this.conversationTimer = setTimeout(() => {
      this.conversationTimer = null;
      void this.persist();
    }, 1500);
  }

  private conversationTimer: ReturnType<typeof setTimeout> | null = null;

  /** Write a conversation change still waiting, before another project replaces this one. */
  private flushConversation() {
    if (!this.conversationTimer) return;
    clearTimeout(this.conversationTimer);
    this.conversationTimer = null;
    void this.persist();
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
    // (in the Layout view they stay until the board is laid again, a moment later)
    if (this.view !== 'lay') this.boardCounts = null;
    const next = await this.kernel.state();
    const shown = this.k?.view.sheets[this.sheet]?.id;
    this.k = next;
    this.designParts = await this.kernel.designParts();
    const ids = new Set(this.k.proposal?.hunks.map((h) => h.id) ?? []);
    for (const id of Object.keys(this.hunkOff)) if (!ids.has(id)) delete this.hunkOff[id];
    // the sheet on screen stays when a sheet before it comes or goes; one that went leaves its place to its neighbour
    const at = this.k.view.sheets.findIndex((s) => s.id === shown);
    this.sheet = at >= 0 ? at : Math.max(0, Math.min(this.sheet, this.k.view.sheets.length - 1));
    if (this.view === 'lay') void this.refreshBoard();
    if (this.view === 'enc') void this.refreshEnclosure();
  }

  /** The Enclosure view: the working copy's brief and script, and the board they go with. */
  async refreshEnclosure() {
    this.encDraft = (await this.kernel.draftDesign()).enclosure ?? null;
    if (!this.board || this.boardRev !== this.rev) void this.refreshBoard();
  }

  /** The board anew: its placement from the kernel at once, then routing, pours and DRC in the board worker. */
  async refreshBoard() {
    const rev = this.rev;
    const request = await this.kernel.boardRequest().catch((e: Error) => {
      this.boardBusy = false;
      this.routeProgress = null;
      this.boardCounts = null;
      this.boards.fail();
      this.flash(`Board layout failed: ${e.message}`);
      return null;
    });
    if (!request) return;
    this.boardBusy = true;
    this.boardStage = 'placed';
    this.routeProgress = null;
    this.boards.compute(
      request.design,
      request.placed,
      (stage, board) => {
        this.routeProgress = null;
        const { newCopper, ...shown } = board;
        this.board = shown;
        this.boardStage = stage;
        if (stage === 'routed') {
          this.boardBusy = false;
          this.boardRev = rev;
          if (rev === this.rev) this.boardCounts = countDiagnostics(board.diagnostics);
          // routed here, not taken from the design: keep it, so it is not routed again
          if (newCopper) void this.keepCopper(newCopper);
        }
      },
      (msg) => {
        this.boardBusy = false;
        this.routeProgress = null;
        this.boardCounts = null;
        this.flash(`Board layout failed: ${msg}`);
      },
      (p) => (this.routeProgress = p),
    );
  }

  /**
   * Stop the routing under way and keep its best pass: the board then shows it, with what is
   * still open; Route runs it again from the start.
   */
  async stopRouting() {
    const best = this.boards.stop();
    this.routeProgress = null;
    this.boardBusy = false;
    if (!best) return;
    this.flash(best.passes ? `Routing stopped: kept the best pass, ${best.open.length} connection${best.open.length === 1 ? '' : 's'} open` : 'Routing stopped before its first pass finished');
    await this.keepCopper(best);
    await this.refreshBoard();
  }

  /** Keep copper the board worker routed with the design; saved when the committed design took it. */
  private async keepCopper(copper: NonNullable<BoardView['newCopper']>) {
    if (await this.kernel.keepCopper(copper)) await this.persist();
  }

  /** A try_placements query, run on a copy of the working design in a worker of its own (trial routing takes seconds). */
  private async trialQuery(query: unknown): Promise<unknown> {
    const design = await this.kernel.draftDesign();
    const worker = new Worker(new URL('./trial.worker.ts', import.meta.url), { type: 'module' });
    try {
      return await new Promise((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<{ result?: unknown; error?: string }>) => (e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.result));
        worker.onerror = (e) => reject(new Error(e.message || 'The placement trial failed.'));
        worker.postMessage({ design, query });
      });
    } finally {
      worker.terminate();
    }
  }

  /** The routed board of the current design, for agents (computed if needed). */
  private async routedBoard(): Promise<BoardView | null> {
    if (!this.boards.busy && this.board && this.boardStage === 'routed' && this.boardRev === this.rev) return this.board;
    const next = this.boards.next();
    if (!this.boards.busy) void this.refreshBoard();
    return next;
  }

  /**
   * Run the working copy's enclosure script and measure what it makes, in a worker of its own
   * (docs/design/enclosure.md §5). Keeps the result for the Enclosure view and the pictures.
   */
  async renderEnclosure(): Promise<{ report: EnclosureReport; facts: EnclosureFacts } | { error: string }> {
    const design = await this.kernel.draftDesign();
    const script = design.enclosure?.script;
    if (!script) return { error: 'There is no enclosure script yet: write one with design_edit set_enclosure_script.' };
    const b = await this.routedBoard();
    if (!b) return { error: 'The board could not be computed.' };
    const facts = enclosureFacts(b);
    this.enclosureBusy = true;
    try {
      const report = await renderScript({ facts, script, ...(design.enclosure?.brief ? { brief: design.enclosure.brief } : {}), ...(design.enclosure?.graphics ? { graphics: design.enclosure.graphics } : {}) });
      const out = { report, facts };
      this.enclosure = out;
      return out;
    } catch (e) {
      return { error: `Rendering failed: ${(e as Error).message}` };
    } finally {
      this.enclosureBusy = false;
    }
  }

  /** Pictures of the last render for the agent (render_enclosure). */
  private async enclosurePictures(req: RenderEnclosureInput, r: { report: EnclosureReport; facts: EnclosureFacts }): Promise<{ data: string; mimeType: string; title: string }[]> {
    const b = await this.routedBoard();
    if (!b) return [];
    const design = await this.kernel.draftDesign();
    try {
      const { enclosurePictures } = await import('./enclosure3d.ts');
      return await enclosurePictures({ board: b, facts: r.facts, pieces: r.report.pieces, findings: r.report.findings, openings: design.enclosure?.brief?.openings ?? [], inlays: scriptInlays(r.report.script) }, req);
    } catch (e) {
      this.flash(`Enclosure pictures failed: ${(e as Error).message}`);
      return [];
    }
  }

  /** board.scad for the working copy (a download, for a box of one's own in OpenSCAD). */
  async boardScadFile(): Promise<{ name: string; content: string } | null> {
    const design = await this.kernel.draftDesign();
    const b = await this.routedBoard();
    return b ? boardScad(b, design.name, design.enclosure?.brief, design.enclosure?.graphics) : null;
  }

  /** design_query get_enclosure: the brief, the script, the board as the script finds it and what it can call, the last render. */
  private async enclosureQuery(): Promise<unknown> {
    const design = await this.kernel.draftDesign();
    const enc = design.enclosure;
    const b = await this.routedBoard();
    const last = this.enclosure;
    return {
      brief: enc?.brief ?? null,
      open_questions: openQuestions(enc?.brief).map((i) => `${i.topic}: ${i.question}`),
      script: enc?.script ?? null,
      graphics: enclosureGraphicsInfo(enc?.graphics),
      board_api: b ? enclosureApiSummary(enclosureFacts(b), enc?.brief, enc?.graphics) : 'the board could not be computed',
      last_render: !enc?.script ? 'no script yet' : last && last.report.key === enclosureKey(enc) ? reportText(last.report, last.facts) : 'not rendered since the script or its graphics last changed: render_enclosure',
      how: 'Read design_query get_guide topic "mechanics" before the first brief. 1. The brief (set_enclosure_brief): decide what you can, ask what only the user knows, in one brief; the user answers in the app. 2. The script (set_enclosure_script), JavaScript against board_api: never copy a number the board has, const pieces = [\'base\', \'lid\'];, one function per piece. 3. render_enclosure after every change: fix the report first, then what the pictures show. 4. propose when the report is clean.',
    };
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
    this.conversationChanged();
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

  /** Take an empty sheet away (the × on its tab); Undo brings it back. */
  removeSheet(name: string) {
    return this.userEdit(`Remove sheet ${name}`, [{ op: 'remove_sheet', sheet: name }]);
  }

  /** A direct user edit (e.g. removing a ledger entry) commits immediately, attributed to the user. */
  async userEdit(summary: string, ops: unknown[]): Promise<boolean> {
    if (this.k?.proposal) {
      this.flash('Review the pending changes first.');
      return false;
    }
    const r = await this.transactEdit({ summary, ops }, 'user');
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
  waiveCheck(d: Diagnostic): Promise<boolean> {
    return this.userEdit(`Not a problem: ${d.code} on ${d.entities.join(', ')}`, [{ op: 'add_waiver', code: d.code, entities: d.entities, reason: 'Marked as intended in the layout checks' }]);
  }

  /** Bring a waived board check back. */
  restoreCheck(waiverId: string): Promise<boolean> {
    return this.userEdit(`Check back on (${waiverId})`, [{ op: 'remove_waiver', id: waiverId }]);
  }

  /**
   * Who lays the copper: the router, or the agent (drawn copper; `keep` starts from the router's
   * copper as it is). Back to the router drops the drawn copper (undo brings it back).
   */
  setCopperMode(mode: 'drawn' | 'router', keep = true): Promise<boolean> {
    const drawn = this.board?.drawn;
    if (mode === 'router' && drawn && !window.confirm(`Back to the router: the ${drawn.tracks.length} drawn tracks and ${drawn.vias.length} vias are dropped and the router lays the board again (Undo brings them back).`)) return Promise.resolve(false);
    return this.userEdit(mode === 'drawn' ? (keep ? 'Drawn copper, from the routing' : 'Drawn copper, empty') : 'Copper back to the router', [{ op: 'set_copper_mode', mode, ...(mode === 'drawn' ? { keep } : {}) }]);
  }

  /** Drawn copper: the route helper on every open connection, round what is drawn (`fresh`: its own copper laid again too). */
  routeOpen(fresh = false): Promise<boolean> {
    return this.userEdit(fresh ? "Lay the route helper's copper again" : 'Route the open connections', [{ op: 'route', ...(fresh ? { fresh: true } : {}) }]);
  }

  /** Drawn copper: ask the agent to lay it. */
  askToDraw() {
    const open = this.board?.unrouted.length ?? 0;
    void this.send(
      `The copper is yours to draw (drawn copper)${open ? `, ${open} connection${open === 1 ? '' : 's'} open` : ''}. Lay it as an engineer would: the paths that matter first (switching loops short and wide, the drops to the planes, return paths, sensitive signals away from noisy ones), then the route helper for the connections that do not matter, and look at each step with get_board_image. Finish with no open connections and no errors; say which warnings you keep and why.`,
      { shown: 'Draw the copper yourself' },
    );
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
    if (known && !(same && ing.phase !== 'idle')) return text(`${args.mpn} is already in the library as ${known.id}; add it with add_part. To change it, use design_edit on a component using it (set_pin_descriptions, set_footprint, set_symbol, set_mating, set_polarity, rename_part), not a new import.`);
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

  /** Every file attached in this conversation, #1 first. */
  private chatFiles(): ChatFile[] {
    return this.chat.flatMap((c) => c.files ?? []);
  }

  /** Add dropped, pasted or picked files to the composer (pictures and PDFs; anything else is refused with a note). */
  async attach(files: Iterable<File>) {
    for (const f of files) {
      if (!CHAT_FILE_TYPES.includes(f.type)) {
        this.flash(`${f.name}: the chat takes pictures (PNG, JPEG, WebP, GIF) and PDFs.`);
        continue;
      }
      if (f.size > MAX_CHAT_FILE_BYTES) {
        this.flash(`${f.name} is larger than ${MAX_CHAT_FILE_BYTES >> 20} MB.`);
        continue;
      }
      const name = f.name || `pasted.${f.type === 'application/pdf' ? 'pdf' : f.type.split('/')[1]}`;
      const buf = await f.arrayBuffer();
      const data = base64(new Uint8Array(buf));
      let pages: number | undefined;
      if (f.type === 'application/pdf') {
        try {
          const { openPdf, pageCount } = await import('./pdf.ts');
          pages = pageCount(await openPdf(chatPdfKey(name, data), buf));
        } catch (e) {
          this.flash(`Could not read ${name}: ${(e as Error).message}`);
          continue;
        }
      }
      this.attachments.push({ name, mime: f.type, data, ...(pages ? { pages } : {}) });
    }
  }

  /** The view_attachment tool: a file from the chat as a picture, whole or a region zoomed in. */
  private async viewAttachment(args: { n: number; page?: number; region?: [number, number, number, number] }): Promise<ToolResult> {
    const all = this.chatFiles();
    const f = all.find((x) => x.n === args.n);
    if (!f) return { content: all.length ? `There is no attachment #${args.n}; the conversation has #1 to #${all.length}.` : 'Nothing is attached in this conversation.', isError: true };
    const box = args.region ?? [0, 0, 1, 1];
    if (box[2] <= box[0] || box[3] <= box[1]) return { content: 'The region needs x1 > x0 and y1 > y0.', isError: true };
    const px = args.region ? 1600 : 1400;
    let src: string;
    let what = `#${f.n} ${f.name}`;
    if (f.pages) {
      const page = args.page ?? 1;
      if (page > f.pages) return { content: `${f.name} has ${f.pages} page${f.pages === 1 ? '' : 's'}.`, isError: true };
      const { openPdf, cropPage } = await import('./pdf.ts');
      const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
      src = await cropPage(await openPdf(chatPdfKey(f.name, f.data), bytes.buffer), page, box, px);
      what += `, page ${page} of ${f.pages}`;
    } else {
      src = await cropImage(`data:${f.mime};base64,${f.data}`, box, px);
    }
    if (args.region) what += ` (region ${args.region.join(', ')})`;
    return { content: `${what}.`, images: [{ data: src.slice(src.indexOf(',') + 1), mimeType: 'image/jpeg' }], isError: false };
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
      getBuiltinPart(id) ??
      (pending && (pending.id === id || pending.mpn?.toLowerCase() === args.part.toLowerCase()) ? pending : undefined);
    if (!card) return text(`No part or component "${args.part}".`, true);
    let ds: Awaited<ReturnType<IngestState['datasheetFor']>>;
    try {
      ds = await this.ingest.datasheetFor(card, { download: true });
    } catch (e) {
      return text(`${card.id}'s datasheet could not be downloaded from ${card.datasheet}: ${(e as Error).message}.`, true);
    }
    if (!ds) return text(`${card.id} has no datasheet: neither a stored PDF nor a link.`, true);
    const { openPdf, pageText, pageCount, cropPage } = await import('./pdf.ts');
    const doc = await openPdf(ds.hash, ds.data);
    const n = pageCount(doc);
    // the card's page numbers were read from the file it was imported from
    const other = card.provenance.document?.startsWith('sha256:') && card.provenance.document !== `sha256:${ds.hash}`;
    const caveat = other ? ' (downloaded from its link: not the file the part was imported from, so the page numbers on the card may be off)' : '';
    if (args.page) {
      if (args.page > n) return text(`The datasheet has ${n} pages.`, true);
      const body = await pageText(doc, args.page);
      const src = await cropPage(doc, args.page, args.region ?? [0, 0, 1, 1], args.region ? 1600 : 1400);
      return {
        isError: false,
        content: `${card.id} datasheet, page ${args.page} of ${n}${args.region ? ` (region ${args.region.join(', ')})` : ''}${caveat}:\n${body}`,
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
    const known = describeDatasheetPages({
      ...(card.provenance.page ? { pinout: [card.provenance.page] } : {}),
      ...(card.packageInfo?.page ? { package: [card.packageInfo.page] } : {}),
      ...card.datasheetPages,
    });
    const headings = findDesignSections(pages);
    return text(
      [
        `${card.id} datasheet ${ds.name}, ${n} pages${caveat}.`,
        known && `Noted at import: ${known}.`,
        headings.length && `Design sections (by heading): ${headings.map((h) => `p.${h.page} ${h.heading}`).join(' · ')}.`,
        'Pages:',
        ...index,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  async queryNet(net: string): Promise<unknown> {
    return this.kernel.query({ op: 'get_net', net });
  }

  async queryComponent(ref: string): Promise<unknown> {
    return this.kernel.query({ op: 'get_component', ref });
  }

  /* -------------------------------- sourcing ------------------------------- */

  /**
   * The working copy's components as the stock check sees them: what each is, its values, its
   * package, and its land as it lies on the board (held against the house's footprint for the part).
   */
  private async sourcedComponents(): Promise<SourcedComponent[]> {
    type Info = { refdes: string; part: string; category?: SourcedComponent['category']; params: Record<string, string>; package?: { name: string } };
    const refs = this.k?.summary.components.map((c) => c.refdes) ?? [];
    const [infos, board] = await Promise.all([
      Promise.all(refs.map((ref) => this.kernel.query({ op: 'get_component', ref }))) as Promise<(Info | { error: string })[]>,
      this.kernel.boardPlacement().catch(() => null),
    ]);
    const placed = new Map((board?.parts ?? []).map((p) => [p.refdes, p]));
    return infos.flatMap((c) => {
      if (!('refdes' in c)) return [];
      const card = this.designParts[c.part];
      const pkg = c.package?.name ?? c.params.package ?? card?.package;
      const mpn = c.params.mpn ?? card?.mpn;
      const p = placed.get(c.refdes);
      const land = p && card ? placedLand(p, (pin) => card.pins.find((x) => x.number === pin)?.name) : undefined;
      return [{ refdes: c.refdes, ...(c.category ? { category: c.category } : {}), params: c.params, ...(pkg ? { pkg } : {}), ...(mpn ? { mpn } : {}), ...(land ? { land } : {}) }];
    });
  }

  /** What the assembly fees depend on, read off the working copy's placed board (joints, sides, size); null when it cannot be placed. */
  private async boardFacts(): Promise<BoardFacts | null> {
    try {
      const b = await this.kernel.boardPlacement();
      return (assembled, kinds) => assemblyFacts(b, assembled, kinds);
    } catch {
      return null;
    }
  }

  /** The assembly house the checks run for: the user's pick (Layout → Sourcing), else the board's manufacturer when it assembles, else the default. */
  get house(): AssemblyHouse {
    return assemblyHouse(this.settings.assemblyHouse) ?? assemblyHouse(this.board?.fab?.house) ?? ASSEMBLY_HOUSE;
  }

  /** Source at another house (the Layout view shows a report only for the house it was made for). */
  chooseHouse(id: string) {
    return this.updateSettings({ assemblyHouse: id });
  }

  /** Check the stock of every part for `boards` boards (default: the number set in the Layout view) at a house, with the order's estimate; the Layout view shows the chosen house's report. */
  async checkStock(boards?: number, house: AssemblyHouse = this.house): Promise<StockReport> {
    this.stockBusy = true;
    try {
      const [components, facts] = await Promise.all([this.sourcedComponents(), this.boardFacts()]);
      const report = await checkDesignStock(components, boards ?? this.settings.buildBoards, facts ?? undefined, house);
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
      const [components, facts] = await Promise.all([this.sourcedComponents(), this.boardFacts()]);
      if (!facts) throw new Error('the board could not be placed, so the assembly fees cannot be counted');
      const report = await checkDesignCost(components, boards ?? this.settings.buildBoards, facts, house);
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
    void this.send(
      `Make this design cheaper to make at ${this.house.name} for ${n} boards, without changing what it does. Read design_query get_guide topic "cost" first and follow it: ` +
        'measure with sourcing cost and sourcing values, decide part by part by what each does in the circuit, ask me before a change I may care about, ' +
        'make the rest in one changeset, check again with sourcing cost and sourcing check, and tell me the total before and after, what each change saves, and what you left as it was and why.',
      { shown: `Optimize the cost for ${n} boards` },
    );
  }

  /** Make a sourcing change (the user's), then run the check shown again. */
  private async sourcingEdit(summary: string, ops: unknown[]): Promise<boolean> {
    const ok = ops.length > 0 && (await this.userEdit(summary, ops));
    if (ok) {
      const again = this.sourcingShown === 'cost' ? this.checkCost(this.costReport?.boards) : this.checkStock(this.stockReport?.boards);
      void again.catch((e: Error) => this.flash(`The check failed: ${e.message}`));
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
    this.chat.push({ id: this.seq++, role: 'agent', at: new Date().toISOString(), source: agent, segments: [], status: 'streaming' });
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
        if ((input as { op?: string })?.op === 'try_placements') {
          try {
            const out = (await this.trialQuery(input)) as { error?: string; options?: { name: string; error?: string }[] };
            if (out.error) return fail('query · try_placements', out.error);
            const best = out.options?.find((o) => !o.error);
            return { content: JSON.stringify(out), isError: false, label: 'query · try_placements', detail: `${out.options?.length ?? 0} option(s)${best ? `, best: ${best.name}` : ''}` };
          } catch (e) {
            return fail('query · try_placements', (e as Error).message);
          }
        }
        // (it routes each try for a moment: off the kernel worker too)
        if ((input as { op?: string })?.op === 'suggest_moves') {
          try {
            const out = (await this.trialQuery(input)) as { error?: string; suggestions?: { change: string; closes: number }[]; tried?: number };
            if (out.error) return fail('query · suggest_moves', out.error);
            const best = out.suggestions?.[0];
            return { content: JSON.stringify(out), isError: false, label: 'query · suggest_moves', detail: best ? `${out.suggestions!.length} suggestion(s), best: ${best.change} (closes ${best.closes})` : `none of ${out.tried ?? 0} tries closes a connection` };
          } catch (e) {
            return fail('query · suggest_moves', (e as Error).message);
          }
        }
        if ((input as { op?: string })?.op === 'get_enclosure') {
          const out = await this.enclosureQuery();
          return { content: JSON.stringify(out), isError: false, label: 'query · get_enclosure', detail: (out as { open_questions: string[] }).open_questions.length ? 'questions open' : 'ok' };
        }
        if ((input as { op?: string })?.op === 'get_guide') {
          const topic = (input as { topic?: string }).topic;
          const guide = topic === 'mechanics' ? mechanicsGuide : topic === 'cost' ? costGuide : topic === 'high_speed' ? highSpeedGuide : topic === 'schematic' ? schematicGuide : null;
          if (!guide) return fail('query · get_guide', 'Guides: schematic, mechanics, cost, high_speed.');
          // the guide is its docs/design file as it is, without its header for people
          return { content: guide.replace(/^#[^\n]*\n+(>[^\n]*\n)+\n*/, ''), isError: false, label: 'query · get_guide', detail: topic! };
        }
        if ((input as { op?: string })?.op !== 'get_board') break;
        // routed in the board worker, so the kernel stays responsive
        const b = await this.routedBoard();
        if (!b) return fail('query · get_board', 'The board could not be computed.');
        return { content: JSON.stringify(boardSummary(b)), isError: false, label: 'query · get_board', detail: `${b.stats.routed}/${b.stats.nets} nets routed` };
      }
      case 'sourcing':
        return sourcingTool(input, { stock: (boards, h) => this.checkStock(boards, h), cost: (boards, h) => this.checkCost(boards, h), values: (boards, h) => this.checkValues(boards, h) }, this.house);
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
      case 'view_attachment': {
        const args = AttachmentInput.safeParse(input ?? {});
        if (!args.success) return fail('attachment', args.error.message);
        const out = await this.viewAttachment(args.data);
        return { ...out, label: `attachment · #${args.data.n}${args.data.page ? ` p.${args.data.page}` : ''}${args.data.region ? ' (zoom)' : ''}`, detail: out.isError ? first(out.content) : 'ok' };
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
        const seen = this.turnView ?? this.currentView();
        if (args.area && this.scope) {
          const i = sheets.findIndex((s) => s.id === this.scope!.scope.sheet);
          if (i >= 0) this.sheet = i;
          await tick();
          frame = this.scope.scope.rect;
        } else if (args.area && seen?.view === 'schematic') {
          const i = sheets.findIndex((s) => s.name === seen.sheetName);
          if (i >= 0) this.sheet = i;
          await tick();
          frame = seen.rect;
        } else if (args.area) {
          return fail('schematic image', 'There is no area: the user was not looking at the schematic. Leave area out for the whole sheet, or pass page.');
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
      case 'render_enclosure': {
        const parsed = RenderEnclosureInput.safeParse(input ?? {});
        if (!parsed.success) return fail('enclosure', parsed.error.message);
        const r = await this.renderEnclosure();
        if ('error' in r) return fail('enclosure', r.error);
        const errors = r.report.findings.filter((f) => f.severity === 'error').length;
        const images = r.report.pieces.length ? await this.enclosurePictures(parsed.data, r) : [];
        return {
          content: reportText(r.report, r.facts) + (images.length ? `\nPictures: ${images.map((i) => i.title).join('; ')}.` : ''),
          images: images.map(({ title: _t, ...img }) => img),
          isError: false,
          label: 'enclosure render',
          detail: errors ? `${errors} finding(s)` : r.report.findings.length ? 'warnings' : 'clean',
        };
      }
      case 'get_board_image': {
        const parsed = BoardImageInput.safeParse(input ?? {});
        if (!parsed.success) return fail('board image', parsed.error.message);
        const args = parsed.data;
        const seen = this.turnView ?? this.currentView();
        if (args.area && seen?.view !== 'board') return fail('board image', 'There is no area: the user was not looking at the board. Leave area out for the whole board, or pass region.');
        if (this.view !== 'lay') {
          this.view = 'lay';
          await tick();
        }
        // the picture shows the routing, so it waits for it (a big board takes a while)
        const b = await this.routedBoard();
        if (!b) return fail('board image', 'The board could not be computed.');
        await tick();
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const m = Math.max(b.outline.w, b.outline.h) * 0.04 + 1;
        const region = args.region ? { x: Math.min(args.region[0], args.region[2]), y: Math.min(args.region[1], args.region[3]), w: Math.abs(args.region[2] - args.region[0]), h: Math.abs(args.region[3] - args.region[1]) } : null;
        if (region && (region.w < 0.5 || region.h < 0.5)) return fail('board image', 'The region is too small: give x0, y0, x1, y1 in mm at least 0.5 mm apart.');
        const frame = args.area && seen?.view === 'board' ? seen.rect : (region ?? { x: -m, y: -m, w: b.outline.w + 2 * m, h: b.outline.h + 2 * m });
        try {
          const img = await renderBoardPng(args.width, frame);
          return {
            content: `${b.outline.w} × ${b.outline.h} mm, ${b.routing === 'done' ? `${b.stats.routed}/${b.stats.nets} nets routed${b.ratsnest.length ? `, ${b.ratsnest.length} connection(s) open (thin straight lines)` : ''}` : 'not routed (thin straight lines: the connections to route)'}.`,
            images: [img],
            isError: false,
            label: 'board image',
            detail: `${args.width}px${args.area ? ' · the area' : region ? ' · region' : ''}`,
          };
        } catch (e) {
          return fail('board image', (e as Error).message);
        }
      }
    }
    return (await runKernelTool(this.editPort, tool, input)) ?? unknownTool(tool);
  }

  /** The kernel as the agent's tools reach it: an edit asking the route helper runs in its worker first (transactEdit). */
  private editPort: KernelPort = { ...this.kernel.port, transact: (tx) => this.transactEdit(tx) };

  /**
   * A transaction for the kernel. One that asks the route helper on drawn copper (route nets /
   * from, to) searches in a worker first, so the kernel stays responsive and the user sees the
   * copper fill in and may stop it; the kernel then applies the transaction with what the helper
   * found (the same copper, without routing again). Everything else goes straight to the kernel.
   */
  private transactEdit(tx: unknown, by?: 'user'): Promise<TransactionResult> {
    const ops = (tx as { ops?: RouteAsk[] })?.ops;
    if (!Array.isArray(ops) || !ops.some((o) => o?.op === 'route')) return this.kernel.transact(tx, by);
    // one at a time (the agent may send two at once): each starts from the design the one before left
    const run = this.helperQueue.then(() => this.transactHelped(tx, by, ops));
    this.helperQueue = run.catch(() => {});
    return run;
  }
  private helperQueue: Promise<unknown> = Promise.resolve();

  private async transactHelped(tx: unknown, by: 'user' | undefined, ops: RouteAsk[]): Promise<TransactionResult> {
    const what = ops.filter((o) => o?.op === 'route').map((o) => (o.nets?.length ? o.nets.join(', ') : o.from ? `${o.from} → ${o.to}` : 'every open connection') + (o.fresh ? ', its own copper again' : '')).join('; ');
    // the results are laid only on the working copy they were found for; changed meanwhile (a drag,
    // an undo), the helper searches again on it, a few times, then the kernel routes itself
    for (let attempt = 0; attempt < 3; attempt++) {
      const { design, rev } = await this.kernel.draftSnapshot();
      if (!design.board?.drawn && !ops.some((o) => o?.op === 'set_copper_mode')) return this.kernel.transact(tx, by);
      const run = await this.runHelper(design, tx, by ?? 'agent', ops.flatMap((o, i) => (o?.op === 'route' ? [i] : [])), what);
      if (!run) return this.kernel.transact(tx, by);
      const r = await this.kernel.transact(tx, by, run.results, rev);
      if (r.rejection?.code !== 'STALE') return r;
      if (run.stopped) return { ...r, rejection: { ...r.rejection, message: 'The route helper was stopped, and the design changed while it searched: nothing was laid. Route again.' } };
    }
    return this.kernel.transact(tx, by);
  }

  /**
   * The route helper of a transaction in its worker: the results by op index (null if the worker
   * failed: the kernel then routes itself). Stop keeps the best the running op had found and
   * nothing for the route ops not started.
   */
  private runHelper(design: Design, tx: unknown, by: 'user' | 'agent', routeOps: number[], what: string): Promise<{ results: Record<number, RouteHelperResult>; stopped: boolean } | null> {
    return new Promise((resolve) => {
      const worker = new Worker(new URL('./helper.worker.ts', import.meta.url), { type: 'module' });
      const results: Record<number, RouteHelperResult> = {};
      let best: { op: number; result: RouteHelperResult } | null = null;
      const end = (out: Record<number, RouteHelperResult> | null, stopped = false) => {
        worker.terminate();
        this.helperRun = null;
        this.helperStop = null;
        resolve(out ? { results: out, stopped } : null);
      };
      this.helperRun = { what, progress: null };
      this.helperStop = () => {
        const out = { ...results };
        for (const i of routeOps) out[i] ??= i === best?.op ? { ...best.result, stopped: true } : { tracks: [], vias: [], open: [], passes: 0, stopped: true };
        this.flash(best?.result.passes ? `Route helper stopped: kept what it had found (${best.result.tracks.length} tracks, ${best.result.vias.length} vias)` : 'Route helper stopped before its first pass ended: nothing laid');
        end(out, true);
      };
      worker.onmessage = (e: MessageEvent<{ progress?: RouteProgress; best?: { op: number; result: RouteHelperResult }; done?: { op: number; result: RouteHelperResult }; finished?: { results: Record<number, RouteHelperResult> }; error?: string }>) => {
        const m = e.data;
        if (m.progress) this.helperRun = { what, progress: m.progress };
        else if (m.best) best = m.best;
        else if (m.done) results[m.done.op] = m.done.result;
        else if (m.finished) end(m.finished.results);
        else if (m.error) end(null);
      };
      worker.onerror = () => end(null);
      worker.postMessage({ design, tx, by });
    });
  }

  /** Stop the route helper: what it found by then is laid (see runHelper). */
  stopHelper() {
    this.helperStop?.();
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
        return text(formatDesignContext({ ...snap, selection: this.selection, scope: this.scope, view: this.turnView ?? this.currentView(), rules: this.settings.schematicNotes, layoutRules: this.settings.layoutNotes, enclosureRules: this.settings.enclosureNotes }) + pending + `\nautonomy: ${this.settings.mode}`);
      }
      case 'propose': {
        const args = ProposeInput.safeParse(input);
        if (!args.success) return text(args.error.message, true);
        await this.refresh();
        const p = this.k?.proposal;
        if (!p) return text('Nothing to propose: the working copy has no changes.', true);
        const errors = this.k!.diagnostics.filter(mustFix);
        if (errors.length) {
          log('propose', false, `refused: ${errors.length} open error(s)`);
          return text(
            `Refused: the design has ${errors.length} open error(s). Fix them (or waive intended ones with a reason) first:\n` +
              errors.map((d) => `- ${d.code} ${d.entities.join(',')}: ${d.message}`).join('\n'),
            true,
          );
        }
        // drawn copper: the hard rules (errors of the copper DRC) hold; warnings are the agent's call
        const draftBoard = (await this.kernel.draftDesign()).board;
        if (p.hunks.some((h) => h.id === 'board:board') && draftBoard?.drawn) {
          const b = await this.routedBoard();
          const hard = (b?.diagnostics ?? []).filter((x) => x.severity === 'error' && !x.waivedBy && x.code !== 'DRC.UNROUTED');
          if (hard.length) {
            log('propose', false, `refused: ${hard.length} hard copper rule(s)`);
            return text(`Refused: the drawn copper breaks ${hard.length} hard rule(s). Fix them (get_board_image region shows the spot; get_copper lists the copper by id):\n` + hard.slice(0, 20).map((x) => `- ${x.code}${x.at ? ` at ${x.at.x.toFixed(2)}, ${x.at.y.toFixed(2)}` : ''}: ${x.message}`).join('\n'), true);
          }
        }
        // a routed board is routed completely, or the agent says why not
        if (p.hunks.some((h) => h.id === 'board:board') && !args.data.open_connections?.trim() && (draftBoard?.routed || draftBoard?.drawn)) {
          const b = await this.routedBoard();
          if (b?.routing === 'done' && b.unrouted.length) {
            log('propose', false, `refused: ${b.unrouted.length} open connection(s)`);
            const name = (id: string) => b.netNames[id] ?? id;
            return text(
              `Refused: ${b.drawn ? 'the drawn copper leaves' : 'the board is routed but'} ${b.unrouted.length} connection(s) ${b.drawn ? '' : 'are '}open, and a board with an open connection does not work. ${b.drawn ? 'Draw them' : 'Make room and route again'} (get_board lists them with what blocks them; get_board_image region shows the spot):\n` +
                b.unrouted.slice(0, 12).map((u) => `- ${name(u.netId)} ${u.from} → ${u.to}${u.blockedBy?.length ? `, blocked by ${u.blockedBy.map(name).join(', ')}` : u.enclosed ? ', closed off' : u.plane ? `, no room for the via to ${u.plane}` : ''}${u.near.length ? `, near ${u.near.join(', ')}` : ''}`).join('\n') +
                '\nIf you cannot close them, propose with open_connections saying why and what the user could decide.',
              true,
            );
          }
        }
        // a changed enclosure script (or its graphics) was rendered and its report is clean, or the agent says why not
        if (p.hunks.some((h) => h.id === 'enclosure:script' || h.id === 'enclosure:graphics') && !args.data.enclosure_findings?.trim()) {
          const enc = (await this.kernel.draftDesign()).enclosure;
          const script = enc?.script;
          const last = this.enclosure?.report;
          if (script && (!last || last.key !== enclosureKey(enc))) {
            log('propose', false, 'refused: enclosure not rendered');
            return text('Refused: the enclosure script or its graphics changed and have not been rendered since. Call render_enclosure and fix what its report says first.', true);
          }
          const errors = last?.findings.filter((f) => f.severity === 'error') ?? [];
          if (script && errors.length) {
            log('propose', false, `refused: ${errors.length} enclosure finding(s)`);
            return text(`Refused: the enclosure's last render has ${errors.length} finding(s):\n${errors.map((f) => `- ${f.code} ${f.message}`).join('\n')}\nFix them and render again; if you cannot, propose with enclosure_findings saying why and what the user could decide.`, true);
          }
        }
        const it = item();
        it.segments.push({ type: 'text', text: args.data.summary + (args.data.message ? `\n${args.data.message}` : '') + (args.data.open_connections ? `\nOpen connections: ${args.data.open_connections}` : '') + (args.data.enclosure_findings ? `\nEnclosure: ${args.data.enclosure_findings}` : '') });
        if (this.agentRun?.item !== it) it.status = 'done';
        it.changeset = { state: 'pending' };
        this.conversationChanged();
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
    this.conversationChanged();
    return {
      isError: out.isError,
      content: [...(out.images ?? []).map((i) => ({ type: 'image' as const, ...i })), ...(out.content ? [{ type: 'text' as const, text: out.content }] : [])],
    };
  }

  /** Write the design to its project file (a new file the first time); without the server, mark it unsaved. */
  private persist(): Promise<void> {
    return this.queueWrite(async () => {
      const design = await this.kernel.exportDesign();
      await this.ingest.adoptParts(JSON.parse(design) as Design).catch(() => {});
      const json = this.projectText(design);
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
        if (this.renameFile) await this.renameProjectFile((JSON.parse(design) as Design).name);
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

  /** The project file's text (with the conversation when the project keeps it), for a copy elsewhere. */
  async exportJson(): Promise<string> {
    return this.projectText(await this.kernel.exportDesign());
  }

  /** Open a design (a project file: with the conversation it keeps) as a new project (its own file, named after the design). */
  async importDesign(file: ProjectFile) {
    if (this.running) {
      this.flash('Wait for the agent to finish first.');
      return;
    }
    this.flushConversation();
    const { design: d, conversation } = readProject(file);
    await this.queueWrite(async () => {
      await this.kernel.load(d);
      this.projectId = null;
      this.renameFile = false;
      this.restoreConversation(conversation);
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

  /** What the user has on screen: the schematic sheet or the 2D board, and the area of it shown; the box cut open. */
  currentView(): ViewInfo | null {
    if (this.view === 'enc') return this.enclosureCut?.() ?? null;
    if (this.view === 'sch') {
      const sheet = this.k?.view.sheets[this.sheet];
      const rect = this.visibleArea.sch?.();
      return sheet && rect ? schematicViewInfo(sheet, rect) : null;
    }
    if (this.view === 'lay') {
      const rect = this.visibleArea.board?.();
      return this.board && rect ? boardViewInfo(this.board, rect) : null;
    }
    return null;
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
    let trimmed = text.trim();
    if (!trimmed || this.running) return;
    const files = opts.scope ? [] : this.attachments.map((f, i) => ({ ...f, n: this.chatFiles().length + i + 1 }));
    if (files.length) {
      this.attachments = [];
      const list = files.map((f) => `#${f.n} ${f.name} (${f.pages ? `a PDF, ${f.pages} page${f.pages === 1 ? '' : 's'}` : 'a picture'})`).join(', ');
      opts = { ...opts, shown: opts.shown ?? trimmed };
      trimmed += `\n\n[Attached: ${list}. Look at ${files.length === 1 ? 'it' : 'them'} with view_attachment.]`;
    }
    if (this.k?.proposal) {
      // New instructions while a proposal is pending: the agent keeps building on the same
      // working copy and the next turn shows the combined changeset.
      const pending = [...this.chat].reverse().find((c) => c.changeset?.state === 'pending');
      if (pending) pending.changeset = { state: 'superseded', note: 'Continued below; review the combined changeset there.' };
    }
    const refs = opts.scope ? [] : [...this.selection];
    this.turnView = opts.scope ? null : this.currentView();
    this.chat.push({ id: this.seq++, role: 'user', at: new Date().toISOString(), text: opts.shown ?? trimmed, refs, ...(files.length ? { files } : {}), segments: [], status: 'done' });
    for (const q of this.chat) for (const s of q.segments) if (s.type === 'question' && !s.answered) s.answered = opts.shown ?? trimmed;
    const viaAgent = this.settings.provider === 'agent';
    this.chat.push({ id: this.seq++, role: 'agent', at: new Date().toISOString(), segments: [], status: 'streaming', ...(viaAgent ? { source: this.harness.name } : {}) });
    const item = this.chat[this.chat.length - 1]!;

    this.running = true;
    try {
      if (viaAgent) {
        await this.runCodingAgent(trimmed, item);
      } else {
        this.inAppBusy = true;
        this.abort = new AbortController();
        await this.agent.run(trimmed, { selection: refs, scope: opts.scope ?? null, view: this.turnView, rules: this.settings.schematicNotes, layoutRules: this.settings.layoutNotes, enclosureRules: this.settings.enclosureNotes }, (e) => this.onEvent(item, e), this.abort.signal);
      }
    } catch (e) {
      item.segments.push({ type: 'error', text: (e as Error).message });
    } finally {
      item.status = 'done';
      this.running = false;
      this.inAppBusy = false;
      this.turnView = null;
      this.agentRun = null;
      this.abort = null;
      await this.refresh();
      if (this.k?.proposal) {
        item.changeset = { state: 'pending' };
        if (this.settings.mode === 'auto' && !this.k.diagnostics.some(mustFix)) await this.accept();
      }
      this.conversationChanged();
    }
  }

  stop() {
    if (this.agentRun) server.cancelChat(this.agentRun.id);
    this.abort?.abort();
  }

  /** One chat turn answered by a coding agent on this computer (Claude Code, Copilot, Codex, OpenCode) through the server. */
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
        item.segments.push({ type: 'verify', round: e.round, errors: e.errors, message: e.message, ...(e.review ? { review: true } : {}) });
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
    const checks = this.settings.schematicChecks;
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
    if (this.settings.schematicChecks !== checks) await this.applyChecks();
    this.settingsChannel?.postMessage({ type: 'settings' });
  }

  /** Hands the check levels to the kernel, which re-runs the SCH checks on the open design. */
  private async applyChecks() {
    await this.kernel.setChecks($state.snapshot(this.settings.schematicChecks));
    await this.refresh();
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
    const checks = JSON.stringify(this.settings.schematicChecks);
    this.settings = await loadSettings();
    this.apiKey = await loadApiKey(this.settings.api);
    this.agent?.setProvider(this.makeProvider());
    this.applyTheme();
    if (JSON.stringify(this.settings.schematicChecks) !== checks) await this.applyChecks();
  }

  /** A new conversation; with the project keeping it, this one stays in the project file. */
  clearChat() {
    this.agentSession = null;
    this.agent.reset();
    if (this.keepConversation && this.chat.length) this.chatArchive = [...this.chatArchive, { items: $state.snapshot(this.chat) as ChatItem[] }];
    this.chat = [];
    this.conversationChanged();
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

  /* ----------------- hand editing in the schematic ------------------ */
  /* The gestures of the canvas issue the ops the agent uses, as the user's own edit: undoable,
     validated like any op, and marked as the user's decision where the drawing keeps one. */

  /** Move or turn a symbol (place_symbol): the wires it had are drawn again, round what is there. */
  placeSymbol(ref: string, spot: { page: number; x: number; y: number }, look: { orient?: 'upright' | 'lying'; mirror?: boolean; rotate?: 0 | 90 | 180 | 270 } = {}): Promise<boolean> {
    const what = look.orient ? `Turn ${ref} ${look.orient === 'lying' ? 'lying' : 'upright'}` : look.rotate !== undefined ? `Turn ${ref} to ${look.rotate}°` : look.mirror !== undefined ? `Mirror ${ref}` : `Move ${ref}`;
    return this.userEdit(what, [{ op: 'place_symbol', ref, ...spot, ...look, rewire: true }]);
  }

  /** Move a part's name or value (place_text): only the text moves, and it stays the user's. */
  placeText(ref: string, at: { name?: { x: number; y: number }; value?: { x: number; y: number } }): Promise<boolean> {
    return this.userEdit(`Move ${ref}'s ${[at.name ? 'name' : '', at.value ? 'value' : ''].filter(Boolean).join(' and ')}`, [{ op: 'place_text', ref, ...at }]);
  }

  /** Point a net label another way round its pin (label). */
  labelAt(pin: string, net: string, dir: 'left' | 'right' | 'up' | 'down'): Promise<boolean> {
    return this.userEdit(`Label ${net} ${dir} at ${pin}`, [{ op: 'label', pin, dir }]);
  }

  /** Move a supply symbol on its page (move_supply): a wire joins it to what it stood on. */
  moveSupply(net: string, from: { page: number; x: number; y: number }, to: { x: number; y: number }): Promise<boolean> {
    return this.userEdit(`Move the ${net} symbol`, [{ op: 'move_supply', ...from, to: { x: to.x, y: to.y } }]);
  }

  /** Take one drawn wire or net label away (erase at a point); the connection shows as an automatic label if nothing else does. */
  eraseDrawn(what: 'wire' | 'label', net: string, at: { page: number; x: number; y: number }): Promise<boolean> {
    return this.userEdit(`Erase ${what}${net ? ` of ${net}` : ''}`, [{ op: 'erase', at: [{ ...at, what }] }]);
  }

  /** Remove parts from the design (remove), after asking: it changes the circuit, not only the drawing. */
  async removeParts(refs: string[]): Promise<boolean> {
    if (!refs.length) return false;
    if (!window.confirm(`Remove ${refs.join(', ')} from the design? ${refs.length === 1 ? 'Its' : 'Their'} connections go with ${refs.length === 1 ? 'it' : 'them'} (Undo brings ${refs.length === 1 ? 'it' : 'them'} back).`)) return false;
    const ok = await this.userEdit(`Remove ${refs.join(', ')}`, refs.map((ref) => ({ op: 'remove', ref })));
    if (ok) this.selection = this.selection.filter((r) => !refs.includes(r));
    return ok;
  }

  flash(msg: string) {
    this.toast = msg;
    setTimeout(() => {
      if (this.toast === msg) this.toast = null;
    }, 3500);
  }
}

export const app = new AppState();
