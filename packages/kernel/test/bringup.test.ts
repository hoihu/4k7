import { describe, expect, it } from 'vitest';
import type { Transaction } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { buckTransaction, twoBoards } from './fixtures.ts';

/**
 * The bring-up sheet (Kernel.bringUp, for the design document): the rails in power-up order, the
 * voltage to expect, the test point to probe, the bench supply's current limit. See docs/design/layout.md §4.
 */
function build(ops: Transaction['ops']): Kernel {
  const k = new Kernel();
  const r = k.transact({ summary: 'power', ops });
  expect(r.status, JSON.stringify(r)).toBe('ok');
  return k;
}

/** 5 V in on J1, an MCP1700 to 3.3 V with 100 mA of load stated (or none). */
const ldoBoard = (opts: { load?: boolean; tps?: string[] } = {}) =>
  build([
    { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
    { op: 'add_part', part: 'microchip:MCP1700T-3302E/TT', refdes: 'U1' },
    { op: 'add_part', part: 'generic:C', refdes: 'C1', params: { capacitance: '10uF', voltage: '16V' } },
    { op: 'add_part', part: 'generic:C', refdes: 'C2', params: { capacitance: '10uF', voltage: '10V' } },
    { op: 'connect', pins: ['J1.1', 'U1.VIN', 'C1.1'], net: '+5V' },
    { op: 'connect', pins: ['J1.2', 'U1.GND', 'C1.2', 'C2.2'], net: 'GND' },
    { op: 'connect', pins: ['U1.VOUT', 'C2.1'], net: '+3V3' },
    { op: 'set_net', net: '+5V', external: true, voltage: 5 },
    { op: 'set_net', net: '+3V3', voltage: 3.3, ...(opts.load === false ? {} : { loads: [{ pin: 'C2.1', amps: 0.1 }] }) },
    ...(opts.tps ? [{ op: 'add_test_points' as const, nets: opts.tps }] : []),
  ]);

describe('bring-up sheet', () => {
  it('lists the input rail before the regulated one, with their voltages, sources and test points', () => {
    const plan = ldoBoard({ tps: ['rails'] }).bringUp();
    expect(plan.rails.map((r) => r.net)).toEqual(['+5V', '+3V3']);
    const [in5, v33] = plan.rails;
    expect(in5).toMatchObject({ voltage: 5, input: true, source: 'J1 (connector)', testPoints: [{ label: 'TP_+5V' }] });
    expect(v33).toMatchObject({ voltage: 3.3, input: false, source: 'U1 (linear regulator from +5V)', testPoints: [{ label: 'TP_+3V3' }] });
    expect(in5!.testPoints[0]!.ref).toMatch(/^TP\d+$/);
    expect(v33!.testPoints[0]!.ref).not.toBe(in5!.testPoints[0]!.ref);
    expect(in5!.probeAt).toBeUndefined();
    // the steps: the input powered first, then the regulated rail checked at its test point
    const power = plan.steps.findIndex((s) => s.startsWith('Power +5V'));
    const check = plan.steps.findIndex((s) => s.startsWith('Check +3V3'));
    expect(power).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(power);
    expect(plan.steps[check]).toContain(`${v33!.testPoints[0]!.ref} (TP_+3V3)`);
  });

  it('says where to probe a rail without a test point', () => {
    const plan = ldoBoard({ tps: ['+5V'] }).bringUp();
    const v33 = plan.rails.find((r) => r.net === '+3V3')!;
    expect(v33.testPoints).toEqual([]);
    expect(v33.probeAt).toBe('U1.VOUT');
    expect(plan.steps.join('\n')).toContain('at U1.VOUT (no test point)');
  });

  it('sets the current limit from the loads with the margin, the linear regulator passing them', () => {
    const in5 = ldoBoard().bringUp().rails[0]!;
    // 100 mA on +3V3 passes through the LDO: 1.5 × 0.1 A
    expect(in5.supply).toEqual({ draw_a: 0.1, basis: 'loads', limit_a: 0.15 });
  });

  it('says unknown when the current is not known, never a number', () => {
    const plan = ldoBoard({ load: false }).bringUp();
    expect(plan.rails[0]!.supply).toEqual({ draw_a: 'unknown', basis: 'unknown', limit_a: 'unknown' });
    expect(plan.steps.find((s) => s.startsWith('Power +5V'))).toMatch(/current limit unknown: start low/);
  });

  it('turns a switching regulator\'s output current into its input current', () => {
    const k = new Kernel();
    expect(k.transact(buckTransaction()).status).toBe('ok');
    const plan = k.bringUp();
    expect(plan.rails.map((r) => r.net)).toEqual(['+12V', '+3V3']);
    expect(plan.rails[1]!.source).toBe('U1 (switching regulator from +12V), through L1');
    // +3V3's max_current 2 A at 3.3 V from 12 V at 80 %: 0.6875 A, the limit 1.5 × that rounded up to 10 mA
    const s = plan.rails[0]!.supply!;
    expect(s).toMatchObject({ basis: 'max_current', limit_a: 1.04 });
    expect(s.draw_a).toBeCloseTo(0.6875, 2);
  });

  it('has nothing to bring up without supply rails', () => {
    const plan = build([{ op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '10k' } }]).bringUp();
    expect(plan.rails).toEqual([]);
    expect(plan.note).toMatch(/No supply rails/);
  });

  it('is unchanged on one board: the ldo and buck plans as before boards were named', () => {
    expect(ldoBoard({ tps: ['+5V'] }).bringUp()).toEqual(LDO_BEFORE);
    const k = new Kernel();
    expect(k.transact(buckTransaction()).status).toBe('ok');
    expect(k.transact({ summary: 'tp', ops: [{ op: 'add_test_points', nets: ['rails'] }] }).status).toBe('ok');
    expect(k.bringUp()).toEqual(BUCK_BEFORE);
  });
});

