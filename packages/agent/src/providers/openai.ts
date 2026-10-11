/**
 * Any OpenAI-compatible Chat Completions API (OpenAI, OpenRouter, Google Gemini, Ollama, LM Studio,
 * vLLM, Azure OpenAI v1, company gateways such as LiteLLM), called directly from the browser with
 * the user's own key. Plain fetch + server-sent events, so it needs no SDK.
 */
import type { Block, Message, Provider, StepRequest, StepResult, StopReason, Usage } from '../types.ts';

export interface OpenAICompatOptions {
  /** Up to and including the version, e.g. https://api.openai.com/v1 (…/chat/completions is added). */
  baseURL: string;
  /** Empty for local servers that need none (Ollama, LM Studio). */
  apiKey: string;
  model: string;
  /** Shown in the chat header; the model id by default. */
  label?: string;
}

/** An assistant turn as this API takes it back (kept as the message's `raw`). */
interface ApiAssistant {
  role: 'assistant';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
}

type ApiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[] }
  | ApiAssistant
  | { role: 'tool'; tool_call_id: string; content: string };

/** One streamed chunk (the fields this provider reads). */
interface Chunk {
  model?: string;
  choices?: {
    delta?: {
      content?: string | null;
      /** DeepSeek, vLLM, LM Studio; OpenRouter calls it `reasoning`. */
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null } | null;
  error?: { message?: string };
}

export class OpenAICompatProvider implements Provider {
  readonly id = 'openai-compat';
  readonly label: string;
  private opts: OpenAICompatOptions;

  constructor(opts: OpenAICompatOptions) {
    this.opts = opts;
    this.label = opts.label ?? opts.model;
  }

  async step(req: StepRequest): Promise<StepResult> {
    const url = `${trimSlash(this.opts.baseURL)}/chat/completions`;
    const body = {
      model: this.opts.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: toApi(req.system, req.messages),
      tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    };
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers: headers(this.opts.apiKey), body: JSON.stringify(body), ...(req.signal ? { signal: req.signal } : {}) });
    } catch (e) {
      if (req.signal?.aborted) throw e;
      throw new Error(unreachable(this.opts.baseURL, e));
    }
    if (!res.ok || !res.body) throw new Error(await apiError(res));

    let text = '';
    let finish: string | null = null;
    let model: string | undefined;
    let usage: Usage | undefined;
    const calls: { id: string; name: string; args: string }[] = [];

    for await (const data of sse(res.body)) {
      if (data === '[DONE]') break;
      let c: Chunk;
      try {
        c = JSON.parse(data) as Chunk;
      } catch {
        continue;
      }
      if (c.error) throw new Error(c.error.message ?? 'The API reported an error.');
      if (c.model) model = c.model;
      if (c.usage) {
        const cached = c.usage.prompt_tokens_details?.cached_tokens ?? 0;
        usage = { input: Math.max(0, (c.usage.prompt_tokens ?? 0) - cached), output: c.usage.completion_tokens ?? 0, cacheRead: cached, cacheWrite: 0 };
      }
      const choice = c.choices?.[0];
      if (!choice) continue;
      const d = choice.delta ?? {};
      if (d.content) {
        text += d.content;
        req.onText?.(d.content);
      }
      const thought = d.reasoning_content ?? d.reasoning;
      if (thought) req.onThinking?.(thought);
      for (const tc of d.tool_calls ?? []) {
        const i = tc.index ?? calls.length;
        const call = (calls[i] ??= { id: '', name: '', args: '' });
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.name += tc.function.name;
        if (tc.function?.arguments) call.args += tc.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    // some APIs leave ids out; the history needs one to pair each call with its result
    const used = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${Date.now().toString(36)}_${i}` }));
    const content: Block[] = [];
    if (text) content.push({ type: 'text', text });
    for (const c of used) content.push({ type: 'tool_use', id: c.id, name: c.name, input: parseArgs(c.args) });
    const raw: ApiAssistant = {
      role: 'assistant',
      content: text || null,
      ...(used.length ? { tool_calls: used.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.args || '{}' } })) } : {}),
    };
    return { content, raw: { openai: raw }, stop: mapStop(finish, used.length > 0), ...(usage ? { usage } : {}), ...(model ? { model } : {}) };
  }
}

/** The models the API offers (GET /models), sorted; throws with a readable message. */
export async function listOpenAIModels(baseURL: string, apiKey: string, signal?: AbortSignal): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(`${trimSlash(baseURL)}/models`, { headers: headers(apiKey), ...(signal ? { signal } : {}) });
  } catch (e) {
    throw new Error(unreachable(baseURL, e));
  }
  if (!res.ok) throw new Error(await apiError(res));
  const json = (await res.json()) as { data?: { id?: string }[]; models?: { name?: string }[] };
  const ids = (json.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
  return [...new Set(ids)].sort();
}

function headers(apiKey: string): Record<string, string> {
  return { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
}

function trimSlash(u: string): string {
  return u.trim().replace(/\/+$/, '');
}

function unreachable(baseURL: string, e: unknown): string {
  return `Could not reach ${trimSlash(baseURL)} (${(e as Error).message}). Check the address; a service that does not allow requests from a browser (CORS) cannot be used directly from the app.`;
}

async function apiError(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  let msg = body.trim().slice(0, 500);
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    msg = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? msg;
  } catch {
    // not JSON: the text itself
  }
  return `API error ${res.status}${msg ? `: ${msg}` : ''}`;
}

/** The `data:` payloads of a server-sent event stream. */
async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
  buf += decoder.decode();
  if (buf.startsWith('data:')) yield buf.slice(5).trim();
}

function parseArgs(args: string): unknown {
  if (!args.trim()) return {};
  try {
    return JSON.parse(args);
  } catch {
    return args; // the tool's validation explains what is wrong with it
  }
}

function mapStop(s: string | null, toolCalls: boolean): StopReason {
  // Gemini and some local servers say "stop" even when they called tools
  if (toolCalls && s !== 'length') return 'tool_use';
  switch (s) {
    case 'stop':
    case 'end_turn':
    case null:
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

/**
 * Assistant turns are replayed from `raw` when it came from this API; other turns (and turns of
 * another provider, after the user switched) are built from the blocks. Tool results become
 * `tool` messages; their pictures follow in a user message, as tool messages carry text only.
 */
function toApi(system: string, messages: Message[]): ApiMessage[] {
  const out: ApiMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const raw = (m.raw as { openai?: ApiAssistant } | undefined)?.openai;
      if (raw) {
        out.push(raw);
        continue;
      }
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const uses = m.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
      out.push({
        role: 'assistant',
        content: text || null,
        ...(uses.length ? { tool_calls: uses.map((u) => ({ id: u.id, type: 'function' as const, function: { name: u.name, arguments: JSON.stringify(u.input ?? {}) } })) } : {}),
      });
      continue;
    }
    const images: { type: 'image_url'; image_url: { url: string } }[] = [];
    const texts: string[] = [];
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `Error: ${b.content}` : b.content });
        for (const i of b.images ?? []) images.push({ type: 'image_url', image_url: { url: `data:${i.mimeType};base64,${i.data}` } });
      } else if (b.type === 'text') texts.push(b.text);
    }
    if (images.length) out.push({ role: 'user', content: [{ type: 'text', text: 'Images returned by the tool calls above:' }, ...images] });
    if (texts.length) out.push({ role: 'user', content: texts.join('\n\n') });
  }
  return out;
}
