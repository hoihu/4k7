import { describe, expect, it } from 'vitest';
import { DEFAULT_BOARD, type Design, type Diagnostic, type PartCard } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { buckTransaction } from './fixtures.ts';

const diags = (k: Kernel, code?: string) => (k.query({ op: 'get_diagnostics' }) as Diagnostic[]).filter((x) => x.code.startsWith('XCHK.') && (!code || x.code === code));

/** A part from a made-up maker: `pins` as the symbol numbers them, the package as given. */
const card = (id: string, pins: string[], extra: Partial<PartCard> = {}): PartCard => ({
  id,
  mpn: id,
  manufacturer: 'Acme',
  description: 'test part',
  category: 'other',
  refPrefix: 'X',
  package: 'SOD-123',
  pins: pins.map((n) => ({ number: n, name: n, type: 'passive' as const })),
  params: {},
  provenance: { source: 'datasheet' },
  ...extra,
});

/** The part as X1 beside a connector J1: X1's first two pins on nets N1 and N2. `edit` changes the design after (a state the ops would not let it reach). */
function withPart(c: PartCard, edit: (d: Design) => void = () => {}) {
  const k = new Kernel();
  const d = k.committedDesign();
  d.parts[c.id] = c;
  k.load(d);
  k.transact({ summary: 'part', ops: [
    { op: 'add_part', part: c.id, refdes: 'X1' },
    { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
    { op: 'connect', pins: ['J1.1', `X1.${c.pins[0]!.number}`], net: 'N1' },
    { op: 'connect', pins: ['J1.2', `X1.${c.pins[1]!.number}`], net: 'N2' },
  ] });
  const e = k.draftDesign();
  edit(e);
  k.load(e);
  return k;
}

const comp = (d: Design, refdes: string) => Object.values(d.components).find((c) => c.refdes === refdes)!;
const pad = (number: string, x: number, extra: Record<string, unknown> = {}) => ({ number, x, y: 0, w: 1.6, ...extra });

describe('XCHK: schematic, board and BOM agree', () => {
  it('finds nothing in a design whose pins, pads and package agree', () => {
    const k = new Kernel();
    expect(k.transact(buckTransaction()).status).toBe('ok');
    expect(diags(k)).toEqual([]);
  });

  it('a symbol pin with no pad: the connected ones are an error, with the nets that lose a pad', () => {
    const k = withPart(card('acme:AK', ['A', 'K']));
    const [pin] = diags(k, 'XCHK.PIN_NO_PAD');
    expect(pin).toMatchObject({ severity: 'error', entities: ['X1'] });
    expect(pin!.message).toContain('pins A (N1), K (N2)');
    expect(pin!.message).toContain('set_footprint');
    const nets = diags(k, 'XCHK.NET_INCOMPLETE');
    expect(nets.map((x) => x.entities[0])).toEqual(['net:N1', 'net:N2']);
    expect(nets[0]).toMatchObject({ severity: 'error' });
    expect(nets[0]!.message).toContain('joins 2 pins');
    expect(nets[0]!.message).toContain('X1.A');
  });

  it('a pin with no pad that nothing connects is a note', () => {
    const k = withPart(card('acme:T3', ['1', '2', '3']));
    expect(diags(k, 'XCHK.PIN_NO_PAD')).toMatchObject([{ severity: 'info' }]);
    expect(diags(k, 'XCHK.NET_INCOMPLETE')).toEqual([]);
  });

  it('a pad no pin is on: a generated exposed pad, and a hand-drawn pad', () => {
    const dfn = card('acme:DFN6', ['1', '2', '3', '4', '5', '6'], {
      category: 'ic',
      packageInfo: { name: 'DFN-6', family: 'DFN', pins: 6, pitch_mm: 0.5, body_mm: [2, 2], span_mm: [2, 2], lead_length_mm: 0.4, lead_width_mm: 0.25, exposed_pad_mm: [1.2, 0.8] },
    });
    const [ep] = diags(withPart(dfn), 'XCHK.PAD_NO_PIN');
    expect(ep).toMatchObject({ severity: 'warning', entities: ['X1'] });
    expect(ep!.message).toContain('a pad EP');
    expect(ep!.message).toContain('exposed pad');
    // given by hand with a third pad: the generator refuses it, and the part is off the board
    const hand = card('acme:H', ['1', '2'], { packageInfo: { name: 'H', family: 'other', pins: 2, pads: [pad('1', -2), pad('2', 2), pad('3', 0)] } });
    const h = withPart(hand);
    expect(diags(h, 'XCHK.PAD_NO_PIN')[0]!.message).toContain('a pad 3');
    expect(diags(h, 'XCHK.NOT_IN_BOM')).toMatchObject([{ severity: 'warning', entities: ['X1'] }]);
  });

  it('a pin that matches a pad only in upper/lower case is not connected', () => {
    const k = withPart(card('acme:CASE', ['A1', 'A2'], { packageInfo: { name: 'CASE', family: 'other', pins: 2, pads: [pad('a1', -2), pad('A2', 2)] } }));
    const [m] = diags(k, 'XCHK.PIN_PAD_MAP');
    expect(m).toMatchObject({ severity: 'error', entities: ['X1'] });
    expect(m!.message).toContain('pin A1 matches pad a1 only in upper/lower case');
    expect(diags(k, 'XCHK.PIN_NO_PAD')).toEqual([]);
    expect(diags(k, 'XCHK.NET_INCOMPLETE').map((x) => x.entities[0])).toEqual(['net:N1']);
  });

  it('a pin on two different pads is ambiguous', () => {
    const k = withPart(card('acme:TWICE', ['1', '2'], { packageInfo: { name: 'TWICE', family: 'other', pins: 2, pads: [pad('1', -2, { also: ['2'] }), pad('2', 2)] } }));
    expect(diags(k, 'XCHK.PIN_PAD_MAP')).toMatchObject([{ severity: 'warning' }]);
    expect(diags(k, 'XCHK.PIN_PAD_MAP')[0]!.message).toContain('pin 2 is on pads 1 and 2');
  });

  it('a package parameter that the footprint does not follow', () => {
    // the part card has package data of its own, which wins
    const own = card('acme:OWN', ['1', '2'], { packageInfo: { name: '0603', family: 'CHIP', pins: 2, body_mm: [1.6, 0.8], lead_length_mm: 0.3, height_mm: 0.5 } });
    const k = withPart(own, (d) => { comp(d, 'X1').params.package = '0805'; });
    const [m] = diags(k, 'XCHK.PACKAGE_MISMATCH');
    expect(m).toMatchObject({ severity: 'warning', entities: ['X1'], fixHints: [{ op: 'set_param', ref: 'X1', params: { package: null } }] });
    expect(m!.message).toContain('package parameter says 0805, but its footprint is 0603');
    // a name nobody knows falls back to the card's package
    const j = new Kernel();
    j.transact({ summary: 'r', ops: [{ op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '1k' } }] });
    const d = j.draftDesign();
    comp(d, 'R1').params.package = 'bogus';
    j.load(d);
    expect(diags(j, 'XCHK.PACKAGE_MISMATCH')).toHaveLength(1);
    // the same package spelled another way is no mismatch
    comp(d, 'R1').params.package = 'R_0603';
    j.load(d);
    expect(diags(j, 'XCHK.PACKAGE_MISMATCH')).toEqual([]);
  });

  it('a part with no footprint is in neither the BOM nor the pick-and-place', () => {
    const buzzer = card('acme:BUZ', ['1', '2'], { package: 'BUZ12', packageInfo: { name: 'BUZ12', family: 'other', pins: 2, body_mm: [12, 12] } });
    const k = withPart(buzzer);
    expect(diags(k, 'XCHK.NOT_IN_BOM')[0]!.message).toContain('N1, N2 lose its pad');
    const r = k.transact({ summary: 'footprint', ops: [{ op: 'set_footprint', ref: 'X1', name: 'BUZ', pads: [{ number: '1', x: -3.8, y: 0, w: 1.6, drill: 0.9 }, { number: '2', x: 3.8, y: 0, w: 1.6, drill: 0.9 }], body_mm: [12, 12] }] });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    expect(diags(k, 'XCHK.NOT_IN_BOM')).toEqual([]);
  });

  it('board objects on a net the schematic does not have', () => {
    const k = withPart(card('acme:AK', ['1', '2']), (d) => {
      d.board = { ...DEFAULT_BOARD, holes: [{ id: 'MH1', d: 3, plated: true, netId: 'n_gone' }, { id: 'MH2', d: 3, plated: false }] };
    });
    const [m] = diags(k, 'XCHK.BOARD_NET_UNKNOWN');
    expect(m).toMatchObject({ severity: 'warning', entities: ['MH1'] });
    expect(m!.message).toContain('remove_hole');
  });

  it('a waiver covers a finding', () => {
    const k = withPart(card('acme:AK', ['A', 'K']));
    const r = k.transact({ summary: 'intended', ops: [{ op: 'add_waiver', code: 'XCHK.PIN_NO_PAD', entities: ['X1'], reason: 'a test part with no real footprint' }] });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    expect(diags(k, 'XCHK.PIN_NO_PAD')[0]!.waivedBy).toBeTruthy();
  });
});
