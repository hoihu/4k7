/**
 * Codex CLI: `codex exec --json`, with the chat rules in a file (they replace Codex's own prompt for coding) and the
 * message on stdin. Codex has no list of allowed tools, so the settings of the run (`-c`, which win over the user's
 * ~/.codex/config.toml; their login, provider and model stay) switch off what it would add, and the user's own MCP
 * servers by name: `codex mcp list` tells which there are, and a run that cannot tell does not start.
 *
 * Three things cannot be switched off and are harmless here: `apply_patch` (the read-only sandbox refuses every patch),
 * `list_mcp_resources` and its kin (the 4k7 server has none) and, on current models, `exec`/`wait` (JavaScript with no
 * files, no network and none of the 4k7 tools, which stay plain tools). `scripts/check-codex.mjs` runs the real CLI
 * and fails on anything else: a new Codex can add a tool this file does not know of.
 *
 * Text comes a whole message at a time: the JSON output has no deltas. Token totals are per session, as with Copilot.
 */
import { CHAT_WEB_PROMPT, chatModePrompt, type HarnessCapability, type TokenCount } from '@4k7/schema';
import { compareVersions } from '../update.ts';
import { capture, detectCli, parseLine, rulesFile, type ChatJob, type Harness, type Invocation, type RunSink } from './types.ts';

/** Older ones strip design_edit's schema whatever the settings say: the agent would run and could not edit. */
const MIN_VERSION = '0.158.0';
/** Its own name: the user may have registered `4k7` for their agent, which must not start here (and has a command, this a URL). */
const SERVER = '4k7_chat';
const TOKEN_VAR = 'FOURK7_MCP_TOKEN';

/** Everything that adds tools or runs the user's programs besides what `CodexHarness.chat` sets by name. A name Codex does not know is ignored. */
const FEATURES_OFF = ['shell_tool', 'view_image', 'image_generation', 'apps', 'plugins', 'multi_agent_v2', 'hooks', 'goals', 'skill_search', 'sleep_tool', 'tool_suggest', 'memories', 'multi_env_copy_file', 'request_permissions_tool'];
const off = (names: string[]) => Object.fromEntries(names.map((n) => [n, false]));

/** A value for `-c`: TOML, which reads JSON's strings, numbers and arrays but writes a table its own way. */
function toml(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(toml).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}=${toml(x)}`).join(',')}}`;
  return JSON.stringify(v);
}

const settings = (config: Record<string, unknown>) => Object.entries(config).flatMap(([k, v]) => ['-c', `${k}=${toml(v)}`]);

export class CodexHarness implements Harness {
  readonly id = 'codex' as const;
  readonly name = 'Codex CLI';
  /** Token totals per session: the CLI reports them for the whole session, a run's are the difference. */
  #totals = new Map<string, TokenCount>();

  bin: string;
  #cwd: string;

  constructor(bin: string, cwd: string) {
    this.bin = bin;
    this.#cwd = cwd;
  }

