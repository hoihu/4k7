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
  runCalc,
  type AgentEvent,
  type Provider,
} from '@tracewise/agent';
import type { KernelState } from '@tracewise/kernel';
import { tick } from 'svelte';
import { CalcCall, ImageInput, ProposeInput, WaitForReviewInput, type BridgeContent, type Design } from '@tracewise/schema';
import { bridge } from './bridge.svelte.ts';
import { createKernel } from './kernelClient.ts';
import { renderSchematicPng } from './snapshot.ts';
import { DEFAULT_SETTINGS, loadApiKey, loadProject, loadSettings, saveApiKey, saveProject, saveSettings, type Settings } from './persist.ts';

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
}

class AppState {
  view = $state<View>('sch');
  tab = $state<InspectorTab>('issues');
  k = $state<KernelState | null>(null);
  chat = $state<ChatItem[]>([]);
  running = $state(false);
  selection = $state<string[]>([]);
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

  private kernel = createKernel();
  private agent!: Agent;
  private abort: AbortController | null = null;
  private seq = 1;
  private reviewWaiters: ((result: string) => void)[] = [];

  async init() {
    this.settings = await loadSettings();
    this.apiKey = await loadApiKey('anthropic');
    const saved = await loadProject();
    if (saved) {
      try {
        await this.kernel.load(saved);
      } catch (e) {
        this.flash(`Could not load the saved project: ${(e as Error).message}`);
      }
    }
    this.agent = new Agent({ provider: this.makeProvider(), kernel: this.kernel.port, fixBudget: this.settings.fixBudget });
    this.applyTheme();
    await this.refresh();
    bridge.init(
      (tool, input) => this.handleBridgeCall(tool, input),
      (code, port) => void this.updateSettings({ bridgeCode: code, bridgePort: port }),
      () => {
        // the external agent went away: close its open activity block
        for (const c of this.chat) if (c.source && c.status === 'streaming') c.status = 'done';
      },
    );
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
    this.k = await this.kernel.state();
    const ids = new Set(this.k.proposal?.hunks.map((h) => h.id) ?? []);
    for (const id of Object.keys(this.hunkOff)) if (!ids.has(id)) delete this.hunkOff[id];
    if (this.sheet >= (this.k.view.sheets.length || 1)) this.sheet = 0;
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

  async queryComponent(ref: string): Promise<unknown> {
    return this.kernel.query({ op: 'get_component', ref });
  }

  private markChangeset(state: 'accepted' | 'rejected', note: string) {
    const item = [...this.chat].reverse().find((c) => c.changeset?.state === 'pending');
    if (item) item.changeset = { state, note };
    const waiters = this.reviewWaiters.splice(0);
    for (const w of waiters) w(state === 'accepted' ? `accepted: ${note}` : 'rejected by the user. Ask them what to change.');
  }

  /* ---------------------------- external agents ---------------------------- */

  /** The chat item that collects an external agent's activity; one per burst of work. */
  private externalItem(): ChatItem {
    const agent = bridge.agent ?? 'External agent';
    const last = this.chat[this.chat.length - 1];
    if (last?.role === 'agent' && last.source === agent && last.status === 'streaming') return last;
    this.chat.push({ id: this.seq++, role: 'agent', source: agent, segments: [], status: 'streaming' });
    return this.chat[this.chat.length - 1]!;
  }

  /** Execute one tool call forwarded by the Claude Code bridge. */
  async handleBridgeCall(tool: string, input: unknown): Promise<{ isError: boolean; content: BridgeContent[] }> {
    const text = (t: string, isError = false) => ({ isError, content: [{ type: 'text' as const, text: t }] });
    if (this.running) return text('The in-app agent is working on this design right now. Try again when it has finished.', true);

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
        return text(formatDesignContext({ ...snap, selection: this.selection }) + pending + `\nautonomy: ${this.settings.mode}`);
      }
      case 'design_query': {
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
          const out = runCalc(parsed.data);
          log(`calc · ${parsed.data.fn}`, true, Object.entries(out).filter(([k]) => k !== 'note').map(([k, v]) => `${k}=${v}`).join(', '));
          return text(JSON.stringify(out));
        } catch (e) {
          return text((e as Error).message, true);
        }
      }
      case 'get_schematic_image': {
        const args = ImageInput.parse(input ?? {});
        if (this.view !== 'sch') {
          this.view = 'sch';
          await tick();
        }
        if (args.sheet) {
          const i = this.k?.view.sheets.findIndex((s) => s.name.toLowerCase() === args.sheet!.toLowerCase()) ?? -1;
          if (i >= 0) this.sheet = i;
          await tick();
        }
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const img = await renderSchematicPng(args.width);
        log('schematic image', true, `${args.width}px`);
        return { isError: false, content: [{ type: 'image', ...img }] };
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
        it.status = 'done';
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
    await saveProject(await this.kernel.exportDesign());
  }

  async exportJson(): Promise<string> {
    return this.kernel.exportDesign();
  }

  async importDesign(d: Design) {
    await this.kernel.load(d);
    this.agent.reset();
    this.chat = [];
    await this.persist();
    await this.refresh();
  }

  async newProject() {
    await this.importDesign({
      format: 1,
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
    return this.agent?.provider.label ?? '';
  }

  get isDemo() {
    return !(this.settings.provider === 'anthropic' && this.apiKey);
  }

  async send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || this.running) return;
    if (this.k?.proposal) {
      // New instructions while a proposal is pending: the agent keeps building on the same
      // working copy and the next turn shows the combined changeset.
      const pending = [...this.chat].reverse().find((c) => c.changeset?.state === 'pending');
      if (pending) pending.changeset = { state: 'superseded', note: 'Continued below; review the combined changeset there.' };
    }
    const refs = [...this.selection];
    this.chat.push({ id: this.seq++, role: 'user', text: trimmed, refs, segments: [], status: 'done' });
    for (const q of this.chat) for (const s of q.segments) if (s.type === 'question' && !s.answered) s.answered = trimmed;
    this.chat.push({ id: this.seq++, role: 'agent', segments: [], status: 'streaming' });
    const item = this.chat[this.chat.length - 1]!;

    this.running = true;
    this.abort = new AbortController();
    try {
      await this.agent.run(trimmed, { selection: refs }, (e) => this.onEvent(item, e), this.abort.signal);
    } catch (e) {
      item.segments.push({ type: 'error', text: (e as Error).message });
    } finally {
      item.status = 'done';
      this.running = false;
      this.abort = null;
      await this.refresh();
      if (this.k?.proposal) {
        item.changeset = { state: 'pending' };
        if (this.settings.mode === 'auto' && this.k.counts.errors === 0) await this.accept();
      }
    }
  }

  stop() {
    this.abort?.abort();
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
  }

  clearChat() {
    this.agent.reset();
    this.chat = [];
  }

  private applyTheme() {
    const t = this.settings.theme;
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  }

  /* --------------------------------- misc --------------------------------- */

  toggleSelect(refdes: string, additive: boolean) {
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
