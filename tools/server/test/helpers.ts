import WebSocket from 'ws';
import { SERVER_PROTOCOL, type ChatEvent, type ServerToTab } from '@4k7/schema';
import { LocalServer } from '../src/index.ts';

/**
 * What the chat tests (chat.test.ts, harness.test.ts) share: a local server on a free port and a tab
 * connected to it that answers tool calls and collects each chat's events. Each file builds its own
 * ChatRunner in between. Teardown goes on the file's `cleanups`, run in reverse after each test.
 */
export const KEY = '0cd22f19-30de-4d39-9287-ab0123456789';

type Cleanups = (() => unknown)[];
type Call = Extract<ServerToTab, { type: 'call' }>;

export async function startServer(cleanups: Cleanups) {
  const server = new LocalServer({ accessKey: KEY, ports: [0], devPorts: [5173] });
  const port = await server.start();
  cleanups.push(() => server.stop());
  return { server, port };
}

/** A tab on `port`: it says hello, answers every tool call with `answer`, and keeps the chat events by run id. */
export async function connectTab(port: number, cleanups: Cleanups, opts: { answer?: (m: Call) => string; onMessage?: (m: ServerToTab) => void } = {}) {
  const answer = opts.answer ?? (() => '<design_state>empty</design_state>');
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: 'http://localhost:5173' } });
  cleanups.push(() => ws.close());
  const calls: string[] = [];
  const events = new Map<string, ChatEvent[]>();
  const welcome = await new Promise<ServerToTab>((resolve) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: SERVER_PROTOCOL, accessKey: KEY, client: 'test' })));
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as ServerToTab;
      if (m.type === 'welcome') resolve(m);
      opts.onMessage?.(m);
      if (m.type === 'call') {
        calls.push(m.tool);
        ws.send(JSON.stringify({ type: 'result', id: m.id, isError: false, content: [{ type: 'text', text: answer(m) }] }));
      }
      if (m.type === 'chat_event') events.set(m.id, [...(events.get(m.id) ?? []), m.event]);
    });
  });
  return { ws, welcome, calls, events };
}

/** Sends `msg` from the tab and resolves with its run's events once one of them is `done`. */
export function runChat(ws: WebSocket, events: Map<string, ChatEvent[]>, msg: { id: string; [k: string]: unknown }): Promise<ChatEvent[]> {
  return new Promise<ChatEvent[]>((resolve) => {
    ws.send(JSON.stringify(msg));
    const t = setInterval(() => {
      if (events.get(msg.id)?.some((e) => e.kind === 'done')) {
        clearInterval(t);
        resolve(events.get(msg.id)!);
      }
    }, 20);
  });
}
