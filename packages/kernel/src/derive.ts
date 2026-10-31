/**
 * What is worked out from a design is asked for many times during one edit: an op wants to know
 * where things stand, the next op too, then the checks. Designs are plain data and every edit works
 * on a copy, so results are remembered by the text of what they were worked out from (the design's
 * inputs: the same text, the same result; key order included, as it decides the order things are
 * met in). The rule: a key leaves out only what cannot change the result, so a new field of the
 * design costs a miss, never a stale answer. viewOf (drawing.ts) and placedOf (board.ts) go through
 * here. What they return is shared: read it, and take a copy to write into it.
 *
 * checkDerived makes every hit work the result out again and compare, and freezes what is
 * remembered: `npm run test:derived` runs the tests like that, to catch a key that leaves out too
 * much and a caller that writes into a shared result.
 */
import { partsRevision } from '@4k7/parts';
import type { Design } from '@4k7/schema';

let checking = false;

/** Turn the check of every remembered result on or off (tests). */
export function checkDerived(on: boolean): void {
  checking = on;
}

function deepFreeze<T>(v: T): T {
  if (v === null || typeof v !== 'object' || Object.isFrozen(v) || ArrayBuffer.isView(v)) return v;
  Object.freeze(v);
  for (const x of Object.values(v)) deepFreeze(x);
  return v;
}

/** What copies share and nobody is to write to: frozen when asked to check. */
export const sharedData = <T>(v: T): T => (checking ? deepFreeze(v) : v);

/** Where two texts of the same result part, for the message of a failed check. */
function firstDifference(a: string, b: string): string {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `at ${i}: remembered …${a.slice(Math.max(0, i - 60), i + 60)}… worked out again …${b.slice(Math.max(0, i - 60), i + 60)}…`;
}

/** Fails when what is remembered is no longer what its inputs give. */
function sameResult(what: string, remembered: unknown, fresh: unknown): void {
  const [a, b] = [JSON.stringify(remembered), JSON.stringify(fresh)];
  if (a !== b) throw new Error(`${what}: stale result, ${firstDifference(a, b)}`);
}

/** The last results by key, oldest out first. */
export class Memo<T> {
  private readonly kept = new Map<string, T>();
  private readonly size: number;
  private readonly what: string;

  constructor(what: string, size: number) {
    this.what = what;
    this.size = size;
  }

  get(key: string, work: () => T): T {
    const had = this.kept.get(key);
    if (had !== undefined) {
      if (checking) sameResult(this.what, had, work());
      this.kept.delete(key);
      this.kept.set(key, had);
      return had;
    }
    const v = work();
    if (checking) deepFreeze(v);
    this.kept.set(key, v);
    if (this.kept.size > this.size) this.kept.delete(this.kept.keys().next().value!);
    return v;
  }

}

/**
 * What a sheet is drawn from, other than its own stored drawing: the netlist, the part cards (the
 * design's copies, then the library's), the paper, the blocks, the ledger. Not the board, the
 * enclosure, the waivers (they only mark findings) or the name and id counter, and not where parts
 * stand on the board (`position` entries: a drag there moves no symbol).
 */
export function drawingInputs(d: Design): string {
  const { board: _b, enclosure: _e, waivers: _w, seq: _s, name: _n, drawing: _dr, ledger, ...rest } = d;
  return `${partsRevision()}|${JSON.stringify(rest)}|${JSON.stringify(Object.values(ledger).filter((k) => k.kind !== 'position'))}`;
}

/** What the placement is worked out from: the design, without the copper kept with the board (a cache of what the router made of it), the enclosure, the name and the id counter. */
export function boardInputs(d: Design): string {
  const { board, enclosure: _e, seq: _s, name: _n, ...rest } = d;
  const { copper: _c, ...settings } = board ?? {};
  return `${partsRevision()}|${JSON.stringify(rest)}|${board ? JSON.stringify(settings) : ''}`;
}
