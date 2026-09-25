import { describe, expect, it } from 'vitest';
import { bridgeTools, toolDefinitions } from '@tracewise/schema';

describe('tool schemas', () => {
  const all = [...toolDefinitions(), ...bridgeTools()];

  it.each(all.map((t) => [t.name, t] as const))('%s has a plain object input schema (Anthropic + MCP requirement)', (_n, t) => {
    expect(t.input_schema.type).toBe('object');
    expect(t.input_schema).not.toHaveProperty('anyOf');
    expect(t.input_schema).not.toHaveProperty('oneOf');
    expect(t.input_schema).not.toHaveProperty('allOf');
  });

  it('flattens the query union into an op enum', () => {
    const q = toolDefinitions().find((t) => t.name === 'design_query')!.input_schema as {
      properties: Record<string, { enum?: string[] }>;
      required: string[];
    };
    expect(q.properties.op?.enum).toEqual(['get_summary', 'find', 'get_component', 'get_net', 'get_diagnostics', 'get_ledger', 'search_parts', 'get_part']);
    expect(q.required).toEqual(['op']);
    expect(Object.keys(q.properties).sort()).toEqual(['category', 'id', 'net', 'op', 'ref', 'text']);
  });
});
