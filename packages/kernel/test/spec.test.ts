import { describe, expect, it } from 'vitest';
import { mustFix, type SpecAnswer, type TransactionResult } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { resolveBoard } from '../src/boards.ts';
import { buck, buckTransaction, twoBoards } from './fixtures.ts';

// The spec: what the board must do, each item with how the kernel can tell (docs/design/spec.md).

type By = 'user' | 'agent';
const tx = (k: Kernel, ops: unknown[], by: By = 'agent'): TransactionResult => k.transact({ summary: 'spec', ops }, by);
const ok = (k: Kernel, ops: unknown[], by: By = 'agent') => {
  const r = tx(k, ops, by);
  if (r.status !== 'ok') throw new Error(JSON.stringify(r.rejection));
  return r;
};
const spec = (k: Kernel) => k.query({ op: 'get_spec' }) as SpecAnswer;
const item = (k: Kernel, id: string) => spec(k).items.find((x) => x.id === id)!;
/** Add one item from the user, with these verifiers; its id. */
const add = (k: Kernel, text: string, verify: unknown[], by: By = 'user') => ok(k, [{ op: 'specify', text, verify }], by).results[0]!.ids![0]!;
/** One verifier's result. */
const result = (k: Kernel, v: unknown) => item(k, add(k, 'the thing it must do', [v])).verify[0]!;
const findings = (k: Kernel, code: string) => k.diagnostics().filter((x) => x.code === code);

describe('a design without a spec', () => {
  it('is untouched: the same findings, no spec in the summary or the state', () => {
    const k = buck();
    const plain = buck();
    expect(k.diagnostics()).toEqual(plain.diagnostics());
    expect(k.state().diagnostics).toEqual(plain.state().diagnostics);
    expect(k.summary()).not.toHaveProperty('spec');
    expect(k.state().spec).toBeNull();
    expect(spec(k).items).toEqual([]);
    expect(k.committedDesign()).not.toHaveProperty('spec');
  });

  it('is the same again once its last item is removed', () => {
    const k = buck();
    const before = k.diagnostics();
    const id = add(k, 'a 12 V input', [{ kind: 'measure', of: 'net.voltage', net: '+12V', min: 12, max: 12 }]);
    expect(k.summary().spec).toEqual({ verified: 1, violated: 0, unverified: 0, waived: 0, assumed: 0 });
    ok(k, [{ op: 'remove_spec', id }], 'user');
    expect(k.draftDesign()).not.toHaveProperty('spec');
    expect(k.diagnostics()).toEqual(before);
  });
});

describe('part verifiers', () => {
  it('holds when a fitted part matches', () => {
    const k = buck();
    const r = result(k, { kind: 'part', category: 'ic', pins: ['vin', 'PH'] });
    expect(r.result).toBe('holds');
    expect(r.why).toContain('U1');
    expect(result(k, { kind: 'part', text: ['tps5433'] }).result).toBe('holds');
  });

  it('fails when none does: a USB-C connector is not a pin header', () => {
    const k = buck();
    const id = add(k, 'USB-C connector', [{ kind: 'part', category: 'connector', pins: ['CC1', 'CC2'] }]);
    expect(item(k, id).status).toBe('violated');
    const [f] = findings(k, 'SPEC.VIOLATED');
    expect(f!.severity).toBe('error');
    expect(f!.entities).toEqual([id]);
    expect(f!.message).toBe('"USB-C connector": no fitted connector has pins CC1 and CC2');
    // not a must-fix error: propose asks about the spec on its own
    expect(mustFix(f!)).toBe(false);
  });

  it('fails when a part that must not be there is fitted, naming it', () => {
    const k = buck();
    const r = result(k, { kind: 'part', category: 'diode', min: 0, max: 0 });
    expect(r.result).toBe('fails');
    expect(r.why).toMatch(/^D1 is a fitted diode/);
    expect(findings(k, 'SPEC.VIOLATED')[0]!.entities).toContain('D1');
  });

  it('is unknown when the board it counts on is gone', () => {
    const k = twoBoards();
    const id = add(k, 'an LED on the LED board', [{ kind: 'part', category: 'led', board: 'LED board' }]);
    expect(item(k, id).verify[0]!.result).toBe('holds');
    ok(k, [{ op: 'remove_board', board: 'LED board' }]);
    expect(item(k, id).verify[0]!).toMatchObject({ result: 'unknown', why: 'the board it counts on is no longer in the design' });
    expect(findings(k, 'SPEC.UNVERIFIED')[0]!.message).toContain('no longer in the design');
  });

  it('is refused with nothing to match', () => {
    const r = tx(buck(), [{ op: 'specify', text: 'some part', verify: [{ kind: 'part', min: 1 }] }]);
    expect(r.rejection?.code).toBe('INVALID_OP');
  });
});

