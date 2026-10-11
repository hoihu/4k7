/**
 * GitHub Copilot CLI: `copilot -p` with JSONL output. The 4k7 endpoint is added as an MCP server
 * for the run, and every other tool (shell, files, the GitHub MCP server, the user's own MCP
 * servers) is filtered out with --available-tools. The CLI has no system-prompt option, so the
 * chat rules open the first message of a conversation.
 */
import { randomUUID } from 'node:crypto';
import { CHAT_WEB_PROMPT, chatModePrompt, type HarnessCapability, type TokenCount } from '@4k7/schema';
import { detectCli, parseLine, type ChatJob, type Harness, type Invocation, type RunSink } from './types.ts';

export class CopilotHarness implements Harness {
  readonly id = 'copilot' as const;
  readonly name = 'GitHub Copilot CLI';
  /** Token totals per session: the CLI reports them for the whole session, a run's are the difference. */
  #totals = new Map<string, TokenCount>();

  readonly bin: string;

  constructor(bin: string) {
    this.bin = bin;
  }

  #env(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.COPILOT_ALLOW_ALL; // would approve every tool, shell included
    return env;
  }

  detect(): HarnessCapability {
    return { id: this.id, name: this.name, ...detectCli(this.bin, 'GitHub Copilot', this.#env(), 'FOURK7_COPILOT_BIN') };
  }

  chat(job: ChatJob, sink: RunSink): Invocation {
    // a new conversation gets its id now, so the tab has it even if the run is stopped
    const session = job.session ?? randomUUID();
    const rules = job.session ? (job.web ? `${CHAT_WEB_PROMPT}\n\n` : '') : `${chatModePrompt()}${job.web ? `\n\n${CHAT_WEB_PROMPT}` : ''}\n\n---\n\nThe user's message:\n\n`;
    const mcp = { mcpServers: { '4k7': { type: 'http', url: job.mcpUrl, headers: { Authorization: `Bearer ${job.token}` }, tools: ['*'] } } };
    sink.emit({ kind: 'session', session });
    return {
      args: [
        '-p',
        rules + job.text,
        '--output-format',
        'json',
        '--stream',
        'on',
        '--additional-mcp-config',
        JSON.stringify(mcp),
        '--disable-builtin-mcps',
        '--available-tools',
        ...(job.web ? ['4k7', 'web_fetch'] : ['4k7']),
        '--allow-tool',
        '4k7',
        ...(job.web ? ['--allow-all-urls'] : []),
        '--no-ask-user',
        '--no-custom-instructions',
        '--no-auto-update',
        `--session-id=${session}`,
        ...(job.model ? ['--model', job.model] : []),
      ],
      env: this.#env(),
      ...this.#reader(session, job.session !== null, sink),
    };
  }

  #reader(session: string, resumed: boolean, sink: RunSink): Pick<Invocation, 'line'> {
    const streamed = new Set<string>();
    let wrote = false;
    let model: string | undefined;
    let error: string | undefined;
    // without the totals at the start of a resumed session (the server restarted) the run's own are unknown
    const before = this.#totals.get(session) ?? (resumed ? null : { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
    return {
      line: (line) => {
        const m = parseLine<CopilotEvent>(line);
        if (!m) return;
        const d = m.data ?? {};
        switch (m.type) {
          case 'assistant.message_start':
            if (wrote) sink.emit({ kind: 'text', text: '\n\n' });
            break;
          case 'assistant.message_delta':
            if (d.deltaContent) {
              if (d.messageId) streamed.add(d.messageId);
              wrote = true;
              sink.emit({ kind: 'text', text: d.deltaContent });
            }
            break;
          case 'assistant.message':
            if (d.model) model = d.model;
            if (d.content && !(d.messageId && streamed.has(d.messageId))) {
              if (wrote) sink.emit({ kind: 'text', text: '\n\n' });
              wrote = true;
              sink.emit({ kind: 'text', text: d.content });
            }
            break;
          case 'assistant.reasoning_delta':
            if (d.deltaContent) sink.emit({ kind: 'thinking', text: d.deltaContent });
            break;
          case 'session.auto_mode_resolved':
            if (d.chosenModel) model = d.chosenModel;
            break;
          case 'session.usage_checkpoint': {
            const total = sumUsage(d.accountingSnapshot?.modelMetrics ?? d.modelMetrics);
            if (!total) break;
            if (before) {
              const last = this.#totals.get(session) ?? before;
              sink.count({
                input: Math.max(0, total.input - last.input),
                cacheRead: Math.max(0, total.cacheRead - last.cacheRead),
                cacheWrite: Math.max(0, total.cacheWrite - last.cacheWrite),
                output: Math.max(0, total.output - last.output),
                ...(model ? { model } : {}),
              });
            }
            this.#totals.set(session, total);
            break;
          }
          case 'session.error':
            error = d.message ?? error;
            break;
          case 'result':
            sink.finish({
              kind: 'done',
              ok: m.exitCode === 0 && !error,
              ...(m.exitCode !== 0 || error ? { error: error ?? `GitHub Copilot CLI exited (${m.exitCode})` } : {}),
              session: m.sessionId ?? session,
            });
            break;
        }
      },
    };
  }
}

/** Input (without cache reads), cache reads and writes, output: summed over the session's models. */
function sumUsage(metrics: Record<string, { usage?: CopilotUsage }> | undefined): TokenCount | null {
  if (!metrics) return null;
  const t: TokenCount = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const { usage: u } of Object.values(metrics)) {
    if (!u) continue;
    t.cacheRead += u.cacheReadTokens ?? 0;
    t.cacheWrite += u.cacheWriteTokens ?? 0;
    t.input += Math.max(0, (u.inputTokens ?? 0) - (u.cacheReadTokens ?? 0));
    t.output += u.outputTokens ?? 0;
  }
  return t;
}

interface CopilotUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** The subset of the CLI's JSONL events this reader reads. */
interface CopilotEvent {
  type: string;
  data?: {
    messageId?: string;
    deltaContent?: string;
    content?: string;
    model?: string;
    chosenModel?: string;
    message?: string;
    modelMetrics?: Record<string, { usage?: CopilotUsage }>;
    accountingSnapshot?: { modelMetrics?: Record<string, { usage?: CopilotUsage }> };
  };
  sessionId?: string;
  exitCode?: number;
}
