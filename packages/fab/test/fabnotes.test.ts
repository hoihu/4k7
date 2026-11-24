import { describe, expect, it } from 'vitest';
import { Kernel } from '@4k7/kernel';
import { fabFiles, fabNotes, panelFabFiles, unzip, zip } from '../src/index.ts';
import { buck as buckFixture, buckTransaction } from '../../kernel/test/fixtures.ts';

/** Two 4-pin headers joined by a USB pair at 90 Ω, on JLCPCB's 4 layers (its standard stack-up). */
function usb() {
  const k = new Kernel();
  const r = k.transact({
    summary: 'usb',
    ops: [
      { op: 'add_part', part: 'generic:CONN_1x4', refdes: 'J1' },
      { op: 'add_part', part: 'generic:CONN_1x4', refdes: 'J2' },
      { op: 'connect', pins: ['J1.2', 'J2.2'], net: 'USB_DP' },
      { op: 'connect', pins: ['J1.3', 'J2.3'], net: 'USB_DN' },
      { op: 'connect', pins: ['J1.4', 'J2.4'], net: 'GND' },
      { op: 'set_board', layers: 4, width_mm: 40, height_mm: 20 },
      { op: 'set_fab_profile', preset: 'jlcpcb' },
      { op: 'place', ref: 'J1', x_mm: 6, y_mm: 10, rot: 0, lock: true },
      { op: 'place', ref: 'J2', x_mm: 34, y_mm: 10, rot: 0, lock: true },
      { op: 'set_impedance', nets: ['USB_DP', 'USB_DN'], ohms: 90, label: 'USB 2.0' },
    ],
  } as never);
  if (r.status !== 'ok') throw new Error(JSON.stringify(r.rejection));
  return k.board();
}

function buck() {
  return buckFixture().board();
}

const notes = (files: { name: string; content: string }[], name: string) => files.find((f) => f.name === name)?.content;

