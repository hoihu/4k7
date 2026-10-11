/**
 * Browser side of the local bridge to Claude Code (tools/bridge). Connects to the local relay over a
 * WebSocket, pairs with the code, and executes forwarded tool calls against the kernel.
 */
import {
  BRIDGE_PORTS,
  BRIDGE_PROTOCOL,
  type BridgeContent,
  type BridgeToTab,
  type ChatCapability,
  type ChatEvent,
  type TabInfo,
  type TabToBridge,
} from '@tracewise/schema';

/** 'elsewhere': another tab of the app took over the bridge; this tab stops retrying. */
export type BridgeStatus = 'off' | 'connecting' | 'connected' | 'waiting' | 'elsewhere';

/** Close code the bridge uses when a newer tab replaces this one. */
const REPLACED = 4000;

export interface BridgeHandler {
  (tool: string, input: unknown): Promise<{ isError: boolean; content: BridgeContent[] }>;
}

const RETRY_MS = 4000;

class BridgeClient {
  status = $state<BridgeStatus>('off');
  port = $state<number | null>(null);
  agent = $state<string | null>(null);
  error = $state<string | null>(null);
  calls = $state(0);
  /** Whether the bridge can answer the app's chat with the local Claude Code. */
  chat = $state<ChatCapability | null>(null);
  #chatListeners = new Map<string, (e: ChatEvent) => void>();

  #ws: WebSocket | null = null;
  #code = '';
  #handler: BridgeHandler | null = null;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #onPaired: ((code: string, port: number) => void) | null = null;
  #onLost: (() => void) | null = null;
  #wanted = false;

  #info: () => TabInfo = () => ({ origin: location.origin, build: '', userAgent: navigator.userAgent, provider: '', storage: '', persistent: null });

  init(handler: BridgeHandler, onPaired: (code: string, port: number) => void, onLost?: () => void, info?: () => TabInfo) {
    this.#handler = handler;
    this.#onPaired = onPaired;
    this.#onLost = onLost ?? null;
    if (info) this.#info = info;
  }

  /** Try the saved/entered code on every bridge port. `silent` = background reconnect. */
  async connect(code: string, opts: { silent?: boolean; preferPort?: number | null } = {}): Promise<boolean> {
    this.#code = code.trim();
    this.#wanted = true;
    if (this.#retry) clearTimeout(this.#retry);
    this.status = 'connecting';
    if (!opts.silent) this.error = null;
    const ports = opts.preferPort ? [opts.preferPort, ...BRIDGE_PORTS.filter((p) => p !== opts.preferPort)] : [...BRIDGE_PORTS];
    let denied: string | null = null;
    for (const port of ports) {
      const r = await this.#tryPort(port);
      if (r === true) return true;
      if (typeof r === 'string') denied = r;
    }
    if (denied && !opts.silent) this.error = denied === 'wrong pairing code' ? 'Wrong pairing code. Ask Claude Code for the current one.' : denied;
    else if (!opts.silent) this.error = `No bridge found. Is it running (${__BRIDGE_RUN__}, or Claude Code with the tracewise MCP server)?`;
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
    this.#retry = setTimeout(() => void this.connect(this.#code, { silent: true, preferPort: this.port }), RETRY_MS);
  }

  /** true = paired, string = denied reason, false = nothing there. */
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
        ws.send(JSON.stringify({ type: 'hello', protocol: BRIDGE_PROTOCOL, code: this.#code, client: 'tracewise-web', info: this.#info() } satisfies TabToBridge));
      ws.onerror = () => done(false);
      ws.onclose = (ev) => {
        if (!settled) done(false);
        else if (this.#ws === ws) this.#lost(ev.code);
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data)) as BridgeToTab;
        if (msg.type === 'denied') return done(msg.reason);
        if (msg.type === 'welcome') {
          this.#ws?.close();
          this.#ws = ws;
          this.port = port;
          this.agent = msg.agent;
          this.chat = msg.chat ?? null;
          this.status = 'connected';
          this.error = null;
          this.#onPaired?.(this.#code, port);
          done(true);
          return;
        }
        if (msg.type === 'agent') this.agent = msg.name;
        if (msg.type === 'call') void this.#call(ws, msg.id, msg.tool, msg.input);
        if (msg.type === 'chat_event') {
          this.#chatListeners.get(msg.id)?.(msg.event);
          if (msg.event.kind === 'done') this.#chatListeners.delete(msg.id);
        }
      };
    });
  }

  /** Send a chat message to the local Claude Code; events stream to `onEvent` until 'done'. */
  sendChat(msg: Omit<Extract<TabToBridge, { type: 'chat' }>, 'type'>, onEvent: (e: ChatEvent) => void): boolean {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return false;
    this.#chatListeners.set(msg.id, onEvent);
    this.#ws.send(JSON.stringify({ type: 'chat', ...msg } satisfies TabToBridge));
    return true;
  }

  /** Import a part from a datasheet with the local Claude Code; events stream like chat. */
  sendIngest(msg: Omit<Extract<TabToBridge, { type: 'ingest' }>, 'type'>, onEvent: (e: ChatEvent) => void): boolean {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return false;
    this.#chatListeners.set(msg.id, onEvent);
    this.#ws.send(JSON.stringify({ type: 'ingest', ...msg } satisfies TabToBridge));
    return true;
  }

  cancelChat(id: string) {
    this.#ws?.send(JSON.stringify({ type: 'chat_cancel', id } satisfies TabToBridge));
  }

  #lost(code?: number) {
    for (const [id, l] of this.#chatListeners) l({ kind: 'done', ok: false, error: 'The bridge disconnected.' });
    this.#chatListeners.clear();
    this.#onLost?.();
    this.#ws = null;
    this.agent = null;
    if (code === REPLACED) {
      // Another tab paired with the bridge. Retrying would kick it out again (ping-pong),
      // so this tab steps back until the user asks for it.
      this.#wanted = false;
      this.status = 'elsewhere';
      this.error = 'Claude Code is connected to this app in another browser tab.';
      return;
    }
    this.status = this.#wanted ? 'waiting' : 'off';
    this.#scheduleRetry();
  }

  /** Take the bridge back from another tab. */
  useThisTab() {
    if (this.#code) void this.connect(this.#code);
  }

  /** Another tab announced that it holds the bridge connection. */
  heldElsewhere(code: string) {
    if (this.status === 'connected' || this.status === 'connecting') return;
    this.#code = code;
    this.#wanted = false;
    if (this.#retry) clearTimeout(this.#retry);
    this.status = 'elsewhere';
    this.error = 'Claude Code is connected to this app in another browser tab.';
  }

  async #call(ws: WebSocket, id: number, tool: string, input: unknown) {
    this.calls++;
    let reply: TabToBridge;
    try {
      const r = await this.#handler!(tool, input);
      reply = { type: 'result', id, ...r };
    } catch (e) {
      reply = { type: 'result', id, isError: true, content: [{ type: 'text', text: `App error: ${(e as Error).message}` }] };
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
  }
}

export const bridge = new BridgeClient();
