/**
 * The agent loop: model ↔ tools ↔ kernel, plus the verification loop that refuses to
 * finish a turn while the design has open errors (within a fix budget).
 * See docs/design/ai-loop.md.
 */
import { AskUser, CalcCall, TOOL_NAMES, toolDefinitions } from '@tracewise/schema';
import { CalcError, runCalc } from './calc.ts';
import { compactTx, describeTx } from './format.ts';
import { SYSTEM_PROMPT, formatDesignContext, formatVerification } from './prompt.ts';
import type { AgentEvent, Block, KernelPort, Message, Provider } from './types.ts';

export interface AgentOptions {
  provider: Provider;
  kernel: KernelPort;
  /** Model calls per user turn. */
  maxSteps?: number;
  /** Verification rounds before giving up and reporting remaining errors. */
  fixBudget?: number;
  /** Tools the app provides beyond the kernel ones (jlc_search), by tool name. */
  tools?: Record<string, ToolHandler>;
}

export type ToolHandler = (input: unknown) => Promise<{ content: string; isError: boolean; label: string; detail: string }>;

interface PendingQuestion {
  askId: string;
  otherResults: Block[];
}

const MAX_RESULT_CHARS = 16000;

export class Agent {
  readonly messages: Message[] = [];
  private pending: PendingQuestion | null = null;
  private readonly tools = toolDefinitions();

  constructor(private opts: AgentOptions) {}

  setProvider(p: Provider): void {
    this.opts.provider = p;
  }

  get provider(): Provider {
    return this.opts.provider;
  }

  /** Forget the conversation (the design is unaffected). */
  reset(): void {
    this.messages.length = 0;
    this.pending = null;
  }

