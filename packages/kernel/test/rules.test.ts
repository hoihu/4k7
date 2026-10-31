import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHECKED_SCH_RULES, LAYOUT_SCH_RULES, changedChecks, emptyDesign, migrateRulesText, mustFix, resolveChecks, type Design, type LabelView, type RuleLevel, type SchematicView, type SheetView, type SymbolView, type Transaction } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { diagKey, sortDiagnostics } from '../src/checks.ts';
import { schematicChecks } from '../src/schcheck.ts';
import { measure } from '../src/scope.ts';
import { buckTransaction } from './fixtures.ts';

describe('the checks', () => {
  const rules = resolveChecks();

  it('runs every check the kernel has at its shipped level', () => {
    expect(rules['SCH.RAIL_UP']).toEqual({ id: 'SCH.RAIL_UP', title: 'Power symbols point up', level: 'error', layout: true });
    expect(rules['SCH.JOG']).toMatchObject({ level: 'warning', layout: false });
    expect(rules['SCH.CROSSING']).toMatchObject({ level: 'info', max: 0 });
    expect(Object.keys(rules)).toEqual([...CHECKED_SCH_RULES]);
    expect(resolveChecks(null)).toEqual(rules);
  });

  it('takes the user\'s level and limit, and ignores what is not a level or a limit', () => {
    const r = resolveChecks({ 'SCH.JOG': { level: 'off' }, 'SCH.CROSSING': { level: 'loud' as never, max: 2 }, 'SCH.DETOUR': { max: 3 }, 'SCH.MINE': { level: 'error' } });
    expect(r['SCH.JOG']!.level).toBe('off');
    expect(r['SCH.CROSSING']).toMatchObject({ level: 'info', max: 2 });
    expect(r['SCH.DETOUR']!.max).toBeUndefined();
    expect(r['SCH.MINE']).toBeUndefined();
    expect(resolveChecks({ 'SCH.CROSSING': { max: -1 } })['SCH.CROSSING']!.max).toBe(0);
    expect(resolveChecks({ 'SCH.CROSSING': { max: 1.5 } })['SCH.CROSSING']!.max).toBe(0);
  });

  it('stores only what differs from the shipped checks', () => {
    expect(changedChecks({ 'SCH.JOG': { level: 'warning' }, 'SCH.CROSSING': { max: 0 } })).toEqual({});
    expect(changedChecks({ 'SCH.JOG': { level: 'error' }, 'SCH.CROSSING': { level: 'info', max: 2 } })).toEqual({ 'SCH.JOG': { level: 'error' }, 'SCH.CROSSING': { max: 2 } });
  });

  it('does not hold a layout rule\'s finding against the agent', () => {
    expect([...LAYOUT_SCH_RULES].sort()).toEqual(['SCH.DANGLING', 'SCH.GND_DOWN', 'SCH.ORTHOGONAL', 'SCH.RAIL_UP']);
    expect(mustFix({ code: 'SCH.RAIL_UP', severity: 'error', entities: [], message: '' })).toBe(false);
    expect(mustFix({ code: 'SCH.JOG', severity: 'error', entities: [], message: '' })).toBe(true);
    expect(mustFix({ code: 'ERC.PIN_UNCONNECTED', severity: 'error', entities: [], message: '' })).toBe(true);
    expect(mustFix({ code: 'ERC.PIN_UNCONNECTED', severity: 'error', entities: [], message: '', waivedBy: 'w1' })).toBe(false);
  });
});

