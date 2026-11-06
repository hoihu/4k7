/**
 * The board's netlist as an IPC-D-356A file, for the fab house's electrical test: every pad and via
 * with its net, where it is (the Gerbers' coordinates, y up from the board's bottom-left corner),
 * its size, its hole and the side it is reached from. The house extracts a netlist from the Gerbers
 * itself and compares the two before it builds anything, so a short or an open that only the files
 * have (one their writer put there) stops the order instead of reaching the boards.
 *
 * The format: records of 80 fixed columns. P records give the job, the units (CUST 0: inches,
 * coordinates and sizes in 0.0001 in, angles in degrees), the version and the image; a net's name
 * has 14 columns, so a longer one goes by an alias that a P NNAME record spells out; a pad on no
 * net is on N/C. A test record (317 a plated hole's pad or a via, 327 a surface pad) holds, by
 * column: 1-3 the record type, 4-17 the net, 21-26 the designator, 27 a dash before 28-31 the pin,
 * 32 M for a midpoint (a via: joined, not an end to probe), 33-38 the hole (D, its diameter, P
 * plated), 39-41 the access side (A00 both, A01 the top, the bottom by its layer number), 42-57 the
 * position (X and Y, signed, 6 digits), 58-71 the size (X and Y, 4 digits; Y 0 for a round pad) and
 * rotation (R, 3 digits), 73-74 the solder mask (S0 bare both sides, S1 covered on top, S2 covered
 * on the bottom, S3 both). 999 ends the file.
 *
 * readIpc356 reads such a file back (ours, or another program's), so the Gerber viewer can hold a
 * set of files against the netlist that came with them, as the house does.
 */
import type { BoardView, PanelView } from '@4k7/schema';
import type { FabStamp } from './gerber.ts';
import type { NetDesign, NetPad, NetVia } from './netcheck.ts';

/** 0.0001 inch in mm. */
const UNIT = 0.00254;
const NO_NET = 'N/C';
const NAME_COLS = 14;
const natCmp = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

const units = (mm: number, max: number) => Math.max(-max, Math.min(max, Math.round(mm / UNIT)));
const signed = (v: number) => `${v < 0 ? '-' : '+'}${String(Math.abs(v)).padStart(6, '0')}`;
const digits = (v: number, n: number) => String(Math.max(0, v)).padStart(n, '0');
/** What a net's name may hold in the file: printable ASCII, no spaces, upper case (some test programs read no lower case). */
const canonical = (name: string) => name.replace(/[^\x21-\x7e]/g, '_').toUpperCase();

/** A record padded to the format's 80 columns (its text kept to 72, the rest are the record's own). */
const record = (s: string) => s.slice(0, 80).padEnd(80);
const param = (name: string, value: string) => record(`P  ${name.padEnd(6)}${value}`.slice(0, 72));

interface Point {
  net: string | null;
  /** 317, 327. */
  type: number;
  ref: string;
  pin: string;
  via: boolean;
  /** mm, the files' coordinates. */
  x: number;
  y: number;
  w: number;
  h: number;
  round: boolean;
  drill?: number;
  /** 0 both sides, 1 the top, the layer count for the bottom. */
  access: number;
  /** 0 bare both sides, 1 covered on top, 2 covered below, 3 both. */
  mask: number;
}

