/**
 * Application state (Svelte 5 runes). Owns the kernel worker, the agent and settings.
 */
import {
  Agent,
  AnthropicProvider,
  DEMO_FALLBACK,
  DEMO_SCRIPTS,
  ScriptedProvider,
  costUsd,
  type AgentEvent,
  type Provider,
} from '@tracewise/agent';
import type { KernelState } from '@tracewise/kernel';
import type { Design } from '@tracewise/schema';
import { createKernel } from './kernelClient.ts';
import { DEFAULT_SETTINGS, loadApiKey, loadProject, loadSettings, saveApiKey, saveProject, saveSettings, type Settings } from './persist.ts';

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
