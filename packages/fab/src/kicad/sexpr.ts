/**
 * KiCad's s-expressions: a writer that lays the text out as KiCad 10 saves it (its Prettify in
 * common/io/kicad/kicad_io_utils.cpp: one tab per level, a list without inner lists on one line, the
 * points of a polygon several to a line), and a small reader, which the tests use to read back what
 * was written. See docs/design/kicad-export.md §2.
 *
 * A list is an array. Its first element, when a string, is the list's keyword and written bare
 * (`(layer "F.Cu")`); every other string is a string and always quoted; a `Sym` is written bare
 * (`smd`, `yes`); a number is written with at most six decimals and no trailing zeros (KiCad's
 * board unit is the nanometre). The same input gives the same text.
 */

/** A bare token: a keyword inside a list (`smd`, `thru_hole`, `yes`). */
export class Sym {
  constructor(readonly name: string) {}
}

export type SAtom = string | number | Sym;
export type SNode = SAtom | SNode[];
export type SList = SNode[];

export const sym = (name: string) => new Sym(name);
/** KiCad's booleans: `yes` and `no`. */
export const yn = (v: boolean) => sym(v ? 'yes' : 'no');

/** A number as KiCad writes it: at most six decimals, no trailing zeros, no "-0". */
export function num(v: number): string {
  if (!Number.isFinite(v)) throw new Error(`not a number for a KiCad file: ${v}`);
  const s = (Math.round(v * 1e6) / 1e6).toFixed(6).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

/** A string in double quotes, with backslashes, quotes and line breaks escaped. */
export function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

function atom(a: SAtom, head: boolean): string {
  if (a instanceof Sym) return a.name;
  if (typeof a === 'number') return num(a);
  return head ? a : quote(a);
}

/** The points of a polygon go several to a line until this column, as KiCad lays them out. */
const XY_COLUMN = 99;

function render(list: SList, depth: number): string {
  const lists = list.some(Array.isArray);
  if (!lists) return `(${list.map((x, i) => atom(x as SAtom, i === 0)).join(' ')})`;
  const indent = '\t'.repeat(depth + 1);
  let out = '(';
  let started = false;
  let column = depth;
  let prevXY = false;
  list.forEach((x, i) => {
    if (!Array.isArray(x)) {
      const t = atom(x, i === 0);
      out += (started ? ' ' : '') + t;
      started = true;
      return;
    }
    const text = render(x, depth + 1);
    const isXY = x[0] === 'xy';
    if (isXY && prevXY && column < XY_COLUMN) {
      out += ` ${text}`;
      column += 1 + text.length;
    } else {
      out += `\n${indent}${text}`;
      column = depth + 1 + text.length;
    }
    prevXY = isXY;
  });
  return `${out}\n${'\t'.repeat(depth)})`;
}

/** A file's text: the list laid out as KiCad does, with a line break at the end. */
export function write(root: SList): string {
  return `${render(root, 0)}\n`;
}

/* ---- reader ---- */

/**
 * Reads s-expression text: lists as arrays, quoted strings as strings, bare numbers as numbers, other
 * bare tokens as `Sym` (a list's first bare token as a string, its keyword). For the tests: it reads
 * what `write` writes, and the KiCad files kept as a reference.
 */
export function read(text: string): SList {
  let i = 0;
  const n = text.length;
  const ws = () => {
    while (i < n && /\s/.test(text[i]!)) i++;
  };
  const list = (): SList => {
    if (text[i] !== '(') throw new Error(`expected ( at ${i}`);
    i++;
    const out: SList = [];
    for (;;) {
      ws();
      if (i >= n) throw new Error('unexpected end: a list is not closed');
      const c = text[i]!;
      if (c === ')') {
        i++;
        return out;
      }
      if (c === '(') out.push(list());
      else if (c === '"') {
        i++;
        let s = '';
        while (i < n && text[i] !== '"') {
          if (text[i] === '\\') {
            const e = text[i + 1]!;
            s += e === 'n' ? '\n' : e === 'r' ? '\r' : e;
            i += 2;
          } else s += text[i++];
        }
        if (i >= n) throw new Error('unexpected end: a string is not closed');
        i++;
        out.push(s);
      } else {
        const start = i;
        while (i < n && !/[\s()"]/.test(text[i]!)) i++;
        const t = text.slice(start, i);
        if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) out.push(Number(t));
        else out.push(out.length === 0 ? t : sym(t));
      }
    }
  };
  ws();
  const root = list();
  ws();
  if (i < n) throw new Error(`text after the end of the list at ${i}`);
  return root;
}

/** The first inner list with this keyword. */
export function child(l: SList, head: string): SList | undefined {
  return l.find((x): x is SList => Array.isArray(x) && x[0] === head);
}

/** Every inner list with this keyword. */
export function children(l: SList, head: string): SList[] {
  return l.filter((x): x is SList => Array.isArray(x) && x[0] === head);
}

/** A bare token's or a string's text, a number as is. */
export const text = (x: SNode | undefined): string | number | undefined => (x instanceof Sym ? x.name : Array.isArray(x) ? undefined : x);
