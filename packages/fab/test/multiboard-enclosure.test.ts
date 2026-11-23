import { describe, expect, it } from 'vitest';
import { Kernel } from '@4k7/kernel';
import { assemblyEnclosureFacts, enclosureApiSummary } from '../src/index.ts';
import { renderFacts } from './csg-setup.ts';
import { buckTransaction } from '../../kernel/test/fixtures.ts';

/** The buck with an LED board stacked on it: J2 (a header on the main board) into J3 (under the LED board), 11 mm apart. See docs/design/multi-board.md §6. */
function stacked() {
  const k = new Kernel();
  k.transact(buckTransaction());
  const r = k.transact({
    summary: 'LED board',
    ops: [
      { op: 'add_sheet', name: 'LED' },
      { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J2' },
      { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J3', sheet: 'LED' },
      { op: 'add_part', part: 'generic:R', refdes: 'R4', params: { resistance: '1k' }, sheet: 'LED' },
      { op: 'add_part', part: 'generic:LED', refdes: 'D2', sheet: 'LED' },
      { op: 'connect', pins: ['J2.1', 'J3.1', 'R4.1'], net: '+3V3' },
      { op: 'connect', pins: ['R4.2', 'D2.A'], net: 'LED_A' },
      { op: 'connect', pins: ['J2.2', 'J3.2', 'D2.K'], net: 'GND' },
      { op: 'add_board', name: 'LED board', sheets: ['LED'] },
      { op: 'constrain', kind: 'layer', a: 'J3', value: 'bottom', strength: 'hard' },
      { op: 'set_board', board: 'LED board', width_mm: 20, height_mm: 16 },
      { op: 'add_hole', board: 'LED board', diameter_mm: 2.2, corner: 'all' },
      { op: 'mate', a: 'J2', b: 'J3', kind: 'stack', height_mm: 11 },
    ],
  });
  expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  const places = k.assembly();
  return assemblyEnclosureFacts(
    places.map((at) => ({ b: k.boardPlacement(at.board), id: at.board, name: at.name, at })),
    [{ a: 'J2', b: 'J3', kind: 'stack', height_mm: 11 }],
  );
}

describe('the enclosure of a design of several boards', () => {
  const facts = stacked();

  it('has every board, and every part where it stands', () => {
    expect(facts.boards!.map((b) => b.name)).toEqual(['Main', 'LED board']);
    const led = facts.parts.filter((p) => p.board === 'LED board').map((p) => p.ref).sort();
    expect(led).toEqual(['D2', 'J3', 'R4']);
    // the LED board's underside 11 mm over the main board's top: its parts on top above that
    const r4 = facts.parts.find((p) => p.ref === 'R4')!;
    expect(r4.min[2]).toBeGreaterThan(1.6 + 11 + 1.6 - 0.01);
    expect(facts.tallestTop).toBeGreaterThanOrEqual(r4.max[2]);
    expect(enclosureApiSummary(facts)).toMatch(/boards = \[/);
  });

  it('gives the script each board where it stands, and posts between them', async () => {
    const r = await renderFacts(
      facts,
      `const pieces = ['posts'];
echo('led', bbox(pcb('LED board')).min[2], bbox(pcb('LED board')).max[2]);
echo('all', bbox(pcbs()).max[2]);
echo('parts', parts_info.filter((p) => p.board === 'LED board').length);
function posts() { return hole_posts(pcb_thickness, { board: 'LED board', d: 4 }); }
`,
    );
    expect(r.findings.filter((f) => f.code === 'ENC.SCRIPT')).toEqual([]);
    const said = Object.fromEntries(r.log!.map((l) => [l.split(' ')[0], l.split(' ').slice(1).map(Number)]));
    expect(said.led![0]).toBeCloseTo(12.6, 3);
    expect(said.led![1]).toBeCloseTo(14.2, 3);
    expect(said.all![0]).toBeCloseTo(14.2, 3);
    expect(said.parts![0]).toBe(3);
    // four standoffs from the main board's top up to the LED board's underside
    const p = r.pieces.find((x) => x.name === 'posts')!;
    expect(p).toBeDefined();
    expect(r.size?.[2] ?? 0).toBeGreaterThan(0);
  });

  it('says where a post cannot start', async () => {
    const r = await renderFacts(facts, `const pieces = ['posts'];\nfunction posts() { return hole_posts(20, { board: 'LED board' }); }\n`);
    expect(r.findings.find((f) => f.code === 'ENC.SCRIPT')?.message).toMatch(/under board "LED board"/);
  });
});
