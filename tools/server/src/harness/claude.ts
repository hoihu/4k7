/**
 * Claude Code: `claude -p` with stream-json output, the 4k7 MCP endpoint as its only MCP server,
 * and the chat rules appended to its system prompt. Also runs the datasheet importer.
 */
import { CHAT_WEB_PROMPT, INGEST_VERIFY_PROMPT, chatModePrompt, ingestPrompt, type ChatCapability, type HarnessCapability } from '@4k7/schema';
import type { ClaudeProfile } from '../config.ts';
import { detectCli, parseLine, type ChatJob, type Harness, type Invocation, type RunSink } from './types.ts';

/** Probe the Claude Code CLI. */
export function detectClaude(bin: string, profile?: ClaudeProfile): ChatCapability {
  return detectCli(bin, 'Claude Code', childEnv(profile), 'FOURK7_CLAUDE_BIN');
}

/**
 * Environment for the headless Claude: the profile's changes, and never the markers of the
 * Claude Code session that may have started the server (it is not nested inside it).
 */
export function childEnv(profile?: ClaudeProfile): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  for (const k of profile?.unsetEnv ?? []) delete env[k];
  if (profile?.configDir) env.CLAUDE_CONFIG_DIR = profile.configDir;
  Object.assign(env, profile?.env ?? {});
  return env;
}

/** A datasheet import pass: the prompt, and the importer's own rules. */
export interface IngestJob {
  prompt: string;
  model?: string;
  mcpUrl: string;
  token: string;
  /** 2 = the independent verification pass. */
  pass: number;
}

