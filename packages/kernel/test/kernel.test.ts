import { describe, expect, it } from 'vitest';
import { Kernel, canonicalJson } from '../src/index.ts';
import { buckTransaction } from './fixtures.ts';

const codes = (k: Kernel) => k.state().diagnostics.filter((d) => !d.waivedBy).map((d) => `${d.code} ${d.entities.join(',')}`);

describe('transactions', () => {
  it('builds a clean buck converter', () => {
    const k = new Kernel();
    const r = k.transact(buckTransaction());
    expect(r.status).toBe('ok');
    expect(r.counts.errors).toBe(0);
    // The only warning expected: C2 10 V rating on 3.3 V is fine; nothing else should fire.
    expect(codes(k)).toEqual([]);
  });

  it('catches the missing bootstrap capacitor from the datasheet requirement', () => {
    const k = new Kernel();
    const r = k.transact(buckTransaction({ withBootCap: false }));
    expect(r.status).toBe('ok');
    expect(codes(k)).toContain('ERC.PIN_UNCONNECTED U1.BOOT');
    const pin = r.introduced.find((d) => d.code === 'ERC.PIN_UNCONNECTED');
    expect(pin?.message).toMatch(/bootstrap/);
  });

  it('reports the BOOT requirement once the pin is wired without a cap', () => {
    const k = new Kernel();
    k.transact(buckTransaction({ withBootCap: false }));
    const r = k.transact({ summary: 'wire boot', ops: [{ op: 'connect', pins: ['U1.BOOT', 'R3.2'] }] });
    expect(r.status).toBe('ok');
    const req = r.introduced.find((d) => d.code === 'SEM.REQUIREMENT');
    expect(req?.entities).toEqual(['U1.BOOT', 'U1.PH']);
    expect(req?.fixHints?.[0]).toMatchObject({ op: 'add_part', part: 'generic:C', refdes: 'C4' });
  });

  it('is atomic: a failing op leaves the draft untouched and names the op', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    const before = k.state().summary;
    const r = k.transact({
      summary: 'bad',
      ops: [
        { op: 'set_param', ref: 'C1', params: { capacitance: '22uF' } },
        { op: 'connect', pins: ['U7.VIN'], net: '+12V' },
      ],
    });
    expect(r.status).toBe('rejected');
    expect(r.rejection).toMatchObject({ opIndex: 1, code: 'REF_UNKNOWN' });
    expect(k.state().summary).toEqual(before);
  });

  it('dry runs do not change the draft', () => {
    const k = new Kernel();
    const r = k.transact({ ...buckTransaction(), dry_run: true });
    expect(r.status).toBe('ok');
    expect(r.diff.added.length).toBeGreaterThan(5);
    expect(k.state().summary.components).toEqual([]);
  });

  it('refuses to silently move a pin between named nets', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    const r = k.transact({ summary: 'x', ops: [{ op: 'connect', pins: ['C1.1'], net: '+3V3' }] });
    expect(r.rejection).toMatchObject({ code: 'PIN_ALREADY_CONNECTED' });
    expect(r.rejection?.fixHints?.[0]).toEqual({ op: 'disconnect', pins: ['C1.1'] });
  });

  it('suggests candidates for unknown pins and parts', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    const pin = k.transact({ summary: 'x', ops: [{ op: 'connect', pins: ['U1.VOUT'], net: 'X' }] });
    expect(pin.rejection?.code).toBe('PIN_UNKNOWN');
    expect(pin.rejection?.candidates).toContain('U1.VSNS');
    const part = k.transact({ summary: 'x', ops: [{ op: 'add_part', part: 'ti:TPS5433' }] });
    expect(part.rejection?.code).toBe('PART_UNKNOWN');
    expect(part.rejection?.candidates).toContain('ti:TPS54331DR');
  });

  it('validates parameter units', () => {
    const k = new Kernel();
    const r = k.transact({ summary: 'x', ops: [{ op: 'add_part', part: 'generic:C', params: { capacitance: '10k' } }] });
    expect(r.rejection?.code).toBe('PARAM_INVALID');
  });
});

