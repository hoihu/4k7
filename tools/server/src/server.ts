/**
 * The relay core: an HTTP + WebSocket server on 127.0.0.1. One browser tab of the app connects over
 * the WebSocket; tool calls (from stdio MCP or the HTTP /mcp endpoint) are forwarded to the tab,
 * which executes them against its kernel. Chat messages from the tab go to a chat handler.
 *
 * It also serves the built app itself, so the page and the server share an origin on this computer.
 *
 * Security: binds to loopback only, accepts WebSocket connections only from the app's own pages
 * (localhost on the server ports, the app's address, the dev server), and requires the access key
 * from the app's address before anything is forwarded.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { secretsMatch } from './mcp.ts';
import {
  SERVER_PORTS,
  SERVER_PROTOCOL,
  type ToolContent,
  type ServerToTab,
  type ChatCapability,
  type HarnessCapability,
  type TabToServer,
  type UpdateInfo,
} from '@4k7/schema';

export interface CallResult {
  isError: boolean;
  content: ToolContent[];
}

export interface LocalServerOptions {
  accessKey: string;
  ports?: readonly number[];
  host?: string;
  callTimeoutMs?: number;
  /** Where the app runs, for the app link; default: the app this server serves. */
  appUrl?: string;
  /** More localhost ports whose pages may connect (the dev server of a checkout). */
  devPorts?: readonly number[];
  /** Called when a tab connects (true) or the connected tab goes away (false). */
  onTab?: (connected: boolean) => void;
  /** How Claude Code starts this server, when the app cannot know from its build (the downloaded app). */
  mcpCommand?: string;
  log?: (msg: string) => void;
}

export type HttpHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
export type ChatMessage = Extract<TabToServer, { type: 'chat' | 'ingest' | 'chat_cancel' }>;
export type AgentsMessage = Extract<TabToServer, { type: 'agent_bin' | 'agents_detect' }>;

