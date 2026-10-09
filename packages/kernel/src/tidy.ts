/**
 * Wire tidy: a supply symbol that stands at the end of a bus, past the last thing connected to
 * it, is moved onto that last connection. The templates leave a margin there (room for the symbol
 * and its text), which draws as an elbow: the wire runs on, turns up, and ends in the arrow.
 * Moving the symbol onto the last junction or pin draws the same circuit with a shorter wire and
 * the rail going straight up. Connections never change, only where the symbol stands.
 */
import { tw, type Scene } from './scene.ts';

type Seg = { net: string; x1: number; y1: number; x2: number; y2: number };

const key = (x: number, y: number) => `${x},${y}`;
/** Height a supply symbol takes above (rail) or below (ground) its connection point, with its text. */
const UP = 500;
const DOWN = 320;

function segmentsOf(scene: Scene): Seg[] {
  const out: Seg[] = [];
  for (const w of scene.wires) {
    for (let i = 0; i + 3 < w.pts.length; i += 2) {
      const [x1, y1, x2, y2] = [w.pts[i]!, w.pts[i + 1]!, w.pts[i + 2]!, w.pts[i + 3]!];
      if (x1 !== x2 || y1 !== y2) out.push({ net: w.netId, x1, y1, x2, y2 });
    }
  }
  return out;
}

const touches = (s: Seg, x: number, y: number) => (s.x1 === x && s.y1 === y) || (s.x2 === x && s.y2 === y);
const inside = (s: Seg, x: number, y: number) =>
  (s.x1 === s.x2 && x === s.x1 && y > Math.min(s.y1, s.y2) && y < Math.max(s.y1, s.y2)) ||
  (s.y1 === s.y2 && y === s.y1 && x > Math.min(s.x1, s.x2) && x < Math.max(s.x1, s.x2));

/** Returns how many supply symbols were moved. */
export function tidyWires(scene: Scene): number {
  const pinAt = new Set<string>();
  for (const s of scene.symbols) for (const p of s.pins) pinAt.add(key(p.x, p.y));
  let moved = 0;

  for (const l of scene.labels) {
    if ((l.kind !== 'rail' && l.kind !== 'ground') || l.stub || l.rise || (l.dir !== 'up' && l.dir !== 'down')) continue;
    if (pinAt.has(key(l.x, l.y))) continue;
    const segs = segmentsOf(scene);
    const mine = segs.filter((s) => s.net === l.netId);
    // the symbol ends exactly one wire, and nothing else is attached at that point
    const here = mine.filter((s) => touches(s, l.x, l.y) || inside(s, l.x, l.y));
    if (here.length !== 1) continue;
    const wire = scene.wires.find((w) => w.netId === l.netId && w.pts.length >= 4 && w.pts[w.pts.length - 2] === l.x && w.pts[w.pts.length - 1] === l.y);
    if (!wire) continue;
    const n = wire.pts.length;
    const [ax, ay] = [wire.pts[n - 4]!, wire.pts[n - 3]!];
    if (ay !== l.y || ax === l.x) continue; // only a horizontal last run: the symbol stands on a stub
    const [lo, hi] = [Math.min(ax, l.x), Math.max(ax, l.x)];

    // connections strictly between the run's start and the symbol: the nearest one to the symbol
    const onRun = (x: number, y: number) => y === l.y && x > lo && x < hi;
    const candidates = new Set<number>();
    for (const j of scene.junctions) if (onRun(j.x, j.y)) candidates.add(j.x);
    for (const k of pinAt) {
      const [x, y] = k.split(',').map(Number) as [number, number];
      if (onRun(x, y)) candidates.add(x);
    }
    for (const s of mine) {
      if (s === here[0]) continue;
      for (const [x, y] of [[s.x1, s.y1], [s.x2, s.y2]] as const) if (onRun(x, y)) candidates.add(x);
    }
    if (!candidates.size) continue;
    const x = l.x > ax ? Math.max(...candidates) : Math.min(...candidates);

    // the symbol and its text must have the room where it will stand
    const half = Math.max(80, tw(l.text) / 2 + 20);
    const box = { x: x - half, y: l.dir === 'up' ? l.y - UP : l.y, w: 2 * half, h: l.dir === 'up' ? UP : DOWN };
    const clear = scene.symbols.every((s) => !(s.bbox.x < box.x + box.w && box.x < s.bbox.x + s.bbox.w && s.bbox.y < box.y + box.h && box.y < s.bbox.y + s.bbox.h));
    const crowded = scene.labels.some((o) => o !== l && o.kind !== 'net' && o.x > box.x && o.x < box.x + box.w && o.y >= box.y - 100 && o.y <= box.y + box.h + 100);
    if (!clear || crowded) continue;

    wire.pts[n - 2] = x;
    l.x = x;
    moved++;

    // a dot is for three or more connections: the point may now be a plain corner
    const k = key(x, l.y);
    const after = segmentsOf(scene).filter((s) => s.net === l.netId);
    let degree = 1 + (pinAt.has(k) ? 1 : 0); // the symbol, a pin
    for (const s of after) degree += touches(s, x, l.y) ? 1 : inside(s, x, l.y) ? 2 : 0;
    if (degree < 3) scene.junctions = scene.junctions.filter((j) => key(j.x, j.y) !== k);
  }
  return moved;
}