describe('semantic checks', () => {
  it('flags capacitor voltage and absolute maximum ratings', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    k.transact({ summary: 'x', ops: [{ op: 'set_param', ref: 'C1', params: { voltage: '10V' } }] });
    expect(codes(k)).toContain('SEM.CAP_VOLTAGE C1');
    k.transact({ summary: 'x', ops: [{ op: 'set_param', ref: 'C1', params: { voltage: '16V' } }] });
    expect(codes(k)).toContain('SEM.CAP_DERATING C1');
    k.transact({ summary: 'x', ops: [{ op: 'set_net', net: '+12V', voltage: 30 }] });
    expect(codes(k)).toContain('SEM.ABS_MAX U1.VIN');
  });

  it('requires a power source for power pins, through series parts', () => {
    const k = new Kernel();
    k.transact({
      summary: 'ldo',
      ops: [
        { op: 'add_part', part: 'ams:AMS1117-3.3', refdes: 'U1' },
        { op: 'connect', pins: ['U1.VIN'], net: 'VBUS' },
        { op: 'connect', pins: ['U1.GND'], net: 'GND' },
      ],
    });
    expect(codes(k)).toContain('ERC.POWER_UNDRIVEN net:VBUS');
    k.transact({ summary: 'x', ops: [{ op: 'set_net', net: 'VBUS', external: true, voltage: 5 }] });
    expect(codes(k)).not.toContain('ERC.POWER_UNDRIVEN net:VBUS');
    expect(codes(k)).toContain('SEM.DECOUPLING U1.VIN');
  });

  it('waivers silence exactly the waived diagnostic', () => {
    const k = new Kernel();
    k.transact(buckTransaction({ withBootCap: false }));
    k.transact({ summary: 'w', ops: [{ op: 'add_waiver', code: 'ERC.PIN_UNCONNECTED', entities: ['U1.BOOT'], reason: 'test waiver reason' }] });
    expect(codes(k)).not.toContain('ERC.PIN_UNCONNECTED U1.BOOT');
    expect(k.state().counts.waived).toBe(1);
  });
});

describe('ledger', () => {
  it('hard param constraints block conflicting edits and replace older entries', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    let r = k.transact({ summary: 'hint', ops: [
      { op: 'set_param', ref: 'C2', params: { capacitance: '100uF' } },
      { op: 'constrain', kind: 'param', a: 'C2', key: 'capacitance', value: '100uF', strength: 'hard', quote: 'make C2 100uF' },
    ] });
    expect(r.status).toBe('ok');
    r = k.transact({ summary: 'x', ops: [{ op: 'set_param', ref: 'C2', params: { capacitance: '47uF' } }] });
    expect(r.rejection).toMatchObject({ code: 'CONSTRAINT_CONFLICT' });
    expect(r.rejection?.message).toContain('make C2 100uF');
  });

  it('left_of constraints move parts in the schematic and are evaluated', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    k.transact({ summary: 'hint', ops: [{ op: 'constrain', kind: 'left_of', a: 'C1', b: 'U1', quote: 'put C1 left of U1' }] });
    const s = k.state();
    const entry = s.ledger[0]!;
    expect(entry.text).toBe('left_of(C1, U1)');
    expect(entry.status).toBe('ok');
  });

  it('contradicting soft directional hints replace each other', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    k.transact({ summary: 'a', ops: [{ op: 'constrain', kind: 'left_of', a: 'C1', b: 'U1' }] });
    const r = k.transact({ summary: 'b', ops: [{ op: 'constrain', kind: 'right_of', a: 'C1', b: 'U1' }] });
    expect(r.results[0]?.effect).toMatch(/replaces/);
    expect(k.state().ledger.map((l) => l.text)).toEqual(['right_of(C1, U1)']);
  });
});

describe('changesets', () => {
  it('accepts a subset of hunks and keeps the rest out', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    k.accept();
    k.transact({ summary: 'tweak', ops: [
      { op: 'set_param', ref: 'R2', params: { resistance: '10k' } },
      { op: 'add_part', part: 'generic:C', refdes: 'C9', params: { capacitance: '100nF', voltage: '25V' } },
      { op: 'connect', pins: ['C9.1'], net: '+12V' },
      { op: 'connect', pins: ['C9.2'], net: 'GND' },
    ] });
    const p = k.proposal()!;
    expect(p.hunks.map((h) => h.title)).toEqual(['C9 100nF 25V', 'R2 10.2k → 10k']);
    const c9 = p.hunks.find((h) => h.title.startsWith('C9'))!;
    k.accept([c9.id], 'user');
    const s = k.state();
    expect(s.summary.components.find((c) => c.refdes === 'R2')?.value).toBe('10.2k');
    expect(s.summary.components.find((c) => c.refdes === 'C9')).toBeTruthy();
    expect(s.proposal).toBeNull();
  });

  it('undo restores the previous commit', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    k.accept();
    k.transact({ summary: 'rm', ops: [{ op: 'remove', ref: 'C2' }] });
    k.accept();
    expect(k.state().summary.components.some((c) => c.refdes === 'C2')).toBe(false);
    k.undo();
    expect(k.state().summary.components.some((c) => c.refdes === 'C2')).toBe(true);
  });
});