describe('the ruleset text of earlier versions', () => {
  const old = `# Schematic rules

How this ruleset works: an editor's note.

## Wires

Few bends.

### SCH.JOG: parts facing each other are in line
level: error

Two pins that face each other sit on one line.

### SCH.CROSSING: few crossings
level: info
param: max 2

### SCH.ORTHOGONAL: wires run horizontally and vertically
level: error

*(layout)* On the grid, no diagonals.

### SCH.LABEL_ALONE: a net label has a partner
level: off
`;

  it('turns the levels into check settings and keeps the prose as notes, without ids and level lines', () => {
    const { notes, checks } = migrateRulesText(old);
    expect(checks).toEqual({ 'SCH.JOG': { level: 'error' }, 'SCH.CROSSING': { max: 2 } });
    expect(notes).toBe('## Wires\n\nFew bends.\n\n### Parts facing each other are in line\n\nTwo pins that face each other sit on one line.\n\n### Few crossings\n\n### Wires run horizontally and vertically\n\nOn the grid, no diagonals.\n\n### A net label has a partner\n');
    expect(migrateRulesText(old.replace(/\n/g, '\r\n'))).toEqual({ notes, checks });
  });

  it('leaves no notes from a copy of the old default with only its levels changed', () => {
    const shipped = readFileSync(new URL('./old-schematic-rules.md', import.meta.url), 'utf8');
    expect(migrateRulesText(shipped)).toEqual({ notes: '', checks: {} });
    expect(migrateRulesText(shipped.replace('param: max 0', 'param: max 3'))).toEqual({ notes: '', checks: { 'SCH.CROSSING': { max: 3 } } });
    expect(migrateRulesText(shipped + '\nLabels are horizontal.\n').notes).toContain('Labels are horizontal.');
  });
});

/* ------------------------------ hand-built sheets ------------------------------ */

/** A vertical two-pin part with its pins at (x, top) and (x, top + 400). */
const vertical = (ref: string, x: number, top: number) =>
  ({ componentId: ref, refdes: ref, value: '', bbox: { x: x - 100, y: top, w: 200, h: 400 }, prims: [], pins: [{ number: '1', name: '1', x, y: top, side: 'top', showName: false, showNumber: false }, { number: '2', name: '2', x, y: top + 400, side: 'bottom', showName: false, showNumber: false }], refPos: { x: x + 120, y: top + 190, anchor: 'start' }, valuePos: { x: x + 120, y: top + 275, anchor: 'start' } }) as SymbolView;
const sheet = (s: Partial<SheetView>): SheetView => ({ id: 's', name: 'Main', bbox: { x: 0, y: 0, w: 0, h: 0 }, pages: [], symbols: [], wires: [], labels: [], junctions: [], noConnects: [], ...s });
const view = (s: SheetView): SchematicView => ({ paper: 'A4', sheets: [s], constraintStatus: {} });
/** A design that knows the nets the sheets use: FB and SW are signals, VIN a rail, GND ground. */
function design(): Design {
  const d = emptyDesign();
  for (const [id, name] of [['fb', 'FB'], ['sw', 'SW'], ['vin', 'VIN'], ['gnd', 'GND']] as const) d.nets[id] = { id, name, attrs: {} };
  return d;
}
const DEFAULT = resolveChecks();
const check = (s: SheetView, rules = DEFAULT) => schematicChecks(design(), view(s), rules);
/** The findings of one rule: hand-built sheets leave ends loose and parts askew that other rules would report. */
const only = (code: string, s: SheetView, rules = DEFAULT) => check(s, rules).filter((x) => x.code === code);
const withLevel = (id: string, level: RuleLevel) => resolveChecks({ [id]: { level } });