  /** Its HTTP client takes the proxy variables for 127.0.0.1 too, where the 4k7 endpoint is. */
  #env(): NodeJS.ProcessEnv {
    const noProxy = [process.env.NO_PROXY ?? process.env.no_proxy, '127.0.0.1'].filter(Boolean).join(',');
    return { ...process.env, NO_PROXY: noProxy, no_proxy: noProxy };
  }

  detect(): HarnessCapability {
    const cap = detectCli(this.bin, 'Codex', this.#env(), 'FOURK7_CODEX_BIN');
    const version = /\d+\.\d+\.\d+/.exec(cap.version ?? '')?.[0];
    if (version && compareVersions(version, MIN_VERSION) < 0) {
      return { id: this.id, name: this.name, ...cap, available: false, reason: `Codex ${version} is too old for 4k7, which needs ${MIN_VERSION} or newer. Update it ("codex update"), then press Look again.` };
    }
    return { id: this.id, name: this.name, ...cap };
  }

  async models(): Promise<string[]> {
    const out = await capture(this.bin, ['debug', 'models'], { env: this.#env(), cwd: this.#cwd });
    return (parseLine<{ models?: { slug: string; visibility?: string }[] }>(out ?? '')?.models ?? []).filter((m) => m.visibility === 'list').map((m) => m.slug);
  }

  /** The servers from the user's settings. Connectors and plugins are off for the run, so not among them (to switch off one that is not in the settings is an error). */
  async #userServers(): Promise<string[]> {
    const out = await capture(this.bin, ['mcp', 'list', '--json', ...settings({ features: off(['apps', 'plugins']) })], { env: this.#env(), cwd: this.#cwd });
    try {
      return (JSON.parse(out ?? '') as { name: string }[]).map((s) => s.name);
    } catch {
      throw new Error('it did not say which MCP servers it would start ("codex mcp list --json").');
    }
  }

  async chat(job: ChatJob, sink: RunSink): Promise<Invocation> {
    const users = await this.#userServers();
    const config = {
      model_instructions_file: rulesFile(job.rulesDir, job.web ? `${chatModePrompt()}\n\n${CHAT_WEB_PROMPT}` : chatModePrompt()),
      developer_instructions: '',
      include_permissions_instructions: false,
      include_collaboration_mode_instructions: false,
      skills: { include_instructions: false },
      sandbox_mode: 'read-only',
      web_search: job.web ? 'live' : 'disabled',
      notify: [], // the user's program for when a turn ends
      agents: { enabled: false },
      tools: { experimental_request_user_input: { enabled: false } },
      // direct: the model calls them like any tool, instead of from a script or after searching for them
      features: { ...off(FEATURES_OFF), code_mode: { enabled: false, direct_only_tool_namespaces: [`mcp__${SERVER}`] } },
      // the default cuts a result at 10,000 tokens, shorter than a guide (this is Claude Code's limit)
      tool_output_token_limit: 25_000,
      mcp_servers: {
        ...Object.fromEntries(users.map((name) => [name, { enabled: false }])),
        [SERVER]: {
          url: job.mcpUrl,
          bearer_token_env_var: TOKEN_VAR,
          required: true, // without its tools a run could only apologise
          default_tools_approval_mode: 'approve', // with nobody to ask, Codex cancels the call
          tool_input_schema_max_bytes: 1_000_000, // above 5,000 it strips a tool's schema, and design_edit's is 90,000
          tool_timeout_sec: 1800, // import_part waits for up to 900 s
        },
      },
      ...(job.effort ? { model_reasoning_effort: job.effort } : {}),
    };
    return {
      args: [
        'exec',
        ...(job.session ? ['resume'] : []),
        '--json',
        '--skip-git-repo-check', // its working directory is a neutral one
        ...settings(config),
        ...(job.model ? ['--model', job.model] : []),
        ...(job.session ? [job.session] : []),
        '-', // the message: stdin
      ],
      env: { ...this.#env(), [TOKEN_VAR]: job.token },
      stdin: job.text,
      ...this.#reader(job, sink),
    };
  }

  #reader(job: ChatJob, sink: RunSink): Pick<Invocation, 'line' | 'close'> {
    let session = job.session;
    let wrote = false;
    let retrying = false;
    let error: string | undefined;
    const failed = (message: string) => sink.finish({ kind: 'done', ok: false, error: errorText(message), ...(session ? { session } : {}) });
    return {
      line: (line) => {
        const m = parseLine<CodexEvent>(line);
        if (!m) return;
        switch (m.type) {
          case 'thread.started':
            if (m.thread_id) {
              session = m.thread_id;
              sink.emit({ kind: 'session', session });
            }
            break;
          case 'item.completed':
            if (m.item?.type === 'agent_message' && m.item.text?.trim()) {
              sink.emit({ kind: 'text', text: wrote ? `\n\n${m.item.text}` : m.item.text });
              wrote = true;
            } else if (m.item?.type === 'reasoning' && m.item.text) sink.emit({ kind: 'thinking', text: `${m.item.text}\n\n` });
            else if (m.item?.type === 'error' && m.item.message) sink.log(m.item.message); // warnings: a setting it ignored, another model on resuming
            break;
          case 'error':
            // not the end: Codex tries again, and says so first; once is enough to say why nothing is happening
            if (!m.message?.startsWith('Reconnecting')) error = m.message ?? error;
            else if (!retrying) {
              retrying = true;
              sink.emit({ kind: 'status', text: m.message });
            }
            break;
          case 'turn.completed': {
            const u = m.usage ?? {};
            const cacheRead = u.cached_input_tokens ?? 0;
            const cacheWrite = u.cache_write_input_tokens ?? 0;
            const total: TokenCount = { input: Math.max(0, (u.input_tokens ?? 0) - cacheRead - cacheWrite), cacheRead, cacheWrite, output: u.output_tokens ?? 0 };
            // without the totals at the start of a resumed session (the server restarted) the run's own are unknown
            const last = job.session ? this.#totals.get(job.session) : { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
            if (last) {
              sink.count({
                input: Math.max(0, total.input - last.input),
                cacheRead: Math.max(0, total.cacheRead - last.cacheRead),
                cacheWrite: Math.max(0, total.cacheWrite - last.cacheWrite),
                output: Math.max(0, total.output - last.output),
                ...(job.model ? { model: job.model } : {}),
              });
            }
            if (session) this.#totals.set(session, total);
            sink.finish({ kind: 'done', ok: true, ...(session ? { session } : {}) });
            break;
          }
          case 'turn.failed':
            failed(m.error?.message ?? 'Codex reported an error.');
            break;
        }
      },
      close: async () => {
        if (error) failed(error);
      },
    };
  }
}

/** What to show of an error: an API's comes as its JSON, and a refused login should say what to do. */
function errorText(message: string): string {
  const api = parseLine<{ error?: { message?: string; param?: string } }>(message)?.error;
  if (api?.message) return api.param ? `${api.message} (${api.param})` : api.message;
  return /\b401\b/.test(message) ? `${message}. Is Codex signed in? Run "codex login" in a terminal, then try again.` : message;
}

/** The subset of `codex exec --json` this reader reads. */
interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: { type: string; text?: string; message?: string };
  usage?: { input_tokens?: number; cached_input_tokens?: number; cache_write_input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
  message?: string;
}
