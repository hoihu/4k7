/**
 * The golden circuits of the schematic drawing eval (docs/design/schematic-drawing.md, "The drawing
 * eval"): ten representative designs built through the kernel's ops, each laid out by the
 * auto-layout and scored by schematic-eval.ts. Parts that are not in the library are small cards
 * of the kind a datasheet import makes (pin types and the sides a symbol would put them on).
 */
import { readFileSync } from 'node:fs';
import type { Design, EditOp, PartCard, PartPin } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { buckTransaction } from '../test/fixtures.ts';

export interface Golden {
  id: string;
  title: string;
  /** Built with `ops` on top of `parts`, or loaded from a saved design. */
  parts?: PartCard[];
  ops?: EditOp[];
  design?: () => Design;
  /** Description blocks (as `describe`): drawn as framed units, the way the app draws a described design. */
  blocks?: { title: string; refs: string[] }[];
}

/* ---------------------------------- cards --------------------------------- */

const pin = (number: string, name: string, type: PartPin['type'], side: NonNullable<PartPin['side']>): PartPin => ({ number, name, type, side });
const card = (id: string, category: PartCard['category'], refPrefix: string, description: string, pins: PartPin[]): PartCard => ({ id, mpn: id.split(':')[1], description, category, refPrefix, pins, params: {}, provenance: { source: 'datasheet' } });

/** A 32-bit MCU in the style of an STM32 in LQFP-48: 3 supply pins, crystal, SWD, USB, a few GPIO and the QSPI bus. */
const MCU = card('acme:MCU32', 'ic', 'U', 'Cortex-M MCU, LQFP-48', [
  pin('1', 'VDD', 'pwr_in', 'top'), pin('2', 'VDD', 'pwr_in', 'top'), pin('3', 'VDD', 'pwr_in', 'top'), pin('4', 'VDDA', 'pwr_in', 'top'),
  pin('5', 'VSS', 'pwr_in', 'bottom'), pin('6', 'VSS', 'pwr_in', 'bottom'), pin('7', 'VSSA', 'pwr_in', 'bottom'),
  pin('8', 'NRST', 'in', 'left'), pin('9', 'BOOT0', 'in', 'left'), pin('10', 'OSC_IN', 'in', 'left'), pin('11', 'OSC_OUT', 'out', 'left'),
  pin('12', 'USB_DM', 'bidir', 'left'), pin('13', 'USB_DP', 'bidir', 'left'),
  pin('14', 'SWDIO', 'bidir', 'right'), pin('15', 'SWCLK', 'in', 'right'),
  pin('16', 'PA0', 'bidir', 'right'), pin('17', 'PA1', 'bidir', 'right'), pin('18', 'PA2', 'bidir', 'right'), pin('19', 'PA3', 'bidir', 'right'),
  pin('20', 'QSPI_NCS', 'out', 'right'), pin('21', 'QSPI_CLK', 'out', 'right'),
  pin('22', 'QSPI_IO0', 'bidir', 'right'), pin('23', 'QSPI_IO1', 'bidir', 'right'), pin('24', 'QSPI_IO2', 'bidir', 'right'), pin('25', 'QSPI_IO3', 'bidir', 'right'),
]);
const FLASH = card('acme:QSPI_FLASH', 'ic', 'U', 'QSPI NOR flash, SOIC-8', [
  pin('1', 'CS#', 'in', 'left'), pin('2', 'IO1', 'bidir', 'left'), pin('3', 'IO2', 'bidir', 'left'), pin('4', 'GND', 'pwr_in', 'bottom'),
  pin('5', 'IO0', 'bidir', 'left'), pin('6', 'CLK', 'in', 'left'), pin('7', 'IO3', 'bidir', 'left'), pin('8', 'VCC', 'pwr_in', 'top'),
]);
const USBC = card('acme:USBC', 'connector', 'J', 'USB Type-C receptacle, USB 2.0', [
  pin('1', 'VBUS', 'passive', 'right'), pin('2', 'CC1', 'passive', 'right'), pin('3', 'D-', 'passive', 'right'), pin('4', 'D+', 'passive', 'right'),
  pin('5', 'CC2', 'passive', 'right'), pin('6', 'GND', 'passive', 'right'), pin('7', 'SHIELD', 'passive', 'right'),
]);
const ESD = card('acme:USBLC6', 'ic', 'U', 'USB ESD protection, SOT-23-6', [
  pin('1', 'IO1A', 'passive', 'left'), pin('2', 'GND', 'pwr_in', 'bottom'), pin('3', 'IO2A', 'passive', 'left'),
  pin('4', 'IO2B', 'passive', 'right'), pin('5', 'VBUS', 'pwr_in', 'top'), pin('6', 'IO1B', 'passive', 'right'),
]);
const XTAL = card('acme:XTAL', 'crystal', 'Y', '8 MHz crystal', [pin('1', '1', 'passive', 'left'), pin('2', '2', 'passive', 'right')]);
const DRIVER = card('acme:HB_DRIVER', 'ic', 'U', 'Half-bridge gate driver, SOIC-8', [
  pin('1', 'VCC', 'pwr_in', 'top'), pin('2', 'IN', 'in', 'left'), pin('3', 'SD', 'in', 'left'), pin('4', 'COM', 'pwr_in', 'bottom'),
  pin('5', 'LO', 'out', 'right'), pin('6', 'VS', 'passive', 'right'), pin('7', 'HO', 'out', 'right'), pin('8', 'VB', 'pwr_in', 'right'),
]);

