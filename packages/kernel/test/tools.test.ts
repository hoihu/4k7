import { describe, expect, it } from 'vitest';
import { agentTools, ingestTools } from '@4k7/schema';

describe('tool schemas', () => {
  const all = [...agentTools('app'), ...agentTools('cli')];

  it.each(all.map((t) => [t.name, t] as const))('%s has a plain object input schema (Anthropic + MCP requirement)', (_n, t) => {
    expect(t.input_schema.type).toBe('object');
    expect(t.input_schema).not.toHaveProperty('anyOf');
    expect(t.input_schema).not.toHaveProperty('oneOf');
    expect(t.input_schema).not.toHaveProperty('allOf');
  });

  it('gives every array an items schema (VS Code refuses tuples with items: false)', () => {
    const arrays: Array<[string, Record<string, unknown>]> = [];
    const walk = (o: unknown, path: string) => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) return o.forEach((v, i) => walk(v, `${path}[${i}]`));
      const s = o as Record<string, unknown>;
      if (s.type === 'array') arrays.push([path, s]);
      for (const [k, v] of Object.entries(s)) walk(v, `${path}.${k}`);
    };
    for (const t of [...all, ...ingestTools()]) walk(t.input_schema, t.name);
    expect(arrays.length).toBeGreaterThan(5);
    for (const [path, s] of arrays) expect(s.items, path).toBeTypeOf('object');
    const region = agentTools('cli').find((t) => t.name === 'read_datasheet')!.input_schema as { properties: { region: Record<string, unknown> } };
    expect(region.properties.region).toMatchObject({ type: 'array', minItems: 4, maxItems: 4, items: { type: 'number', minimum: 0, maximum: 1 } });
    expect(region.properties.region.prefixItems).toHaveLength(4);
  });

  it('flattens the query union into an op enum', () => {
    const q = agentTools('app').find((t) => t.name === 'design_query')!.input_schema as {
      properties: Record<string, { enum?: string[] }>;
      required: string[];
    };
    expect(q.properties.op?.enum).toEqual(['get_summary', 'find', 'get_component', 'get_net', 'get_diagnostics', 'get_ledger', 'get_description', 'get_fab_profiles', 'get_schematic', 'get_board', 'try_placements', 'search_parts', 'get_part', 'get_enclosure', 'get_guide']);
    expect(q.required).toEqual(['op']);
    expect(Object.keys(q.properties).sort()).toEqual(['candidates', 'category', 'id', 'net', 'op', 'ref', 'route', 'text', 'topic']);
  });
});
