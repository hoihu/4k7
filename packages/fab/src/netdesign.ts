/**
 * A board's netlist as the netlist check of its files reads it (netcheck.ts): its pads and vias with
 * their nets, in the files' coordinates (y up from the bottom-left corner), the connections it
 * leaves unrouted, and its copper areas. A panel's: every copy's, each copy's nets apart (the copies
 * are not joined), with the panel's fiducials as copper meant to be joined to nothing.
 */
import { padPins, type BoardView, type PanelView } from '@4k7/schema';
import type { NetDesign, NetPad, NetVia } from './netcheck.ts';

export function boardNetDesign(b: BoardView, panel?: PanelView): NetDesign {
  const copies = panel ? panel.copies.map((c, i) => ({ dx: c.dx, dy: c.dy, n: i + 1 })) : [{ dx: 0, dy: 0, n: 0 }];
  const H = panel ? panel.h : b.outline.h;
  const many = copies.length > 1;
  const pads: NetPad[] = [];
  const vias: NetVia[] = [];
  const open: [string, string][] = [];
  const areas: NonNullable<NetDesign['areas']> = [];
  for (const { dx, dy, n } of copies) {
    const net = (id: string) => `${b.netNames[id] ?? id}${many ? ` (copy ${n})` : ''}`;
    const ref = (r: string) => (panel ? `${r}_${n}` : r);
    // a pin's pad, by the pin's name ("J1.B12" lands on pad A1)
    const padOf = new Map<string, string>();
    for (const part of b.parts) {
      for (const p of part.pads) {
        if (p.npth) continue;
        const name = `${ref(part.refdes)}.${p.number}`;
        for (const pin of padPins(p)) padOf.set(`${part.refdes}.${pin}`, name);
        pads.push({
          name,
          net: p.netId ? net(p.netId) : null,
          x: p.x + dx,
          y: H - (p.y + dy),
          w: p.w,
          h: p.h,
          shape: p.shape,
          layers: p.drill ? [...b.layers] : [...p.layers],
          ...(p.drill ? { drill: p.drill } : {}),
          ...(p.slot ? { slot: { ...p.slot } } : {}),
        });
      }
    }
    for (const v of b.vias) vias.push({ net: net(v.netId), x: v.x + dx, y: H - (v.y + dy), pad: v.pad, drill: v.drill });
    for (const u of b.unrouted) {
      const [from, to] = [padOf.get(u.from), padOf.get(u.to)];
      if (from && to) open.push([from, to]);
    }
    for (const z of b.zones) {
      let box: [number, number, number, number] | null = z.shape ? [...z.shape.outline] : null;
      for (let i = 0; !box && i + 3 < z.rects.length; i += 4) box = [z.rects[i]!, z.rects[i + 1]!, z.rects[i]! + z.rects[i + 2]!, z.rects[i + 1]! + z.rects[i + 3]!];
      for (let i = 4; !z.shape && i + 3 < z.rects.length; i += 4) {
        const r = [z.rects[i]!, z.rects[i + 1]!, z.rects[i]! + z.rects[i + 2]!, z.rects[i + 1]! + z.rects[i + 3]!];
        box = [Math.min(box![0], r[0]!), Math.min(box![1], r[1]!), Math.max(box![2], r[2]!), Math.max(box![3], r[3]!)];
      }
      if (box) areas.push({ net: net(z.netId), layer: z.layer, box: [box[0] + dx, H - (box[3] + dy), box[2] + dx, H - (box[1] + dy)] });
    }
  }
  const loose = (panel?.fiducials ?? []).map((f) => ({ x: f.x, y: H - f.y }));
  return { pads, vias, open, areas, ...(loose.length ? { loose } : {}) };
}