/* ---------------------------------- helpers -------------------------------- */

const add = (part: string, refdes: string, params?: Record<string, string>): EditOp => ({ op: 'add_part', part, refdes, ...(params ? { params } : {}) });
const R = (ref: string, resistance: string) => add('generic:R', ref, { resistance });
const C = (ref: string, capacitance: string, voltage = '16V') => add('generic:C', ref, { capacitance, voltage });
const net = (name: string, ...pins: string[]): EditOp => ({ op: 'connect', pins, net: name });
const nc = (...pins: string[]): EditOp => ({ op: 'no_connect', pins });

/* --------------------------------- circuits -------------------------------- */

/** The USB-C input: ESD array on D+/D-, 5.1k pull-downs on CC, a TVS on VBUS, shield to ground through R and C; D+/D- and VBUS out to a header. */
const usbc: Golden = {
  id: 'usbc-esd',
  title: 'USB-C input with ESD protection and CC resistors',
  parts: [USBC, ESD],
  ops: [
    add('acme:USBC', 'J1'), add('acme:USBLC6', 'U1'), add('generic:CONN_1x4', 'J2'),
    R('R1', '5.1k'), R('R2', '5.1k'), R('R3', '1M'), C('C1', '4.7nF', '250V'), C('C2', '10uF', '10V'), add('generic:D', 'D1', { mpn: 'SMAJ5.0A' }),
    net('VBUS', 'J1.VBUS', 'U1.VBUS', 'D1.K', 'C2.1', 'J2.1'),
    net('GND', 'J1.GND', 'U1.GND', 'D1.A', 'C2.2', 'R1.2', 'R2.2', 'J2.4', 'R3.2', 'C1.2'),
    net('CC1', 'J1.CC1', 'R1.1'), net('CC2', 'J1.CC2', 'R2.1'),
    net('USB_DM_CONN', 'J1.D-', 'U1.IO1A'), net('USB_DP_CONN', 'J1.D+', 'U1.IO2A'),
    net('USB_DM', 'U1.IO1B', 'J2.2'), net('USB_DP', 'U1.IO2B', 'J2.3'),
    net('SHIELD', 'J1.SHIELD', 'R3.1', 'C1.1'),
    { op: 'set_net', net: 'VBUS', external: true, voltage: 5 },
  ],
};

