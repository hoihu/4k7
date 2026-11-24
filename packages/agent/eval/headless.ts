/**
 * The headless eval server: the local server's token-gated /mcp endpoint answered from an in-process
 * kernel loaded from a task's design, with no browser tab. An external agent (`claude -p`) drives it
 * with the same tool definitions it gets from the app (McpMode 'eval': the cli tools plus ask_user);
 * the design tools run through runKernelTool as in the in-app loop, and the turn tools the tab
 * answers (get_context, propose, wait_for_review, ask_user) are answered here, as in Auto mode.
 * See docs/ARCHITECTURE.md §3.9.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AskUser, GuideTopic, PLAN_STEP_OFF, ProposeInput, TOOL_NAMES, mustFix, type Design, type ToolContent } from '@4k7/schema';
import { mcpHttpHandler, secretsMatch } from '../../../tools/server/src/mcp.ts';
import { LocalServer, type CallResult } from '../../../tools/server/src/server.ts';
import { formatDesignContext } from '../src/prompt.ts';
import { runKernelTool } from '../src/tools.ts';
import { answerer, countingKernel, scoreRun, type EvalTask, type RunReport, type Score } from './run.ts';

export interface HeadlessServer {
  /** The /mcp endpoint, e.g. http://127.0.0.1:PORT/mcp. */
  url: string;
  /** The bearer token /mcp accepts. */
  token: string;
  /** Questions the agent asked that the task had no answer for. */
  unanswered: string[];
  /** Scores the design as the agent left it; `run` carries what the agent's own output says (turns, tokens, how it ended). */
  score(run: Omit<RunReport, 'counts'>): Score;
  stop(): Promise<void>;
}

/** The agent's guides as the app hands them to the kernel: each topic's design doc as it is. */
const GUIDES = Object.fromEntries(GuideTopic.options.map((t) => [t, readFileSync(new URL(`../../../docs/design/${t.replace('_', '-')}.md`, import.meta.url), 'utf8')]));

/** The tab's side of the tool calls, against an in-process kernel. */
export function headlessCalls(design: Design | undefined, task: EvalTask) {
  const k = countingKernel(design);
  // the kernel answers get_guide from the design docs, as in the app; no projects folder here
  const port = { ...k.port, query: async (q: unknown) => k.kernel.query(q, { guides: GUIDES }) };
  const answer = answerer(task.answers);
  const unanswered: string[] = [];
  const text = (t: string, isError = false): CallResult => ({ isError, content: [{ type: 'text', text: t }] });

  async function call(tool: string, input: unknown): Promise<CallResult> {
    switch (tool) {
      case TOOL_NAMES.context: {
        const snap = await k.port.snapshot();
        return text(formatDesignContext({ ...snap, selection: [] }) + '\nautonomy: auto\nplan_step: off');
      }
      case TOOL_NAMES.propose: {
        const args = ProposeInput.safeParse(input);
        if (!args.success) return text(args.error.message, true);
        const errors = (await k.port.snapshot()).diagnostics.filter(mustFix);
        if (errors.length) {
          return text(
            `Refused: the design has ${errors.length} open error(s). Fix them (or waive intended ones with a reason) first:\n` +
              errors.map((d) => `- ${d.code} ${d.entities.join(',')}: ${d.message}`).join('\n'),
            true,
          );
        }
        return text('Committed (autonomy is Auto).');
      }
      case TOOL_NAMES.waitForReview:
        return text('Nothing is pending review.');
      case TOOL_NAMES.proposePlan:
        return text(`Refused: ${PLAN_STEP_OFF}`, true);
      case TOOL_NAMES.ask: {
        const args = AskUser.safeParse(input);
        if (!args.success) return text(`Invalid input: ${args.error.message}`, true);
        const a = answer(args.data.question);
        if (a !== null) return text(`The user answered: ${a}`);
        unanswered.push(args.data.question);
        return text('The user is not available to answer. End your turn here.', true);
      }
    }
    const out = await runKernelTool(port, tool, input);
    if (!out) return text(`${tool} is not available in the headless eval server (no app).`, true);
    // as the tab sends it (handleServerCall in apps/web/src/lib/app.svelte.ts)
    const content: ToolContent[] = [...(out.images ?? []).map((i) => ({ type: 'image' as const, ...i })), ...(out.content ? [{ type: 'text' as const, text: out.content }] : [])];
    return { isError: out.isError, content };
  }

  return { call, kernel: k.kernel, counts: k.counts, unanswered };
}

/** Starts the headless server on a free loopback port for one task. */
export async function startHeadless(design: Design | undefined, task: EvalTask): Promise<HeadlessServer> {
  const calls = headlessCalls(design, task);
  const token = randomUUID();
  const server = new LocalServer({ accessKey: randomUUID(), ports: [0], local: calls.call });
  server.setHttpHandler(mcpHttpHandler(server, (t) => (secretsMatch(t, token) ? 'eval' : null)));
  const port = await server.start();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    unanswered: calls.unanswered,
    score: (run) => {
      const done = calls.unanswered.length ? { reason: 'question', message: `no answer for "${calls.unanswered[0]}"` } : run.done;
      return scoreRun(calls.kernel, task, { ...run, done, counts: calls.counts });
    },
    stop: () => server.stop(),
  };
}

/** How a `claude -p --output-format json` run went, from its result object: how it ended, model calls, tokens and cost. */
export function claudeResult(stdout: string): Omit<RunReport, 'counts'> & { cost_usd: number | null } {
  let r: {
    subtype?: string;
    is_error?: boolean;
    result?: string;
    num_turns?: number;
    total_cost_usd?: number;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  };
  try {
    r = JSON.parse(stdout.trim().split('\n').at(-1) ?? '');
  } catch {
    return { done: { reason: 'error', message: `no result from claude: ${stdout.slice(0, 200)}` }, turns: 0, tokensIn: 0, tokensOut: 0, cost_usd: null };
  }
  const u = r.usage ?? {};
  const ok = r.subtype === 'success' && !r.is_error;
  return {
    done: ok ? { reason: 'complete' } : { reason: r.subtype ?? 'error', ...(r.result ? { message: r.result.slice(0, 200) } : {}) },
    turns: r.num_turns ?? 0,
    tokensIn: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    tokensOut: u.output_tokens ?? 0,
    cost_usd: r.total_cost_usd ?? null,
  };
}
