import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Design } from '@4k7/schema';
import { Kernel } from '@4k7/kernel';
import { answerer, runTask, scriptedFor, type EvalTask } from '../eval/run.ts';

const dir = new URL('../eval/tasks/', import.meta.url);
const load = <T>(name: string) => JSON.parse(readFileSync(new URL(name, dir), 'utf8')) as T;

describe('agent eval runner', () => {
  it('scores the decoupling smoke task on a saved design, headless', async () => {
    const task = load<EvalTask>('decouple-led.json');
    const score = await runTask(load<Design>(task.design!), task, scriptedFor(task));
    expect(score).toEqual({
      task: 'decouple-led',
      ok: true,
      erc_errors: 0,
      drc_errors: 0,
      constraint_failures: 0,
      ops_applied: 4,
      ops_rejected: 0,
      turns: 3,
      tokens_in: 0,
      tokens_out: 0,
      failures: [],
    });
  });

  it('counts a rejected op and fails an unmet expectation', async () => {
    const task: EvalTask = {
      name: 'reject',
      prompt: 'add a cap',
      expect: { parts: ['C1'] },
      script: [
        [{ type: 'tool_use', id: '', name: 'design_edit', input: { summary: 'bad', ops: [{ op: 'add_part', part: 'generic:NO_SUCH_PART', refdes: 'C1' }] } }],
        [{ type: 'text', text: 'Could not add it.' }],
      ],
    };
    const score = await runTask(undefined, task, scriptedFor(task));
    expect(score).toMatchObject({ ok: false, ops_applied: 0, ops_rejected: 1, erc_errors: 0, turns: 2 });
    expect(score.failures).toEqual(['no part C1']);
  });

  it('counts the errors the agent leaves', async () => {
    const task: EvalTask = {
      name: 'open-pins',
      prompt: 'add a 555',
      script: [[{ type: 'tool_use', id: '', name: 'design_edit', input: { summary: 'ic', ops: [{ op: 'add_part', part: 'ti:NE555DR', refdes: 'U1' }] } }]],
    };
    const score = await runTask(undefined, task, scriptedFor(task));
    expect(score.ok).toBe(false);
    expect(score.ops_applied).toBe(1);
    expect(score.erc_errors).toBeGreaterThan(0);
  });

  it('answers questions in order or by substring, and fails on one it has no answer for', async () => {
    const a = answerer(['first', { match: 'Package', answer: '0603' }, 'second']);
    expect([a('which package?'), a('colour?'), a('size?'), a('package again?'), a('more?')]).toEqual(['0603', 'first', 'second', null, null]);

    const ask = (question: string) => [{ type: 'tool_use' as const, id: '', name: 'ask_user', input: { question, options: ['a', 'b'] } }];
    const task: EvalTask = { name: 'asks', prompt: 'p', answers: ['yes'], script: [ask('Shall I go on?'), ask('And again?')] };
    const score = await runTask(undefined, task, scriptedFor(task));
    expect(score).toMatchObject({ ok: false, turns: 2 });
    expect(score.failures).toEqual(['the turn ended with question: no answer for "And again?"']);
  });
});

describe('golden tasks', () => {
  for (const file of ['led-current.json', 'second-led.json', 'power-input.json']) {
    it(`${file} parses, its design loads clean, and its scripted solution scores ok`, async () => {
      const task = load<EvalTask>(file);
      expect(task.prompt.length).toBeGreaterThan(20);
      expect(task.expect).toBeDefined();
      const design = task.design ? load<Design>(task.design) : undefined;
      expect(new Kernel(design).state().counts.errors).toBe(0);
      const score = await runTask(design, task, scriptedFor(task));
      expect(score.failures).toEqual([]);
      expect(score.ok).toBe(true);
    });
  }

  it('fails a part whose value is not one the task accepts', async () => {
    const task = { ...load<EvalTask>('led-current.json'), script: [[{ type: 'text' as const, text: 'Done.' }]] };
    const score = await runTask(load<Design>(task.design!), task, scriptedFor(task));
    expect(score.failures).toEqual(['R1 is 330, not 240 or 270']);
  });
});