/** The MCU with its decoupling, an 8 MHz crystal with load caps, the SWD header, reset and boot straps, a status LED. */
const mcu: Golden = {
  id: 'mcu-core',
  title: 'MCU with decoupling, crystal and SWD header',
  parts: [MCU, XTAL],
  ops: [
    add('acme:MCU32', 'U1'), add('acme:XTAL', 'Y1'), add('generic:CONN_1x5', 'J1'),
    C('C1', '100nF'), C('C2', '100nF'), C('C3', '100nF'), C('C4', '1uF'), C('C5', '10uF'), C('C6', '20pF'), C('C7', '20pF'), C('C8', '100nF'),
    R('R1', '10k'), R('R2', '10k'), R('R3', '1k'), R('R4', '1M'), add('generic:LED', 'D1', { color: 'green' }),
    net('+3V3', 'U1.VDD', 'U1.VDDA', 'C1.1', 'C2.1', 'C3.1', 'C4.1', 'C5.1', 'R1.1', 'J1.1'),
    net('GND', 'U1.VSS', 'U1.VSSA', 'C1.2', 'C2.2', 'C3.2', 'C4.2', 'C5.2', 'C6.2', 'C7.2', 'C8.2', 'R2.2', 'D1.K', 'J1.5'),
    net('NRST', 'U1.NRST', 'R1.2', 'C8.1', 'J1.4'),
    net('BOOT0', 'U1.BOOT0', 'R2.1'),
    net('OSC_IN', 'U1.OSC_IN', 'Y1.1', 'C6.1', 'R4.1'), net('OSC_OUT', 'U1.OSC_OUT', 'Y1.2', 'C7.1', 'R4.2'),
    net('SWDIO', 'U1.SWDIO', 'J1.2'), net('SWCLK', 'U1.SWCLK', 'J1.3'),
    net('LED', 'U1.PA0', 'R3.1'), net('LED_A', 'R3.2', 'D1.A'),
    { op: 'set_net', net: '+3V3', external: true, voltage: 3.3 },
  ],
};

/** The MCU's QSPI bus to a flash chip: four data lines, clock and chip select with a pull-up, a series resistor on the clock. */
const qspi: Golden = {
  id: 'mcu-qspi-flash',
  title: 'QSPI flash next to an MCU',
  parts: [MCU, FLASH],
  ops: [
    add('acme:MCU32', 'U1'), add('acme:QSPI_FLASH', 'U2'),
    C('C1', '100nF'), C('C2', '100nF'), C('C3', '100nF'), R('R1', '10k'), R('R2', '33'),
    net('+3V3', 'U1.VDD', 'U1.VDDA', 'C1.1', 'C2.1', 'U2.VCC', 'C3.1', 'R1.1'),
    net('GND', 'U1.VSS', 'U1.VSSA', 'C1.2', 'C2.2', 'U2.GND', 'C3.2'),
    net('FLASH_CS', 'U1.QSPI_NCS', 'U2.CS#', 'R1.2'),
    net('QSPI_CLK_MCU', 'U1.QSPI_CLK', 'R2.1'), net('QSPI_CLK', 'R2.2', 'U2.CLK'),
    net('QSPI_IO0', 'U1.QSPI_IO0', 'U2.IO0'), net('QSPI_IO1', 'U1.QSPI_IO1', 'U2.IO1'),
    net('QSPI_IO2', 'U1.QSPI_IO2', 'U2.IO2'), net('QSPI_IO3', 'U1.QSPI_IO3', 'U2.IO3'),
    { op: 'set_net', net: '+3V3', external: true, voltage: 3.3 },
  ],
};

