/**
 * A coding agent's CLI ("harness") that the server runs headlessly to answer the app chat: how to
 * start it with only the 4k7 tools, and how to read what it prints. Each one uses the user's own
 * login and plan (Claude Code, GitHub Copilot CLI, OpenCode).
 */
import { spawn, spawnSync } from 'node:child_process';
import type { AgentEffort, ChatCapability, ChatEvent, HarnessCapability, HarnessId, TokenCount } from '@4k7/schema';

export type DoneEvent = Extract<ChatEvent, { kind: 'done' }>;

/** One chat message to answer. */
export interface ChatJob {
  text: string;
  /** The harness's session to continue, null for a new conversation. */
  session: string | null;
  model?: string;
  /** Left out: the CLI's own default. */
  effort?: AgentEffort;
  web: boolean;
  /** The server's MCP endpoint and the bearer token of this run (it decides which tools it sees). */
  mcpUrl: string;
  token: string;
}

/** Where a run's output goes. */
export interface RunSink {
  emit(event: ChatEvent): void;
  /** Add token usage (sent to the tab at most once a second unless forced). */
  count(add: Partial<TokenCount>, force?: boolean): void;
  /** The run's outcome; the first one counts. */
  finish(done: DoneEvent): void;
  log(msg: string): void;
}

/** How to start one run, and the reader for its stdout. */
export interface Invocation {
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Written to the CLI's stdin (else it gets none). */
  stdin?: string;
  line(line: string): void;
  /** After the process exited, before its exit code decides the outcome (e.g. to fetch what the stream left out). */
  close?(code: number | null): Promise<void>;
}

export interface Harness {
  readonly id: HarnessId;
  readonly name: string;
  readonly bin: string;
  detect(): HarnessCapability;
  /** The models the CLI offers, if it can list them. */
  models?(): Promise<string[]>;
  chat(job: ChatJob, sink: RunSink): Invocation;
}

/** `<bin> --version`, the first line of it; unavailable when it does not run. */
export function detectCli(bin: string, name: string, env: NodeJS.ProcessEnv, envVar: string): ChatCapability {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000, env });
  if (r.error || r.status !== 0) {
    return { available: false, reason: `${name} CLI not found ("${bin}"). Install it or set ${envVar}.` };
  }
  return { available: true, version: r.stdout.trim().split('\n')[0] ?? '' };
}

/** Run a CLI to completion and return its stdout (null when it failed). */
export function capture(bin: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number }): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: opts.env, ...(opts.cwd ? { cwd: opts.cwd } : {}), stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 30_000);
    child.stdout.on('data', (d) => (out += String(d)));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out : null);
    });
  });
}

/** JSON of one output line, or null for anything else the CLI prints. */
export function parseLine<T>(line: string): T | null {
  if (!line.startsWith('{')) return null;
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}