describe('schematic checks', () => {
  const rail = (l: Partial<LabelView> = {}): LabelView => ({ x: 1000, y: 300, text: 'VIN', netId: 'vin', kind: 'rail', dir: 'up', stub: 'left', stubLen: 100, ...l });
  const pvin = { ...vertical('U1', 2000, 300), pins: [{ number: '3', name: 'PVIN', x: 1000, y: 300, side: 'left' as const, showName: true, showNumber: true }] };

  it('reports a rail pointing down on the pin it stands at, as an error', () => {
    const out = check(sheet({ symbols: [pvin], labels: [rail({ dir: 'down' })] }));
    expect(out).toEqual([{ code: 'SCH.RAIL_UP', severity: 'error', entities: ['net:VIN', 'U1.PVIN'], message: 'VIN on U1.PVIN points down' }]);
    expect(check(sheet({ symbols: [pvin], labels: [rail()] }))).toEqual([]);
  });

  it('finds the pin along the net\'s wire, and a ground pointing up is SCH.GND_DOWN', () => {
    const gnd: LabelView = { x: 1000, y: 900, text: 'GND', netId: 'gnd', kind: 'ground', dir: 'up' };
    const out = check(sheet({ symbols: [vertical('C1', 1000, 300)], wires: [{ netId: 'gnd', pts: [1000, 700, 1000, 900] }], labels: [gnd] }));
    expect(out).toEqual([{ code: 'SCH.GND_DOWN', severity: 'error', entities: ['net:GND', 'C1.2'], message: 'GND on C1.2 points up' }]);
  });

  it('reports nothing for a rule that is off, and at the level the ruleset says', () => {
    const s = sheet({ symbols: [pvin], labels: [rail({ dir: 'down' })] });
    expect(check(s, withLevel('SCH.RAIL_UP', 'off'))).toEqual([]);
    expect(check(s, withLevel('SCH.RAIL_UP', 'info'))[0]?.severity).toBe('info');
    expect(check(s, {})).toEqual([]);
  });

  it('names the two parts of a divider drawn side by side as a jog', () => {
    const out = only('SCH.JOG', sheet({ wires: [{ netId: 'fb', pts: [5800, 3900, 4900, 3900] }], symbols: [vertical('R1', 5300, 3500), vertical('R2', 4900, 3900)] }));
    expect(out).toEqual([{ code: 'SCH.JOG', severity: 'warning', entities: ['net:FB', 'R1.2', 'R2.1'], message: 'R1 and R2 face each other on FB but are not in line: the wire jogs' }]);
    expect(only('SCH.JOG', sheet({ wires: [{ netId: 'fb', pts: [5800, 3900, 5300, 3900] }], symbols: [vertical('R1', 5300, 3500), vertical('R2', 5300, 3900)] }))).toEqual([]);
  });

  it('reports a supply name standing on another net\'s wire, and a name running into a part\'s text', () => {
    const under = only('SCH.TEXT_OVERLAP', sheet({ wires: [{ netId: 'fb', pts: [1000, 50, 0, 50] }], labels: [rail()] }));
    expect(under).toEqual([{ code: 'SCH.TEXT_OVERLAP', severity: 'warning', entities: ['net:VIN', 'net:FB'], message: "the VIN symbol's name stands on a wire of FB" }]);
    const part = { ...vertical('U1', 3000, 3000), refPos: { x: 900, y: 0, anchor: 'start' as const } };
    expect(only('SCH.TEXT_OVERLAP', sheet({ symbols: [part], labels: [rail()] })).map((x) => x.message)).toEqual(["the VIN symbol's name runs into U1's name"]);
    // crossing the stem is the price of standing upright, not an overlap
    expect(only('SCH.TEXT_OVERLAP', sheet({ wires: [{ netId: 'fb', pts: [1000, 200, 0, 200] }], labels: [rail()] }))).toEqual([]);
  });

  it('reports a detour, a diagonal wire and a dangling end', () => {
    expect(check(sheet({ wires: [{ netId: 'fb', pts: [0, 0, 0, -300, 500, -300, 500, 0] }], symbols: [vertical('R1', 0, 0), vertical('R2', 500, 0)] })).map((x) => [x.code, x.entities.join(','), x.message])).toEqual([
      ['SCH.DETOUR', 'net:FB,R1.1,R2.1', 'the FB wire turns back on itself between (0, -300) and (500, -300)'],
    ]);
    expect(only('SCH.ORTHOGONAL', sheet({ wires: [{ netId: 'fb', pts: [0, 0, 500, 300] }], symbols: [vertical('R1', 0, -400), vertical('R2', 500, 300)] })).map((x) => [x.severity, x.entities.join(','), x.message])).toEqual([
      ['error', 'net:FB,R1.2,R2.1', 'a wire of FB runs diagonally from (0, 0) to (500, 300)'],
    ]);
    // the lead of a part drawn at 45° (a diode on a bridge's diamond) is not a diagonal wire
    const slanted = { ...vertical('D1', 0, 0), rotation: 45, pins: [{ number: '1', name: 'K', x: 0, y: 0, side: 'top' as const, showName: false, showNumber: false }] };
    expect(only('SCH.ORTHOGONAL', sheet({ wires: [{ netId: 'fb', pts: [0, 0, 100, -100] }], symbols: [slanted], junctions: [{ x: 100, y: -100 }] }))).toEqual([]);
    const loose = check(sheet({ wires: [{ netId: 'fb', pts: [0, 0, 0, 300] }], symbols: [vertical('R1', 0, -400)] }));
    expect(loose).toEqual([{ code: 'SCH.DANGLING', severity: 'error', entities: ['net:FB', 'R1.2'], message: 'a wire of FB from R1.2 ends at (0, 300) on nothing' }]);
    // a T onto another wire of the net, a junction or a label anchor is an end
    expect(only('SCH.DANGLING', sheet({ wires: [{ netId: 'fb', pts: [0, 0, 0, 300] }, { netId: 'fb', pts: [-200, 300, 200, 300] }], symbols: [vertical('R1', 0, -400), vertical('R2', -200, 300), vertical('R3', 200, 300)] }))).toEqual([]);
  });

  it('counts crossings per net against the rule\'s max', () => {
    // FB crosses SW twice and GND once; no pins, so nothing else fires
    const s = sheet({ wires: [{ netId: 'fb', pts: [0, 100, 1000, 100] }, { netId: 'sw', pts: [200, 0, 200, 200] }, { netId: 'sw', pts: [400, 0, 400, 200] }, { netId: 'gnd', pts: [600, 0, 600, 200] }], junctions: [{ x: 0, y: 100 }, { x: 1000, y: 100 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 400, y: 0 }, { x: 400, y: 200 }, { x: 600, y: 0 }, { x: 600, y: 200 }] });
    expect(check(s).map((x) => [x.code, x.severity, x.entities.join(','), x.message])).toEqual([
      ['SCH.CROSSING', 'info', 'net:FB', 'FB crosses SW twice and GND once: 3 crossings, max 0'],
      ['SCH.CROSSING', 'info', 'net:GND', 'GND crosses FB once: 1 crossing, max 0'],
      ['SCH.CROSSING', 'info', 'net:SW', 'SW crosses FB twice: 2 crossings, max 0'],
    ]);
    expect(check(s, resolveChecks({ 'SCH.CROSSING': { max: 2 } })).map((x) => x.entities.join(','))).toEqual(['net:FB']);
  });

  it('keeps two findings of one rule on one net apart by their pins', () => {
    // two VIN symbols pointing down on two pins of U1, two loose wires from two parts, and two
    // ground symbols standing on wires of FB: the Inspector and the waivers go by code and entities
    const u1 = { ...vertical('U1', 2000, 300), pins: [{ number: '3', name: 'PVIN', x: 1000, y: 300, side: 'left' as const, showName: true, showNumber: true }, { number: '4', name: 'AVIN', x: 1000, y: 500, side: 'left' as const, showName: true, showNumber: true }] };
    const gnd = (x: number): LabelView => ({ x, y: 2000, text: 'GND', netId: 'gnd', kind: 'ground', dir: 'down' });
    const s = sheet({
      symbols: [u1, vertical('R1', 4000, 0), vertical('R2', 5000, 0), vertical('C1', 6000, 1600), vertical('C2', 7000, 1600)],
      labels: [rail({ dir: 'down' }), rail({ dir: 'down', y: 500 }), gnd(6000), gnd(7000)],
      wires: [{ netId: 'fb', pts: [4000, 400, 4000, 700] }, { netId: 'fb', pts: [5000, 400, 5000, 700] }, { netId: 'fb', pts: [5500, 2100, 7500, 2100] }],
      junctions: [{ x: 5500, y: 2100 }, { x: 7500, y: 2100 }],
    });
    const out = check(s);
    const keys = out.map(diagKey);
    expect(keys).toEqual([...new Set(keys)]);
    expect(keys.filter((k) => k.startsWith('SCH.RAIL_UP'))).toEqual(['SCH.RAIL_UP|net:VIN,U1.PVIN', 'SCH.RAIL_UP|net:VIN,U1.AVIN']);
    expect(keys.filter((k) => k.startsWith('SCH.DANGLING'))).toEqual(['SCH.DANGLING|net:FB,R1.2', 'SCH.DANGLING|net:FB,R2.2']);
    expect(keys.filter((k) => k.startsWith('SCH.TEXT_OVERLAP|net:GND'))).toEqual(['SCH.TEXT_OVERLAP|net:GND,C1.2,net:FB', 'SCH.TEXT_OVERLAP|net:GND,C2.2,net:FB']);
  });
});