/** An H-bridge of four MOSFETs, a gate driver per half with its bootstrap diode and capacitor, gate resistors, the supply and the motor. */
const hbridge: Golden = {
  id: 'h-bridge',
  title: 'H-bridge with two half-bridge drivers',
  parts: [DRIVER],
  ops: [
    add('generic:CONN_1x2', 'J1'), add('generic:CONN_1x2', 'J2'), add('generic:CONN_1x4', 'J3'),
    add('acme:HB_DRIVER', 'U1'), add('acme:HB_DRIVER', 'U2'),
    add('generic:NMOS', 'Q1'), add('generic:NMOS', 'Q2'), add('generic:NMOS', 'Q3'), add('generic:NMOS', 'Q4'),
    R('R1', '10'), R('R2', '10'), R('R3', '10'), R('R4', '10'),
    add('generic:D', 'D1', { mpn: 'SS14' }), add('generic:D', 'D2', { mpn: 'SS14' }),
    C('C1', '100nF'), C('C2', '100nF'), C('C3', '100uF', '35V'), C('C4', '100nF'), C('C5', '100nF'),
    net('VM', 'J1.1', 'C3.1', 'Q1.D', 'Q3.D'),
    net('GND', 'J1.2', 'C3.2', 'Q2.S', 'Q4.S', 'U1.COM', 'U2.COM', 'C4.2', 'C5.2', 'J3.4'),
    net('+12V', 'D1.A', 'D2.A', 'U1.VCC', 'U2.VCC', 'C4.1', 'C5.1', 'J3.3'),
    net('OUT_A', 'Q1.S', 'Q2.D', 'U1.VS', 'C1.2', 'J2.1'), net('OUT_B', 'Q3.S', 'Q4.D', 'U2.VS', 'C2.2', 'J2.2'),
    net('BOOT_A', 'D1.K', 'U1.VB', 'C1.1'), net('BOOT_B', 'D2.K', 'U2.VB', 'C2.1'),
    net('HO_A', 'U1.HO', 'R1.1'), net('G1', 'R1.2', 'Q1.G'), net('LO_A', 'U1.LO', 'R2.1'), net('G2', 'R2.2', 'Q2.G'),
    net('HO_B', 'U2.HO', 'R3.1'), net('G3', 'R3.2', 'Q3.G'), net('LO_B', 'U2.LO', 'R4.1'), net('G4', 'R4.2', 'Q4.G'),
    net('IN_A', 'U1.IN', 'J3.1'), net('IN_B', 'U2.IN', 'J3.2'), net('SD', 'U1.SD', 'U2.SD'),
    { op: 'set_net', net: 'VM', external: true, voltage: 24 },
    { op: 'set_net', net: '+12V', external: true, voltage: 12 },
  ],
};

/** An inverting op-amp stage biased to mid-supply by a divider, with input and output coupling, a feedback cap and decoupling. */
const opamp: Golden = {
  id: 'opamp-stage',
  title: 'Op-amp stage (inverting amplifier on a mid-supply bias)',
  ops: [
    add('generic:CONN_1x3', 'J1'), add('generic:CONN_1x2', 'J2'), add('ti:LM358DR', 'U1'),
    R('R1', '10k'), R('R2', '100k'), R('R3', '10k'), R('R4', '10k'), R('R5', '1k'),
    C('C1', '1uF'), C('C2', '1uF'), C('C3', '10pF', '50V'), C('C4', '100nF'), C('C5', '10uF'),
    net('+5V', 'J1.1', 'U1.V+', 'R3.1', 'C4.1', 'C5.1'),
    net('GND', 'J1.2', 'U1.GND', 'R4.2', 'C4.2', 'C5.2', 'J2.2'),
    net('IN', 'J1.3', 'C1.1'), net('INV', 'C1.2', 'R1.1', 'U1.INA-', 'R2.2', 'C3.2'),
    net('BIAS', 'R3.2', 'R4.1', 'U1.INA+'),
    net('AMP', 'U1.OUTA', 'R2.1', 'C3.1', 'R5.1'), net('OUT', 'R5.2', 'C2.1'), net('OUT_AC', 'C2.2', 'J2.1'),
    nc('U1.INB+', 'U1.INB-', 'U1.OUTB'),
  ],
};

