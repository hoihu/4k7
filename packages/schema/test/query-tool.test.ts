/**
 * The design_query tool description names every query op of the schema, so a query added later cannot
 * be missing from what the agent reads. See docs/design/ops-api.md.
 */
import { describe, expect, it } from 'vitest';
import { QueryOp } from '../src/ops.ts';
import { agentTools } from '../src/tools.ts';

const queries = QueryOp.options.map((o) => o.shape.op.value as string);

describe('design_query description', () => {
  for (const engine of ['app', 'chat', 'cli'] as const) {
    it(`names every query op (${engine})`, () => {
      const tool = agentTools(engine).find((t) => t.name === 'design_query')!;
      expect(queries.length).toBeGreaterThanOrEqual(20);
      const missing = queries.filter((op) => !new RegExp(`\\b${op}\\b`).test(tool.description));
      expect(missing, 'query ops missing from the design_query description').toEqual([]);
    });
  }
});