  async run(userText: string, ctx: { selection: string[] }, emit: (e: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
    const { kernel } = this.opts;
    const maxSteps = this.opts.maxSteps ?? 40;
    const fixBudget = this.opts.fixBudget ?? 5;

    const snap = await kernel.snapshot();
    const context = formatDesignContext({ ...snap, selection: ctx.selection });
    const content: Block[] = [];
    if (this.pending) {
      content.push(...this.pending.otherResults, { type: 'tool_result', tool_use_id: this.pending.askId, content: `The user answered: ${userText}` });
      this.pending = null;
      content.push({ type: 'text', text: context });
    } else {
      content.push({ type: 'text', text: `${context}\n\n${userText}` });
    }
    this.messages.push({ role: 'user', content });

    let fixRounds = 0;
    for (let step = 0; ; step++) {
      if (signal?.aborted) return this.abort(emit);
      if (step >= maxSteps) {
        emit({ type: 'done', reason: 'budget', message: `Stopped after ${maxSteps} model calls.` });
        return;
      }

      let res;
      try {
        res = await this.opts.provider.step({
          system: SYSTEM_PROMPT,
          tools: this.tools,
          messages: this.messages,
          ...(signal ? { signal } : {}),
          onText: (delta) => emit({ type: 'text', delta }),
          onThinking: (delta) => emit({ type: 'thinking', delta }),
        });
      } catch (e) {
        if (signal?.aborted) return this.abort(emit);
        emit({ type: 'done', reason: 'error', message: errorMessage(e) });
        return;
      }
      if (res.usage) emit({ type: 'usage', usage: res.usage, ...(res.model ? { model: res.model } : {}) });
      this.messages.push({ role: 'assistant', content: res.content, raw: res.raw });

      if (res.stop === 'refusal') {
        emit({ type: 'done', reason: 'refusal', message: res.detail ?? 'The model declined this request.' });
        this.closeDanglingToolUses('The request was declined.');
        return;
      }
      if (res.stop === 'max_tokens') {
        this.closeDanglingToolUses('Output was cut off (max_tokens); the tool call was not executed.');
        emit({ type: 'done', reason: 'max_tokens', message: 'The response hit the output limit.' });
        return;
      }
      if (res.stop === 'pause_turn') continue;

      const uses = res.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
      if (uses.length) {
        const results: Block[] = [];
        let question: { id: string; q: AskUser } | null = null;
        for (const u of uses) {
          if (signal?.aborted) {
            results.push({ type: 'tool_result', tool_use_id: u.id, content: 'Aborted by the user before execution.', is_error: true });
            continue;
          }
          if (u.name === TOOL_NAMES.ask) {
            const parsed = AskUser.safeParse(u.input);
            if (parsed.success && !question) {
              question = { id: u.id, q: parsed.data };
              continue;
            }
            results.push({ type: 'tool_result', tool_use_id: u.id, content: parsed.success ? 'Only one question per turn.' : `Invalid input: ${parsed.error.message}`, is_error: true });
            continue;
          }
          const r = await this.execTool(u.name, u.input);
          emit({ type: 'tool', id: u.id, name: u.name, label: r.label, ok: !r.isError, detail: r.detail });
          results.push({ type: 'tool_result', tool_use_id: u.id, content: truncate(r.content), ...(r.isError ? { is_error: true } : {}) });
        }
        if (question) {
          this.pending = { askId: question.id, otherResults: results };
          emit({ type: 'question', question: question.q.question, options: question.q.options });
          emit({ type: 'done', reason: 'question' });
          return;
        }
        this.messages.push({ role: 'user', content: results });
        if (signal?.aborted) return this.abort(emit);
        continue;
      }

      // The model considers itself done: verify.
      const after = await kernel.snapshot();
      const errors = after.diagnostics.filter((d) => d.severity === 'error' && !d.waivedBy);
      if (errors.length && fixRounds < fixBudget) {
        fixRounds++;
        const message = formatVerification(errors);
        emit({ type: 'verify', round: fixRounds, errors: errors.length, message });
        this.messages.push({ role: 'user', content: [{ type: 'text', text: message }] });
        continue;
      }
      emit({
        type: 'done',
        reason: 'complete',
        ...(errors.length ? { message: `${errors.length} error(s) remain after ${fixRounds} fix round(s).` } : {}),
      });
      return;
    }
  }

  private abort(emit: (e: AgentEvent) => void): void {
    this.closeDanglingToolUses('Aborted by the user.');
    emit({ type: 'done', reason: 'aborted' });
  }

  /** Keep the history valid: every tool_use needs a tool_result in the next user message. */
  private closeDanglingToolUses(reason: string): void {
    const last = this.messages.at(-1);
    if (last?.role !== 'assistant') return;
    const uses = last.content.filter((b) => b.type === 'tool_use') as Extract<Block, { type: 'tool_use' }>[];
    if (!uses.length) return;
    this.messages.push({ role: 'user', content: uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, content: reason, is_error: true })) });
  }

  private async execTool(name: string, input: unknown): Promise<{ content: string; isError: boolean; label: string; detail: string }> {
    const { kernel } = this.opts;
    try {
      switch (name) {
        case TOOL_NAMES.query: {
          const out = await kernel.query(input);
          const op = (input as { op?: string })?.op ?? '?';
          const isError = !!(out && typeof out === 'object' && 'error' in out);
          return { content: JSON.stringify(out), isError, label: `query · ${op}`, detail: summariseQuery(input, out) };
        }
        case TOOL_NAMES.edit: {
          const r = await kernel.transact(input);
          const tx = input as { summary?: string; ops?: unknown[]; dry_run?: boolean };
          const label = `${tx.dry_run ? 'dry-run' : 'edit'} · ${tx.ops?.length ?? 0} ops · ${tx.summary ?? ''}`;
          return { content: JSON.stringify(compactTx(r)), isError: r.status !== 'ok', label, detail: describeTx(r) };
        }
        case TOOL_NAMES.calc: {
          const parsed = CalcCall.safeParse(input);
          if (!parsed.success) return { content: `Invalid calc input: ${parsed.error.message}`, isError: true, label: 'calc', detail: 'invalid input' };
          const out = runCalc(parsed.data);
          return { content: JSON.stringify(out), isError: false, label: `calc · ${parsed.data.fn}`, detail: Object.entries(out).filter(([k]) => k !== 'note').map(([k, v]) => `${k}=${v}`).join(', ') };
        }
        default: {
          const extra = this.opts.tools?.[name];
          if (extra) return await extra(input);
          return { content: `Unknown tool ${name}`, isError: true, label: name, detail: 'unknown tool' };
        }
      }
    } catch (e) {
      const msg = e instanceof CalcError ? e.message : errorMessage(e);
      return { content: `Tool failed: ${msg}`, isError: true, label: name, detail: msg };
    }
  }
}

function summariseQuery(input: unknown, out: unknown): string {
  if (Array.isArray(out)) return `${out.length} result(s)`;
  if (out && typeof out === 'object' && 'error' in out) return String((out as { error: unknown }).error);
  const op = (input as { op?: string })?.op;
  return op === 'get_summary' ? 'design summary' : 'ok';
}

function truncate(s: string): string {
  return s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}… [truncated; query more specifically]` : s;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