describe('bring-up sheet of a design of several boards', () => {
  it('lists a rail made on Main and loaded on the LED board with both boards and the mate it crosses', () => {
    const k = twoBoards();
    const r = k.transact({ summary: 'mate', ops: [{ op: 'set_net', net: '+3V3', loads: [{ pin: 'R4.1', amps: 0.01 }] }, { op: 'mate', a: 'J2', b: 'J3', kind: 'stack' }] });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const plan = k.bringUp();
    expect(plan.rails.map((x) => x.net)).toEqual(['+12V', '+3V3']);
    const v33 = plan.rails[1]!;
    expect(v33).toMatchObject({ boards: ['Main', 'LED board'], crosses: [{ board: 'LED board', through: 'J2↔J3', pins: 1, probeAt: 'J3.1' }] });
    expect(plan.rails[0]!.boards).toEqual(['Main']);
    const step = plan.steps.find((x) => x.startsWith('Check +3V3'))!;
    expect(step).toMatch(/^Check \+3V3 \(Main \+ LED board\): /);
    expect(step).toContain('It reaches LED board through J2↔J3 (1 pin): check it there too, at J3.1.');
    expect(plan.steps[0]).toContain('with the boards mated and unpowered');
  });

  it('orders the rails across boards, names each probe point\'s board, and sums all the loads into the bench limit', () => {
    const k = fiveVoltsToLedBoard();
    const plan = k.bringUp();
    // +5V comes in on Main and crosses to the LED board, where U1 makes +3V3 from it: +5V first
    expect(plan.rails.map((r) => r.net)).toEqual(['+5V', '+3V3']);
    const [in5, v33] = plan.rails;
    expect(in5).toMatchObject({ boards: ['Main', 'LED board'], crosses: [{ board: 'LED board', through: 'J2↔J3', pins: 1 }] });
    expect(v33).toMatchObject({ boards: ['LED board'], source: 'U1 (linear regulator from +5V)', testPoints: [{ label: 'TP_+3V3', board: 'LED board' }] });
    expect(v33!.crosses).toBeUndefined();
    expect(plan.steps.find((s) => s.startsWith('Check +3V3'))).toMatch(/at TP\d+ \(TP_\+3V3\) on LED board/);
    // 100 mA on +3V3 (LED board, through the LDO) plus 20 mA on +5V (Main): 1.5 × 120 mA
    expect(in5!.supply).toEqual({ draw_a: 0.12, basis: 'loads', limit_a: 0.18 });
    expect(plan.steps.findIndex((s) => s.startsWith('Power +5V'))).toBeLessThan(plan.steps.findIndex((s) => s.startsWith('Check +3V3')));
  });
});

