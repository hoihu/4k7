/**
 * OpenCode: `opencode run --format json` with an agent of its own, defined for the run through
 * OPENCODE_CONFIG_CONTENT (merged into the user's config, so their providers and logins apply):
 * the chat rules as its prompt (from a file: they do not fit a variable on Windows), the 4k7
 * endpoint as a remote MCP server, and every tool but the 4k7 ones switched off. The message goes
 * in on stdin (an argument would be quoted).
 *
 * `opencode run` can exit before it prints the last step of its answer, so once it has exited the
 * session is read back with `opencode export` and whatever the stream left out is sent then.
 */
import { CHAT_WEB_PROMPT, chatModePrompt, type HarnessCapability } from '@4k7/schema';
import { capture, detectCli, parseLine, rulesFile, type ChatJob, type Harness, type Invocation, type RunSink } from './types.ts';

const AGENT = '4k7-chat';

export class OpenCodeHarness implements Harness {
  readonly id = 'opencode' as const;
  readonly name = 'OpenCode';

  bin: string;
  #cwd: string;

  constructor(bin: string, cwd: string) {
    this.bin = bin;
    this.#cwd = cwd;
  }

  detect(): HarnessCapability {
    return { id: this.id, name: this.name, ...detectCli(this.bin, this.name, process.env, 'FOURK7_OPENCODE_BIN') };
  }

  /** `opencode models`: provider/model, one per line. */
  async models(): Promise<string[]> {
    const out = await capture(this.bin, ['models'], { env: process.env, cwd: this.#cwd, timeoutMs: 60_000 });
    return (out ?? '').split('\n').map((l) => l.trim()).filter((l) => /^[\w.-]+\/\S+$/.test(l));
  }

  chat(job: ChatJob, sink: RunSink): Invocation {
    const config = {
      mcp: { '4k7': { type: 'remote', url: job.mcpUrl, headers: { Authorization: `Bearer ${job.token}` }, enabled: true } },
      agent: {
        [AGENT]: {
          mode: 'primary',
          description: 'Answers the chat of the 4k7 app through its tools',
          // forward slashes: this goes into the config's text as it is, where a backslash would be an escape
          prompt: `{file:${rulesFile(job.rulesDir, job.web ? `${chatModePrompt()}\n\n${CHAT_WEB_PROMPT}` : chatModePrompt()).replaceAll('\\', '/')}}`,
          tools: { '*': false, '4k7_*': true, ...(job.web ? { webfetch: true, websearch: true } : {}) },
          permission: { edit: 'deny', bash: 'deny', webfetch: job.web ? 'allow' : 'deny', external_directory: 'deny' },
        },
      },
    };
    const env = { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
    return {
      args: ['run', '--format', 'json', '--thinking', '--agent', AGENT, ...(job.model ? ['--model', job.model] : []), ...(job.session ? ['--session', job.session] : [])],
      env,
      stdin: job.text,
      ...this.#reader(job, env, sink),
    };
  }

  #reader(job: ChatJob, env: NodeJS.ProcessEnv, sink: RunSink): Pick<Invocation, 'line' | 'close'> {
    let session = job.session;
    let wrote = false;
    let cost = 0;
    let error: string | undefined;
    const seen = new Set<string>(); // parts already passed on
    const text = (t: string) => {
      if (!t.trim()) return;
      sink.emit({ kind: 'text', text: wrote ? `\n\n${t}` : t });
      wrote = true;
    };
    const part = (p: OpenCodePart) => {
      if (p.id) {
        if (seen.has(p.id)) return;
        seen.add(p.id);
      }
      if (p.type === 'text' && p.text && !p.synthetic) text(p.text);
      else if (p.type === 'reasoning' && p.text) sink.emit({ kind: 'thinking', text: p.text });
      else if (p.type === 'step-finish') {
        const t = p.tokens;
        if (t) sink.count({ input: t.input ?? 0, output: (t.output ?? 0) + (t.reasoning ?? 0), cacheRead: t.cache?.read ?? 0, cacheWrite: t.cache?.write ?? 0, ...(job.model ? { model: job.model } : {}) });
        cost += p.cost ?? 0;
      }
    };
    return {
      line: (line) => {
        const m = parseLine<OpenCodeEvent>(line);
        if (!m) return;
        if (m.sessionID && m.sessionID !== session) {
          session = m.sessionID;
          sink.emit({ kind: 'session', session });
        }
        if (m.type === 'error') error = errorText(m.error) ?? 'OpenCode reported an error.';
        else if (m.part) part(m.part);
      },
      close: async (code) => {
        if (session) {
          const out = await capture(this.bin, ['export', session], { env, cwd: this.#cwd });
          const start = out?.indexOf('{') ?? -1;
          try {
            const exported = start >= 0 ? (JSON.parse(out!.slice(start)) as { messages?: { info?: { role?: string; error?: unknown }; parts?: OpenCodePart[] }[] }) : null;
            const msgs = exported?.messages ?? [];
            const lastUser = msgs.findLastIndex((x) => x.info?.role === 'user');
            for (const msg of msgs.slice(lastUser + 1)) {
              for (const p of msg.parts ?? []) part(p);
              if (msg.info?.error) error ??= errorText(msg.info.error);
            }
          } catch (e) {
            sink.log(`opencode export: ${(e as Error).message}`);
          }
        }
        if (code === 0 || error) {
          sink.count({}, true);
          sink.finish({ kind: 'done', ok: !error, ...(error ? { error } : {}), ...(cost ? { costUsd: cost } : {}), ...(session ? { session } : {}) });
        }
      },
    };
  }
}

function errorText(e: unknown): string | undefined {
  const err = e as { name?: string; message?: string; data?: { message?: string } } | undefined;
  return err?.data?.message ?? err?.message ?? err?.name;
}

/** A message part as `opencode run --format json` and `opencode export` give it (the fields read here). */
interface OpenCodePart {
  id?: string;
  type: string;
  text?: string;
  synthetic?: boolean;
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
  cost?: number;
}

interface OpenCodeEvent {
  type: string;
  sessionID?: string;
  part?: OpenCodePart;
  error?: unknown;
}
