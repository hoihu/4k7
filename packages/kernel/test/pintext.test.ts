import { afterAll, describe, expect, it } from 'vitest';
import { registerUserParts, symbolFor, unregisterUserPart } from '@4k7/parts';
import { agentTools, type PartCard } from '@4k7/schema';
import { Kernel } from '../src/index.ts';

/** A part as saved in the library: no pin says what it does, but for what an import noted of one. */
const usbc: PartCard = {
  id: 'acme:USBC-TEST',
  mpn: 'USBC-TEST',
  description: 'USB Type-C receptacle',
  category: 'connector',
  refPrefix: 'J',
  pins: [
    { number: '1', name: 'GND', type: 'pwr_in', page: 1 },
    { number: '2', name: 'GND', type: 'pwr_in', page: 1 },
    { number: '3', name: 'VBUS', type: 'pwr_in', page: 1 },
    { number: '4', name: 'CC1', type: 'bidir', page: 1 },
    { number: '5', name: 'D+', type: 'bidir', description: 'alt: USB_DP, UART_TX', page: 1 },
    { number: '6', name: 'SHELL', type: 'passive', description: 'Shield', page: 1 },
  ],
  params: {},
  provenance: { source: 'datasheet' },
};
/** A tactile switch, four pins joined inside in pairs, which only the pins' texts say. */
const tact: PartCard = {
  id: 'acme:TACT-TEST',
  mpn: 'TACT-TEST',
  description: 'SMD tactile switch, 4 pads',
  category: 'other',
  refPrefix: 'SW',
  pins: [
    { number: '1', name: 'A', type: 'passive', description: 'Contact A, internally connected to B (pad 2)' },
    { number: '2', name: 'B', type: 'passive', description: 'Contact B, internally connected to A (pad 1)' },
    { number: '3', name: 'C', type: 'passive', description: 'Contact C, internally connected to D (pad 4)' },
    { number: '4', name: 'D', type: 'passive', description: 'Contact D, internally connected to C (pad 3)' },
  ],
  params: {},
  provenance: { source: 'datasheet' },
};
registerUserParts([usbc, tact]);
afterAll(() => {
  unregisterUserPart(usbc.id);
  unregisterUserPart(tact.id);
});

function placed(ops: unknown[] = [{ op: 'add_part', part: usbc.id, refdes: 'J2' }]): Kernel {
  const k = new Kernel();
  expect(k.transact({ summary: 'parts', ops } as never).status).toBe('ok');
  k.accept();
  return k;
}
const edit = (k: Kernel, ops: unknown[]) => k.transact({ summary: 'pins', ops } as never);
const describePins = (ref: string, pins: { pin: string; description: string }[]) => ({ op: 'set_pin_descriptions', ref, pins });
const pinsOf = (k: Kernel, id = usbc.id) => k.committedDesign().parts[id]!.pins;