/** 5 V in on J1 on Main, out on J2 to J3 on the LED board (stacked), where an MCP1700 makes 3.3 V with its test point. */
function fiveVoltsToLedBoard(): Kernel {
  return build([
    { op: 'add_sheet', name: 'LED' },
    { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
    { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J2' },
    { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '1k' } },
    { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J3', sheet: 'LED' },
    { op: 'add_part', part: 'microchip:MCP1700T-3302E/TT', refdes: 'U1', sheet: 'LED' },
    { op: 'add_part', part: 'generic:C', refdes: 'C1', params: { capacitance: '10uF', voltage: '16V' }, sheet: 'LED' },
    { op: 'add_part', part: 'generic:C', refdes: 'C2', params: { capacitance: '10uF', voltage: '10V' }, sheet: 'LED' },
    { op: 'connect', pins: ['J1.1', 'J2.1', 'R1.1', 'J3.1', 'U1.VIN', 'C1.1'], net: '+5V' },
    { op: 'connect', pins: ['J1.2', 'J2.2', 'R1.2', 'J3.2', 'U1.GND', 'C1.2', 'C2.2'], net: 'GND' },
    { op: 'connect', pins: ['U1.VOUT', 'C2.1'], net: '+3V3' },
    { op: 'set_net', net: '+5V', external: true, voltage: 5, loads: [{ pin: 'R1.1', amps: 0.02 }] },
    { op: 'set_net', net: '+3V3', voltage: 3.3, loads: [{ pin: 'C2.1', amps: 0.1 }] },
    { op: 'add_board', name: 'LED board', sheets: ['LED'] },
    { op: 'mate', a: 'J2', b: 'J3', kind: 'stack' },
    { op: 'add_test_points', nets: ['+3V3'] },
  ]);
}

/** The plans of one board as they were before boards were named (captured from 8074dd3). */
const LDO_BEFORE = {"rails":[{"net":"+5V","voltage":5,"source":"J1 (connector)","input":true,"testPoints":[{"ref":"TP1","label":"TP_+5V"}],"supply":{"draw_a":0.1,"basis":"loads","limit_a":0.15}},{"net":"+3V3","voltage":3.3,"source":"U1 (linear regulator from +5V)","input":false,"testPoints":[],"probeAt":"U1.VOUT"}],"steps":["Before power: with the board unpowered, measure the resistance from each rail to ground (+5V, +3V3); a reading near 0 Ω is a short to find first.","Power +5V: set the bench supply to 5 V, current limit 150 mA (1.5 × the 100 mA expected, from the loads stated), and connect it at J1. Check 5 V at TP1 (TP_+5V).","Check +3V3: expect 3.3 V at U1.VOUT (no test point), made by U1 (linear regulator from +5V). If it is off, switch off before going on."]};
const BUCK_BEFORE = {
  "rails": [
    {
      "net": "+12V",
      "voltage": 12,
      "source": "J1 (connector)",
      "input": true,
      "testPoints": [
        {
          "ref": "TP2",
          "label": "TP_+12V"
        }
      ],
      "supply": {
        "draw_a": 0.687,
        "basis": "max_current",
        "limit_a": 1.04
      }
    },
    {
      "net": "+3V3",
      "voltage": 3.3,
      "source": "U1 (switching regulator from +12V), through L1",
      "input": false,
      "testPoints": [
        {
          "ref": "TP1",
          "label": "TP_+3V3"
        }
      ]
    }
  ],
  "steps": [
    "Before power: with the board unpowered, measure the resistance from each rail to ground (+12V, +3V3); a reading near 0 Ω is a short to find first.",
    "Power +12V: set the bench supply to 12 V, current limit 1.04 A (1.5 × the 687 mA expected, from the rails' max_current), and connect it at J1. Check 12 V at TP2 (TP_+12V).",
    "Check +3V3: expect 3.3 V at TP1 (TP_+3V3), made by U1 (switching regulator from +12V), through L1. If it is off, switch off before going on."
  ]
};
