/**
 * The agent eval runner: one task through the agent loop against a headless kernel, scored on
 * what the design looks like afterwards. No browser and no server: the loop talks to an
 * in-process Kernel through the same KernelPort the app's worker implements.
 * See docs/ARCHITECTURE.md §3.9.
 */
import type { Design, Diagnostic, TransactionResult } from '@4k7/schema';
import { Kernel } from '@4k7/kernel';
import { Agent } from '../src/loop.ts';
import { ScriptedProvider } from '../src/providers/scripted.ts';
import type { Block, KernelPort, Provider } from '../src/types.ts';

/** A task file (`eval/tasks/*.json`). */
export interface EvalTask {
  name: string;
  prompt: string;
  /** Starting design, a *.twd.json path relative to the task file; empty design when left out. */
  design?: string;
  /** What the scripted provider answers, one entry per model call. Real providers ignore it. */
  script?: Block[][];
  /** Checked after the run, on top of a clean design. */
  expect?: { parts?: string[]; nets?: string[] };
}

export interface Score {
  task: string;
  ok: boolean;
  /** Unwaived error diagnostics outside the board DRC (ERC, semantic, ledger, drawing rules). */
  erc_errors: number;
  /** Unwaived DRC errors the kernel reports without routing: pads that short or are too close. */
  drc_errors: number;
  /** Ledger constraints the kernel reports as violated. */
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
}

/** A provider that replays a task's script. */
export function scriptedFor(task: EvalTask): Provider {
  return new ScriptedProvider([{ name: task.name, match: /[\s\S]*/, steps: task.script ?? [] }], { label: 'eval script' });
}

export async function runTask(design: Design | undefined, task: EvalTask, provider: Provider): Promise<Score> {
  const k = new Kernel(design);
  let applied = 0;
  let rejected = 0;
  const port: KernelPort = {
    transact: async (tx) => {
      const r: TransactionResult = k.transact(tx as Parameters<Kernel['transact']>[0]);
      if (r.status === 'rejected') rejected++;
      else if (!r.dryRun) applied += r.results.length;
      return r;
    },
    query: async (q) => k.query(q as Parameters<Kernel['query']>[0]),
    snapshot: async () => {
      const s = k.state();
      return { summary: s.summary, diagnostics: s.diagnostics, counts: s.counts, ledger: s.ledger };
    },
  };

  let turns = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let done: { reason: string; message?: string } = { reason: 'none' };
  await new Agent({ provider, kernel: port }).run(task.prompt, { selection: [] }, (e) => {
    if (e.type === 'usage') {
      turns++;
      tokensIn += e.usage.input + e.usage.cacheRead + e.usage.cacheWrite;
      tokensOut += e.usage.output;
    } else if (e.type === 'done') done = e;
  });

  const open = (k.query({ op: 'get_diagnostics' }) as Diagnostic[]).filter((x) => x.severity === 'error' && !x.waivedBy);
  const drc = open.filter((x) => x.code.startsWith('DRC.')).length;
  const erc = open.length - drc;
  const state = k.state();
  const violated = state.ledger.filter((l) => l.status === 'violated').length;

  const failures: string[] = [];
  if (done.reason !== 'complete') failures.push(`the turn ended with ${done.reason}${done.message ? `: ${done.message}` : ''}`);
  if (erc) failures.push(`${erc} ERC error(s)`);
  if (drc) failures.push(`${drc} DRC error(s)`);
  if (violated) failures.push(`${violated} constraint(s) violated`);
  const refs = new Set(state.summary.components.map((c) => c.refdes));
  const nets = new Set(state.summary.nets.map((n) => n.name));
  for (const p of task.expect?.parts ?? []) if (!refs.has(p)) failures.push(`no part ${p}`);
  for (const n of task.expect?.nets ?? []) if (!nets.has(n)) failures.push(`no net ${n}`);

  return {
    task: task.name,
    ok: failures.length === 0,
    erc_errors: erc,
    drc_errors: drc,
    constraint_failures: violated,
    ops_applied: applied,
    ops_rejected: rejected,
    turns,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    failures,
  };
}
