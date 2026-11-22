import { describe, expect, it } from 'vitest';
import type { Design, EditOp } from '@4k7/schema';
import { getBuiltinPart } from '@4k7/parts';
import { Kernel } from '../src/index.ts';
import type { ImportSources } from '../src/importops.ts';

/** A regulator card the library does not have: only the project's file stores it (its VOUT pin named FB). */
function regCard() {
  const card = structuredClone(getBuiltinPart('microchip:MCP1700T-3302E/TT')!);
  card.id = 'acme:REG';
  for (const p of card.pins) if (p.name === 'VOUT') p.name = 'FB';
  return card;
}

/** "lamp": a supply block (J1, U1 on its own card, C1, R2 on FB) and a power LED block (R1, D1) with a note and an order. */
function lamp(): Design {
  const k = new Kernel();
  const empty = JSON.parse(k.exportDesign()) as Design;
  k.load({ ...empty, parts: { 'acme:REG': regCard() } });
  const ops: EditOp[] = [
    { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
    { op: 'add_part', part: 'acme:REG', refdes: 'U1' },
    { op: 'add_part', part: 'generic:C', refdes: 'C1', params: { capacitance: '10uF' } },
    { op: 'add_part', part: 'generic:R', refdes: 'R2', params: { resistance: '100k' } },
    { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '1k' } },
    { op: 'add_part', part: 'generic:LED', refdes: 'D1' },
    { op: 'connect', pins: ['J1.1', 'C1.1', 'U1.VIN', 'R1.1'], net: '+5V' },
    { op: 'connect', pins: ['J1.2', 'C1.2', 'U1.GND', 'R2.2', 'D1.K'], net: 'GND' },
    { op: 'connect', pins: ['U1.FB', 'R2.1'], net: 'FB' },
    { op: 'connect', pins: ['R1.2', 'D1.A'], net: 'LED_A' },
    { op: 'constrain', kind: 'note', a: 'R1', value: 'sets the LED to 3 mA', strength: 'soft' },
    { op: 'constrain', kind: 'left_of', a: 'R1', b: 'D1', strength: 'soft' },
    { op: 'describe', blocks: [{ title: 'Supply', refs: ['J1', 'U1', 'C1', 'R2'], text: 'USB 5 V in.' }, { title: 'Power LED', refs: ['R1', 'D1'] }] },
  ];
  const r = k.transact({ summary: 'lamp', ops });
  expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  k.accept();
  return JSON.parse(k.exportDesign()) as Design;
}

const sources = (file: Design = lamp()): ImportSources => ({ projects: ['lamp', 'other'], files: { lamp: JSON.stringify(file) } });

/** The open design: an LED of its own already (R1, D1 on LED_A) on +3V3. */
function target(): Kernel {
  const k = new Kernel();
  const r = k.transact({
    summary: 'own',
    ops: [
      { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '470' } },
      { op: 'add_part', part: 'generic:LED', refdes: 'D1' },
      { op: 'connect', pins: ['R1.1'], net: '+3V3' },
      { op: 'connect', pins: ['R1.2', 'D1.A'], net: 'LED_A' },
      { op: 'connect', pins: ['D1.K'], net: 'GND' },
    ],
  });
  expect(r.status).toBe('ok');
  k.accept();
  return k;
}

const importing = (k: Kernel, op: Omit<Extract<EditOp, { op: 'import_block' }>, 'op'>, src: ImportSources | null = sources()) =>
  k.transact({ summary: 'import', ops: [{ op: 'import_block', ...op }] }, 'agent', undefined, src ?? undefined);

