/**
 * Browser side of the local server to Claude Code (tools/server). Connects to the local relay over a
 * WebSocket with the access key from the app's address, and executes forwarded tool calls against the kernel.
 */
import {
  SERVER_PORTS,
  SERVER_PROTOCOL,
  type ToolContent,
  type ServerToTab,
  type ChatCapability,
  type ChatEvent,
  type HarnessCapability,
  type HarnessId,
  type TabInfo,
  type TabToServer,
  type UpdateInfo,
} from '@4k7/schema';

/** 'elsewhere': another tab of the app took over the server; this tab stops retrying. */
export type ServerStatus = 'off' | 'connecting' | 'connected' | 'waiting' | 'elsewhere';

/** Close code the server uses when a newer tab replaces this one. */
const REPLACED = 4000;

export interface ServerHandler {
  (tool: string, input: unknown): Promise<{ isError: boolean; content: ToolContent[] }>;
}

const RETRY_MS = 4000;

class ServerClient {
  status = $state<ServerStatus>('off');
  port = $state<number | null>(null);
  agent = $state<string | null>(null);
  error = $state<string | null>(null);
  calls = $state(0);
  /** Whether the server can run the local Claude Code (the app chat and datasheet imports). */
  chat = $state<ChatCapability | null>(null);
  /** The coding agents the server can run for the app chat (Claude Code included). */
  harnesses = $state<HarnessCapability[]>([]);
  /** A newer release of the app than the server runs (the downloaded app does not update itself). */
  update = $state<UpdateInfo | null>(null);
  /** How Claude Code starts this server, when it knows better than this build (the downloaded app, wherever it was put). */
  mcpCommand = $state<string | null>(null);
  #chatListeners = new Map<string, (e: ChatEvent) => void>();

  #ws: WebSocket | null = null;
  #accessKey = '';
  #handler: ServerHandler | null = null;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #onConnected: ((accessKey: string, port: number) => void) | null = null;
  #onLost: (() => void) | null = null;
  #wanted = false;

  #info: () => TabInfo = () => ({ origin: location.origin, build: '', userAgent: navigator.userAgent, provider: '', storage: '', persistent: null });

  init(handler: ServerHandler, onConnected: (accessKey: string, port: number) => void, onLost?: () => void, info?: () => TabInfo) {
    this.#handler = handler;
    this.#onConnected = onConnected;
    this.#onLost = onLost ?? null;
    if (info) this.#info = info;
  }

