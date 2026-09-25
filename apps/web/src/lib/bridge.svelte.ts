/**
 * Browser side of the Claude Code bridge (tools/bridge). Connects to the local relay over a
 * WebSocket, pairs with the code, and executes forwarded tool calls against the kernel.
 */
import { BRIDGE_PORTS, BRIDGE_PROTOCOL, type BridgeContent, type BridgeToTab, type TabToBridge } from '@tracewise/schema';

export type BridgeStatus = 'off' | 'connecting' | 'connected' | 'waiting';

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

  #ws: WebSocket | null = null;
  #code = '';
  #handler: BridgeHandler | null = null;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #onPaired: ((code: string, port: number) => void) | null = null;
  #onLost: (() => void) | null = null;
  #wanted = false;

  init(handler: BridgeHandler, onPaired: (code: string, port: number) => void, onLost?: () => void) {
    this.#handler = handler;
    this.#onPaired = onPaired;
    this.#onLost = onLost ?? null;
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
    else if (!opts.silent) this.error = 'No bridge found. Is Claude Code running with the tracewise MCP server?';
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
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', protocol: BRIDGE_PROTOCOL, code: this.#code, client: 'tracewise-web' } satisfies TabToBridge));
      ws.onerror = () => done(false);
      ws.onclose = () => {
        if (!settled) done(false);
        else if (this.#ws === ws) this.#lost();
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data)) as BridgeToTab;
        if (msg.type === 'denied') return done(msg.reason);
        if (msg.type === 'welcome') {
          this.#ws?.close();
          this.#ws = ws;
          this.port = port;
          this.agent = msg.agent;
          this.status = 'connected';
          this.error = null;
          this.#onPaired?.(this.#code, port);
          done(true);
          return;
        }
        if (msg.type === 'agent') this.agent = msg.name;
        if (msg.type === 'call') void this.#call(ws, msg.id, msg.tool, msg.input);
      };
    });
  }

  #lost() {
    this.#onLost?.();
    this.#ws = null;
    this.agent = null;
    this.status = this.#wanted ? 'waiting' : 'off';
    this.#scheduleRetry();
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