describe('determinism', () => {
  it('same ops → identical canonical file and layout', () => {
    const a = new Kernel();
    const b = new Kernel();
    a.transact(buckTransaction());
    b.transact(buckTransaction());
    a.accept();
    b.accept();
    expect(a.exportDesign()).toBe(b.exportDesign());
    expect(JSON.stringify(a.state().view)).toBe(JSON.stringify(b.state().view));
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{\n  "a": [\n    {\n      "c": 2,\n      "d": 1\n    }\n  ],\n  "b": 1\n}\n');
  });

  it('round-trips through the native format', () => {
    const a = new Kernel();
    a.transact(buckTransaction());
    a.accept();
    const b = new Kernel(JSON.parse(a.exportDesign()));
    expect(b.exportDesign()).toBe(a.exportDesign());
  });
});

describe('design description', () => {
  const blocks = [
    { title: 'Input', refs: ['J1', 'C1'], text: 'The 12 V input and its bulk capacitor.' },
    { title: 'Buck regulator', refs: ['U1', 'L1', 'D1', 'C2', 'C3', 'R1', 'R2'], text: 'TPS54331 stepping 12 V down to 3.3 V.' },
  ];

  it('is written with describe, reviewed as one hunk and kept in the file', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    k.accept();
    const all = k.state().summary.components.map((c) => c.refdes);
    const r = k.transact({ summary: 'describe', ops: [{ op: 'describe', overview: 'A 12 V to 3.3 V supply.', blocks }] });
    expect(r.status).toBe('ok');
    const covered = new Set(blocks.flatMap((b) => b.refs));
    expect(r.results[0]!.effect).toBe(`description: overview, 2 blocks; in no block yet: ${all.filter((x) => !covered.has(x)).join(', ')}`);
    expect(k.proposal()!.hunks.map((h) => [h.kind, h.title, h.details])).toEqual([['description', 'design description: overview, 2 blocks', ['Input', 'Buck regulator']]]);
    k.accept();
    const d = k.state().description!;
    expect(d.blocks[1]!.refs).toEqual(['C2', 'C3', 'D1', 'L1', 'R1', 'R2', 'U1']);
    expect(d.undescribed).toEqual(all.filter((x) => !covered.has(x)));
    expect(k.state().summary.description).toEqual({ blocks: 2, undescribed: d.undescribed });
    expect(JSON.parse(k.exportDesign()).description.overview).toBe('A 12 V to 3.3 V supply.');
    expect(k.query({ op: 'get_description' })).toEqual(d);
  });

  it('keeps what is not given, follows renames and drops removed parts', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    k.transact({ summary: 'describe', ops: [{ op: 'describe', overview: 'First.', blocks }] });
    k.transact({ summary: 'edit', ops: [{ op: 'describe', overview: 'Second.' }, { op: 'rename', ref: 'C1', refdes: 'C10' }, { op: 'remove', ref: 'R2' }] });
    const d = k.state().description!;
    expect(d.overview).toBe('Second.');
    expect(d.blocks.map((b) => b.refs)).toEqual([['C10', 'J1'], ['C2', 'C3', 'D1', 'L1', 'R1', 'U1']]);
  });

  it('refuses a part in two blocks and unknown parts', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    const twice = k.transact({ summary: 'd', ops: [{ op: 'describe', blocks: [blocks[0], { title: 'Again', refs: ['C1'], text: 'x' }] }] });
    expect(twice.rejection?.message).toContain('C1 is in two blocks');
    expect(k.transact({ summary: 'd', ops: [{ op: 'describe', blocks: [{ title: 'X', refs: ['Q99'], text: 'x' }] }] }).rejection?.code).toBe('REF_UNKNOWN');
    expect(k.transact({ summary: 'd', ops: [{ op: 'describe' }] }).rejection?.code).toBe('INVALID_OP');
    expect(k.state().description).toBeNull();
  });
});
