/**
 * Runs one eval task with a real external agent: starts the headless eval server for the task's
 * design, runs `claude -p` against its /mcp endpoint (only the 4k7 tools; no shell, files or web),
 * then prints the task's score with Claude's model calls, tokens and cost. Local only: it spends on
 * the model Claude Code is signed in to, so nothing runs it in CI.
 *
 *   npm run eval:mcp -- packages/agent/eval/tasks/led-current.json [claude options, e.g. --model sonnet --max-turns 30]
 *
 * CLAUDE_BIN picks the claude program (default: claude on the PATH). Exits 1 when the task is not ok.
 * See docs/ARCHITECTURE.md §3.9.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Design } from '@4k7/schema';
import { commandFor } from '../../../tools/server/src/claude-bin.ts';
import { claudeResult, startHeadless } from './headless.ts';
import type { EvalTask } from './run.ts';

const [file, ...extra] = process.argv.slice(2);
if (!file) {
  console.error('usage: npm run eval:mcp -- <task.json> [claude options]');
  process.exit(2);
}
const task = JSON.parse(readFileSync(file, 'utf8')) as EvalTask;
const design = task.design ? (JSON.parse(readFileSync(resolve(dirname(file), task.design), 'utf8')) as Design) : undefined;
const h = await startHeadless(design, task);

const mcp = JSON.stringify({ mcpServers: { '4k7': { type: 'http', url: h.url, headers: { Authorization: `Bearer ${h.token}` } } } });
const args = ['-p', '--output-format', 'json', '--mcp-config', mcp, '--strict-mcp-config', '--tools', '', '--allowedTools', 'mcp__4k7', '--permission-mode', 'dontAsk', ...extra];
const cmd = commandFor(process.env.CLAUDE_BIN ?? 'claude');
const child = spawn(cmd.file, [...cmd.args, ...args], { stdio: ['pipe', 'pipe', 'inherit'] });
let out = '';
child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
child.stdin.end(task.prompt);
const code = await new Promise<number | null>((res) => {
  child.on('close', res);
  child.on('error', (e) => {
    console.error(`could not start claude: ${e.message}`);
    res(null);
  });
});

const run = claudeResult(out);
if (code !== 0 && run.done.reason === 'complete') run.done = { reason: 'error', message: `claude exited with ${code}` };
const score = h.score(run);
await h.stop();
console.log(JSON.stringify({ ...score, cost_usd: run.cost_usd }));
process.exit(score.ok ? 0 : 1);
