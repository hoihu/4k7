/**
 * The agent eval runner: one task through the agent loop against a headless kernel, scored on
 * what the design looks like afterwards. No browser and no server: the loop talks to an
 * in-process Kernel through the same KernelPort the app's worker implements.
 * See docs/ARCHITECTURE.md §3.9.
 */
import type { Design, Scorecard, TransactionResult } from '@4k7/schema';
import { Kernel } from '@4k7/kernel';
import { Agent } from '../src/loop.ts';
import { ScriptedProvider } from '../src/providers/scripted.ts';
import type { Block, KernelPort, Provider } from '../src/types.ts';

/** A scripted answer to ask_user: taken in order, or the first one whose `match` is in the question (case-insensitive). */
export type EvalAnswer = string | { match: string; answer: string };

/** A task file (`eval/tasks/*.json`). */
export interface EvalTask {
  name: string;
  prompt: string;
  /** Starting design, a *.twd.json path relative to the task file; empty design when left out. */
  design?: string;
  /** What the scripted provider answers, one entry per model call. Real providers ignore it. */
  script?: Block[][];
  /** What the user answers when asked (ask_user); a question with no answer left ends the run not ok. */
  answers?: EvalAnswer[];
  /** Checked after the run, on top of a clean design. values: a part's value (as get_summary gives it) is one of these. */
  expect?: { parts?: string[]; nets?: string[]; values?: Record<string, string[]> };
}

export interface Score {
  task: string;
  ok: boolean;
  /** Open errors outside the board DRC (ERC, semantic, ledger, drawing rules, panel, stack): the scorecard's, every family but DRC. */
  erc_errors: number;
  /** Open DRC errors on the scorecard: the board as placed, or as routed for its placement (nothing is routed to score it). */
  drc_errors: number;
  /** Ledger constraints the kernel reports as violated (the scorecard's ledger). */
  constraint_failures: number;
  /** Ops in design_edit transactions the kernel applied (dry runs not counted). */
  ops_applied: number;
  /** Rejected transactions: the one op each names (the rest of that transaction is not applied either). */
  ops_rejected: number;
  /** Model calls. */
  turns: number;
  tokens_in: number;
  tokens_out: number;
  /** Why ok is false, in words. */
  failures: string[];
  /** The design's scorecard after the run (get_scorecard; docs/design/scorecard.md), for the model table. */
  card: Scorecard;
}

/** A provider that replays a task's script. */
export function scriptedFor(task: EvalTask): Provider {
  return new ScriptedProvider([{ name: task.name, match: /[\s\S]*/, steps: task.script ?? [] }], { label: 'eval script' });
}

/** Answers a task's questions: a `match` entry when its text is in the question, else the next plain one. Null when none is left. */
export function answerer(answers: EvalAnswer[] = []): (question: string) => string | null {
  const used = new Set<number>();
  return (question) => {
    const q = question.toLowerCase();
    let i = answers.findIndex((a, n) => !used.has(n) && typeof a !== 'string' && q.includes(a.match.toLowerCase()));
    if (i < 0) i = answers.findIndex((a, n) => !used.has(n) && typeof a === 'string');
    if (i < 0) return null;
    used.add(i);
    const a = answers[i]!;
    return typeof a === 'string' ? a : a.answer;
  };
}

/** An in-process kernel behind a KernelPort that counts the ops applied and the transactions rejected. */
export function countingKernel(design: Design | undefined) {
  const kernel = new Kernel(design);
  const counts = { applied: 0, rejected: 0 };
  const port: KernelPort = {
    transact: async (tx) => {
      const r: TransactionResult = kernel.transact(tx as Parameters<Kernel['transact']>[0]);
      if (r.status === 'rejected') counts.rejected++;
      else if (!r.dryRun) counts.applied += r.results.length;
      return r;
    },
    query: async (q) => kernel.query(q as Parameters<Kernel['query']>[0]),
    snapshot: async () => {
      const s = kernel.state();
      return { summary: s.summary, diagnostics: s.diagnostics, counts: s.counts, ledger: s.ledger };
    },
  };
  return { kernel, port, counts };
}

/** How a run went, from whichever engine ran it (the agent loop, or an external agent through the headless server). */
export interface RunReport {
  /** 'complete' when the agent finished its turn. */
  done: { reason: string; message?: string };
  counts: { applied: number; rejected: number };
  turns: number;
  tokensIn: number;
  tokensOut: number;
}

/** Scores the design a run left behind. */
export function scoreRun(kernel: Kernel, task: EvalTask, run: RunReport): Score {
  const card = kernel.scorecard();
  const drc = card.findings.DRC?.errors ?? 0;
  const erc = Object.entries(card.findings).reduce((n, [family, f]) => n + (family === 'DRC' ? 0 : f.errors), 0);
  const violated = card.ledger.violated;
  const state = kernel.state();

  const { done } = run;
  const failures: string[] = [];
  if (done.reason !== 'complete') failures.push(`the turn ended with ${done.reason}${done.message ? `: ${done.message}` : ''}`);
  if (erc) failures.push(`${erc} ERC error(s)`);
  if (drc) failures.push(`${drc} DRC error(s)`);
  if (violated) failures.push(`${violated} constraint(s) violated`);
  const refs = new Set(state.summary.components.map((c) => c.refdes));
  const nets = new Set(state.summary.nets.map((n) => n.name));
  for (const p of task.expect?.parts ?? []) if (!refs.has(p)) failures.push(`no part ${p}`);
  for (const n of task.expect?.nets ?? []) if (!nets.has(n)) failures.push(`no net ${n}`);
  for (const [ref, ok] of Object.entries(task.expect?.values ?? {})) {
    const v = state.summary.components.find((c) => c.refdes === ref)?.value;
    if (v !== undefined && !ok.includes(v)) failures.push(`${ref} is ${v}, not ${ok.join(' or ')}`);
  }

  return {
    task: task.name,
    ok: failures.length === 0,
    erc_errors: erc,
    drc_errors: drc,
    constraint_failures: violated,
    ops_applied: run.counts.applied,
    ops_rejected: run.counts.rejected,
    turns: run.turns,
    tokens_in: run.tokensIn,
    tokens_out: run.tokensOut,
    failures,
    card,
  };
}

/** Runs a task through the agent loop; the task's answers reply to its questions. */
export async function runTask(design: Design | undefined, task: EvalTask, provider: Provider): Promise<Score> {
  const { kernel, port, counts } = countingKernel(design);
  const answer = answerer(task.answers);
  const run: RunReport = { done: { reason: 'none' }, counts, turns: 0, tokensIn: 0, tokensOut: 0 };
  const agent = new Agent({ provider, kernel: port });
  let text: string | null = task.prompt;
  while (text !== null) {
    let question = '';
    await agent.run(text, { selection: [] }, (e) => {
      if (e.type === 'usage') {
        run.turns++;
        run.tokensIn += e.usage.input + e.usage.cacheRead + e.usage.cacheWrite;
        run.tokensOut += e.usage.output;
      } else if (e.type === 'question') question = e.question;
      else if (e.type === 'done') run.done = e;
    });
    text = run.done.reason === 'question' ? answer(question) : null;
    if (run.done.reason === 'question' && text === null) run.done = { reason: 'question', message: `no answer for "${question}"` };
  }
  return scoreRun(kernel, task, run);
}
