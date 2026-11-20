import { describe, expect, it } from 'vitest';
import { Kernel } from '../src/index.ts';
import { buckTransaction } from './fixtures.ts';

const codes = (k: Kernel) => k.state().diagnostics.filter((d) => !d.waivedBy).map((d) => `${d.code} ${d.entities.join(',')}`);
const comp = (k: Kernel, refdes: string) => Object.values(k.draftDesign().components).find((c) => c.refdes === refdes)!;

function buck() {
  const k = new Kernel();
  expect(k.transact(buckTransaction()).status).toBe('ok');
  return k;
}

describe('do not populate (set_dnp)', () => {
  it('sets and clears the flag, says so, and get_component shows it', () => {
    const k = buck();
    const r = k.transact({ summary: 'dnp', ops: [{ op: 'set_dnp', refs: ['C4', 'R3'], dnp: true }] });
    expect(r.status).toBe('ok');
    expect(comp(k, 'C4').dnp).toBe(true);
    expect(comp(k, 'R3').dnp).toBe(true);
    expect(k.query({ op: 'get_component', ref: 'C4' })).toMatchObject({ dnp: true });
    k.transact({ summary: 'fit', ops: [{ op: 'set_dnp', refs: ['C4'], dnp: false }] });
    expect(comp(k, 'C4').dnp).toBeUndefined();
    expect(comp(k, 'R3').dnp).toBe(true);
    expect(k.query({ op: 'get_component', ref: 'C4' })).not.toHaveProperty('dnp');
  });

  it('is a change to review: one hunk for the part, kept when it is accepted', () => {
    const k = buck();
    k.accept();
    k.transact({ summary: 'dnp', ops: [{ op: 'set_dnp', refs: ['C4'], dnp: true }] });
    const hunks = k.proposal()!.hunks.filter((h) => h.kind === 'component');
    expect(hunks.map((h) => [h.title, h.details])).toEqual([['C4 do not populate', ['do not populate']]]);
    k.accept(hunks.map((h) => h.id));
    expect(Object.values(k.committedDesign().components).find((c) => c.refdes === 'C4')!.dnp).toBe(true);
  });

  it('refuses an unknown part', () => {
    const k = buck();
    const r = k.transact({ summary: 'dnp', ops: [{ op: 'set_dnp', refs: ['C99'], dnp: true }] });
    expect(r.status).toBe('rejected');
  });

  it('keeps the part on the board with its pads on their nets, marked dnp', () => {
    const k = buck();
    k.transact({ summary: 'dnp', ops: [{ op: 'set_dnp', refs: ['C4'], dnp: true }] });
    const b = k.boardPlacement();
    const c4 = b.parts.find((p) => p.refdes === 'C4')!;
    expect(c4.dnp).toBe(true);
    expect(c4.pads).toHaveLength(2);
    expect(c4.pads.every((p) => p.netId)).toBe(true);
    expect(b.parts.find((p) => p.refdes === 'C1')!.dnp).toBeUndefined();
  });

  it('shows DNP by the value on the schematic, and takes it away when cleared', () => {
    const k = buck();
    k.transact({ summary: 'dnp', ops: [{ op: 'set_dnp', refs: ['C4', 'R3'], dnp: true }] });
    const sym = (ref: string) => k.state().view.sheets.flatMap((s) => s.symbols).find((s) => s.refdes === ref)!;
    expect(sym('C4').valueLines).toEqual(['100nF', '25V', 'DNP']);
    expect(sym('R3').valueLines).toEqual(['8.2k', 'DNP']);
    k.transact({ summary: 'fit', ops: [{ op: 'set_dnp', refs: ['C4', 'R3'], dnp: false }] });
    expect(sym('C4').valueLines).toEqual(['100nF', '25V']);
    expect(sym('R3').valueLines).toBeUndefined();
  });

  it('a DNP part does not meet a requirement; fitted again, it does', () => {
    const k = buck();
    k.transact({ summary: 'dnp', ops: [{ op: 'set_dnp', refs: ['C4', 'C1'], dnp: true }] });
    expect(codes(k)).toContain('SEM.REQUIREMENT U1.BOOT,U1.PH');
    expect(codes(k)).toContain('SEM.DECOUPLING U1.VIN');
    k.transact({ summary: 'fit', ops: [{ op: 'set_dnp', refs: ['C4', 'C1'], dnp: false }] });
    expect(codes(k)).not.toContain('SEM.REQUIREMENT U1.BOOT,U1.PH');
    expect(codes(k)).not.toContain('SEM.DECOUPLING U1.VIN');
  });

  it('a DNP pull-up does not meet a pull requirement', () => {
    const k = new Kernel();
    k.transact({
      summary: 'mcu',
      ops: [
        { op: 'add_part', part: 'microchip:ATTINY85-20SU', refdes: 'U1' },
        { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '10k' } },
        { op: 'connect', pins: ['U1.VCC', 'R1.1'], net: '+5V' },
        { op: 'set_net', net: '+5V', external: true, voltage: 5 },
        { op: 'connect', pins: ['U1.PB5/RESET', 'R1.2'], net: 'RESET' },
      ],
    });
    expect(codes(k).some((c) => c.startsWith('SEM.PULL'))).toBe(false);
    k.transact({ summary: 'dnp', ops: [{ op: 'set_dnp', refs: ['R1'], dnp: true }] });
    expect(codes(k)).toContain('SEM.PULL U1.PB5/RESET');
  });
});
