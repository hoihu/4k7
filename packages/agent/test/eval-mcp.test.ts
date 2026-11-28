import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { GuideTopic, PLAN_STEP_OFF, type Design } from '@4k7/schema';
import { runKernelTool } from '../src/tools.ts';
import { claudeResult, headlessCalls, startHeadless, type HeadlessServer } from '../eval/headless.ts';
import { countingKernel, type EvalTask } from '../eval/run.ts';
import { twoBoards } from '../../kernel/test/fixtures.ts';

const dir = new URL('../eval/tasks/', import.meta.url);
const load = <T>(name: string) => JSON.parse(readFileSync(new URL(name, dir), 'utf8')) as T;
const led = () => load<Design>('led.twd.json');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function connect(task: EvalTask, token?: string): Promise<{ h: HeadlessServer; client: Client }> {
  const h = await startHeadless(led(), task);
  cleanups.push(() => h.stop());
  const client = new Client({ name: 'eval-test', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(h.url), { requestInit: { headers: { authorization: `Bearer ${token ?? h.token}` } } });
  await client.connect(transport);
  cleanups.push(() => client.close());
  return { h, client };
}

const text = (r: unknown) => ((r as { content: { type: string; text?: string }[] }).content.find((c) => c.type === 'text')?.text ?? '');

const C1 = {
  summary: 'decouple',
  ops: [
    { op: 'add_part', part: 'generic:C', refdes: 'C1', params: { capacitance: '100nF' } },
    { op: 'connect', pins: ['C1.1'], net: '+3V3' },
  ],
};

describe('headless eval server (/mcp without a tab)', () => {
  it('lists the cli tools plus ask_user and answers as the tab path does', async () => {
    const task: EvalTask = { name: 't', prompt: 'p', expect: { parts: ['C1'] } };
    const { h, client } = await connect(task);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['get_context', 'design_query', 'design_edit', 'propose', 'wait_for_review', 'ask_user']));
    expect(names).not.toContain('view_attachment');

    // the tab runs the same executor against its kernel: the answers are the same
    const tab = countingKernel(led());
    const edit = await client.callTool({ name: 'design_edit', arguments: C1 });
    expect(edit.isError).toBe(false);
    expect(text(edit)).toBe((await runKernelTool(tab.port, 'design_edit', C1))!.content);
    const q = { op: 'get_diagnostics' };
    const erc = await client.callTool({ name: 'design_query', arguments: q });
    expect(text(erc)).toBe((await runKernelTool(tab.port, 'design_query', q))!.content);
    expect(JSON.parse(text(erc)).diagnostics.some((d: { code: string; severity: string }) => d.severity === 'error')).toBe(true); // C1.2 open

    expect(text(await client.callTool({ name: 'get_context', arguments: {} }))).toMatch(/C1=100nF[\s\S]*plan_step: off/);
    const refused = await client.callTool({ name: 'propose', arguments: { summary: 'Decouple J1' } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/^Refused: the design has \d+ open error/);

    await client.callTool({ name: 'design_edit', arguments: { summary: 'gnd', ops: [{ op: 'connect', pins: ['C1.2'], net: 'GND' }] } });
    expect((await client.callTool({ name: 'propose', arguments: { summary: 'Decouple J1' } })).isError).toBe(false);
    expect(h.score({ done: { reason: 'complete' }, turns: 4, tokensIn: 100, tokensOut: 20 })).toMatchObject({
      ok: true,
      erc_errors: 0,
      ops_applied: 3,
      ops_rejected: 0,
      turns: 4,
      tokens_in: 100,
      tokens_out: 20,
    });
  });

  it('serves every get_guide topic the schema has (boards too) through the kernel, from its design doc without the header', async () => {
    // the guides only read docs/design, not the design: one design is enough
    const { call } = headlessCalls(led(), { name: 't', prompt: 'p' });
    const out = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('');
    for (const topic of GuideTopic.options) {
      const r = await call('design_query', { op: 'get_guide', topic });
      expect(r.isError, topic).toBe(false);
      expect(out(r)).not.toMatch(/^#|^>/);
    }
    const boards = await call('design_query', { op: 'get_guide', topic: 'boards' });
    const doc = readFileSync(new URL('../../../docs/design/boards.md', import.meta.url), 'utf8');
    expect(out(boards)).toBe(doc.replace(/^#[^\n]*\n+(>[^\n]*\n)+\n*/, ''));
    const bad = await call('design_query', { op: 'get_guide', topic: 'nope' });
    expect(bad.isError).toBe(true);
    // the kernel's answer, as the app gives it: every guide there is
    expect(JSON.parse(out(bad))).toEqual({ error: `No guide "nope". Guides: ${GuideTopic.options.join(', ')}.`, guides: GuideTopic.options });
    expect(out(bad)).toContain('boards');
  });

  it('answers list_blocks through the kernel: there is no projects folder in the eval', async () => {
    const { call } = headlessCalls(led(), { name: 't', prompt: 'p' });
    const r = await call('design_query', { op: 'list_blocks', project: 'lamp' });
    expect(r.isError).toBe(true);
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({ error: 'No projects folder: the app is not connected to the 4k7 server.' });
  });

  it('refuses propose while a spec item is violated, on the second board too, unless spec_open names it or it is waived', async () => {
    // two boards joined by a cable; the LED board is to have one layer, which it has not (docs/design/spec.md §5)
    const { call } = headlessCalls(JSON.parse(twoBoards().exportDesign()) as Design, { name: 't', prompt: 'p' });
    const out = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('');
    const edit = await call('design_edit', { summary: 'spec', ops: [{ op: 'mate', a: 'J2', b: 'J3', kind: 'cable' }, { op: 'specify', text: 'a single-layer LED board', verify: [{ kind: 'measure', of: 'board.layers', board: 'LED board', max: 1 }] }] });
    expect(edit.isError, out(edit)).toBe(false);
    const id = (JSON.parse(out(await call('design_query', { op: 'get_spec' }))) as { items: { id: string; status: string }[] }).items[0]!;
    expect(id.status).toBe('violated');

    const refused = await call('propose', { summary: 'LED board' });
    expect(refused.isError).toBe(true);
    expect(out(refused), out(refused)).toMatch(/^Refused: 1 spec item\(s\) violated/);
    expect(out(refused)).toContain(`- ${id.id} "a single-layer LED board"`);
    expect((await call('propose', { summary: 'LED board', spec_open: ' ' })).isError).toBe(true);
    // named with the reason: proposed
    const named = await call('propose', { summary: 'LED board', spec_open: `${id.id}: the user decides on one layer once the LED board is placed` });
    expect(named.isError, out(named)).toBe(false);
    // waived: proposed without spec_open
    await call('design_edit', { summary: 'waive', ops: [{ op: 'add_waiver', code: 'SPEC.VIOLATED', entities: [id.id], reason: 'two layers are fine for now' }] });
    const waived = await call('propose', { summary: 'LED board' });
    expect(waived.isError, out(waived)).toBe(false);
  });

  it('refuses propose_plan with the app\'s plan-off text', async () => {
    const { call } = headlessCalls(led(), { name: 't', prompt: 'p' });
    const r = await call('propose_plan', { steps: ['add the regulator'] });
    expect(r.isError).toBe(true);
    expect(r.content[0]).toEqual({ type: 'text', text: `Refused: ${PLAN_STEP_OFF}` });
  });

  it('answers ask_user from the task, and an unanswered ask fails the run', async () => {
    const task: EvalTask = { name: 't', prompt: 'p', answers: [{ match: 'package', answer: '0603' }] };
    const { h, client } = await connect(task);
    const ask = (question: string) => client.callTool({ name: 'ask_user', arguments: { question, options: ['a', 'b'] } });
    expect(text(await ask('Which package for C1?'))).toBe('The user answered: 0603');
    const again = await ask('Which package for C2?');
    expect(again.isError).toBe(true);
    expect(h.unanswered).toEqual(['Which package for C2?']);
    const score = h.score({ done: { reason: 'complete' }, turns: 1, tokensIn: 0, tokensOut: 0 });
    expect(score.ok).toBe(false);
    expect(score.failures).toEqual(['the turn ended with question: no answer for "Which package for C2?"']);
  });

  it('refuses a request without the token', async () => {
    const h = await startHeadless(undefined, { name: 't', prompt: 'p' });
    cleanups.push(() => h.stop());
    const res = await fetch(h.url, { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });
});

describe('eval:mcp', () => {
  it('reads how a claude -p run went from its JSON result', () => {
    const usage = { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 7 };
    expect(claudeResult(JSON.stringify({ subtype: 'success', is_error: false, num_turns: 2, total_cost_usd: 0.5, usage }))).toEqual({
      done: { reason: 'complete' },
      turns: 2,
      tokensIn: 125,
      tokensOut: 7,
      cost_usd: 0.5,
    });
    expect(claudeResult(JSON.stringify({ subtype: 'error_max_turns', is_error: true, num_turns: 30 })).done).toEqual({ reason: 'error_max_turns' });
    expect(claudeResult('').done.reason).toBe('error');
  });

  // a fake claude (no model) drives the headless server through the script itself
  it.skipIf(process.platform === 'win32')('starts the headless server, runs claude against it and scores the task', () => {
    const r = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', fileURLToPath(new URL('../eval/mcp-cli.ts', import.meta.url)), fileURLToPath(new URL('led-current.json', dir)), '--model', 'x'], {
      env: { ...process.env, CLAUDE_BIN: fileURLToPath(new URL('fake-eval-claude.mjs', import.meta.url)) },
      encoding: 'utf8',
    });
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual({
      task: 'led-current',
      ok: true,
      erc_errors: 0,
      drc_errors: 0,
      constraint_failures: 0,
      ops_applied: 1,
      ops_rejected: 0,
      turns: 3,
      tokens_in: 1210,
      tokens_out: 50,
      failures: [],
      card: expect.objectContaining({ ledger: expect.objectContaining({ violated: 0 }) }),
      cost_usd: 0.01,
    });
    expect(r.status).toBe(0);
  });
});
