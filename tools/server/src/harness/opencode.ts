/**
 * OpenCode: `opencode run --format json` with an agent of its own, defined for the run through
 * OPENCODE_CONFIG_CONTENT (merged into the user's config, so their providers and logins apply):
 * the chat rules as its prompt, the 4k7 endpoint as a remote MCP server, and every tool but the
 * 4k7 ones switched off. The message goes in on stdin (an argument would be quoted). Datasheet
 * imports get an agent with the read-only file tools (read, grep, glob) as well, kept inside the
 * job folder (its working directory) by denying external_directory.
 *
 * `opencode run` can exit before it prints the last step of its answer, so once it has exited the
 * session is read back with `opencode export` and whatever the stream left out is sent then.
 */
import { CHAT_WEB_PROMPT, INGEST_VERIFY_PROMPT, chatModePrompt, ingestPrompt, type HarnessCapability } from '@4k7/schema';
import { describeTool } from './ingest.ts';
import { capture, detectCli, parseLine, type ChatJob, type Harness, type IngestJob, type Invocation, type RunSink } from './types.ts';

/** The CLI's read-only file tools. */
const FILE_TOOLS = ['read', 'grep', 'glob'];

export class OpenCodeHarness implements Harness {
  readonly id = 'opencode' as const;
  readonly name = 'OpenCode';

  readonly bin: string;
  #cwd: string;

  constructor(bin: string, cwd: string) {
    this.bin = bin;
    this.#cwd = cwd;
  }

  detect(): HarnessCapability {
    return { id: this.id, name: this.name, ingest: true, ...detectCli(this.bin, this.name, process.env, 'FOURK7_OPENCODE_BIN') };
  }

  /** `opencode models`: provider/model, one per line. */
  async models(): Promise<string[]> {
    const out = await capture(this.bin, ['models'], { env: process.env, cwd: this.#cwd, timeoutMs: 60_000 });
    return (out ?? '').split('\n').map((l) => l.trim()).filter((l) => /^[\w.-]+\/\S+$/.test(l));
  }

  chat(job: ChatJob, sink: RunSink): Invocation {
    return this.#run(job, sink, {
      name: '4k7-chat',
      description: 'Answers the chat of the 4k7 app through its tools',
      prompt: job.web ? `${chatModePrompt()}\n\n${CHAT_WEB_PROMPT}` : chatModePrompt(),
      tools: { '4k7_*': true, ...(job.web ? { webfetch: true, websearch: true } : {}) },
      webfetch: job.web,
      text: job.text,
      session: job.session,
    });
  }

  /** Datasheet import: the file tools in the job folder and submit_part; a fresh session per pass. */
  ingest(job: IngestJob, sink: RunSink): Invocation {
    return this.#run(job, sink, {
      name: '4k7-ingest',
      description: 'Extracts a part from a datasheet for the 4k7 app',
      prompt: job.pass === 1 ? ingestPrompt() : `${ingestPrompt()}\n\n${INGEST_VERIFY_PROMPT}`,
      tools: { ...Object.fromEntries(FILE_TOOLS.map((t) => [t, true])), '4k7_*': true },
      webfetch: false,
      text: job.prompt,
      session: null,
      progress: true,
    });
  }

  #run(
    job: { mcpUrl: string; token: string; model?: string; cwd: string },
    sink: RunSink,
    a: { name: string; description: string; prompt: string; tools: Record<string, boolean>; webfetch: boolean; text: string; session: string | null; progress?: boolean },
  ): Invocation {
    const config = {
      mcp: { '4k7': { type: 'remote', url: job.mcpUrl, headers: { Authorization: `Bearer ${job.token}` }, enabled: true } },
      agent: {
        [a.name]: {
          mode: 'primary',
          description: a.description,
          prompt: a.prompt,
          tools: { '*': false, ...a.tools },
          permission: { edit: 'deny', bash: 'deny', webfetch: a.webfetch ? 'allow' : 'deny', external_directory: 'deny' },
        },
      },
    };
    const env = { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
    return {
      args: ['run', '--format', 'json', '--thinking', '--agent', a.name, ...(job.model ? ['--model', job.model] : []), ...(a.session ? ['--session', a.session] : [])],
      env,
      stdin: a.text,
      ...this.#reader(a.session, job, env, sink, !!a.progress),
    };
  }

  #reader(resumed: string | null, job: { model?: string; cwd: string }, env: NodeJS.ProcessEnv, sink: RunSink, progress: boolean): Pick<Invocation, 'line' | 'close'> {
    let session = resumed;
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
      else if (p.type === 'tool' && progress && p.tool && FILE_TOOLS.includes(p.tool)) sink.emit({ kind: 'status', text: describeTool(p.tool, p.state?.input) });
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
          // sessions belong to the folder they ran in
          const out = await capture(this.bin, ['export', session], { env, cwd: job.cwd });
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
  tool?: string;
  state?: { input?: unknown };
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
  cost?: number;
}

interface OpenCodeEvent {
  type: string;
  sessionID?: string;
  part?: OpenCodePart;
  error?: unknown;
}
