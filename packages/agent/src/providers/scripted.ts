/**
 * Offline, deterministic provider: replays scripted tool calls. Used for tests and for the
 * "no API key" demo mode, so the whole loop (including verification) runs without a model.
 */
import type { Block, Message, Provider, StepRequest, StepResult } from '../types.ts';

export type ScriptStep = Block[] | ((ctx: { userText: string; messages: Message[] }) => Block[]);

export interface Script {
  name: string;
  match: RegExp;
  steps: ScriptStep[];
}

export class ScriptedProvider implements Provider {
  readonly id = 'scripted';
  readonly label: string;
  private active: Script | null = null;
  private cursor = 0;
  private userText = '';
  private seq = 0;

  constructor(private scripts: Script[], opts: { label?: string; fallback?: string; streamDelayMs?: number } = {}) {
    this.label = opts.label ?? 'Offline demo';
    this.fallback = opts.fallback ?? 'I only know scripted demo scenarios.';
    this.delay = opts.streamDelayMs ?? 0;
  }

  private fallback: string;
  private delay: number;

  async step(req: StepRequest): Promise<StepResult> {
    const last = req.messages.at(-1);
    const isNewTurn =
      last?.role === 'user' &&
      !last.content.some((b) => b.type === 'tool_result') &&
      !last.content.some((b) => b.type === 'text' && b.text.startsWith('[kernel verification]'));
    if (isNewTurn) {
      const text = last.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      this.userText = text.replace(/<design_state>[\s\S]*?<\/design_state>/, '').replace(/<selection>[\s\S]*?<\/selection>/, '').trim();
      this.active = this.scripts.find((s) => s.match.test(this.userText)) ?? null;
      this.cursor = 0;
    }

    let content: Block[];
    if (!this.active) {
      content = [{ type: 'text', text: this.fallback }];
    } else {
      const step = this.active.steps[this.cursor++];
      content = step ? (typeof step === 'function' ? step({ userText: this.userText, messages: req.messages }) : step) : [{ type: 'text', text: 'Done.' }];
    }
    // give tool uses unique ids
    content = content.map((b) => (b.type === 'tool_use' ? { ...b, id: `toolu_demo_${++this.seq}` } : b));

    for (const b of content) {
      if (b.type === 'text' && req.onText) await this.stream(b.text, req.onText, req.signal);
      if (b.type === 'thinking' && req.onThinking) await this.stream(b.text, req.onThinking, req.signal);
    }
    const stop = content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
    return { content, stop, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, model: 'scripted' };
  }

  private async stream(text: string, sink: (d: string) => void, signal?: AbortSignal) {
    if (!this.delay) {
      sink(text);
      return;
    }
    for (const word of text.split(/(?<=\s)/)) {
      if (signal?.aborted) return;
      sink(word);
      await new Promise((r) => setTimeout(r, this.delay));
    }
  }
}