describe('import_block', () => {
  it('copies the parts, nets and describe block, and lists the values to recheck', () => {
    const k = target();
    const r = importing(k, { project: 'lamp', block: 'Supply', nets: { '+5V': 'VBUS', GND: 'GND' } });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const d = k.draftSnapshot().design;
    const by = (ref: string) => Object.values(d.components).find((c) => c.refdes === ref)!;
    const net = (ref: string, pin: string) => d.nets[by(ref).pins[pin]!]!.name;
    expect(['J1', 'U1', 'C1', 'R2'].map((x) => by(x).part)).toEqual(['generic:CONN_1x2', 'acme:REG', 'generic:C', 'generic:R']);
    expect(by('C1').params).toEqual({ capacitance: '10uF' });
    expect(net('J1', '1')).toBe('VBUS');
    expect(net('J1', '2')).toBe('GND');
    expect(Object.values(d.nets).filter((n) => n.name === 'GND')).toHaveLength(1); // joined to this design's GND
    expect(net('R2', '1')).toBe('FB');
    expect(d.description?.blocks).toEqual([{ title: 'Supply', components: ['J1', 'U1', 'C1', 'R2'].map((x) => by(x).id), text: 'USB 5 V in.' }]);
    const rep = r.results[0]!.imported!;
    expect(rep.cards).toEqual({ library: ['generic:CONN_1x2', 'generic:C', 'generic:R'], project: ['acme:REG'] });
    expect(rep.renamed).toEqual({ refdes: {}, nets: {} });
    expect(rep.recheck).toEqual([
      { ref: 'C1', params: { capacitance: '10uF' }, why: 'chosen for lamp' },
      { ref: 'R2', params: { resistance: '100k' }, why: 'sets U1.FB' },
    ]);
    expect(r.results[0]!.effect).toMatch(/values to recheck .*R2 100k \(sets U1\.FB\)/);
  });

  it('renames refdes and internal nets that are taken, and brings the note and the order along', () => {
    const k = target();
    const r = importing(k, { project: 'lamp', block: 2, nets: { '+5V': '+3V3', GND: 'GND' } });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const rep = r.results[0]!.imported!;
    expect(rep.renamed).toEqual({ refdes: { R1: 'R2', D1: 'D2' }, nets: { LED_A: 'LED_A_2' } });
    const d = k.draftSnapshot().design;
    const by = (ref: string) => Object.values(d.components).find((c) => c.refdes === ref)!;
    expect(by('R2').params).toEqual({ resistance: '1k' });
    expect(by('R2').pins['1']).toBe(by('R1').pins['1']); // both on +3V3
    expect(d.nets[by('R2').pins['2']!]!.name).toBe('LED_A_2');
    const kinds = Object.values(d.ledger).map((x) => [x.kind, x.a, x.b, x.value]);
    expect(kinds).toEqual([['note', by('R2').id, undefined, 'sets the LED to 3 mA'], ['left_of', by('R2').id, by('D2').id, undefined]]);
    // with a prefix, the internal net takes it instead
    const k2 = target();
    const r2 = importing(k2, { project: 'lamp', block: 'power led', nets: { '+5V': '+3V3', GND: 'GND' }, prefix: 'CH2_' });
    expect(r2.results[0]!.imported!.renamed.nets).toEqual({ LED_A: 'CH2_LED_A' });
  });

  it('refuses and changes nothing when a boundary net is not mapped, or a net is not a boundary net', () => {
    const k = target();
    const before = JSON.stringify(k.draftSnapshot().design);
    const r = importing(k, { project: 'lamp', block: 'Power LED', nets: { GND: 'GND' } });
    expect(r.rejection).toMatchObject({ code: 'NET_UNMAPPED', candidates: ['+5V'] });
    expect(importing(k, { project: 'lamp', block: 'Power LED', nets: { GND: 'GND', '+5V': '+3V3', LED_A: 'X' } }).rejection?.code).toBe('NET_UNKNOWN');
    expect(JSON.stringify(k.draftSnapshot().design)).toBe(before);
  });

  it('refuses an unknown block or project, and without the projects folder', () => {
    const k = target();
    expect(importing(k, { project: 'lamp', block: 'Charger', nets: {} }).rejection).toMatchObject({ code: 'BLOCK_UNKNOWN', candidates: ['Supply', 'Power LED'] });
    expect(importing(k, { project: 'lamp', block: 3, nets: {} }).rejection?.code).toBe('BLOCK_UNKNOWN');
    expect(importing(k, { project: '../lamp', block: 1, nets: {} }).rejection).toMatchObject({ code: 'PROJECT_UNKNOWN', candidates: ['lamp', 'other'] });
    expect(importing(k, { project: 'lamp', block: 1, nets: {} }, null).rejection?.code).toBe('PROJECT_UNKNOWN');
  });

  it('refuses a part neither the library nor the project file has', () => {
    const file = lamp();
    delete file.parts['acme:REG'];
    const k = target();
    const r = importing(k, { project: 'lamp', block: 'Supply', nets: { '+5V': 'VBUS', GND: 'GND' } }, sources(file));
    expect(r.rejection).toMatchObject({ code: 'PART_UNKNOWN', message: expect.stringMatching(/acme:REG/) });
  });

  it('is undone like any edit', () => {
    const k = target();
    const before = k.exportDesign();
    expect(importing(k, { project: 'lamp', block: 'Supply', nets: { '+5V': 'VBUS', GND: 'GND' } }).status).toBe('ok');
    k.accept();
    expect(k.exportDesign()).not.toBe(before);
    k.undo();
    expect(k.exportDesign()).toBe(before);
  });
});