describe('measure verifiers', () => {
  it('holds, fails or is unknown on a net\'s declared numbers', () => {
    const k = buck();
    expect(result(k, { kind: 'measure', of: 'net.voltage', net: '+3V3', min: 3.2, max: 3.4 })).toMatchObject({ result: 'holds', why: "+3V3's voltage is 3.3 V" });
    expect(result(k, { kind: 'measure', of: 'net.max_current', net: '+3V3', min: 3 })).toMatchObject({ result: 'fails', why: "+3V3's max_current is 2 A, wanted at least 3 A" });
    expect(result(k, { kind: 'measure', of: 'net.voltage', net: 'FB', min: 0 })).toMatchObject({ result: 'unknown', why: 'FB has no voltage set (set_net voltage)' });
  });

  it('measures the board: its outline and layers always, its open connections once it is routed', () => {
    const k = buck();
    const w = k.boardPlacement().outline.w;
    expect(result(k, { kind: 'measure', of: 'board.width_mm', max: w + 1 }).result).toBe('holds');
    expect(result(k, { kind: 'measure', of: 'board.width_mm', max: w - 1 }).result).toBe('fails');
    expect(result(k, { kind: 'measure', of: 'board.layers', max: 2 }).result).toBe('holds');
    expect(result(k, { kind: 'measure', of: 'parts.fitted', min: 12, max: 12 }).result).toBe('holds');
    const open = add(k, 'routed', [{ kind: 'measure', of: 'board.open_connections', max: 1000 }]);
    expect(item(k, open).verify[0]!).toMatchObject({ result: 'unknown', why: 'the board is not routed for its placement' });
    ok(k, [{ op: 'route' }]);
    expect(k.board().routing).toBe('done');
    expect(item(k, open).verify[0]!.result).toBe('holds');
  });

  it('is refused without a bound, or with a net it does not take', () => {
    expect(tx(buck(), [{ op: 'specify', text: 'small', verify: [{ kind: 'measure', of: 'board.width_mm' }] }]).rejection?.code).toBe('INVALID_OP');
    expect(tx(buck(), [{ op: 'specify', text: 'rail', verify: [{ kind: 'measure', of: 'net.voltage', net: 'NOPE', min: 1 }] }]).rejection?.code).toBe('NET_UNKNOWN');
    expect(tx(buck(), [{ op: 'specify', text: 'small', verify: [{ kind: 'measure', of: 'board.width_mm', board: 'Other', max: 3 }] }]).rejection?.code).toBe('REF_UNKNOWN');
  });
});