/** A full-wave rectifier of four diodes from an AC input, a reservoir cap and a linear regulator with its caps. */
const bridge: Golden = {
  id: 'diode-bridge',
  title: 'Full diode bridge into a linear regulator',
  ops: [
    add('generic:CONN_1x2', 'J1'), add('generic:CONN_1x2', 'J2'),
    add('generic:D', 'D1', { mpn: '1N4007' }), add('generic:D', 'D2', { mpn: '1N4007' }), add('generic:D', 'D3', { mpn: '1N4007' }), add('generic:D', 'D4', { mpn: '1N4007' }),
    add('ams:AMS1117-3.3', 'U1'), C('C1', '470uF', '25V'), C('C2', '100nF', '25V'), C('C3', '22uF', '10V'), C('C4', '100nF', '10V'),
    add('generic:LED', 'D5', { color: 'green' }), R('R1', '1k'),
    net('AC1', 'J1.1', 'D1.A', 'D2.K'), net('AC2', 'J1.2', 'D3.A', 'D4.K'),
    net('RECT', 'D1.K', 'D3.K', 'C1.1', 'C2.1', 'U1.VIN'),
    net('GND', 'D2.A', 'D4.A', 'C1.2', 'C2.2', 'U1.GND', 'C3.2', 'C4.2', 'D5.K', 'J2.2'),
    net('+3V3', 'U1.VOUT', 'C3.1', 'C4.1', 'R1.1', 'J2.1'), net('PWR_LED', 'R1.2', 'D5.A'),
    { op: 'set_net', net: '+3V3', voltage: 3.3 },
  ],
};

/** The bridge as one package (generic:BRIDGE), with the same supply. */
const packedBridge: Golden = {
  id: 'bridge-package',
  title: 'Bridge rectifier package into a filter and regulator',
  ops: [
    add('generic:CONN_1x2', 'J1'), add('generic:BRIDGE', 'D1', { mpn: 'MB6S' }), add('ams:AMS1117-3.3', 'U1'),
    C('C1', '220uF', '25V'), C('C2', '22uF', '10V'), add('generic:CONN_1x2', 'J2'),
    net('AC1', 'J1.1', 'D1.AC1'), net('AC2', 'J1.2', 'D1.AC2'),
    net('RECT', 'D1.+', 'C1.1', 'U1.VIN'),
    net('GND', 'D1.-', 'C1.2', 'U1.GND', 'C2.2', 'J2.2'),
    net('+3V3', 'U1.VOUT', 'C2.1', 'J2.1'),
  ],
};

/** A 555 astable blinking an LED: two timing resistors, a timing cap, a control-voltage cap, decoupling. */
const timer: Golden = {
  id: 'timer-555',
  title: '555 astable driving an LED',
  ops: [
    add('generic:CONN_1x2', 'J1'), add('ti:NE555DR', 'U1'),
    R('R1', '10k'), R('R2', '47k'), R('R3', '470'), C('C1', '10uF'), C('C2', '10nF'), C('C3', '100nF'), add('generic:LED', 'D1', { color: 'red' }),
    net('+9V', 'J1.1', 'U1.VCC', 'U1.RESET', 'R1.1', 'C3.1'),
    net('GND', 'J1.2', 'U1.GND', 'C1.2', 'C2.2', 'C3.2', 'D1.K'),
    net('DIS', 'R1.2', 'R2.1', 'U1.DISCH'), net('TH', 'R2.2', 'U1.THRES', 'U1.TRIG', 'C1.1'),
    net('CV', 'U1.CONT', 'C2.1'), net('OUT', 'U1.OUT', 'R3.1'), net('LED_A', 'R3.2', 'D1.A'),
    { op: 'set_net', net: '+9V', external: true, voltage: 9 },
  ],
};

/** The buck of docs/design/schematic-drawing.md §1 (a TPS40222 with its divider, saved as a design). */
const tps40222: Golden = {
  id: 'buck-tps40222',
  title: 'TPS40222 buck with feedback divider (saved design)',
  design: () => JSON.parse(readFileSync(new URL('../test/tps40222.json', import.meta.url), 'utf8')) as Design,
};

/** The 12 V to 3.3 V buck of the kernel tests (TPS54331: bootstrap, catch diode, compensation, feedback divider). */
const buck: Golden = {
  id: 'buck-tps54331',
  title: 'TPS54331 buck with feedback divider',
  ops: buckTransaction().ops,
};

