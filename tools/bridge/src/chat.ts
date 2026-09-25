/**
 * Chat in the app, answered by the user's local Claude Code: each message runs
 * `claude -p` headlessly with only the Tracewise MCP tools (served by this bridge over HTTP),
 * and streams its reply back to the tab. Uses the user's own Claude Code login/plan.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { CHAT_WEB_PROMPT, chatModePrompt, type ChatCapability, type ChatEvent } from '@tracewise/schema';
import type { Bridge, ChatMessage } from './bridge.ts';
import type { ClaudeProfile } from './config.ts';
import { tokenMatches } from './mcp.ts';

export interface ChatRunnerOptions {
  bridge: Bridge;
  /** Path or name of the Claude Code executable. */
  claudeBin: string;
  /** Neutral working directory for the headless sessions (no project files, no CLAUDE.md). */
  workDir: string;
  /** Which Claude login/settings to use (like a `claude-personal` alias). */
  profile?: ClaudeProfile;
  log?: (msg: string) => void;
}

interface Run {
  child: ChildProcess;
  token: string;
  done: boolean;
}

/** Probe the Claude Code CLI. */
export function detectClaude(bin: string, profile?: ClaudeProfile): ChatCapability {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000, env: childEnv(profile) });
  if (r.error || r.status !== 0) {
    return {
      available: false,
      reason: `Claude Code CLI not found ("${bin}"). Install it or set TRACEWISE_CLAUDE_BIN.`,
    };
  }
  return { available: true, version: r.stdout.trim().split('\n')[0] ?? '' };
}

/**
 * Environment for the headless Claude: the profile's changes, and never the markers of the
 * Claude Code session that may have started the bridge (it is not nested inside it).
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

export class ChatRunner {
  #opts: ChatRunnerOptions;
  #runs = new Map<string, Run>();

  constructor(opts: ChatRunnerOptions) {
    this.#opts = opts;
    mkdirSync(opts.workDir, { recursive: true, mode: 0o700 });
  }

  isValidToken(token: string): boolean {
    for (const r of this.#runs.values()) if (!r.done && tokenMatches(r.token, token)) return true;
    return false;
  }

  handle = (msg: ChatMessage) => {
    if (msg.type === 'chat_cancel') this.cancel(msg.id);
    else this.start(msg);
  };

  #emit(id: string, event: ChatEvent) {
    this.#opts.bridge.sendToTab({ type: 'chat_event', id, event });
  }

  start(msg: Extract<ChatMessage, { type: 'chat' }>) {
    if ([...this.#runs.values()].some((r) => !r.done)) {
      this.#emit(msg.id, { kind: 'done', ok: false, error: 'Claude Code is still working on the previous message.' });
      return;
    }
    const port = this.#opts.bridge.port;
    const token = randomBytes(24).toString('hex');
    const mcpConfig = {
      mcpServers: {
        tracewise: { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } },
      },
    };
    const args = [
      '-p',
      msg.text,
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--mcp-config',
      JSON.stringify(mcpConfig),
      '--strict-mcp-config',
      '--tools',
      msg.web ? 'WebFetch,WebSearch' : '', // never shell or files; the web only when the user allows it
      '--allowedTools',
      msg.web ? 'mcp__tracewise,WebFetch,WebSearch' : 'mcp__tracewise',
      '--permission-mode',
      'dontAsk',
      '--append-system-prompt',
      msg.web ? `${chatModePrompt()}\n\n${CHAT_WEB_PROMPT}` : chatModePrompt(),
      ...(msg.model ? ['--model', msg.model] : []),
      ...(msg.session ? ['--resume', msg.session] : []),
    ];

    const child = spawn(this.#opts.claudeBin, args, { cwd: this.#opts.workDir, env: childEnv(this.#opts.profile), stdio: ['ignore', 'pipe', 'pipe'] });
    const run: Run = { child, token, done: false };
    this.#runs.set(msg.id, run);
    this.#opts.log?.(`chat ${msg.id}: started claude (${msg.session ? `resume ${msg.session.slice(0, 8)}` : 'new session'})`);

    let streamedText = false;
    let stderr = '';
    const finish = (event: Extract<ChatEvent, { kind: 'done' }>) => {
      if (run.done) return;
      run.done = true;
      this.#emit(msg.id, event);
    };

    createInterface({ input: child.stdout! }).on('line', (line) => {
      let m: StreamJson;
      try {
        m = JSON.parse(line) as StreamJson;
      } catch {
        return;
      }
      switch (m.type) {
        case 'system':
          if (m.subtype === 'init') {
            if (m.session_id) this.#emit(msg.id, { kind: 'session', session: m.session_id });
            const tw = m.mcp_servers?.find((s) => s.name === 'tracewise');
            if (tw && tw.status !== 'connected') this.#opts.log?.(`chat ${msg.id}: tracewise MCP status ${tw.status}`);
          }
          break;
        case 'stream_event': {
          const e = m.event;
          if (e?.type === 'content_block_delta') {
            if (e.delta?.type === 'text_delta' && e.delta.text) {
              streamedText = true;
              this.#emit(msg.id, { kind: 'text', text: e.delta.text });
            } else if (e.delta?.type === 'thinking_delta' && e.delta.thinking) {
              this.#emit(msg.id, { kind: 'thinking', text: e.delta.thinking });
            }
          } else if (e?.type === 'message_start' && streamedText) {
            this.#emit(msg.id, { kind: 'text', text: '\n\n' });
          }
          break;
        }
        case 'assistant':
          if (!streamedText) {
            for (const b of m.message?.content ?? []) if (b.type === 'text' && b.text) this.#emit(msg.id, { kind: 'text', text: b.text });
          }
          break;
        case 'result':
          finish({
            kind: 'done',
            ok: !m.is_error && m.subtype === 'success',
            ...(m.is_error || m.subtype !== 'success' ? { error: m.result || m.subtype || 'Claude Code reported an error.' } : {}),
            ...(typeof m.total_cost_usd === 'number' ? { costUsd: m.total_cost_usd } : {}),
            ...(m.session_id ? { session: m.session_id } : {}),
          });
          break;
      }
    });
    child.stderr!.on('data', (d) => {
      stderr = (stderr + String(d)).slice(-2000);
    });
    child.on('error', (e) => finish({ kind: 'done', ok: false, error: `Could not start Claude Code: ${e.message}` }));
    child.on('close', (code, signal) => {
      finish({
        kind: 'done',
        ok: false,
        error: signal ? 'Stopped.' : `Claude Code exited (${code})${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`,
      });
      this.#runs.delete(msg.id);
      this.#opts.log?.(`chat ${msg.id}: finished (${signal ?? code})`);
    });
  }

  cancel(id: string) {
    const r = this.#runs.get(id);
    if (!r || r.done) return;
    r.child.kill('SIGINT');
    setTimeout(() => r.child.exitCode === null && r.child.kill('SIGKILL'), 3000).unref();
  }

  stopAll() {
    for (const id of this.#runs.keys()) this.cancel(id);
  }
}

/** The subset of Claude Code's stream-json output this runner reads. */
type StreamJson =
  | { type: 'system'; subtype?: string; session_id?: string; mcp_servers?: { name: string; status: string }[] }
  | {
      type: 'stream_event';
      event?: { type: string; delta?: { type: string; text?: string; thinking?: string } };
    }
  | { type: 'assistant'; message?: { content?: { type: string; text?: string }[] } }
  | { type: 'result'; subtype?: string; is_error?: boolean; result?: string; total_cost_usd?: number; session_id?: string }
  | { type: 'user' };
