/**
 * Fabrication notes (`<project>-fab-notes.txt` in the fab zip): the board's thickness and copper,
 * the stack-up it was designed for, its lines at a set impedance and the finish, then how each of
 * JLCPCB, PCBWay and Eurocircuits is to be given them. A plain text file, read by the user and the
 * house; the design document's Layout section shows the same lines. See docs/design/impedance.md §9.
 */
import { COPPER_ORDER, defaultStackup, type BoardView, type Stackup } from '@4k7/schema';
import { stampLines, type FabStamp } from './gerber.ts';

const HOUSES = ['JLCPCB', 'PCBWay', 'Eurocircuits'] as const;
type House = (typeof HOUSES)[number];

const r = (v: number, d = 3) => String(Math.round(v * 10 ** d) / 10 ** d);
const um = (mm: number) => `${r(mm * 1000, 1)} µm`;
/** Copper weight to the nearest half ounce (1 oz = 35 µm; a finished inner 15.2 µm is ordered as 0.5 oz). */
const oz = (mm: number) => `${Math.max(0.5, Math.round((mm / 0.035) * 2) / 2)} oz`;

/** The stack-up in effect: the board's, else the default for its layer count and fab. */
export function notesStackup(b: Pick<BoardView, 'stackup' | 'layers' | 'fab'>): Stackup {
  return b.stackup ?? defaultStackup(b.layers.length === 4 ? 4 : 2, b.fab);
}

/** Thickness over copper and dielectric (mm), and the nearest tenth to order. */
function thickness(s: Stackup): { exact: number; order: number } {
  const exact = s.copper.reduce((a, c) => a + c, 0) + s.dielectric.reduce((a, d) => a + d.mm, 0);
  return { exact: Math.round(exact * 100) / 100, order: Math.round(exact * 10) / 10 };
}

/** "1.6 mm (copper and dielectric add up to 1.59 mm)". */
export function thicknessText(s: Stackup): string {
  const t = thickness(s);
  return `${t.order} mm${t.exact !== t.order ? ` (copper and dielectric add up to ${t.exact} mm)` : ''}`;
}

/** "outer 1 oz (35 µm), inner 0.5 oz (15.2 µm)" or, where the layers differ otherwise, each layer. */
export function copperText(s: Stackup): string {
  const names = COPPER_ORDER[s.copper.length as 2 | 4] ?? s.copper.map((_, i) => `L${i + 1}`);
  const outer: number[] = [s.copper[0]!, s.copper.at(-1)!];
  const inner = s.copper.slice(1, -1);
  const same = (xs: number[]) => xs.every((x) => x === xs[0]);
  if (same(outer) && same(inner)) return `outer ${oz(outer[0]!)} (${um(outer[0]!)})${inner.length ? `, inner ${oz(inner[0]!)} (${um(inner[0]!)})` : ''}`;
  return s.copper.map((c, i) => `${names[i]} ${oz(c)} (${um(c)})`).join(', ');
}

/** The build-up top to bottom, one line per copper layer, dielectric and mask. */
export function stackupLines(s: Stackup): string[] {
  const names = COPPER_ORDER[s.copper.length as 2 | 4] ?? s.copper.map((_, i) => `L${i + 1}`);
  const mask = (side: string) => (s.mask ? [`Solder mask (${side}): ${um(s.mask.overCopper)} over copper, ${um(s.mask.overLaminate)} over laminate, εr ${s.mask.er}`] : []);
  const out = mask('top');
  s.copper.forEach((c, i) => {
    out.push(`${names[i]}: copper ${um(c)} (${oz(c)})`);
    const d = s.dielectric[i];
    if (d) out.push(`  ${d.what ?? 'dielectric'}: ${r(d.mm, 4)} mm, εr ${d.er}`);
  });
  return [...out, ...mask('bottom')];
}

/** Where the stack-up comes from: "JLC04161H-7628 (JLCPCB's, https://…, checked 2026-10-25)". */
export function stackupSource(s: Stackup): string {
  const whose = s.origin === 'generic' ? 'a typical FR-4 board, not a manufacturer\'s' : s.origin === 'imported' ? 'imported' : `${HOUSES.find((h) => s.id.toLowerCase().startsWith(`${h.toLowerCase()}/`)) ?? s.id.split('/')[0]} preset`;
  return `${s.name} (${whose}${s.source ? `, ${s.source.url}${s.source.checked ? `, checked ${s.source.checked}` : ''}` : ''})`;
}