interface Pending {
  resolve: (r: CallResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?$/;

export class LocalServer {
  readonly accessKey: string;
  #opts: LocalServerOptions;
  #http: HttpServer | null = null;
  #wss: WebSocketServer | null = null;
  #tab: WebSocket | null = null;
  #httpHandler: HttpHandler | null = null;
  #chatHandler: ((msg: ChatMessage) => void) | null = null;
  #agentsHandler: ((msg: AgentsMessage) => void) | null = null;
  #chat: ChatCapability = { available: false, reason: 'chat not enabled' };
  #harnesses: HarnessCapability[] = [];
  #update: UpdateInfo | null = null;
  #pending = new Map<number, Pending>();
  #seq = 0;
  #agent: string | null = null;
  port: number | null = null;

  constructor(opts: LocalServerOptions) {
    this.#opts = opts;
    this.accessKey = opts.accessKey;
  }

  get connected(): boolean {
    return this.#tab !== null;
  }

  #log(msg: string) {
    this.#opts.log?.(msg);
  }

  /** Listen on the first free port of the range (HTTP and WebSocket share it). */
  async start(): Promise<number> {
    const ports = this.#opts.ports ?? SERVER_PORTS;
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
    throw new Error(`All server ports are in use (${ports.join(', ')}). Is another Claude Code session already running the server?`);
  }

  /** Serve HTTP requests (the app, and the /mcp endpoint for the headless Claude Code). */
  setHttpHandler(h: HttpHandler) {
    this.#httpHandler = h;
  }

  /** Receive chat messages from the connected tab. `capability`: Claude Code's; `harnesses`: every agent's. */
  setChatHandler(h: (msg: ChatMessage) => void, capability: ChatCapability, harnesses: HarnessCapability[] = []) {
    this.#chatHandler = h;
    this.#chat = capability;
    this.#harnesses = harnesses;
  }

  /** Receive the app's changes to the agents' programs (paths, looking for them again). */
  setAgentsHandler(h: (msg: AgentsMessage) => void) {
    this.#agentsHandler = h;
  }

  /** The agents' details changed (e.g. a model list arrived): told to the connected tab. */
  setHarnesses(harnesses: HarnessCapability[]) {
    this.#harnesses = harnesses;
    this.#send({ type: 'harnesses', harnesses });
  }

  get chatCapability(): ChatCapability {
    return this.#chat;
  }

  /** A newer release is available: told to the connected tab now and to every tab that connects later. */
  setUpdate(update: UpdateInfo) {
    this.#update = update;
    this.#send({ type: 'update', update });
  }

  /** Send a message to the connected tab (no-op when none is connected). */
  sendToTab(msg: ServerToTab) {
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
      p.resolve(errorResult('The 4k7 server is shutting down.'));
    }
    this.#pending.clear();
    this.#tab?.close(1001, 'server stopped');
    this.#wss?.close();
    await new Promise<void>((resolve) => (this.#http ? this.#http.close(() => resolve()) : resolve()));
    this.#http?.closeAllConnections();
  }

  setAgent(name: string | null) {
    this.#agent = name;
    this.#send({ type: 'agent', name });
  }

  /** Point app links at another address of the app (the dev server, or another server's port). */
  setAppUrl(url: string | undefined) {
    this.#opts.appUrl = url;
  }

  /**
   * Opens the app connected to this server: its path is the access key. When the app is
   * served elsewhere (another server, the dev server), `?port=` makes the tab try this port first.
   */
  appLink(): string {
    const base = (this.#opts.appUrl ?? `http://localhost:${this.port}`).replace(/\/$/, '');
    const elsewhere = new URL(base).port !== String(this.port);
    return `${base}/${this.accessKey}${elsewhere ? `?port=${this.port}` : ''}`;
  }

  /** Pages of the app: localhost on the server ports, on the app's address or on the dev server. */
  allowedOrigin(origin: string): boolean {
    const m = LOCAL_ORIGIN.exec(origin);
    if (!m) return false;
    const port = Number(m[2] ?? (origin.startsWith('https:') ? 443 : 80));
    const app = this.#opts.appUrl ? Number(new URL(this.#opts.appUrl).port || 80) : null;
    return port === this.port || port === app || (SERVER_PORTS as readonly number[]).includes(port) || !!this.#opts.devPorts?.includes(port);
  }

  status() {
    return { port: this.port, connected: this.connected, agent: this.#agent };
  }

  /** Forward a tool call to the tab and wait for its result. */
  call(tool: string, input: unknown): Promise<CallResult> {
    if (!this.#tab) {
      return Promise.resolve(
        errorResult(
          `The 4k7 app is not connected to this server. Give the user this link to open (it connects the app): ${this.appLink()}`,
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

  #send(msg: ServerToTab) {
    if (this.#tab?.readyState === 1) this.#tab.send(JSON.stringify(msg));
  }

  #onConnection(ws: WebSocket, req: IncomingMessage) {
    const origin = req.headers.origin ?? '';
    if (!this.allowedOrigin(origin)) {
      this.#log(`rejected connection from origin "${origin}"`);
      ws.close(1008, 'origin not allowed');
      return;
    }
    let accepted = false;
    const helloTimer = setTimeout(() => !accepted && ws.close(1008, 'no hello'), 5000);

    ws.on('message', (raw) => {
      let msg: TabToServer;
      try {
        msg = JSON.parse(String(raw)) as TabToServer;
      } catch {
        return;
      }
      if (!accepted) {
        if (msg.type !== 'hello') return;
        clearTimeout(helloTimer);
        if (msg.protocol !== SERVER_PROTOCOL) {
          ws.send(JSON.stringify({ type: 'denied', reason: `protocol ${msg.protocol} not supported (server speaks ${SERVER_PROTOCOL})` } satisfies ServerToTab));
          ws.close(1008, 'protocol');
          return;
        }
        if (typeof msg.accessKey !== 'string' || !secretsMatch(msg.accessKey, this.accessKey)) {
          ws.send(JSON.stringify({ type: 'denied', reason: 'wrong access key' } satisfies ServerToTab));
          ws.close(1008, 'wrong access key');
          this.#log(`rejected tab: wrong access key (origin ${origin})`);
          return;
        }
        accepted = true;
        const first = this.#tab === null;
        if (this.#tab && this.#tab !== ws) this.#tab.close(4000, 'replaced by another tab');
        this.#tab = ws;
        ws.send(
          JSON.stringify({
            type: 'welcome',
            protocol: SERVER_PROTOCOL,
            agent: this.#agent ?? 'Claude Code',
            chat: this.#chat,
            harnesses: this.#harnesses,
            ...(this.#update ? { update: this.#update } : {}),
            ...(this.#opts.mcpCommand ? { mcpCommand: this.#opts.mcpCommand } : {}),
          } satisfies ServerToTab),
        );
        if (first) this.#opts.onTab?.(true);
        const i = msg.info;
        this.#log(
          `tab connected (${msg.client}, origin ${origin})` +
            (i ? ` · build ${i.build} · provider ${i.provider} · storage ${i.storage} · ${browserName(i.userAgent)}` : ' · old app build (reload the tab)'),
        );
        return;
      }
      if (msg.type === 'chat' || msg.type === 'ingest' || msg.type === 'chat_cancel') {
        if (this.#chatHandler) this.#chatHandler(msg);
        else if (msg.type !== 'chat_cancel') this.#send({ type: 'chat_event', id: msg.id, event: { kind: 'done', ok: false, error: this.#chat.reason ?? 'Chat is not available on this server.' } });
        return;
      }
      if (msg.type === 'agent_bin' || msg.type === 'agents_detect') {
        if (this.#agentsHandler) this.#agentsHandler(msg);
        else if (msg.type === 'agent_bin') this.#send({ type: 'agent_bin_result', harness: msg.harness, ok: false, error: 'This server cannot change the agents.' });
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
      this.#opts.onTab?.(false);
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
    const http = createServer(handler);
    http.once('listening', () => resolve(http));
    http.once('error', (e) => {
      http.close();
      reject(e);
    });
    http.listen(port, host);
  });
}
