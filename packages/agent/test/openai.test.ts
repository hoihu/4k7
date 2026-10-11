import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatProvider, listOpenAIModels, type Message } from '../src/index.ts';

const tools = [{ name: 'design_query', description: 'Query the design', input_schema: { type: 'object', properties: { op: { type: 'string' } } } }];

/** A fetch that answers with these SSE chunks and records the requests. */
function mockFetch(chunks: unknown[], status = 200) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    if (status !== 200) return new Response(JSON.stringify({ error: { message: 'bad key' } }), { status });
    const text = chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('');
    // split mid-line to check the stream is reassembled
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(ctl) {
        ctl.enqueue(bytes.slice(0, 37));
        ctl.enqueue(bytes.slice(37));
        ctl.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  vi.stubGlobal('fetch', fn);
  return requests;
}

afterEach(() => vi.unstubAllGlobals());

describe('OpenAI-compatible provider', () => {
  it('streams text, reasoning and tool calls, and reports usage', async () => {
    const requests = mockFetch([
      { model: 'gpt-test', choices: [{ delta: { reasoning_content: 'thinking…' } }] },
      { choices: [{ delta: { content: 'Let me ' } }] },
      { choices: [{ delta: { content: 'look.' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'design_query', arguments: '{"op":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"get_summary"}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } } },
      '[DONE]',
    ]);
    const p = new OpenAICompatProvider({ baseURL: 'https://api.example.com/v1/', apiKey: 'sk-x', model: 'gpt-test' });
    const texts: string[] = [];
    const thoughts: string[] = [];
    const r = await p.step({ system: 'SYS', tools, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], onText: (t) => texts.push(t), onThinking: (t) => thoughts.push(t) });

    expect(requests[0]!.url).toBe('https://api.example.com/v1/chat/completions');
    expect((requests[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer sk-x');
    const body = JSON.parse(String(requests[0]!.init.body));
    expect(body).toMatchObject({ model: 'gpt-test', stream: true, messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }] });
    expect(body.tools[0]).toEqual({ type: 'function', function: { name: 'design_query', description: 'Query the design', parameters: tools[0]!.input_schema } });

    expect(texts.join('')).toBe('Let me look.');
    expect(thoughts).toEqual(['thinking…']);
    expect(r.stop).toBe('tool_use');
    expect(r.content).toEqual([
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', id: 'call_1', name: 'design_query', input: { op: 'get_summary' } },
    ]);
    expect(r.usage).toEqual({ input: 200, output: 50, cacheRead: 800, cacheWrite: 0 });
    expect(r.model).toBe('gpt-test');
  });

  it('sends the history back: assistant turns as given, tool results as tool messages, pictures after them', async () => {
    const first = mockFetch([{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'design_query', arguments: '{}' } }] }, finish_reason: 'stop' }] }]);
    const p = new OpenAICompatProvider({ baseURL: 'http://localhost:11434/v1', apiKey: '', model: 'llama' });
    const r = await p.step({ system: 'SYS', tools, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
    // "stop" with a tool call (Gemini, Ollama) still runs the tool; a missing id is made up
    expect(r.stop).toBe('tool_use');
    const use = r.content[0] as { type: 'tool_use'; id: string };
    expect(use.id).toMatch(/^call_/);
    expect((first[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();

    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: r.content, raw: r.raw },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: 'a picture', images: [{ data: 'AAAA', mimeType: 'image/png' }] }] },
      // a turn of another provider (no OpenAI raw): rebuilt from the blocks
      { role: 'assistant', content: [{ type: 'thinking', text: 'x' }, { type: 'text', text: 'Done.' }], raw: [{ type: 'text', text: 'Done.' }] },
      { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
    ];
    const second = mockFetch([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
    const r2 = await p.step({ system: 'SYS', tools, messages: history });
    expect(r2.stop).toBe('end_turn');
    expect(JSON.parse(String(second[0]!.init.body)).messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: use.id, type: 'function', function: { name: 'design_query', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: use.id, content: 'a picture' },
      { role: 'user', content: [{ type: 'text', text: 'Images returned by the tool calls above:' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: 'thanks' },
    ]);
  });

  it('turns API errors into readable messages', async () => {
    mockFetch([], 401);
    const p = new OpenAICompatProvider({ baseURL: 'https://api.example.com/v1', apiKey: 'bad', model: 'm' });
    await expect(p.step({ system: '', tools, messages: [] })).rejects.toThrow('API error 401: bad key');
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(p.step({ system: '', tools, messages: [] })).rejects.toThrow(/Could not reach https:\/\/api.example.com\/v1 \(Failed to fetch\).*CORS/);
  });

  it('lists the models of the API', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      expect(url).toBe('https://openrouter.ai/api/v1/models');
      return new Response(JSON.stringify({ data: [{ id: 'z/model' }, { id: 'a/model' }, { id: 'a/model' }] }));
    });
    expect(await listOpenAIModels('https://openrouter.ai/api/v1', 'k')).toEqual(['a/model', 'z/model']);
  });
});