describe('check verifiers', () => {
  it('holds while the check finds nothing there, fails while it does', () => {
    const good = buck();
    expect(result(good, { kind: 'check', code: 'ERC.PIN_UNCONNECTED', entities: ['U1'] }).result).toBe('holds');
    // without its boot capacitor U1.BOOT is left open
    const bad = new Kernel();
    ok(bad, buckTransaction({ withBootCap: false }).ops);
    const r = result(bad, { kind: 'check', code: 'ERC.PIN_UNCONNECTED', entities: ['U1'] });
    expect(r.result).toBe('fails');
    expect(r.why).toMatch(/^ERC\.PIN_UNCONNECTED: .*BOOT/);
    expect(findings(bad, 'SPEC.VIOLATED')[0]!.entities).toEqual([expect.stringMatching(/^q_/), 'U1.BOOT']);
  });

  it('is unknown for a board check while the board is not routed', () => {
    const k = buck();
    expect(result(k, { kind: 'check', code: 'DRC.CLEARANCE' })).toMatchObject({ result: 'unknown' });
    // routed, and the copper kept with the board (as the app does when the board worker is done)
    ok(k, [{ op: 'route' }]);
    k.keepCopper(k.board().newCopper!);
    expect(result(k, { kind: 'check', code: 'DRC.CLEARANCE' }).result).toBe('holds');
  });

  it('is unknown while the check says it could not judge', () => {
    const k = buck();
    ok(k, [{ op: 'route' }]);
    k.keepCopper(k.board().newCopper!);
    // +12V has no max_current: the current check could not judge its copper (DRC.CURRENT_UNKNOWN)
    expect(k.board().diagnostics.some((x) => x.code === 'DRC.CURRENT_UNKNOWN' && x.entities.includes('net:+12V'))).toBe(true);
    expect(result(k, { kind: 'check', code: 'DRC.TRACK_CURRENT', entities: ['net:+12V'] })).toMatchObject({ result: 'unknown', why: expect.stringMatching(/^DRC\.CURRENT_UNKNOWN is open on net:\+12V: DRC\.TRACK_CURRENT could not judge/) });
  });

  it('refuses a code that is not known, or not the kernel\'s', () => {
    for (const code of ['SEM.NOPE', 'FAB.SHORT', 'PANEL.TAB', 'ENC.SIZE', 'SPEC.VIOLATED']) {
      expect(tx(buck(), [{ op: 'specify', text: 'a check', verify: [{ kind: 'check', code }] }]).rejection?.code, code).toBe('INVALID_OP');
    }
    expect(tx(buck(), [{ op: 'specify', text: 'a check', verify: [{ kind: 'check', code: 'ERC.PIN_UNCONNECTED', entities: ['U7'] }] }]).rejection?.code).toBe('REF_UNKNOWN');
  });

  it('keeps working when a part or net it names is renamed', () => {
    const k = buck();
    const id = add(k, 'no floating input on the regulator', [
      { kind: 'check', code: 'SEM.REQUIREMENT', entities: ['U1', 'net:+3V3'] },
      { kind: 'measure', of: 'net.voltage', net: '+3V3', min: 3.3, max: 3.3 },
    ]);
    expect(item(k, id).status).toBe('verified');
    ok(k, [{ op: 'rename', ref: 'U1', refdes: 'U9' }, { op: 'set_net', net: '+3V3', rename: 'VCC' }]);
    const it2 = item(k, id);
    expect(it2.status).toBe('verified');
    expect(it2.verify[0]!).toMatchObject({ entities: ['U9', 'net:VCC'], result: 'holds' });
    expect(it2.verify[1]!).toMatchObject({ net: 'VCC', result: 'holds', why: "VCC's voltage is 3.3 V" });
  });
});

describe('manual verifiers', () => {
  it('holds once the user ticks it, and is unknown until then', () => {
    const k = buck();
    const id = add(k, 'the button feels right', [{ kind: 'manual', note: 'press it in the housing' }]);
    expect(item(k, id)).toMatchObject({ status: 'unverified', verify: [{ result: 'unknown' }] });
    expect(findings(k, 'SPEC.UNVERIFIED')[0]!.message).toBe('"the button feels right": waiting for the user\'s tick: press it in the housing');
    // the agent cannot tick it for the user, only pass on their words
    expect(tx(k, [{ op: 'specify', id, done: true }]).rejection?.code).toBe('INVALID_OP');
    ok(k, [{ op: 'specify', id, done: true, quote: 'yes, the button is fine' }]);
    expect(item(k, id)).toMatchObject({ status: 'verified', verify: [{ result: 'holds' }] });
    ok(k, [{ op: 'specify', id, done: false }], 'user');
    expect(item(k, id).status).toBe('unverified');
  });

  it('refuses done on an item without a manual verifier', () => {
    const k = buck();
    const id = add(k, 'two layers', [{ kind: 'measure', of: 'board.layers', max: 2 }]);
    expect(tx(k, [{ op: 'specify', id, done: true }], 'user').rejection?.code).toBe('INVALID_OP');
  });
});

