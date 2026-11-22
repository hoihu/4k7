import { describe, expect, it } from 'vitest';
import type { EditOp } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { blocksOfProject, listBlocks, type ListedBlock } from '../src/reuse.ts';

/** USB 5 V in (J1, C1), an LDO to 3.3 V (U1, C2, C3) and an LED with its resistor (R1, D1) on 3.3 V. */
function project(blocks: boolean): string {
  const k = new Kernel();
  const ops: EditOp[] = [
    { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
    { op: 'add_part', part: 'generic:C', refdes: 'C1', params: { capacitance: '10uF', voltage: '16V' } },
    { op: 'add_part', part: 'microchip:MCP1700T-3302E/TT', refdes: 'U1' },
    { op: 'add_part', part: 'generic:C', refdes: 'C2', params: { capacitance: '1uF', voltage: '10V' } },
    { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '1k' } },
    { op: 'add_part', part: 'generic:LED', refdes: 'D1' },
    { op: 'connect', pins: ['J1.1', 'C1.1', 'U1.VIN'], net: '+5V' },
    { op: 'connect', pins: ['J1.2', 'C1.2', 'U1.GND', 'C2.2', 'D1.K'], net: 'GND' },
    { op: 'connect', pins: ['U1.VOUT', 'C2.1', 'R1.1'], net: '+3V3' },
    { op: 'connect', pins: ['R1.2', 'D1.A'], net: 'LED_A' },
  ];
  if (blocks) {
    ops.push({
      op: 'describe',
      blocks: [
        { title: '5 V in and 3.3 V LDO', refs: ['J1', 'C1', 'U1', 'C2'], text: 'An MCP1700 from USB 5 V.' },
        { title: 'Power LED', refs: ['R1', 'D1'] },
      ],
    });
  }
  const r = k.transact({ summary: 'fixture', ops });
  expect(r.status, JSON.stringify(r)).toBe('ok');
  k.accept();
  return k.exportDesign();
}

const byTitle = (blocks: ListedBlock[], title: string) => blocks.find((b) => b.title === title)!;

describe('list_blocks', () => {
  it('lists each block with its parts, internal nets and boundary nets', () => {
    const out = listBlocks('lamp', JSON.parse(project(true)));
    expect(out.project).toBe('lamp');
    expect(out.blocks.map((b) => [b.block, b.title])).toEqual([[1, '5 V in and 3.3 V LDO'], [2, 'Power LED']]);
    const supply = byTitle(out.blocks, '5 V in and 3.3 V LDO');
    expect(supply.text).toBe('An MCP1700 from USB 5 V.');
    expect(supply.parts.map((p) => p.ref)).toEqual(['J1', 'C1', 'U1', 'C2']);
    expect(supply.parts.find((p) => p.ref === 'C1')).toEqual({ ref: 'C1', part: 'generic:C', params: { capacitance: '10uF', voltage: '16V' } });
    expect(supply.parts.find((p) => p.ref === 'U1')?.part).toBe('microchip:MCP1700T-3302E/TT');
    // +5V stays between J1, C1 and U1, but it is a supply: the importing design joins it to one of its own
    expect(supply.internal_nets).toEqual([]);
    expect(supply.boundary_nets.map((n) => [n.net, n.why])).toEqual([['+3V3', 'parts outside'], ['+5V', 'supply'], ['GND', 'parts outside']]);
    expect(supply.boundary_nets.find((n) => n.net === '+3V3')).toMatchObject({ pins: ['C2.1', 'U1.VOUT'], outside: ['R1'] });
    const led = byTitle(out.blocks, 'Power LED');
    expect(led.internal_nets).toEqual(['LED_A']);
    expect(led.boundary_nets.map((n) => n.net)).toEqual(['+3V3', 'GND']);
    expect(led.boundary_nets.find((n) => n.net === 'GND')?.outside).toEqual(['C1', 'C2', 'J1', 'U1']);
    expect(out.not_in_a_block).toBeUndefined();
  });

  it('says so when the project has no blocks', () => {
    const out = listBlocks('bare', JSON.parse(project(false)));
    expect(out.blocks).toEqual([]);
    expect(out.not_in_a_block).toHaveLength(6);
    expect(out.note).toMatch(/no functional blocks/i);
  });

  it('answers an unknown or unreadable project with an error, not a crash', () => {
    const missing = blocksOfProject('nope', undefined, ['lamp', 'bare']);
    expect(missing).toMatchObject({ error: expect.stringMatching(/No project "nope"/), projects: ['bare', 'lamp'] });
    // a project the folder does not list is not read, even when text came with it
    expect(blocksOfProject('../secret', project(true), ['lamp'])).toHaveProperty('error');
    expect(blocksOfProject('lamp', '{not json', ['lamp'])).toMatchObject({ error: expect.stringMatching(/could not be read/) });
    expect(blocksOfProject('lamp', JSON.stringify({ format: 99 }), ['lamp'])).toMatchObject({ error: expect.stringMatching(/could not be read/) });
    expect(blocksOfProject('lamp', project(true), ['lamp'])).toMatchObject({ project: 'lamp', blocks: [{ block: 1 }, { block: 2 }] });
  });
});
