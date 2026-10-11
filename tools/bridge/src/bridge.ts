/**
 * The relay core: an HTTP + WebSocket server on 127.0.0.1. One browser tab of the app connects over
 * the WebSocket; tool calls (from stdio MCP or the HTTP /mcp endpoint) are forwarded to the tab,
 * which executes them against its kernel. Chat messages from the tab go to a chat handler.
 *
 * It also serves the built app itself, so the page and the bridge share an origin on this computer.
 *
 * Security: binds to loopback only, accepts WebSocket connections only from the app's own pages
 * (localhost on the bridge ports, the app's address, the dev server), and requires the access key
 * (token) from the app's address before anything is forwarded.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { tokenMatches } from './mcp.ts';
import {
  BRIDGE_PORTS,
  BRIDGE_PROTOCOL,
  type BridgeContent,
  type BridgeToTab,
  type ChatCapability,
  type TabToBridge,
} from '@tracewise/schema';

export interface CallResult {
  isError: boolean;
  content: BridgeContent[];
}

export interface BridgeOptions {
  token: string;
  ports?: readonly number[];
  host?: string;
  callTimeoutMs?: number;
  /** Where the app runs, for the app link; default: the app this bridge serves. */
  appUrl?: string;
  /** More localhost ports whose pages may connect (the dev server of a checkout). */
  devPorts?: readonly number[];
  log?: (msg: string) => void;
}

export type HttpHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
export type ChatMessage = Extract<TabToBridge, { type: 'chat' | 'ingest' | 'chat_cancel' }>;