const STREAM_ARGS = ['--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

export class ClaudeHarness implements Harness {
  readonly id = 'claude-code' as const;
  readonly name = 'Claude Code';

  readonly bin: string;
  #profile: ClaudeProfile | undefined;

  constructor(bin: string, profile?: ClaudeProfile) {
    this.bin = bin;
    this.#profile = profile;
  }

  detect(): HarnessCapability {
    return { id: this.id, name: this.name, ...detectClaude(this.bin, this.#profile) };
  }

  chat(job: ChatJob, sink: RunSink): Invocation {
    return {
      args: [
        '-p',
        job.text,
        ...STREAM_ARGS,
        '--mcp-config',
        mcpConfig(job),
        '--strict-mcp-config',
        '--tools',
        job.web ? 'WebFetch,WebSearch' : '', // never shell or files; the web only when the user allows it
        '--allowedTools',
        job.web ? 'mcp__4k7,WebFetch,WebSearch' : 'mcp__4k7',
        '--permission-mode',
        'dontAsk',
        '--append-system-prompt',
        job.web ? `${chatModePrompt()}\n\n${CHAT_WEB_PROMPT}` : chatModePrompt(),
        ...(job.model ? ['--model', job.model] : []),
        ...(job.session ? ['--resume', job.session] : []),
      ],
      env: childEnv(this.#profile),
      ...streamReader(sink, 'chat'),
    };
  }

  /** Datasheet import: Read/Grep/Glob in the job folder (the working directory) and submit_part. */
  ingest(job: IngestJob, sink: RunSink): Invocation {
    return {
      args: [
        '-p',
        job.prompt,
        ...STREAM_ARGS,
        '--mcp-config',
        mcpConfig(job),
        '--strict-mcp-config',
        '--tools',
        'Read,Grep,Glob', // reading inside the job folder needs no permission; everything else is denied
        '--allowedTools',
        'mcp__4k7',
        '--permission-mode',
        'dontAsk',
        '--append-system-prompt',
        job.pass === 1 ? ingestPrompt() : `${ingestPrompt()}\n\n${INGEST_VERIFY_PROMPT}`,
        ...(job.model ? ['--model', job.model] : []),
      ],
      env: childEnv(this.#profile),
      ...streamReader(sink, 'ingest'),
    };
  }
}

function mcpConfig(job: { mcpUrl: string; token: string }): string {
  return JSON.stringify({ mcpServers: { '4k7': { type: 'http', url: job.mcpUrl, headers: { Authorization: `Bearer ${job.token}` } } } });
}

/** Reads Claude Code's stream-json output. */
function streamReader(sink: RunSink, mode: 'chat' | 'ingest'): Pick<Invocation, 'line'> {
  let streamedText = false;
  let messageOut = 0; // output tokens of the model call in progress (message_delta counts cumulatively)
  let writing: { json: string; reported: number } | null = null;
  return {
    line(line) {
      const m = parseLine<StreamJson>(line);
      if (!m) return;
      switch (m.type) {
        case 'system':
          if (m.subtype === 'init') {
            if (m.session_id) sink.emit({ kind: 'session', session: m.session_id });
            const tw = m.mcp_servers?.find((s) => s.name === '4k7');
            if (tw && tw.status !== 'connected') sink.log(`4k7 MCP status ${tw.status}`);
          }
          break;
        case 'stream_event': {
          const e = m.event;
          if (e?.type === 'content_block_delta') {
            if (e.delta?.type === 'text_delta' && e.delta.text) {
              streamedText = true;
              sink.emit({ kind: 'text', text: e.delta.text });
            } else if (e.delta?.type === 'thinking_delta' && e.delta.thinking) {
              sink.emit({ kind: 'thinking', text: e.delta.thinking });
            } else if (e.delta?.type === 'input_json_delta' && writing) {
              // the part is written as one long tool call; report pins as they stream in
              writing.json += e.delta.partial_json ?? '';
              const pins = (writing.json.match(/"number"\s*:/g) ?? []).length;
              if (pins >= writing.reported + 20) {
                writing.reported = pins - (pins % 20);
                sink.emit({ kind: 'status', text: `Writing the part: ${writing.reported} pins…` });
              }
            }
          } else if (e?.type === 'content_block_start' && mode === 'ingest' && e.content_block?.type === 'tool_use') {
            writing = e.content_block.name?.endsWith('submit_part') ? { json: '', reported: 0 } : null;
            if (writing) sink.emit({ kind: 'status', text: 'Writing the part…' });
          } else if (e?.type === 'message_start') {
            if (streamedText) sink.emit({ kind: 'text', text: '\n\n' });
            // a new model call: its prompt (fresh, from the cache, into the cache)
            const u = e.message?.usage;
            messageOut = u?.output_tokens ?? 0;
            sink.count({ input: u?.input_tokens ?? 0, cacheRead: u?.cache_read_input_tokens ?? 0, cacheWrite: u?.cache_creation_input_tokens ?? 0, output: messageOut, ...(e.message?.model ? { model: e.message.model } : {}) });
          } else if (e?.type === 'message_delta' && typeof e.usage?.output_tokens === 'number') {
            sink.count({ output: Math.max(0, e.usage.output_tokens - messageOut) });
            messageOut = e.usage.output_tokens;
          }
          break;
        }
        case 'assistant':
          for (const b of m.message?.content ?? []) {
            if (b.type === 'text' && b.text && !streamedText) sink.emit({ kind: 'text', text: b.text });
            if (b.type === 'tool_use' && mode === 'ingest' && !b.name?.endsWith('submit_part')) sink.emit({ kind: 'status', text: describeTool(b.name, b.input) });
          }
          break;
        case 'result':
          sink.finish({
            kind: 'done',
            ok: !m.is_error && m.subtype === 'success',
            ...(m.is_error || m.subtype !== 'success' ? { error: m.result || m.subtype || 'Claude Code reported an error.' } : {}),
            ...(typeof m.total_cost_usd === 'number' ? { costUsd: m.total_cost_usd } : {}),
            ...(m.session_id ? { session: m.session_id } : {}),
          });
          break;
      }
    },
  };
}

/** Progress line for a tool call of the importer ("Reading page 69"). */
function describeTool(name = '', input: unknown): string {
  const i = (input ?? {}) as { file_path?: string; pattern?: string; offset?: number };
  if (name === 'Read') {
    const page = /page-0*(\d+)\.txt$/.exec(i.file_path ?? '');
    if (page) return `Reading page ${page[1]}`;
    return `Reading ${(i.file_path ?? '').split('/').pop()}`;
  }
  if (name === 'Grep') return `Searching for “${i.pattern ?? ''}”`;
  if (name === 'Glob') return 'Listing pages';
  return name;
}

/** Token usage as the Anthropic API reports it (message_start: the prompt; message_delta: output so far). */
interface StreamUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
}

/** The subset of Claude Code's stream-json output this reader reads. */
type StreamJson =
  | { type: 'system'; subtype?: string; session_id?: string; mcp_servers?: { name: string; status: string }[] }
  | {
      type: 'stream_event';
      event?: {
        type: string;
        delta?: { type: string; text?: string; thinking?: string; partial_json?: string };
        content_block?: { type: string; name?: string };
        message?: { model?: string; usage?: StreamUsage };
        usage?: StreamUsage;
      };
    }
  | { type: 'assistant'; message?: { content?: { type: string; text?: string; name?: string; input?: unknown }[] } }
  | { type: 'result'; subtype?: string; is_error?: boolean; result?: string; total_cost_usd?: number; session_id?: string }
  | { type: 'user' };
