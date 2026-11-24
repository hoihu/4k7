import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GuideTopic, type EditOp } from '@4k7/schema';
import { Kernel, type ImportSources, type QueryContext } from '../src/index.ts';

/**
 * What the kernel answers from what the app read for it (Kernel.query's second argument): the
 * agent's guides (get_guide) and the other stored projects (list_blocks). See docs/design/ops-api.md §7.
 */

/** The guides as the app and the eval hand them over: each design doc as it is, header for people included. */
const guides = Object.fromEntries(
  GuideTopic.options.map((t) => [t, readFileSync(new URL(`../../../docs/design/${t.replace('_', '-')}.md`, import.meta.url), 'utf8')]),
) as QueryContext['guides'];
const HEADER = /^#[^\n]*\n+(>[^\n]*\n)+\n*/;

/** A design built from `ops`, accepted; with `board`, the LED and its resistor sit on a board of their own. */
function design(ops: EditOp[], board = false): Kernel {
  const k = new Kernel();
  const r = k.transact({ summary: 'fixture', ops: board ? [...ops, { op: 'add_board', name: 'LED board', sheets: ['LED'] }] : ops });
  expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  k.accept();
  return k;
}

/** USB 5 V in and an LED with its resistor, as two describe blocks; with `board`, the LED on its own sheet and board. */
function lamp(board = false): Kernel {
  const sheet = board ? { sheet: 'LED' } : {};
  return design(
    [
      ...(board ? [{ op: 'add_sheet', name: 'LED' } as const] : []),
      { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
      { op: 'add_part', part: 'generic:C', refdes: 'C1', params: { capacitance: '10uF' } },
      { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '1k' }, ...sheet },
      { op: 'add_part', part: 'generic:LED', refdes: 'D1', ...sheet },
      ...(board ? [{ op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J2', ...sheet } as const] : []),
      { op: 'connect', pins: ['J1.1', 'C1.1', 'R1.1', ...(board ? ['J2.1'] : [])], net: '+5V' },
      { op: 'connect', pins: ['R1.2', 'D1.A'], net: 'LED_A' },
      { op: 'connect', pins: ['J1.2', 'C1.2', 'D1.K', ...(board ? ['J2.2'] : [])], net: 'GND' },
      { op: 'describe', blocks: [{ title: 'USB in', refs: ['J1', 'C1'] }, { title: 'Power LED', refs: ['R1', 'D1', ...(board ? ['J2'] : [])] }] },
    ],
    board,
  );
}

const sources = (files: Record<string, string>): ImportSources => ({ projects: Object.keys(files), files });

describe('get_guide from the guides the app hands over', () => {
  it('serves every guide topic, boards too, as its design doc without the header', () => {
    for (const k of [lamp(), lamp(true)]) {
      for (const topic of GuideTopic.options) {
        const out = k.query({ op: 'get_guide', topic }, { guides });
        expect(typeof out, topic).toBe('string');
        expect(out).toBe(guides![topic]!.replace(HEADER, ''));
        expect(out as string).not.toMatch(/^#|^>/);
      }
    }
    expect(lamp(true).query({ op: 'get_guide', topic: 'boards' }, { guides })).toMatch(/board/i);
  });

  it('lists every guide for a topic it does not have', () => {
    const out = lamp().query({ op: 'get_guide', topic: 'nope' }, { guides }) as { error: string; guides: string[] };
    expect(out.error).toBe(`No guide "nope". Guides: ${GuideTopic.options.join(', ')}.`);
    expect(out.guides).toEqual(GuideTopic.options);
    expect(out.guides).toContain('boards');
    expect(lamp().query({ op: 'get_guide' }, { guides })).toMatchObject({ guides: GuideTopic.options });
  });

  it('says so, without throwing, when it was given no guides', () => {
    const out = lamp().query({ op: 'get_guide', topic: 'boards' }) as { error: string };
    expect(out.error).toMatch(/guide/i);
    expect(lamp().query({ op: 'get_guide', topic: 'cost' }, { guides: { boards: 'x' } })).toHaveProperty('error');
  });
});

describe('list_blocks from the projects the app read', () => {
  it('lists the blocks of a stored project', () => {
    const out = lamp().query({ op: 'list_blocks', project: 'lamp' }, { sources: sources({ lamp: lamp().exportDesign() }) });
    expect(out).toMatchObject({ project: 'lamp', blocks: [{ block: 1, title: 'USB in' }, { block: 2, title: 'Power LED' }] });
  });

  it('lists the blocks of a project of several boards, asked from a design of several boards', () => {
    const out = lamp(true).query({ op: 'list_blocks', project: 'two' }, { sources: sources({ two: lamp(true).exportDesign() }) }) as { blocks: { title: string; parts: { ref: string }[] }[] };
    expect(out.blocks.map((b) => b.title)).toEqual(['USB in', 'Power LED']);
    expect(out.blocks[1]!.parts.map((p) => p.ref)).toEqual(['R1', 'D1', 'J2']);
  });

  it('names the projects there are for one the folder does not list, and reads nothing else', () => {
    const out = lamp().query({ op: 'list_blocks', project: 'nope' }, { sources: { projects: ['lamp'], files: { lamp: lamp().exportDesign() } } });
    expect(out).toMatchObject({ error: expect.any(String), projects: ['lamp'] });
  });

  it('says there is no projects folder, without throwing, when it was given none', () => {
    const out = lamp().query({ op: 'list_blocks', project: 'lamp' }) as { error: string };
    expect(out.error).toMatch(/projects folder/);
    expect(out.error).toMatch(/not connected to the 4k7 server/);
  });
});
