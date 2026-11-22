/**
 * Runs eval tasks with their scripted provider and prints one JSON score per task.
 *
 *   npm run eval -- packages/agent/eval/tasks/decouple-led.json [more task files]
 *
 * Exits 1 when a task is not ok. See docs/ARCHITECTURE.md §3.9.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Design } from '@4k7/schema';
import { runTask, scriptedFor, type EvalTask } from './run.ts';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: npm run eval -- <task.json>...');
  process.exit(2);
}
let failed = false;
for (const file of files) {
  const task = JSON.parse(readFileSync(file, 'utf8')) as EvalTask;
  const design = task.design ? (JSON.parse(readFileSync(resolve(dirname(file), task.design), 'utf8')) as Design) : undefined;
  const score = await runTask(design, task, scriptedFor(task));
  console.log(JSON.stringify(score));
  if (!score.ok) failed = true;
}
process.exit(failed ? 1 : 0);