/** The netlist of the board, or of its panel (`opts.panel`: each copy's nets apart, named with the copy's number: GND_2). */
export function ipc356(b: BoardView, project: string, opts: { panel?: PanelView; stamp?: FabStamp } = {}): string {
  const { panel, stamp } = opts;
  const copies = panel ? panel.copies.map((c, i) => ({ dx: c.dx, dy: c.dy, n: i + 1 })) : [{ dx: 0, dy: 0, n: 0 }];
  const H = panel ? panel.h : b.outline.h;
  const layers = b.layers.length;
  const points: Point[] = [];
  for (const { dx, dy, n } of copies) {
    const net = (id: string | undefined) => (id ? `${b.netNames[id] ?? id}${panel ? `_${n}` : ''}` : null);
    for (const v of b.vias) points.push({ net: net(v.netId), type: 317, ref: 'VIA', pin: '', via: true, x: v.x + dx, y: H - (v.y + dy), w: v.pad, h: v.pad, round: true, drill: v.drill, access: 0, mask: 3 });
    for (const part of b.parts) {
      if (part.componentId.startsWith('hole:') && part.pads.every((p) => p.npth)) continue;
      for (const p of part.pads) {
        if (p.npth) continue;
        const top = p.layers.includes(b.layers[0]!);
        points.push({
          net: net(p.netId),
          type: p.drill ? 317 : 327,
          ref: panel ? `${part.refdes}_${n}` : part.refdes,
          pin: p.number,
          via: false,
          x: p.x + dx,
          y: H - (p.y + dy),
          w: p.w,
          h: p.h,
          round: p.shape === 'round' && p.w === p.h,
          ...(p.drill ? { drill: p.drill } : {}),
          access: p.drill ? 0 : top ? 1 : layers,
          // (the mask is open over a pad on its side: a plated hole's pad on both)
          mask: p.drill ? 0 : top ? 2 : 1,
        });
      }
    }
  }

  // each net's name in the file: its own where that fits and is its alone, else an alias
  const names = [...new Set(points.flatMap((p) => (p.net ? [p.net] : [])))].sort(natCmp);
  const count = new Map<string, number>();
  for (const n of names) count.set(canonical(n), (count.get(canonical(n)) ?? 0) + 1);
  const inFile = new Map<string, string>();
  const taken = new Set([NO_NET, ...count.keys()]);
  const aliases: string[] = [];
  let next = 1;
  for (const n of names) {
    const c = canonical(n);
    if (c.length <= NAME_COLS && c !== NO_NET && count.get(c) === 1) {
      inFile.set(n, c);
      continue;
    }
    // (an alias fills the five columns NNAME leaves it)
    let alias: string;
    do alias = `N${String(next++).padStart(4, '0')}`;
    while (taken.has(alias));
    taken.add(alias);
    inFile.set(n, alias);
    // (the alias in 9-13, the name from 15 on: its end where it is too long, the end tells nets apart)
    aliases.push(record(`P  NNAME${alias.padEnd(5)} ${n.replace(/[^\x20-\x7e]/g, '_').slice(-58)}`));
  }
  const netOf = (p: Point) => (p.net ? inFile.get(p.net)! : NO_NET);

  // by net (the pads of no net last), each net's vias first, then its pads by designator and pin
  points.sort((p, q) => (p.net === null ? 1 : 0) - (q.net === null ? 1 : 0) || natCmp(netOf(p), netOf(q)) || Number(q.via) - Number(p.via) || natCmp(p.ref, q.ref) || natCmp(p.pin, q.pin) || p.x - q.x || p.y - q.y);

  const lines = [
    ...stampComments(project, stamp),
    param('JOB', project.replace(/[^\x20-\x7e]/g, '_') || 'board'),
    param('CODE', '00'),
    param('UNITS', 'CUST 0'),
    param('VER', 'IPC-D-356A'),
    param('IMAGE', 'PRIMARY'),
    ...aliases,
  ];
  for (const p of points) {
    const hole = p.drill ? `D${digits(units(p.drill, 9999), 4)}P` : ' '.repeat(6);
    const size = `X${digits(units(p.w, 9999), 4)}Y${digits(p.round ? 0 : units(p.h, 9999), 4)}R000`;
    lines.push(
      record(
        `${p.type}${netOf(p).slice(0, NAME_COLS).padEnd(NAME_COLS)}   ${p.ref.slice(0, 6).padEnd(6)}${p.pin ? '-' : ' '}${p.pin.slice(0, 4).padEnd(4)}${p.via ? 'M' : ' '}${hole}A${digits(p.access, 2)}X${signed(units(p.x, 999999))}Y${signed(units(p.y, 999999))}${size} S${p.mask}`,
      ),
    );
  }
  lines.push(record('999'));
  return lines.join('\n') + '\n';
}

function stampComments(project: string, stamp?: FabStamp): string[] {
  const out = [`C  IPC-D-356A netlist of ${project || 'board'}${stamp?.board ? `, board ${stamp.board}` : ''}`, `C  written by 4k7 ${stamp?.version ?? 'unknown'}${stamp?.date ? ` on ${stamp.date}` : ''}`];
  return out.map((l) => record(l.replace(/[^\x20-\x7e]/g, '_').slice(0, 72)));
}

/* reading */

export interface Ipc356Point {
  net: string | null;
  type: number;
  ref: string;
  pin: string;
  midpoint: boolean;
  /** mm, the file's coordinates. */
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  drill?: number;
  plated?: boolean;
  access: number;
  mask?: number;
}

export interface Ipc356Read {
  job?: string;
  points: Ipc356Point[];
  /** What was read with a caveat or not at all. */
  notes: string[];
}

