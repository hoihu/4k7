/**
 * The relay core: a WebSocket server on 127.0.0.1 that one paired browser tab connects to.
 * Tool calls from the MCP side are forwarded to the tab, which executes them against its kernel.
 *
 * Security: binds to loopback only, accepts only local http(s) origins (so arbitrary websites
 * cannot connect), and requires the pairing code before any call is forwarded.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { BRIDGE_PORTS, BRIDGE_PROTOCOL, type BridgeContent, type BridgeToTab, type TabToBridge } from '@tracewise/schema';

export interface CallResult {
  isError: boolean;
  content: BridgeContent[];
}

export interface BridgeOptions {
  code: string;
  ports?: readonly number[];
  host?: string;
  /** Extra allowed page origins besides localhost / 127.0.0.1 (e.g. a deployed app URL). */
  origins?: string[];
  callTimeoutMs?: number;
  log?: (msg: string) => void;
}

interface Pending {
  resolve: (r: CallResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export class Bridge {
  readonly code: string;
  #opts: BridgeOptions;
  #wss: WebSocketServer | null = null;
  #tab: WebSocket | null = null;
  #pending = new Map<number, Pending>();
  #seq = 0;
  #agent: string | null = null;
  port: number | null = null;

  constructor(opts: BridgeOptions) {
    this.#opts = opts;
    this.code = opts.code;
  }

  get connected(): boolean {
    return this.#tab !== null;
  }

  #log(msg: string) {
    this.#opts.log?.(msg);
  }

  /** Listen on the first free port of the range. */
  async start(): Promise<number> {
    const ports = this.#opts.ports ?? BRIDGE_PORTS;
    for (const port of ports) {
      try {
        this.#wss = await listen(port, this.#opts.host ?? '127.0.0.1');
        this.port = port;
        this.#wss.on('connection', (ws, req) => this.#onConnection(ws, req));
        return port;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
      }
    }
    throw new Error(`All bridge ports are in use (${ports.join(', ')}). Is another Claude Code session already running the bridge?`);
  }

  async stop(): Promise<void> {
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.resolve(errorResult('Bridge is shutting down.'));
    }
    this.#pending.clear();
    this.#tab?.close(1001, 'bridge stopped');
    await new Promise<void>((resolve) => (this.#wss ? this.#wss.close(() => resolve()) : resolve()));
  }

  setAgent(name: string | null) {
    this.#agent = name;
    this.#send({ type: 'agent', name });
  }

  status() {
    return { port: this.port, connected: this.connected, code: this.code, agent: this.#agent };
  }

  /** Forward a tool call to the tab and wait for its result. */
  call(tool: string, input: unknown): Promise<CallResult> {
    if (!this.#tab) {
      return Promise.resolve(
        errorResult(
          `The Tracewise app is not connected to this bridge. Ask the user to open the app, go to Settings → Claude Code bridge, ` +
            `and enter pairing code ${this.code} (bridge on port ${this.port}).`,
        ),
      );
    }
    const id = ++this.#seq;
    const waitS = tool === 'wait_for_review' ? Number((input as { timeout_s?: number })?.timeout_s ?? 120) : 0;
    const timeoutMs = Math.max(this.#opts.callTimeoutMs ?? 60_000, (waitS + 15) * 1000);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve(errorResult(`The app did not answer ${tool} within ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, timer });
      this.#send({ type: 'call', id, tool, input });
    });
  }

  #send(msg: BridgeToTab) {
    if (this.#tab?.readyState === 1) this.#tab.send(JSON.stringify(msg));
  }

  #onConnection(ws: WebSocket, req: IncomingMessage) {
    const origin = req.headers.origin ?? '';
    const allowed = LOCAL_ORIGIN.test(origin) || (this.#opts.origins ?? []).includes(origin);
    if (!allowed) {
      this.#log(`rejected connection from origin "${origin}"`);
      ws.close(1008, 'origin not allowed');
      return;
    }
    let paired = false;
    const helloTimer = setTimeout(() => !paired && ws.close(1008, 'no hello'), 5000);

    ws.on('message', (raw) => {
      let msg: TabToBridge;
      try {
        msg = JSON.parse(String(raw)) as TabToBridge;
      } catch {
        return;
      }
      if (!paired) {
        if (msg.type !== 'hello') return;
        clearTimeout(helloTimer);
        if (msg.protocol !== BRIDGE_PROTOCOL) {
          ws.send(JSON.stringify({ type: 'denied', reason: `protocol ${msg.protocol} not supported (bridge speaks ${BRIDGE_PROTOCOL})` } satisfies BridgeToTab));
          ws.close(1008, 'protocol');
          return;
        }
        if (msg.code !== this.code) {
          ws.send(JSON.stringify({ type: 'denied', reason: 'wrong pairing code' } satisfies BridgeToTab));
          ws.close(1008, 'wrong code');
          this.#log('rejected tab: wrong pairing code');
          return;
        }
        paired = true;
        if (this.#tab && this.#tab !== ws) this.#tab.close(4000, 'replaced by another tab');
        this.#tab = ws;
        ws.send(JSON.stringify({ type: 'welcome', protocol: BRIDGE_PROTOCOL, agent: this.#agent ?? 'mcp client' } satisfies BridgeToTab));
        this.#log(`tab paired (${msg.client}, origin ${origin})`);
        return;
      }
      if (msg.type === 'result') {
        const p = this.#pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.#pending.delete(msg.id);
        p.resolve({ isError: msg.isError, content: msg.content });
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (this.#tab !== ws) return;
      this.#tab = null;
      this.#log('tab disconnected');
      for (const [id, p] of this.#pending) {
        clearTimeout(p.timer);
        p.resolve(errorResult('The app disconnected before answering.'));
        this.#pending.delete(id);
      }
    });
  }
}

function errorResult(text: string): CallResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

function listen(port: number, host: string): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port, host, maxPayload: 32 * 1024 * 1024 });
    wss.once('listening', () => resolve(wss));
    wss.once('error', (e) => {
      wss.close();
      reject(e);
    });
  });
}