  /** Try the access key on every server port. `silent` = background reconnect. */
  async connect(accessKey: string, opts: { silent?: boolean; preferPort?: number | null } = {}): Promise<boolean> {
    this.#accessKey = accessKey;
    this.#wanted = true;
    if (this.#retry) clearTimeout(this.#retry);
    this.status = 'connecting';
    if (!opts.silent) this.error = null;
    const ports = opts.preferPort ? [opts.preferPort, ...SERVER_PORTS.filter((p) => p !== opts.preferPort)] : [...SERVER_PORTS];
    let denied: string | null = null;
    for (const port of ports) {
      const r = await this.#tryPort(port);
      if (r === true) return true;
      if (typeof r === 'string') denied = r;
    }
    if (denied && !opts.silent) this.error = denied === 'wrong access key' ? 'The server did not accept this address. Open the link the 4k7pcb command printed.' : denied;
    else if (!opts.silent) this.error = `No server found. Is it running (${__APP_RUN__ ? `open ${__SERVER_RUN__}` : __SERVER_RUN__}, or Claude Code with the 4k7 MCP server)?`;
    this.status = 'waiting';
    this.#scheduleRetry();
    return false;
  }

  disconnect() {
    this.#wanted = false;
    if (this.#retry) clearTimeout(this.#retry);
    this.#ws?.close(1000, 'user disconnected');
    this.#ws = null;
    this.status = 'off';
    this.port = null;
    this.agent = null;
  }

  #scheduleRetry() {
    if (!this.#wanted) return;
    this.#retry = setTimeout(() => void this.connect(this.#accessKey, { silent: true, preferPort: this.port }), RETRY_MS);
  }

  /** true = connected, string = denied reason, false = nothing there. */
  #tryPort(port: number): Promise<true | string | false> {
    return new Promise((resolve) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(`ws://127.0.0.1:${port}`);
      } catch {
        resolve(false);
        return;
      }
      let settled = false;
      const done = (v: true | string | false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (v !== true) ws.close();
        resolve(v);
      };
      const timer = setTimeout(() => done(false), 1500);
      ws.onopen = () =>
        ws.send(JSON.stringify({ type: 'hello', protocol: SERVER_PROTOCOL, accessKey: this.#accessKey, client: '4k7-web', info: this.#info() } satisfies TabToServer));
      ws.onerror = () => done(false);
      ws.onclose = (ev) => {
        if (!settled) done(false);
        else if (this.#ws === ws) this.#lost(ev.code);
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data)) as ServerToTab;
        if (msg.type === 'denied') return done(msg.reason);
        if (msg.type === 'welcome') {
          this.#ws?.close();
          this.#ws = ws;
          this.port = port;
          this.agent = msg.agent;
          this.chat = msg.chat ?? null;
          // servers before the other agents: Claude Code only
          this.harnesses = msg.harnesses ?? (msg.chat ? [{ id: 'claude-code', name: 'Claude Code', ...msg.chat }] : []);
          if (msg.update) this.update = msg.update;
          this.mcpCommand = msg.mcpCommand ?? null;
          this.status = 'connected';
          this.error = null;
          this.#onConnected?.(this.#accessKey, port);
          done(true);
          return;
        }
        if (msg.type === 'agent') this.agent = msg.name;
        if (msg.type === 'update') this.update = msg.update;
        if (msg.type === 'harnesses') this.harnesses = msg.harnesses;
        if (msg.type === 'agent_bin_result') {
          this.#binWaiters.get(msg.harness)?.(msg.ok ? null : (msg.error ?? 'failed'));
          this.#binWaiters.delete(msg.harness);
        }
        if (msg.type === 'call') void this.#call(ws, msg.id, msg.tool, msg.input);
        if (msg.type === 'chat_event') {
          this.#chatListeners.get(msg.id)?.(msg.event);
          if (msg.event.kind === 'done') this.#chatListeners.delete(msg.id);
        }
      };
    });
  }

  /** Send a chat message to a coding agent on this computer; events stream to `onEvent` until 'done'. */
  sendChat(msg: Omit<Extract<TabToServer, { type: 'chat' }>, 'type'>, onEvent: (e: ChatEvent) => void): boolean {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return false;
    this.#chatListeners.set(msg.id, onEvent);
    this.#ws.send(JSON.stringify({ type: 'chat', ...msg } satisfies TabToServer));
    return true;
  }

  #binWaiters = new Map<HarnessId, (error: string | null) => void>();

  /** Run `bin` (a full path) for an agent, or its name on the PATH again (null). Resolves with why not, or null when done. */
  setAgentBin(harness: HarnessId, bin: string | null): Promise<string | null> {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return Promise.resolve('The server is not connected.');
    return new Promise((resolve) => {
      this.#binWaiters.get(harness)?.('Replaced by a newer change.');
      this.#binWaiters.set(harness, resolve);
      this.#ws!.send(JSON.stringify({ type: 'agent_bin', harness, bin } satisfies TabToServer));
    });
  }

  /** Ask the server to look for the agents' CLIs again (the answer updates `harnesses`). */
  detectAgents(): boolean {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return false;
    this.#ws.send(JSON.stringify({ type: 'agents_detect' } satisfies TabToServer));
    return true;
  }

  /** Import a part from a datasheet with the local Claude Code; events stream like chat. */
  sendIngest(msg: Omit<Extract<TabToServer, { type: 'ingest' }>, 'type'>, onEvent: (e: ChatEvent) => void): boolean {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return false;
    this.#chatListeners.set(msg.id, onEvent);
    this.#ws.send(JSON.stringify({ type: 'ingest', ...msg } satisfies TabToServer));
    return true;
  }

  cancelChat(id: string) {
    this.#ws?.send(JSON.stringify({ type: 'chat_cancel', id } satisfies TabToServer));
  }

  #lost(code?: number) {
    for (const [id, l] of this.#chatListeners) l({ kind: 'done', ok: false, error: 'The server disconnected.' });
    this.#chatListeners.clear();
    this.#onLost?.();
    this.#ws = null;
    this.agent = null;
    if (code === REPLACED) {
      // Another tab connected to the server. Retrying would kick it out again (ping-pong),
      // so this tab steps back until the user asks for it.
      this.#wanted = false;
      this.status = 'elsewhere';
      this.error = 'Claude Code is connected to this app in another browser tab.';
      return;
    }
    this.status = this.#wanted ? 'waiting' : 'off';
    this.#scheduleRetry();
  }

  /** Take the server back from another tab. */
  useThisTab() {
    if (this.#accessKey) void this.connect(this.#accessKey);
  }

  /** Another tab announced that it holds the server connection. */
  heldElsewhere(accessKey: string) {
    if (this.status === 'connected' || this.status === 'connecting') return;
    this.#accessKey = accessKey;
    this.#wanted = false;
    if (this.#retry) clearTimeout(this.#retry);
    this.status = 'elsewhere';
    this.error = 'Claude Code is connected to this app in another browser tab.';
  }

  async #call(ws: WebSocket, id: number, tool: string, input: unknown) {
    this.calls++;
    let reply: TabToServer;
    try {
      const r = await this.#handler!(tool, input);
      reply = { type: 'result', id, ...r };
    } catch (e) {
      reply = { type: 'result', id, isError: true, content: [{ type: 'text', text: `App error: ${(e as Error).message}` }] };
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
  }
}

export const server = new ServerClient();