describe('set_pin_descriptions', () => {
  it('writes on the design\'s copy of a saved part, by number or a shared name, and leaves the rest of each pin', () => {
    const k = placed();
    const r = edit(k, [describePins('J2', [{ pin: 'GND', description: 'Ground' }, { pin: '4', description: 'Configuration channel' }])]);
    expect(r.status).toBe('ok');
    expect(r.results[0]!.effect).toBe('J2: 3 pin descriptions');
    k.accept();
    expect(pinsOf(k).map((p) => p.description)).toEqual(['Ground', 'Ground', undefined, 'Configuration channel', 'alt: USB_DP, UART_TX', 'Shield']);
    expect(pinsOf(k)[3]).toMatchObject({ number: '4', name: 'CC1', type: 'bidir', page: 1 });
    expect(k.committedDesign().parts[usbc.id]!.customPinText).toBe(true);
    // the library's card is not touched by the kernel: the app adopts it from the committed design
    expect(usbc.pins[3]!.description).toBeUndefined();
  });

  it('applies to every component of the part, and the agent reads it back with get_part', () => {
    const k = placed([{ op: 'add_part', part: usbc.id, refdes: 'J2' }, { op: 'add_part', part: usbc.id, refdes: 'J3' }]);
    const r = edit(k, [describePins('j3', [{ pin: 'cc1', description: 'Configuration channel' }])]);
    expect(r.results[0]!.effect).toBe('J2, J3: 1 pin description');
    const part = k.query({ op: 'get_part', id: usbc.id }) as PartCard;
    expect(part.pins[3]!.description).toBe('Configuration channel');
  });

  it('the review shows what changes, and a rejection leaves the part as it was', () => {
    const k = placed();
    edit(k, [describePins('J2', [{ pin: '3', description: 'Bus power' }, { pin: '6', description: 'Shield, to ground' }])]);
    const hunk = k.proposal()?.hunks.find((h) => h.id === `part:${usbc.id}`);
    expect(hunk?.title).toBe('J2 2 pin descriptions');
    expect(hunk?.details).toEqual([usbc.id, '3 VBUS: Bus power', '6 SHELL: Shield, to ground']);
    k.reject();
    expect(k.committedDesign().parts[usbc.id]!.pins).toEqual(usbc.pins);
    expect(k.committedDesign().parts[usbc.id]!.customPinText).toBeUndefined();
    expect(k.proposal()).toBeNull();
  });

  it('an unconnected pin\'s error says what the pin does', () => {
    const k = placed();
    edit(k, [describePins('J2', [{ pin: '4', description: 'Configuration channel' }])]);
    k.accept();
    const d = k.state().diagnostics.find((x) => x.code === 'ERC.PIN_UNCONNECTED' && x.entities[0]!.endsWith('CC1'));
    expect(d?.message).toContain('(Configuration channel)');
  });

  it('keeps the alternate functions an import noted, unless they are given anew', () => {
    const k = placed();
    edit(k, [describePins('J2', [{ pin: '5', description: 'USB data +' }])]);
    k.accept();
    expect(pinsOf(k)[4]!.description).toBe('USB data + · alt: USB_DP, UART_TX');
    edit(k, [describePins('J2', [{ pin: '5', description: 'USB data, positive' }])]);
    k.accept();
    expect(pinsOf(k)[4]!.description).toBe('USB data, positive · alt: USB_DP, UART_TX');
    edit(k, [describePins('J2', [{ pin: '5', description: 'USB data · alt: USB_DP' }])]);
    k.accept();
    expect(pinsOf(k)[4]!.description).toBe('USB data · alt: USB_DP');
  });

  it('text the pins already have changes nothing and asks for no review', () => {
    const k = placed();
    const r = edit(k, [describePins('J2', [{ pin: '6', description: 'Shield' }])]);
    expect(r.status).toBe('ok');
    expect(r.results[0]!.effect).toContain('already');
    expect(k.proposal()).toBeNull();
    expect(k.committedDesign().parts[usbc.id]!.customPinText).toBeUndefined();
  });

  it('a pin the part does not have refuses all of them, and names the pins it has', () => {
    const k = placed();
    const r = edit(k, [describePins('J2', [{ pin: '3', description: 'Bus power' }, { pin: 'SBU1', description: 'Sideband' }])]);
    expect(r.status).toBe('rejected');
    expect(r.rejection).toMatchObject({ code: 'PIN_UNKNOWN', message: `J2 (${usbc.id}) has no pin "SBU1".` });
    expect(r.rejection!.candidates).toContain('4 CC1');
    expect(k.proposal()).toBeNull();
  });

  it('refuses a library part no component of the design uses', () => {
    const k = placed();
    const r = edit(k, [describePins(tact.id, [{ pin: '1', description: 'Contact' }])]);
    expect(r.status).toBe('rejected');
    expect(r.rejection).toMatchObject({ code: 'REF_UNKNOWN', message: `No component "${tact.id}".` });
    expect(k.committedDesign().parts[tact.id]).toBeUndefined();
  });

  it('refuses a generic part, whose card is shared, and an empty text', () => {
    const k = placed([{ op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' }, { op: 'add_part', part: usbc.id, refdes: 'J2' }]);
    const r = edit(k, [describePins('J1', [{ pin: '1', description: 'Battery +' }])]);
    expect(r.status).toBe('rejected');
    expect(r.rejection!.message).toContain('generic');
    expect(edit(k, [describePins('J2', [{ pin: '1', description: '   ' }])]).status).toBe('rejected');
  });

  it('a switch is drawn from what its pins say is joined inside: losing that redraws it and says so', () => {
    const k = placed([{ op: 'add_part', part: tact.id, refdes: 'SW1' }]);
    const before = symbolFor(tact);
    expect(before.pins.map((p) => [p.number, p.x])).toEqual([['1', -200], ['2', -200], ['3', 200], ['4', 200]]);
    expect(edit(k, [{ op: 'place_symbol', ref: 'SW1', page: 1, x: 3000, y: 3000 }]).status).toBe('ok');
    k.accept();

    // words that keep the pairs: the symbol stays
    const same = edit(k, [describePins('SW1', [{ pin: '1', description: 'One side, internally connected to B' }])]);
    expect(same.results[0]!.effect).toBe('SW1: 1 pin description');
    k.accept();

    // words that lose them: it is drawn as a box now, and the agent hears why
    const lost = edit(k, [describePins('SW1', ['1', '2', '3', '4'].map((pin) => ({ pin, description: 'Contact' })))]);
    expect(lost.status).toBe('ok');
    expect(lost.results[0]!.effect).toContain('drawn differently');
    expect(lost.results[0]!.effect).toContain('Redrawn where it stood');
    const card = k.draftDesign().parts[tact.id]!;
    expect(JSON.stringify(symbolFor(card))).not.toBe(JSON.stringify(before));
    const stored = k.draftDesign().drawing![Object.keys(k.draftDesign().drawing!)[0]!]!.symbols.find((s) => s.part === tact.id)!;
    const box = symbolFor(card);
    expect(stored.bbox.w).toBe(box.bbox.w);
    expect(stored.bbox.h).toBe(box.bbox.h);
  });

  it('the agent is offered it with the design tools', () => {
    const tool = agentTools('chat').find((t) => t.name === 'design_edit')!;
    expect(JSON.stringify(tool.input_schema)).toContain('set_pin_descriptions');
  });
});
