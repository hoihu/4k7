/**
 * docs/design/ops-api.md §2 lists every op of the catalogue. This reads the op names from the schema
 * itself and fails when the doc and the schema drift apart. See docs/design/ops-api.md.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EditOp, QueryOp } from '../src/ops.ts';

const ops = [...EditOp.options, ...QueryOp.options].map((o) => o.shape.op.value as string);

const doc = readFileSync(new URL('../../../docs/design/ops-api.md', import.meta.url), 'utf8');
const start = doc.indexOf('\n## 2.');
const end = doc.indexOf('\n## 3.', start);
const section = doc.slice(start, end);

/** The op each list item of §2 introduces: "- `op_name`: what it does". */
const listed = [...section.matchAll(/^- `([a-z][a-z0-9_]*)`:/gm)].map((m) => m[1]!);
/** Every backticked name in §2 that looks like an op (snake_case, no dots or slashes). */
const named = [...section.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]!);

describe('ops-api.md §2 matches the op schema', () => {
  it('finds the section and the ops', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(ops.length).toBeGreaterThan(50);
  });

  it('lists every op exactly once', () => {
    const missing = ops.filter((op) => !listed.includes(op));
    const twice = listed.filter((op, i) => listed.indexOf(op) !== i);
    expect(missing, 'ops missing from §2').toEqual([]);
    expect(twice, 'ops listed more than once in §2').toEqual([]);
  });

  it('names no op that does not exist', () => {
    const unknown = [...new Set(named)].filter((name) => !ops.includes(name));
    expect(unknown, 'backticked names in §2 that are not ops').toEqual([]);
  });
});