/** Each line at a set impedance: a heading line, then one line per layer it can be built on. Empty: none. */
export function impedanceLines(b: Pick<BoardView, 'impedance' | 'netNames'>): string[][] {
  const name = (id: string) => b.netNames[id] ?? id;
  return (b.impedance ?? []).map((v) => [
    `${v.id}${v.label ? ` ${v.label}` : ''}: ${v.nets.map(name).join(' / ')}, ${v.ohms} Ω${v.pair ? ' differential' : ''} ±${v.tolerance} %, ${v.style}`,
    ...v.layers.map((l) => `${l.layer} over ${l.over} (${r(l.h, 4)} mm, εr ${l.er}): width ${r(l.width)} mm${l.gap !== undefined ? `, gap ${r(l.gap)} mm` : ''}${l.side !== undefined ? `, ${r(l.side)} mm to the ground beside it` : ''}`),
    ...v.unusable.map((u) => `not on ${u.layer}: ${u.why}`),
  ]);
}

/** The finish and colours: the design does not choose them, so the order does. */
export const FINISH_TEXT = 'Surface finish, solder mask colour and silkscreen colour are not set in the design: choose them when you order.';


/** How a house is to be given the stack-up, the impedance table and the finish. */
function houseLines(house: House, b: BoardView, s: Stackup, file: string): string[] {
  const ours = s.id.toLowerCase().startsWith(`${house.toLowerCase()}/`);
  const lines = (b.impedance ?? []).length > 0;
  const set = (form: string) => `${form}: thickness ${thickness(s).order} mm, copper ${copperText(s)}, and the surface finish, solder mask and silkscreen colours.`;
  const not = `The stack-up above is not ${house}'s: the widths were worked out for it. Set ${house}'s build-up (set_stackup) and check the widths before you order.`;
  const out: string[] = [];
  if (house === 'JLCPCB') {
    out.push(`${set('Set in the order form')} JLCPCB builds from the order form, not from notes in the zip.`);
    if (!lines) out.push('Impedance Control: No (no line on this board is routed at a set impedance).');
    else if (b.layers.length === 2) out.push('JLCPCB controls impedance from 4 layers only: order without impedance control. On 2 layers the core is nominal (1.6 mm ±10 %, εr 4.5), so a line comes out within about ±15 %.');
    else {
      out.push(`Impedance Control: Yes, with the stack-up ${ours ? s.name : 'that matches the one above'} selected. JLCPCB holds ±10 %; it does not read the impedance table from a file.`);
      if (!ours) out.push(not);
    }
  } else if (house === 'PCBWay') {
    out.push(set('Set in the quote form'));
    if (!lines) out.push('No impedance control needed.');
    else {
      out.push(`Ask for impedance control, and write in the order's remarks: "Stack-up and impedance table in ${file}". PCBWay builds the stack-up and may adjust the widths a little to hit the targets.`);
      if (!ours) out.push(not);
    }
  } else {
    out.push(set('Set in the configurator'));
    if (!lines) out.push('No impedance control needed: the standard pool will do.');
    else {
      out.push(`Order in the defined-impedance pool, pick its build-up in the configurator, and send ${file} with the data for the impedance table.`);
      if (!ours) out.push(`Eurocircuits shows its build-up only in the configurator: import it (set_stackup) and check the widths before you order.`);
    }
  }
  return out;
}

/** The notes file's text. */
export function fabNotes(b: BoardView, project: string, file: string, stamp?: FabStamp): string {
  const s = notesStackup(b);
  const imp = impedanceLines(b);
  const indent = (xs: string[], n = 2) => xs.map((x) => `${' '.repeat(n)}${x}`);
  const out = [
    'FABRICATION NOTES',
    ...stampLines(project, stamp),
    '',
    'BOARD',
    ...indent([
      `Size: ${b.outline.w} × ${b.outline.h} mm, ${b.layers.length} copper layers (${b.layers.join(', ')})`,
      `Thickness: ${thicknessText(s)}`,
      `Copper (finished): ${copperText(s)}`,
      ...(b.fab ? [`Designed to: ${b.fab.house}, ${b.fab.tier} (${b.fab.source.url})`] : []),
    ]),
    '',
    'STACK-UP, TOP TO BOTTOM',
    ...indent([stackupSource(s), ...indent(stackupLines(s)), ...(s.notes ?? [])]),
    '',
    'CONTROLLED IMPEDANCE',
    ...indent(imp.length ? imp.flatMap(([head, ...layers]) => [head!, ...indent(layers)]) : ['None: no line on this board is routed at a set impedance.']),
    '',
    'FINISH',
    ...indent([FINISH_TEXT]),
  ];
  for (const house of HOUSES) out.push('', `FOR ${house.toUpperCase()}`, ...indent(houseLines(house, b, s, file)));
  return out.join('\n') + '\n';
}