/** An IPC-D-356 netlist by its look: parameter records and test records of the format. */
export function isIpc356(content: string): boolean {
  const head = content.slice(0, 6000);
  return /^P {2}(JOB|UNITS|VER|CODE|IMAGE)\b/m.test(head) && /^3[0-9]{2}\S/m.test(content);
}

export function readIpc356(src: string): Ipc356Read {
  const notes = new Set<string>();
  const alias = new Map<string, string>();
  let scale = UNIT;
  let job: string | undefined;
  const points: Ipc356Point[] = [];
  const num = (s: string) => (/^[+-]?\d+$/.test(s.trim()) ? Number(s.trim()) : NaN);
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.padEnd(80);
    if (line.startsWith('P')) {
      const name = line.slice(3, 9).trim().toUpperCase();
      const value = line.slice(9).trim();
      if (name === 'JOB') job = value;
      else if (name === 'UNITS') {
        if (/^CUST\s*0$/i.test(value) || /^ENG/i.test(value)) scale = UNIT;
        else if (/^CUST\s*1$/i.test(value) || /^SI/i.test(value)) {
          scale = 0.001;
          notes.add('metric units (CUST 1) read as 0.001 mm');
        } else notes.add(`units "${value}" not known: read as 0.0001 inch`);
      } else if (line.slice(3, 8).toUpperCase() === 'NNAME') {
        const a = line.slice(8, 13).trim();
        if (a) alias.set(a, line.slice(14).trim());
      }
      continue;
    }
    if (!/^3\d\d/.test(line)) continue;
    const type = Number(line.slice(0, 3));
    if (type === 27 || line.startsWith('027')) continue;
    const field = (c: string, from: number, to: number) => (line[from - 1] === c ? num(line.slice(from, to)) : NaN);
    const x = field('X', 42, 49);
    const y = field('Y', 50, 57);
    if (Number.isNaN(x) || Number.isNaN(y)) {
      notes.add(`a record without a position was left out (${line.slice(0, 31).trim()})`);
      continue;
    }
    const netField = line.slice(3, 17).trim();
    const d = field('D', 33, 37);
    const w = field('X', 58, 62);
    const h = field('Y', 63, 67);
    const r = field('R', 68, 71);
    const a = field('A', 39, 41);
    const s = field('S', 73, 74);
    points.push({
      net: !netField || netField === NO_NET ? null : (alias.get(netField) ?? netField),
      type,
      ref: line.slice(20, 26).trim(),
      pin: line.slice(27, 31).trim(),
      midpoint: line[31] === 'M',
      x: x * scale,
      y: y * scale,
      w: Number.isNaN(w) ? 0 : w * scale,
      h: Number.isNaN(h) ? 0 : h * scale,
      rotation: Number.isNaN(r) ? 0 : r,
      ...(Number.isNaN(d) ? {} : { drill: d * scale, plated: line[37] !== 'U' }),
      access: Number.isNaN(a) ? 0 : a,
      ...(Number.isNaN(s) ? {} : { mask: s }),
    });
  }
  return { ...(job ? { job } : {}), points, notes: [...notes] };
}

/** A netlist read back as what the netlist check holds files against, for the copper layers `layers` (ids, top down). */
export function ipcNetDesign(read: Ipc356Read, layers: string[]): NetDesign {
  const pads: NetPad[] = [];
  const vias: NetVia[] = [];
  const n = layers.length;
  for (const p of read.points) {
    if (p.type === 367 || p.plated === false) continue;
    // (round: Y 0; turned a quarter: its sides swap)
    const quarter = Math.round(p.rotation / 90) % 2 === 1;
    const [w, h] = p.h === 0 ? [p.w, p.w] : quarter ? [p.h, p.w] : [p.w, p.h];
    if (p.midpoint && !p.pin) {
      if (p.net) vias.push({ net: p.net, x: p.x, y: p.y, pad: w, drill: p.drill ?? 0 });
      continue;
    }
    const on = p.access === 0 || p.drill ? layers : p.access === 1 ? layers.slice(0, 1) : p.access >= n ? layers.slice(-1) : [layers[p.access - 1]!].filter(Boolean);
    pads.push({ name: `${p.ref}.${p.pin}`, net: p.net, x: p.x, y: p.y, w, h, shape: p.h === 0 ? 'round' : 'rect', layers: [...on], ...(p.drill ? { drill: p.drill } : {}) });
  }
  return { pads, vias };
}
