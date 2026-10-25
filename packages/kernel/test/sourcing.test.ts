import { describe, expect, it } from 'vitest';
import { Kernel } from '../src/index.ts';
import { buckTransaction } from './fixtures.ts';

/** The lcsc parameter: sourcing for JLCPCB assembly, allowed on every part. */
describe('lcsc parameter', () => {
  it('is accepted on generic parts and on ICs, normalised to C + digits', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    const r = k.transact({ summary: 'source', ops: [{ op: 'set_param', ref: 'R3', params: { lcsc: 'c25804' } }, { op: 'set_param', ref: 'U1', params: { lcsc: 'C9865' } }] });
    expect(r.status).toBe('ok');
    const r3 = k.query({ op: 'get_component', ref: 'R3' }) as { params: Record<string, string>; specs: Record<string, unknown>; category: string };
    expect(r3.params.lcsc).toBe('C25804');
    expect(r3.category).toBe('resistor');
    expect(Object.keys(r3.specs)).toEqual(['resistance', 'tolerance', 'power', 'package', 'lcsc', 'eurocircuits']);
    expect((k.query({ op: 'get_component', ref: 'U1' }) as { params: Record<string, string> }).params.lcsc).toBe('C9865');
  });

  it('rejects something that is not an LCSC number, and removes with null', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    const bad = k.transact({ summary: 'bad', ops: [{ op: 'set_param', ref: 'R3', params: { lcsc: 'RC0603FR-0710KL' } }] });
    expect(bad.status).toBe('rejected');
    expect(bad.rejection).toMatchObject({ code: 'PARAM_INVALID' });
    expect(bad.rejection?.message).toMatch(/C25804/);
    k.transact({ summary: 'set', ops: [{ op: 'set_param', ref: 'R3', params: { lcsc: 'C25804' } }] });
    k.transact({ summary: 'unset', ops: [{ op: 'set_param', ref: 'R3', params: { lcsc: null } }] });
    expect((k.query({ op: 'get_component', ref: 'R3' }) as { params: Record<string, string> }).params.lcsc).toBeUndefined();
  });

  it('reaches the board parts for the BOM', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    k.transact({ summary: 'source', ops: [{ op: 'set_param', ref: 'R3', params: { lcsc: 'C25804' } }] });
    const parts = k.boardPlacement().parts;
    expect(parts.find((p) => p.refdes === 'R3')?.lcsc).toBe('C25804');
    expect(parts.find((p) => p.refdes === 'R2')?.lcsc).toBeUndefined();
  });
});

/** The eurocircuits parameter: the part Eurocircuits assembles, a Generic number or an MPN. */
describe('eurocircuits parameter', () => {
  it('takes a Generic number (in capitals) or a manufacturer part number, and reaches the board parts', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    const r = k.transact({ summary: 'source', ops: [{ op: 'set_param', ref: 'R3', params: { eurocircuits: ' gpr06034k7 ' } }, { op: 'set_param', ref: 'C1', params: { eurocircuits: 'GRM188R71H104KA93D' } }] });
    expect(r.status).toBe('ok');
    const parts = k.boardPlacement().parts;
    expect(parts.find((p) => p.refdes === 'R3')?.eurocircuits).toBe('GPR06034K7');
    expect(parts.find((p) => p.refdes === 'C1')?.eurocircuits).toBe('GRM188R71H104KA93D');
    const bad = k.transact({ summary: 'bad', ops: [{ op: 'set_param', ref: 'R3', params: { eurocircuits: 'x' } }] });
    expect(bad.rejection).toMatchObject({ code: 'PARAM_INVALID', message: 'R3.eurocircuits = "x" is not a Eurocircuits part number (e.g. GPR06034K7).' });
  });
});