interface Pending {
  resolve: (r: CallResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?$/;

export class Bridge {
  readonly token: string;
  #opts: BridgeOptions;
  #http: HttpServer | null = null;
  #wss: WebSocketServer | null = null;
  #tab: WebSocket | null = null;
  #httpHandler: HttpHandler | null = null;
  #chatHandler: ((msg: ChatMessage) => void) | null = null;
  #chat: ChatCapability = { available: false, reason: 'chat not enabled' };
  #pending = new Map<number, Pending>();
  #seq = 0;
  #agent: string | null = null;
  port: number | null = null;

  constructor(opts: BridgeOptions) {
    this.#opts = opts;
    this.token = opts.token;
  }

  get connected(): boolean {
    return this.#tab !== null;
  }

  #log(msg: string) {
    this.#opts.log?.(msg);
  }

  /** Listen on the first free port of the range (HTTP and WebSocket share it). */
  async start(): Promise<number> {
    const ports = this.#opts.ports ?? BRIDGE_PORTS;
    for (const port of ports) {
      try {
        this.#http = await listen(port, this.#opts.host ?? '127.0.0.1', (req, res) => this.#onHttp(req, res));
        this.port = port;
        this.#wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
        this.#wss.on('connection', (ws, req) => this.#onConnection(ws, req));
        this.#http.on('upgrade', (req, socket, head) => this.#wss!.handleUpgrade(req, socket, head, (ws) => this.#wss!.emit('connection', ws, req)));
        return port;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
      }
    }
    throw new Error(`All bridge ports are in use (${ports.join(', ')}). Is another Claude Code session already running the bridge?`);
  }

  /** Serve HTTP requests (the app, and the /mcp endpoint for the headless Claude Code). */
  setHttpHandler(h: HttpHandler) {
    this.#httpHandler = h;
  }

  /** Receive chat messages from the connected tab. */
  setChatHandler(h: (msg: ChatMessage) => void, capability: ChatCapability) {
    this.#chatHandler = h;
    this.#chat = capability;
  }

  get chatCapability(): ChatCapability {
    return this.#chat;
  }

  /** Send a message to the connected tab (no-op when none is connected). */
  sendToTab(msg: BridgeToTab) {
    this.#send(msg);
  }

  #onHttp(req: IncomingMessage, res: ServerResponse) {
    if (this.#httpHandler) {
      void Promise.resolve(this.#httpHandler(req, res)).catch((e) => {
        this.#log(`http error: ${(e as Error).message}`);
        if (!res.headersSent) res.writeHead(500).end();
      });
      return;
    }
    res.writeHead(404).end();
  }

  async stop(): Promise<void> {
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.resolve(errorResult('Bridge is shutting down.'));
    }
    this.#pending.clear();
    this.#tab?.close(1001, 'bridge stopped');
    this.#wss?.close();
    await new Promise<void>((resolve) => (this.#http ? this.#http.close(() => resolve()) : resolve()));
    this.#http?.closeAllConnections();
  }

  setAgent(name: string | null) {
    this.#agent = name;
    this.#send({ type: 'agent', name });
  }

  /** Point app links at another address of the app (the dev server, or another bridge's port). */
  setAppUrl(url: string | undefined) {
    this.#opts.appUrl = url;
  }

  /**
   * Opens the app connected to this bridge: the token in the path is the access key. When the app is
   * served elsewhere (another bridge, the dev server), `?bridge=` makes the tab try this port first.
   */
  appLink(): string {
    const base = (this.#opts.appUrl ?? `http://localhost:${this.port}`).replace(/\/$/, '');
    const elsewhere = new URL(base).port !== String(this.port);
    return `${base}/${this.token}${elsewhere ? `?bridge=${this.port}` : ''}`;
  }

  /** Pages of the app: localhost on the bridge ports, on the app's address or on the dev server. */
  #allowedOrigin(origin: string): boolean {
    const m = LOCAL_ORIGIN.exec(origin);
    if (!m) return false;
    const port = Number(m[2] ?? (origin.startsWith('https:') ? 443 : 80));
    const app = this.#opts.appUrl ? Number(new URL(this.#opts.appUrl).port || 80) : null;
    return port === this.port || port === app || (BRIDGE_PORTS as readonly number[]).includes(port) || !!this.#opts.devPorts?.includes(port);
  }

  status() {
    return { port: this.port, connected: this.connected, agent: this.#agent };
  }

  /** Forward a tool call to the tab and wait for its result. */
  call(tool: string, input: unknown): Promise<CallResult> {
    if (!this.#tab) {
      return Promise.resolve(
        errorResult(
          `The Tracewise app is not connected to this bridge. Give the user this link to open (it connects the app): ${this.appLink()}`,
        ),
      );
    }
    const id = ++this.#seq;
    const waitS = tool === 'wait_for_review' ? Number((input as { timeout_s?: number })?.timeout_s ?? 120) : tool === 'import_part' ? Number((input as { timeout_s?: number })?.timeout_s ?? 420) : 0;
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
    if (!this.#allowedOrigin(origin)) {
      this.#log(`rejected connection from origin "${origin}"`);
      ws.close(1008, 'origin not allowed');
      return;
    }
    let accepted = false;
    const helloTimer = setTimeout(() => !accepted && ws.close(1008, 'no hello'), 5000);

    ws.on('message', (raw) => {
      let msg: TabToBridge;
      try {
        msg = JSON.parse(String(raw)) as TabToBridge;
      } catch {
        return;
      }
      if (!accepted) {
        if (msg.type !== 'hello') return;
        clearTimeout(helloTimer);
        if (msg.protocol !== BRIDGE_PROTOCOL) {
          ws.send(JSON.stringify({ type: 'denied', reason: `protocol ${msg.protocol} not supported (bridge speaks ${BRIDGE_PROTOCOL})` } satisfies BridgeToTab));
          ws.close(1008, 'protocol');
          return;
        }
        if (typeof msg.token !== 'string' || !tokenMatches(msg.token, this.token)) {
          ws.send(JSON.stringify({ type: 'denied', reason: 'wrong access key' } satisfies BridgeToTab));
          ws.close(1008, 'wrong token');
          this.#log(`rejected tab: wrong access key (origin ${origin})`);
          return;
        }
        accepted = true;
        if (this.#tab && this.#tab !== ws) this.#tab.close(4000, 'replaced by another tab');
        this.#tab = ws;
        ws.send(JSON.stringify({ type: 'welcome', protocol: BRIDGE_PROTOCOL, agent: this.#agent ?? 'Claude Code', chat: this.#chat } satisfies BridgeToTab));
        const i = msg.info;
        this.#log(
          `tab connected (${msg.client}, origin ${origin})` +
            (i ? ` · build ${i.build} · provider ${i.provider} · storage ${i.storage} · ${browserName(i.userAgent)}` : ' · old app build (reload the tab)'),
        );
        return;
      }
      if (msg.type === 'chat' || msg.type === 'ingest' || msg.type === 'chat_cancel') {
        if (this.#chatHandler) this.#chatHandler(msg);
        else if (msg.type !== 'chat_cancel') this.#send({ type: 'chat_event', id: msg.id, event: { kind: 'done', ok: false, error: this.#chat.reason ?? 'Chat is not available on this bridge.' } });
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

function browserName(ua: string): string {
  const m = /(Edg|OPR|Chrome|Firefox|Version)\/([\d.]+)/.exec(ua);
  const name = m ? (m[1] === 'Version' ? (/Safari/.test(ua) ? 'Safari/WebKit' : 'WebKit') : m[1] === 'Edg' ? 'Edge' : m[1]) : 'unknown browser';
  return `${name}${m ? ` ${m[2]!.split('.')[0]}` : ''}${/Electron|Code\//.test(ua) ? ' (VS Code/Electron)' : ''}`;
}

function errorResult(text: string): CallResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

function listen(port: number, host: string, handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<HttpServer> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once('listening', () => resolve(server));
    server.once('error', (e) => {
      server.close();
      reject(e);
    });
    server.listen(port, host);
  });
}
