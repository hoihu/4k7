import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Design } from '@4k7/schema';
import { runTask, scriptedFor, type EvalTask } from '../eval/run.ts';

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
});