/** A mixed board of 30 parts: the buck, an ATtiny85 with decoupling, reset pull-up, I2C pull-ups and three LEDs, and an op-amp following a divider. */
const mixedOps = (): EditOp[] => [
  ...buckTransaction().ops,
  add('microchip:ATTINY85-20SU', 'U2'), add('ti:LM358DR', 'U3'), add('generic:CONN_1x4', 'J2'),
  C('C10', '100nF'), C('C11', '100nF'), C('C12', '10uF'),
  R('R10', '10k'), R('R11', '4.7k'), R('R12', '4.7k'), R('R13', '330'), R('R14', '330'), R('R15', '330'), R('R16', '20k'), R('R17', '10k'),
  add('generic:LED', 'D10', { color: 'red' }), add('generic:LED', 'D11', { color: 'green' }), add('generic:LED', 'D12', { color: 'blue' }),
  net('+3V3', 'U2.VCC', 'C10.1', 'R10.1', 'R11.1', 'R12.1', 'U3.V+', 'C11.1', 'R16.1', 'J2.1', 'C12.1'),
  net('GND', 'U2.GND', 'C10.2', 'C11.2', 'C12.2', 'U3.GND', 'R17.2', 'D10.K', 'D11.K', 'D12.K', 'J2.4'),
  net('RESET', 'U2.PB5/RESET', 'R10.2'),
  net('SDA', 'U2.PB0', 'R11.2', 'J2.2'), net('SCL', 'U2.PB2', 'R12.2', 'J2.3'),
  net('LED1', 'U2.PB1', 'R13.1'), net('LED1_A', 'R13.2', 'D10.A'),
  net('LED2', 'U2.PB4', 'R14.1'), net('LED2_A', 'R14.2', 'D11.A'),
  net('VMON', 'R16.2', 'R17.1', 'U3.INA+'), net('VMON_BUF', 'U3.INA-', 'U3.OUTA', 'U2.PB3', 'R15.1'),
  net('LED3_A', 'R15.2', 'D12.A'),
  nc('U3.INB+', 'U3.INB-', 'U3.OUTB'),
];
const mixed: Golden = { id: 'mixed-board', title: 'Mixed board: buck, ATtiny85 with LEDs and I2C, op-amp monitor (29 parts)', ops: mixedOps() };

/** The same board drawn as the app draws a described design: functional blocks. */
const mixedBlocks: Golden = {
  ...mixed,
  id: 'mixed-board-blocks',
  title: 'The mixed board grouped into functional blocks',
  blocks: [
    { title: 'Power input', refs: ['J1', 'C1'] },
    { title: '3.3 V buck', refs: ['U1', 'L1', 'D1', 'C2', 'C3', 'C4', 'C5', 'R1', 'R2', 'R3'] },
    { title: 'Microcontroller', refs: ['U2', 'C10', 'R10', 'R11', 'R12', 'J2'] },
    { title: 'Status LEDs', refs: ['D10', 'D11', 'D12', 'R13', 'R14', 'R15'] },
    { title: 'Supply monitor', refs: ['U3', 'C11', 'C12', 'R16', 'R17'] },
  ],
};

export const GOLDEN: readonly Golden[] = [buck, tps40222, usbc, mcu, qspi, hbridge, opamp, bridge, packedBridge, timer, mixed, mixedBlocks];

/** The circuit as a committed kernel, ready to be laid out (the layout runs when the view is asked for). */
export function build(g: Golden): Kernel {
  const k = new Kernel();
  if (g.design) {
    k.load(g.design());
    return k;
  }
  const d = k.committedDesign();
  for (const p of g.parts ?? []) d.parts[p.id] = p;
  k.load(d);
  const ops: EditOp[] = [...(g.ops ?? []), ...(g.blocks ? [{ op: 'describe', blocks: g.blocks } as EditOp] : [])];
  const r = k.transact({ summary: g.title, ops });
  if (r.status !== 'ok') throw new Error(`${g.id}: ${JSON.stringify(r.rejection ?? r).slice(0, 600)}`);
  k.accept();
  return k;
}
