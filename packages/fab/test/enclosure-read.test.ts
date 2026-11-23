import { describe, expect, it } from 'vitest';
import { Kernel } from '@4k7/kernel';
import { enclosureAnswer, enclosureKey, TOOL_RESULT_CHARS, type EditOp, type EnclosureBrief, type EnclosureSettings } from '@4k7/schema';
import { assemblyEnclosureFacts, enclosureReadout, type EnclosureReport } from '../src/index.ts';
import { renderFacts } from './csg-setup.ts';
import { buckTransaction } from '../../kernel/test/fixtures.ts';

/**
 * get_enclosure on a large design: the buck with an LED board of 60 LEDs stacked on it, a long
 * script and a long report. Every answer the agent can get fits in a tool result, and each part
 * can be read whole in ranges. See docs/design/enclosure.md §3.
 */
function bigTwoBoards() {
  const k = new Kernel();
  k.transact(buckTransaction());
  const ops: EditOp[] = [
    { op: 'add_sheet', name: 'LED' },
    { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J2' },
    { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J3', sheet: 'LED' },
  ];
  for (let i = 0; i < 60; i++) {
    ops.push(
      { op: 'add_part', part: 'generic:R', refdes: `R${100 + i}`, params: { resistance: '1k' }, sheet: 'LED' },
      { op: 'add_part', part: 'generic:LED', refdes: `D${100 + i}`, sheet: 'LED' },
      { op: 'connect', pins: [`R${100 + i}.2`, `D${100 + i}.A`], net: `L${i}` },
      { op: 'connect', pins: [`R${100 + i}.1`, 'J3.1'], net: '+3V3' },
      { op: 'connect', pins: [`D${100 + i}.K`, 'J3.2'], net: 'GND' },
    );
  }
  ops.push(
    { op: 'connect', pins: ['J2.1', 'J3.1'], net: '+3V3' },
    { op: 'connect', pins: ['J2.2', 'J3.2'], net: 'GND' },
    { op: 'add_board', name: 'LED board', sheets: ['LED'] },
    { op: 'set_board', board: 'LED board', width_mm: 60, height_mm: 50 },
    { op: 'mate', a: 'J2', b: 'J3', kind: 'stack', height_mm: 11 },
  );
  const r = k.transact({ summary: 'LED board', ops });
  expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  const facts = assemblyEnclosureFacts(
    k.assembly().map((at) => ({ b: k.boardPlacement(at.board), id: at.board, name: at.name, at })),
    [{ a: 'J2', b: 'J3', kind: 'stack', height_mm: 11 }],
  );
  return { k, facts };
}

const brief: EnclosureBrief = {
  items: [
    { topic: 'Material', decision: 'PETG, FDM', why: 'outdoors on a bike' },
    { topic: 'J1 input', refs: ['J1'], question: 'Where should the dynamo cable come in?', options: ['the back', 'underneath'] },
  ],
  openings: ['J1'],
};

/** A long script, as one grows over many renders: about 100k characters, with quotes, backslashes, tabs, non-ASCII and empty lines. */
function longScript(): string {
  const L = ["const wall = 2, gap = 0.5;", "const pieces = ['base', 'lid'];", ''];
  for (let i = 0; i < 900; i++) L.push(`\tconst c${i} = translate([${i % 40}, ${(i * 7) % 30}, 0], cube([1, 1, 1])); // "rib" ${i}: 0.5 mm × 2 \\ é`, i % 50 ? `echo('r${i}', bbox(c${i}).size);` : '');
  L.push('function base() { return cube([10, 10, 2]); }', 'function lid() { return translate([0, 0, 20], cube([10, 10, 2])); }', '');
  return L.join('\n');
}

function longReport(enc: EnclosureSettings): EnclosureReport {
  return {
    script: enc.script!,
    key: enclosureKey(enc),
    pieces: [],
    findings: Array.from({ length: 60 }, (_, i) => ({ code: 'ENC.COLLIDES', severity: 'error' as const, message: `The base runs into D${100 + i} (LED board) by 0.4 mm at x 12.3, y 4.5, z 14.2: move the wall or grow the cavity` })),
    size: [70, 60, 30],
    ms: 900,
    log: Array.from({ length: 100 }, (_, i) => `r${i} [1, 1, 1]`),
  };
}

/** Read a text part to its end the way the agent would: from line 1, then each answer's next. */
function readAll(full: Parameters<typeof enclosureAnswer>[0], part: 'script' | 'board_api' | 'last_render') {
  const chunks: string[] = [];
  const sizes: number[] = [];
  let lines: [number, number] | undefined;
  for (let call = 0; call < 50; call++) {
    const a = enclosureAnswer(full, { part, ...(lines ? { lines } : {}) });
    sizes.push(JSON.stringify(a).length);
    chunks.push(a[part] as string);
    const next = a.next as string | undefined;
    if (!next) return { text: chunks.join('\n'), sizes, total: a.total_lines as number };
    const m = /lines \[(\d+), (\d+)\]/.exec(next)!;
    expect(Number(m[1])).toBe((a.lines as number[])[1]! + 1);
    lines = [Number(m[1]), Number(m[2])];
  }
  throw new Error('never ends');
}

describe('get_enclosure on a large design of two boards', () => {
  const { facts } = bigTwoBoards();
  const script = longScript();
  const enc: EnclosureSettings = { brief, script };
  const full = enclosureReadout(enc, facts, { report: longReport(enc), facts });

  it('was too long for one tool result as a whole', () => {
    expect(facts.boards).toHaveLength(2);
    expect(facts.parts.length).toBeGreaterThan(120);
    expect(script.length).toBeGreaterThan(60_000);
    expect(full.board_api!.length).toBeGreaterThan(TOOL_RESULT_CHARS);
    expect(JSON.stringify(full).length).toBeGreaterThan(4 * TOOL_RESULT_CHARS);
  });

  it('answers with an overview that fits, and says how to read the rest', () => {
    const a = enclosureAnswer(full);
    expect(JSON.stringify(a).length).toBeLessThanOrEqual(TOOL_RESULT_CHARS);
    expect(a.script).toBeUndefined();
    expect(a.brief).toEqual(brief);
    expect(a.open_questions).toEqual(['J1 input: Where should the dynamo cable come in?']);
    expect(a.parts).toMatchObject({ script: { lines: script.split('\n').length, characters: script.length } });
    expect(a.last_render_summary).toMatch(/^Box: 70 × 60 × 30 mm/);
    expect(a.read).toMatch(/part "script".*lines \[from, to\]/s);
  });

  it('reads every part whole, each answer within the limit, byte for byte', () => {
    for (const part of ['script', 'board_api', 'last_render'] as const) {
      const r = readAll(full, part);
      expect(r.text).toBe(full[part]);
      expect(r.total).toBe(full[part]!.split('\n').length);
      expect(Math.max(...r.sizes)).toBeLessThanOrEqual(TOOL_RESULT_CHARS);
    }
    expect(readAll(full, 'script').sizes.length).toBeLessThanOrEqual(Math.ceil(JSON.stringify(script).length / 12_000) + 1);
    expect(JSON.stringify(enclosureAnswer(full, { part: 'brief' })).length).toBeLessThanOrEqual(TOOL_RESULT_CHARS);
  });

  it('gives the lines asked for, 1-based, with the total', () => {
    const a = enclosureAnswer(full, { part: 'script', lines: [2, 4] });
    expect(a.script).toBe(script.split('\n').slice(1, 4).join('\n'));
    expect(a.lines).toEqual([2, 4]);
    expect(a.total_lines).toBe(script.split('\n').length);
    expect(a.next).toBeUndefined();
    expect(enclosureAnswer(full, { lines: [1, 1] }).script).toBe('const wall = 2, gap = 0.5;');
    expect(enclosureAnswer(full, { part: 'script', lines: [99_999, 100_000] }).error).toMatch(/1 to \d+/);
  });
});

describe('get_enclosure on a small design', () => {
  it('answers whole, as before', () => {
    const enc: EnclosureSettings = { brief, script: "const pieces = ['base'];\nfunction base() { return cube(1); }\n" };
    const full = enclosureReadout(enc, null, null);
    expect(enclosureAnswer(full)).toEqual(full);
    expect(Object.keys(full)).toEqual(['brief', 'open_questions', 'script', 'graphics', 'board_api', 'last_render', 'how']);
  });

  it('pages through the kernel too', () => {
    const k = new Kernel();
    k.transact({ summary: 'script', ops: [{ op: 'set_enclosure_script', script: "const pieces = ['base'];\nfunction base() { return cube(1); }\n" }] });
    expect(k.query({ op: 'get_enclosure', part: 'script', lines: [2, 2] })).toMatchObject({ script: 'function base() { return cube(1); }', lines: [2, 2], total_lines: 3 });
    expect((k.query({ op: 'get_enclosure', lines: [0, 2] }) as { error: string }).error).toMatch(/lines/);
  });

  it('counts lines as render_enclosure\'s errors do', async () => {
    const { facts } = bigTwoBoards();
    const script = "const pieces = ['base'];\n\nfunction base() {\n  return nope(1);\n}\n";
    const r = await renderFacts(facts, script);
    const n = Number(/line (\d+)/.exec(r.findings.find((f) => f.code === 'ENC.SCRIPT')!.message)![1]);
    expect(enclosureAnswer(enclosureReadout({ script }, facts, null), { part: 'script', lines: [n, n] }).script).toBe('  return nope(1);');
  });
});
