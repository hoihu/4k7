/**
 * The relay core: an HTTP + WebSocket server on 127.0.0.1. One paired browser tab connects over
 * the WebSocket; tool calls (from stdio MCP or the HTTP /mcp endpoint) are forwarded to the tab,
 * which executes them against its kernel. Chat messages from the tab go to a chat handler.
 *
 * Security: binds to loopback only, accepts only local http(s) origins on the WebSocket (so
 * arbitrary websites cannot connect), and requires the pairing code before anything is forwarded.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
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
  code: string;
  ports?: readonly number[];
  host?: string;
  /** Extra allowed page origins besides localhost / 127.0.0.1 (e.g. a deployed app URL). */
  origins?: string[];
  callTimeoutMs?: number;
  /** Where the app runs; used to give the user a one-click pairing link. */
  appUrl?: string;
  log?: (msg: string) => void;
}

export type HttpHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
export type ChatMessage = Extract<TabToBridge, { type: 'chat' | 'ingest' | 'chat_cancel' }>;

interface Pending {
  resolve: (r: CallResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** An allowed origin, exact or "https://*.example.dev" for its subdomains (one level, https only). */
export function originMatches(allowed: string, origin: string): boolean {
  if (allowed === origin) return true;
  const m = /^https:\/\/\*\.(.+)$/.exec(allowed);
  if (!m) return false;
  const host = /^https:\/\/([a-z0-9-]+)\.(.+)$/i.exec(origin);
  return !!host && host[2]!.toLowerCase() === m[1]!.toLowerCase();
}

export class Bridge {
  readonly code: string;
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
    this.code = opts.code;
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

  /** Serve HTTP requests (the /mcp endpoint for the headless Claude Code). */
  setHttpHandler(h: HttpHandler) {
    this.#httpHandler = h;
  }

  /** Receive chat messages from the paired tab. */
  setChatHandler(h: (msg: ChatMessage) => void, capability: ChatCapability) {
    this.#chatHandler = h;
    this.#chat = capability;
  }

  get chatCapability(): ChatCapability {
    return this.#chat;
  }

  /** Send a message to the paired tab (no-op when none is connected). */
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

  pairingLink(): string {
    return `${(this.#opts.appUrl ?? 'http://localhost:5173').replace(/\/$/, '')}/#pair=${this.code}`;
  }

  status() {
    return { port: this.port, connected: this.connected, code: this.code, agent: this.#agent };
  }

  /** Forward a tool call to the tab and wait for its result. */
  call(tool: string, input: unknown): Promise<CallResult> {
    if (!this.#tab) {
      return Promise.resolve(
        errorResult(
          `The Tracewise app is not connected to this bridge. Give the user this link to open (it pairs the app in one click): ` +
            `${this.pairingLink()}\n` +
            `Alternatively they can enter pairing code ${this.code} under Settings → Claude Code bridge in the app (bridge on port ${this.port}).`,
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
    const allowed = LOCAL_ORIGIN.test(origin) || (this.#opts.origins ?? []).some((o) => originMatches(o, origin));
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
        ws.send(JSON.stringify({ type: 'welcome', protocol: BRIDGE_PROTOCOL, agent: this.#agent ?? 'Claude Code', chat: this.#chat } satisfies BridgeToTab));
        const i = msg.info;
        this.#log(
          `tab paired (${msg.client}, origin ${origin})` +
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