describe('the status and the findings', () => {
  it('is unverified with nothing to verify it, and assumed while the agent wrote it', () => {
    const k = buck();
    const r = ok(k, [{ op: 'specify', text: 'the input is 12 V from a wall adapter' }]);
    const id = r.results[0]!.ids![0]!;
    expect(r.results[0]!.effect).toContain('now unverified: nothing verifies it yet (assumed)');
    expect(item(k, id)).toMatchObject({ assumed: true, status: 'unverified', source: { type: 'agent' } });
    expect(findings(k, 'SPEC.UNVERIFIED').map((x) => x.message)).toEqual(['"the input is 12 V from a wall adapter": nothing verifies it']);
    expect(findings(k, 'SPEC.ASSUMED').map((x) => x.message)).toEqual(['"the input is 12 V from a wall adapter": assumed, not confirmed by the user']);
    expect(k.summary().spec).toEqual({ verified: 0, violated: 0, unverified: 1, waived: 0, assumed: 1 });
    expect(k.state().spec?.counts.assumed).toBe(1);
    // the findings are in the one list: the state, the counts and get_diagnostics
    expect(k.state().diagnostics.some((x) => x.code === 'SPEC.ASSUMED')).toBe(true);
    const page = k.query({ op: 'get_diagnostics', code: 'SPEC.ASSUMED' }) as { diagnostics: { code: string }[] };
    expect(page.diagnostics).toHaveLength(1);
  });

  it('reports a violated item as introduced by the transaction that broke it', () => {
    const k = buck();
    add(k, 'the rail gives 2 A', [{ kind: 'measure', of: 'net.max_current', net: '+3V3', min: 2 }]);
    const r = ok(k, [{ op: 'set_net', net: '+3V3', max_current: 1 }]);
    expect(r.introduced.map((x) => x.code)).toContain('SPEC.VIOLATED');
    expect(r.counts.errors).toBeGreaterThan(0);
  });

  it('waives a violated item with add_waiver, and drops the waiver with the item', () => {
    const k = buck();
    const id = add(k, 'USB-C connector', [{ kind: 'part', category: 'connector', pins: ['CC1', 'CC2'] }]);
    const errors = k.state().counts.errors;
    const w = ok(k, [{ op: 'add_waiver', code: 'SPEC.VIOLATED', entities: [id], reason: 'the first revision has a pin header' }], 'user').results[0]!.ids![0]!;
    expect(item(k, id).status).toBe('waived');
    expect(spec(k).counts).toMatchObject({ waived: 1, violated: 0 });
    expect(findings(k, 'SPEC.VIOLATED')[0]!.waivedBy).toBe(w);
    expect(k.state().counts.errors).toBe(errors - 1);
    const r = ok(k, [{ op: 'remove_spec', id }], 'user');
    expect(r.results[0]!.ids).toEqual([id, w]);
    expect(k.draftDesign().waivers[w]).toBeUndefined();
  });

  it('shows items in the changeset as spec hunks, accepted one by one', () => {
    const k = buck();
    ok(k, [
      { op: 'specify', text: 'USB-C input', quote: 'power it from USB-C', verify: [{ kind: 'part', category: 'connector', pins: ['CC1', 'CC2'] }] },
      { op: 'specify', text: 'two layers', verify: [{ kind: 'measure', of: 'board.layers', max: 2 }] },
    ]);
    const hunks = k.proposal()!.hunks.filter((h) => h.kind === 'spec');
    expect(hunks.map((h) => h.title).sort()).toEqual(['spec: USB-C input', 'spec: two layers']);
    const usb = hunks.find((h) => h.title === 'spec: USB-C input')!;
    expect(usb.details).toEqual(['a fitted connector with pins CC1 and CC2', '“power it from USB-C”']);
    expect(hunks.find((h) => h.title === 'spec: two layers')!.details).toContain('assumed: not confirmed by the user');
    k.accept([usb.id]);
    expect(Object.values(k.committedDesign().spec!).map((x) => x.text)).toEqual(['USB-C input']);
  });
});