describe('Kernel.setChecks', () => {
  const sch = (k: Kernel) => k.state().diagnostics.filter((x) => x.code.startsWith('SCH.')).map((x) => `${x.severity} ${x.code} ${x.entities.join(',')}`);

  it('runs the checks on the layout at the levels given, and redoes them when the levels change', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    // the one real finding: U1's SW pin is lower than L1, so the switch node steps up to it
    expect(sch(k)).toEqual(['warning SCH.JOG net:SW,L1.1,U1.PH']);
    k.setChecks({ 'SCH.JOG': { level: 'error' } });
    expect(sch(k)).toEqual(['error SCH.JOG net:SW,L1.1,U1.PH']);
    expect(k.state().counts.errors).toBe(1);
    k.setChecks({ 'SCH.JOG': { level: 'off' } });
    expect(sch(k)).toEqual([]);
    k.setChecks(null);
    expect(sch(k)).toEqual(['warning SCH.JOG net:SW,L1.1,U1.PH']);
  });

  it('draws a bridge rectifier without a finding: net flags on neighbouring connector pins do not touch', () => {
    const k = new Kernel();
    const tx: Transaction = {
      summary: 'bridge rectifier',
      ops: [
        { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
        ...(['D1', 'D2', 'D3', 'D4'] as const).map((r) => ({ op: 'add_part' as const, part: 'generic:D', refdes: r, params: { mpn: '1N4007' } })),
        { op: 'add_part', part: 'generic:CP', refdes: 'C1', params: { capacitance: '1000uF', voltage: '25V' } },
        { op: 'connect', pins: ['J1.1', 'D1.A', 'D3.K'], net: 'AC1' },
        { op: 'connect', pins: ['J1.2', 'D2.A', 'D4.K'], net: 'AC2' },
        { op: 'connect', pins: ['D1.K', 'D2.K', 'C1.+'], net: 'VDC' },
        { op: 'connect', pins: ['D3.A', 'D4.A', 'C1.-'], net: 'GND' },
        { op: 'set_net', net: 'VDC', voltage: 16 },
      ],
    };
    expect(k.transact(tx).status).toBe('ok');
    expect(sch(k)).toEqual([]);
  });

  it('draws the TPS40222 buck of the design note without a finding', () => {
    // the project behind docs/design/schematic-drawing.md §1: its rails stand upright across FB and SW, and the
    // checks agree with the measures that nothing is left to report
    const k = new Kernel();
    k.load(JSON.parse(readFileSync(new URL('./tps40222.json', import.meta.url), 'utf8')));
    expect(sch(k)).toEqual([]);
    const { view } = k.state();
    expect(view.sheets).toHaveLength(1);
    const m = measure(view.sheets[0]!, new Set(Object.keys(k.committedDesign().nets)));
    expect(m).toMatchObject({ crossings: 0, bends: 0, jogs: 0, detours: 0, overlaps: 0 });
  });

  it('lets a waiver cover a drawing diagnostic like any other', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    const r = k.transact({ summary: 'waive', ops: [{ op: 'add_waiver', code: 'SCH.JOG', entities: ['net:SW', 'L1.1', 'U1.PH'], reason: 'the SW pin sits where the symbol puts it' }] });
    expect(r.status).toBe('ok');
    const d = k.state().diagnostics.find((x) => x.code === 'SCH.JOG');
    expect(d?.waivedBy).toBeDefined();
    expect(k.state().counts.warnings).toBe(0);
  });
});

describe('the same finding twice', () => {
  it('is reported once (two labels drawn alike made two identical SCH.TEXT_OVERLAP, and the Issues list could not show them)', () => {
    const d = { code: 'SCH.TEXT_OVERLAP', severity: 'warning' as const, entities: ['net:IS', 'U1.IS', 'net:VOUT'], message: 'the IS label runs into the VOUT symbol' };
    const other = { ...d, entities: ['net:FB', 'U1.FB'], message: 'the FB label runs into R1' };
    expect(sortDiagnostics([d, { ...d, entities: [...d.entities] }, other])).toHaveLength(2);
  });
});
