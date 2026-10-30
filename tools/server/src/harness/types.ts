/**
 * A coding agent's CLI ("harness") that the server runs headlessly to answer the app chat: how to
 * start it with only the 4k7 tools, and how to read what it prints. Each one uses the user's own
 * login and plan (Claude Code, GitHub Copilot CLI, OpenCode).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEffort, ChatCapability, ChatEvent, HarnessCapability, HarnessId, TokenCount } from '@4k7/schema';
import { commandFor, isBatchFile, spawnCli, spawnCliSync, stopCli } from '../claude-bin.ts';

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
  /** Where the run's rules can be written for the CLI to read (see rulesFile). */
  rulesDir: string;
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
  /** The CLI: a path, or a name looked up on the PATH. Can change while the server runs (set in the app). */
  bin: string;
  detect(): HarnessCapability;
  /** The models the CLI offers, if it can list them. */
  models?(): Promise<string[]>;
  chat(job: ChatJob, sink: RunSink): Invocation;
}

/**
 * A run's rules in a file, for a CLI that can read them from one: the chat rules alone are longer than a whole
 * command line may be on Windows (32,767 characters), and than an environment variable there. Named after what it
 * holds, so runs share it and a server of another version leaves it alone.
 */
export function rulesFile(dir: string, text: string): string {
  const file = join(dir, `rules-${createHash('sha256').update(text).digest('hex').slice(0, 16)}.md`);
  if (existsSync(file)) return file;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // a run must never read half of it, nor a later one after a crash
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    if (!existsSync(file)) throw e; // else another server just wrote the same and has it open
  }
  return file;
}

/** `<bin> --version`, the first line of it; unavailable when it does not run. */
export function detectCli(bin: string, name: string, env: NodeJS.ProcessEnv, envVar: string): ChatCapability {
  // a large CLI's first start on Windows takes a while (the virus scanner reads it first)
  const r = spawnCliSync(bin, ['--version'], { encoding: 'utf8', timeout: process.platform === 'win32' ? 30_000 : 10_000, env });
  if (r.error || r.status !== 0) {
    const file = commandFor(bin, env).file;
    if (process.platform === 'win32' && isBatchFile(file)) {
      return { available: false, reason: `${file} is a batch file that was not installed by npm, which the app cannot start. Give the path of the ${name} program itself in Settings → Coding agents (or ${envVar}).` };
    }
    return { available: false, reason: `${name} CLI not found ("${bin}"). Install it, or give its full path in Settings → Coding agents (or ${envVar}).` };
  }
  return { available: true, version: r.stdout.trim().split(/\r?\n/)[0] ?? '' };
}

/** Run a CLI to completion and return its stdout (null when it failed). */
export function capture(bin: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number }): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(bin, args, { env: opts.env, ...(opts.cwd ? { cwd: opts.cwd } : {}), stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(null); // Windows refuses a batch file right here
    }
    let out = '';
    const timer = setTimeout(() => stopCli(child, 'SIGKILL'), opts.timeoutMs ?? 30_000);
    child.stdout!.on('data', (d) => (out += String(d)));
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