describe('fabrication notes (fab-notes.txt)', () => {
  it('give the stack-up, the impedance table, the finish and how each house is to be told', () => {
    expect(fabNotes(usb(), 'usb', 'usb-fab-notes.txt', { version: '0.6.1', board: 'abcd1234' })).toBe(`FABRICATION NOTES
4k7 0.6.1
usb, board abcd1234

BOARD
  Size: 40 × 20 mm, 4 copper layers (F.Cu, In1.Cu, In2.Cu, B.Cu)
  Thickness: 1.6 mm (copper and dielectric add up to 1.59 mm)
  Copper (finished): outer 1 oz (35 µm), inner 0.5 oz (15.2 µm)
  Designed to: JLCPCB, 4-layer, 1 oz copper (https://jlcpcb.com/capabilities/pcb-capabilities)

STACK-UP, TOP TO BOTTOM
  JLC04161H-7628 (JLCPCB preset, https://jlcpcb.com/impedance, checked 2026-10-25)
    Solder mask (top): 15.2 µm over copper, 30.5 µm over laminate, εr 3.8
    F.Cu: copper 35 µm (1 oz)
      7628 prepreg: 0.2104 mm, εr 4.4
    In1.Cu: copper 15.2 µm (0.5 oz)
      core: 1.065 mm, εr 4.6
    In2.Cu: copper 15.2 µm (0.5 oz)
      7628 prepreg: 0.2104 mm, εr 4.4
    B.Cu: copper 35 µm (1 oz)
    Solder mask (bottom): 15.2 µm over copper, 30.5 µm over laminate, εr 3.8
  4 layers, 1.6 mm, 1 oz outer and 0.5 oz inner copper. Impedance control is ordered with this stack-up selected; JLCPCB holds ±10 %.

CONTROLLED IMPEDANCE
  Z1 USB 2.0: USB_DP / USB_DN, 90 Ω differential ±10 %, microstrip
    F.Cu over In1.Cu (0.2104 mm, εr 4.4): width 0.282 mm, gap 0.2 mm
    not on B.Cu: no plane on In2.Cu for it to run over

FINISH
  Surface finish, solder mask colour and silkscreen colour are not set in the design: choose them when you order.

FOR JLCPCB
  Set in the order form: thickness 1.6 mm, copper outer 1 oz (35 µm), inner 0.5 oz (15.2 µm), and the surface finish, solder mask and silkscreen colours. JLCPCB builds from the order form, not from notes in the zip.
  Impedance Control: Yes, with the stack-up JLC04161H-7628 selected. JLCPCB holds ±10 %; it does not read the impedance table from a file.

FOR PCBWAY
  Set in the quote form: thickness 1.6 mm, copper outer 1 oz (35 µm), inner 0.5 oz (15.2 µm), and the surface finish, solder mask and silkscreen colours.
  Ask for impedance control, and write in the order's remarks: "Stack-up and impedance table in usb-fab-notes.txt". PCBWay builds the stack-up and may adjust the widths a little to hit the targets.
  The stack-up above is not PCBWay's: the widths were worked out for it. Set PCBWay's build-up (set_stackup) and check the widths before you order.

FOR EUROCIRCUITS
  Set in the configurator: thickness 1.6 mm, copper outer 1 oz (35 µm), inner 0.5 oz (15.2 µm), and the surface finish, solder mask and silkscreen colours.
  Order in the defined-impedance pool, pick its build-up in the configurator, and send usb-fab-notes.txt with the data for the impedance table.
  Eurocircuits shows its build-up only in the configurator: import it (set_stackup) and check the widths before you order.
`);
  });

  it('on a board without impedance rules give the stack-up and finish, and no table', () => {
    expect(fabNotes(buck(), 'buck', 'buck-fab-notes.txt')).toBe(`FABRICATION NOTES
4k7 unknown
buck

BOARD
  Size: 24 × 22 mm, 2 copper layers (F.Cu, B.Cu)
  Thickness: 1.6 mm
  Copper (finished): outer 1 oz (35 µm)

STACK-UP, TOP TO BOTTOM
  generic 2 layers, 1.6 mm FR-4 (a typical FR-4 board, not a manufacturer's)
    Solder mask (top): 15.2 µm over copper, 30.5 µm over laminate, εr 3.8
    F.Cu: copper 35 µm (1 oz)
      FR-4 core: 1.53 mm, εr 4.5
    B.Cu: copper 35 µm (1 oz)
    Solder mask (bottom): 15.2 µm over copper, 30.5 µm over laminate, εr 3.8
  A typical FR-4 board, not a manufacturer's stack-up: get theirs (set_stackup) before relying on an impedance.

CONTROLLED IMPEDANCE
  None: no line on this board is routed at a set impedance.

FINISH
  Surface finish, solder mask colour and silkscreen colour are not set in the design: choose them when you order.

FOR JLCPCB
  Set in the order form: thickness 1.6 mm, copper outer 1 oz (35 µm), and the surface finish, solder mask and silkscreen colours. JLCPCB builds from the order form, not from notes in the zip.
  Impedance Control: No (no line on this board is routed at a set impedance).

FOR PCBWAY
  Set in the quote form: thickness 1.6 mm, copper outer 1 oz (35 µm), and the surface finish, solder mask and silkscreen colours.
  No impedance control needed.

FOR EUROCIRCUITS
  Set in the configurator: thickness 1.6 mm, copper outer 1 oz (35 µm), and the surface finish, solder mask and silkscreen colours.
  No impedance control needed: the standard pool will do.
`);
  });

  it('go into the fab zip, and the panel\'s', async () => {
    const b = buck();
    const files = fabFiles(b, 'buck converter');
    expect(files.at(-1)!.name).toBe('buck_converter-fab-notes.txt');
    expect(notes(files, 'buck_converter-fab-notes.txt')).toBe(fabNotes(b, 'buck converter', 'buck_converter-fab-notes.txt'));
    const back = await unzip(zip(files));
    expect(new TextDecoder().decode(back.find((f) => f.name === 'buck_converter-fab-notes.txt')!.data)).toBe(notes(files, 'buck_converter-fab-notes.txt'));
    const k = new Kernel();
    k.transact(buckTransaction());
    k.accept();
    k.transact({ summary: 'panel', ops: [{ op: 'set_board', width_mm: 40, height_mm: 30 }, { op: 'set_panel' }] });
    const p = k.board();
    expect(notes(panelFabFiles(p, 'buck'), 'buck-panel-fab-notes.txt')).toMatch(/^FABRICATION NOTES\n4k7 unknown\nbuck-panel\n\nBOARD\n  Size: \d/);
  });
});