describe('who may change an item', () => {
  it('keeps a user\'s item theirs: the agent may only add verifiers without their words', () => {
    const k = buck();
    const id = add(k, 'two layers', [{ kind: 'measure', of: 'board.layers', max: 2 }]);
    expect(item(k, id).source).toEqual({ type: 'user' });
    expect(tx(k, [{ op: 'specify', id, text: 'four layers' }]).rejection?.message).toContain('Ask the user');
    expect(tx(k, [{ op: 'specify', id, verify: [] }]).rejection?.code).toBe('INVALID_OP');
    expect(tx(k, [{ op: 'specify', id, verify: [{ kind: 'measure', of: 'board.layers', max: 4 }] }]).rejection?.code).toBe('INVALID_OP');
    ok(k, [{ op: 'specify', id, verify: [{ kind: 'measure', of: 'board.layers', max: 2 }, { kind: 'measure', of: 'board.layers', min: 2 }] }]);
    expect(item(k, id).verify).toHaveLength(2);
    expect(tx(k, [{ op: 'remove_spec', id }]).rejection?.code).toBe('INVALID_OP');
    // with the user's words it may
    ok(k, [{ op: 'specify', id, text: 'four layers', verify: [{ kind: 'measure', of: 'board.layers', min: 4, max: 4 }], quote: 'make it four layers' }]);
    expect(item(k, id)).toMatchObject({ text: 'four layers', source: { type: 'user', quote: 'make it four layers' }, status: 'violated' });
    ok(k, [{ op: 'remove_spec', id, quote: 'forget the layer count' }]);
    expect(spec(k).items).toEqual([]);
  });

  it('lets the agent change and drop its own assumptions, and the user confirm them', () => {
    const k = buck();
    const a = add(k, 'input 12 V', [], 'agent');
    ok(k, [{ op: 'specify', id: a, text: 'input 12 V from a wall adapter' }]);
    expect(item(k, a)).toMatchObject({ assumed: true, text: 'input 12 V from a wall adapter' });
    // confirmed by the user in the app, or by the agent with the user's words
    ok(k, [{ op: 'specify', id: a }], 'user');
    expect(item(k, a)).toMatchObject({ assumed: false, source: { type: 'user' } });
    const b = add(k, 'one board', [], 'agent');
    const r = ok(k, [{ op: 'specify', id: b, quote: 'yes, one board' }]);
    expect(r.results[0]!.effect).toContain('confirmed by the user');
    expect(item(k, b)).toMatchObject({ assumed: false, source: { type: 'user', quote: 'yes, one board' } });
    const c = add(k, 'blue solder mask', [], 'agent');
    ok(k, [{ op: 'remove_spec', id: c }]);
    expect(spec(k).items.map((x) => x.id)).toEqual([a, b]);
  });

  it('refuses an unknown item', () => {
    const r = tx(buck(), [{ op: 'specify', id: 'q_zz', text: 'x y z' }]);
    expect(r.rejection?.code).toBe('REF_UNKNOWN');
    expect(tx(buck(), [{ op: 'remove_spec', id: 'q_zz' }]).rejection?.code).toBe('REF_UNKNOWN');
  });
});

describe('several boards', () => {
  it('takes a board measure on every board, or on the one named', () => {
    const k = twoBoards();
    const led = resolveBoard(k.draftDesign(), 'LED board').id;
    const ledW = k.boardPlacement(led).outline.w;
    const mainW = k.boardPlacement().outline.w;
    const both = item(k, add(k, 'narrow', [{ kind: 'measure', of: 'board.width_mm', max: Math.max(ledW, mainW) }]));
    expect(both.verify[0]!.result).toBe('holds');
    expect(both.verify[0]!.why).toContain('board "LED board"');
    const small = Math.min(ledW, mainW);
    if (small < Math.max(ledW, mainW)) {
      const r = item(k, add(k, 'small', [{ kind: 'measure', of: 'board.width_mm', max: small }]));
      expect(r.status).toBe('violated');
    }
    const one = item(k, add(k, 'a small LED board', [{ kind: 'measure', of: 'board.width_mm', board: 'LED board', max: ledW }]));
    expect(one).toMatchObject({ status: 'verified', verify: [{ board: 'LED board' }] });
    const noLed = item(k, add(k, 'an LED on the main board', [{ kind: 'part', category: 'led', board: 'Main' }]));
    expect(noLed.verify[0]!).toMatchObject({ result: 'fails', why: 'no fitted led on board "Main"' });
    expect(item(k, add(k, 'three parts on the LED board', [{ kind: 'measure', of: 'parts.fitted', board: 'LED board', min: 3, max: 3 }])).status).toBe('verified');
  });

  it('keeps working when a board is renamed', () => {
    const k = twoBoards();
    const id = add(k, 'an LED on the LED board', [{ kind: 'part', category: 'led', board: 'LED board' }]);
    ok(k, [{ op: 'set_board', board: 'LED board', name: 'Lamp' }]);
    expect(item(k, id)).toMatchObject({ status: 'verified', verify: [{ board: 'Lamp', result: 'holds' }] });
  });
});
