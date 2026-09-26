/**
 * Board view: deterministic placement from the netlist, the schematic and the ledger, then
 * the ratsnest and placement checks. Routing (router.ts) runs on the result.
 *
 * Placement strategy:
 *  - Start from the schematic: parts keep the relative positions of their symbols (scaled to
 *    the board), so functional groups that the schematic layout already formed stay together.
 *  - Relax: pads are pulled towards the other pads of their nets (supply and ground nets pull
 *    weakly, they are poured or routed wide anyway), decoupling capacitors are pulled to "their"
 *    supply pin (one cap per pin, nearest first), `near` constraints pull hard, and courtyards
 *    push each other apart.
 *  - Two-pin parts get the rotation with the shortest connections; everything snaps to 0.1 mm.
 *  - `position` constraints (the place op, dragging) pin a part; the placer never moves it.
 */
import {
  DEFAULT_BOARD,
  type BoardDiagnostic,
  type BoardPad,
  type BoardPart,
  type BoardView,
  type Component,
  type CopperLayer,
  type Design,
  type PackageInfo,
  type PartCard,
  type RatsLine,
  type SchematicView,
} from '@tracewise/schema';
import { footprintFor, isTwoPin, packageOf, type Footprint } from '@tracewise/parts';
import { cardOf, componentsSorted, isGroundNet, isPowerNet, natCmp, valueOf } from './doc.ts';
import { copperDrc } from './drc.ts';
import { route } from './router.ts';

const SPACING = 0.3; // between courtyards
const GRID_MM = 0.1;

interface Item {
  comp: Component;
  card: PartCard;
  fp: Footprint;
  pkg: string;
  info: PackageInfo;
  x: number;
  y: number;
  rot: number;
  fixed: boolean;
  /** Courtyard size at rotation 0, centred. */
  cw: number;
  ch: number;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const snap = (v: number) => Math.round(v / GRID_MM) * GRID_MM;

/** A local point rotated clockwise (y down) by a multiple of 90°. */
function rotate(x: number, y: number, rot: number): [number, number] {
  switch (((rot % 360) + 360) % 360) {
    case 90:
      return [-y, x];
    case 180:
      return [-x, -y];
    case 270:
      return [y, -x];
    default:
      return [x, y];
  }
}

const swapped = (rot: number) => rot % 180 !== 0;
const extent = (it: Item) => (swapped(it.rot) ? { w: it.ch, h: it.cw } : { w: it.cw, h: it.ch });

export function placeBoard(d: Design, sch: SchematicView): BoardView {
  const settings = d.board ?? DEFAULT_BOARD;
  const rules = settings.rules;
  const layers: CopperLayer[] = settings.layers === 4 ? ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] : ['F.Cu', 'B.Cu'];
  const missing: string[] = [];
  const items: Item[] = [];

  /* ---- footprints ---- */
  for (const comp of componentsSorted(d)) {
    const card = cardOf(d, comp.part);
    if (!card) continue;
    const pkg = packageOf(card, comp.params);
    const fp = pkg ? footprintFor(pkg, card.pins.map((p) => p.number)) : null;
    if (!pkg || !fp?.ok) {
      missing.push(comp.refdes);
      continue;
    }
    items.push({ comp, card, fp: fp.footprint, pkg: pkg.name, info: pkg, x: 0, y: 0, rot: 0, fixed: false, cw: fp.footprint.courtyard.w, ch: fp.footprint.courtyard.h });
  }

  /* ---- start from the schematic ---- */
  const centre = new Map<string, { x: number; y: number; vertical: boolean }>();
  let sheetOffset = 0;
  for (const sheet of sch.sheets) {
    const boxes = new Map<string, { x0: number; y0: number; x1: number; y1: number; vertical: boolean }>();
    for (const s of sheet.symbols) {
      const b = boxes.get(s.componentId);
      const x0 = s.bbox.x + sheetOffset;
      const vertical = s.pins.length === 2 && s.pins[0]!.x === s.pins[1]!.x;
      boxes.set(s.componentId, b ? { x0: Math.min(b.x0, x0), y0: Math.min(b.y0, s.bbox.y), x1: Math.max(b.x1, x0 + s.bbox.w), y1: Math.max(b.y1, s.bbox.y + s.bbox.h), vertical } : { x0, y0: s.bbox.y, x1: x0 + s.bbox.w, y1: s.bbox.y + s.bbox.h, vertical });
    }
    for (const [id, b] of boxes) centre.set(id, { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, vertical: b.vertical });
    sheetOffset += sheet.bbox.w + 2000;
  }
  const pts = items.map((it) => centre.get(it.comp.id)).filter((c): c is NonNullable<typeof c> => !!c);
  const area = items.reduce((s, it) => s + (it.cw + SPACING) * (it.ch + SPACING), 0);
  const sx = pts.length ? Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x)) : 1;
  const sy = pts.length ? Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y)) : 1;
  // mm per mil so that the schematic spread becomes a comfortably packed board
  const scale = Math.min(0.05, Math.max(0.004, Math.sqrt((area * 2.2) / Math.max(sx * sy, 1))));
  items.forEach((it, i) => {
    const c = centre.get(it.comp.id);
    it.x = c ? c.x * scale : i * 5;
    it.y = c ? c.y * scale : 0;
    it.rot = c?.vertical && isTwoPin(it.card) ? 90 : 0;
  });

  /*
   * With pinned parts, start from the board placed without any pins: pinned coordinates are
   * board coordinates, so everything else must start in that frame too (a drag then moves
   * one part and the rest adapts around it, instead of jumping to a different frame).
   */
  const pins = Object.values(d.ledger).filter((k) => k.kind === 'position' && k.a);
  if (pins.length) {
    const free: Design = { ...d, ledger: Object.fromEntries(Object.entries(d.ledger).filter(([, k]) => k.kind !== 'position')) };
    const base = placeBoard(free, sch);
    for (const it of items) {
      const p = base.parts.find((x) => x.componentId === it.comp.id);
      if (p) {
        it.x = p.x;
        it.y = p.y;
        it.rot = p.rot;
      }
    }
  }

  /* ---- pinned parts ---- */
  for (const k of Object.values(d.ledger)) {
    if (k.kind !== 'position' || !k.a) continue;
    const it = items.find((x) => x.comp.id === k.a);
    if (!it) continue;
    it.x = k.xMm ?? it.x;
    it.y = k.yMm ?? it.y;
    it.rot = k.rot ?? 0;
    it.fixed = true;
  }
  const anyFixed = items.some((it) => it.fixed);

  /* ---- connectivity ---- */
  const byComp = new Map(items.map((it) => [it.comp.id, it]));
  const padsOf = (it: Item) => it.fp.pads.map((p) => ({ pad: p, net: it.comp.pins[p.number] }));
  const nets = new Map<string, { it: Item; px: number; py: number }[]>();
  for (const it of items) {
    for (const { pad, net } of padsOf(it)) {
      if (!net) continue;
      nets.set(net, [...(nets.get(net) ?? []), { it, px: pad.x, py: pad.y }]);
    }
  }
  const weight = (netId: string, n: number) => {
    const net = d.nets[netId]!;
    const w = 1 / Math.max(1, n - 1);
    return isGroundNet(net) || isPowerNet(net) ? w * 0.25 : w;
  };

  // decoupling caps → one supply pad each (nearest in the schematic sense: first free pad)
  const springs: { it: Item; to: Item; tx: number; ty: number; px: number; py: number; w: number }[] = [];
  const supplyPads = new Map<string, { it: Item; px: number; py: number; used: number }[]>();
  for (const it of items) {
    if (isTwoPin(it.card)) continue;
    for (const { pad, net } of padsOf(it)) {
      const pin = it.card.pins.find((p) => p.number === pad.number);
      if (!net || !pin || pin.type !== 'pwr_in' || isGroundNet(d.nets[net]!)) continue;
      supplyPads.set(net, [...(supplyPads.get(net) ?? []), { it, px: pad.x, py: pad.y, used: 0 }]);
    }
  }
  for (const it of items) {
    if (!isTwoPin(it.card) || it.card.category !== 'capacitor') continue;
    const ns = padsOf(it).map((p) => p.net);
    const rail = ns.find((n) => n && !isGroundNet(d.nets[n]!) && supplyPads.has(n));
    if (!rail || !ns.some((n) => n && isGroundNet(d.nets[n]!))) continue;
    const target = [...supplyPads.get(rail)!].sort((a, b) => a.used - b.used)[0]!;
    target.used++;
    const own = padsOf(it).find((p) => p.net === rail)!.pad;
    springs.push({ it, to: target.it, tx: target.px, ty: target.py, px: own.x, py: own.y, w: 3 });
  }
  const near = Object.values(d.ledger)
    .filter((k) => k.kind === 'near' && k.a && k.b && byComp.has(k.a) && byComp.has(k.b))
    .map((k) => ({ a: byComp.get(k.a!)!, b: byComp.get(k.b!)!, max: k.maxMm ?? 3 }));

  const padPos = (it: Item, px: number, py: number) => {
    const [x, y] = rotate(px, py, it.rot);
    return { x: it.x + x, y: it.y + y };
  };

  /*
   * A fixed outline with pinned parts: pinned coordinates are board coordinates, so the others
   * must stay inside the outline too (without pins, the finished placement is centred instead).
   */
  const margin0 = 1.5 + rules.edgeClearance;
  const contain =
    anyFixed && settings.width && settings.height
      ? (it: Item) => {
          if (it.fixed) return;
          const e = extent(it);
          it.x = Math.min(Math.max(it.x, margin0 + e.w / 2), settings.width! - margin0 - e.w / 2);
          it.y = Math.min(Math.max(it.y, margin0 + e.h / 2), settings.height! - margin0 - e.h / 2);
        }
      : null;
  if (contain) {
    // start from the unpinned board centred in the outline
    const bb0 = bounds(items.filter((it) => !it.fixed));
    const dx = settings.width! / 2 - (bb0.x0 + bb0.x1) / 2;
    const dy = settings.height! / 2 - (bb0.y0 + bb0.y1) / 2;
    for (const it of items) if (!it.fixed) {
      it.x += dx;
      it.y += dy;
    }
  }

  /* ---- relax ---- */
  const movable = items.filter((it) => !it.fixed);
  const ITER = 160;
  for (let iter = 0; iter < ITER; iter++) {
    const step = 0.35 * (1 - iter / ITER) + 0.05;
    const force = new Map<Item, { fx: number; fy: number }>(movable.map((it) => [it, { fx: 0, fy: 0 }]));
    const add = (it: Item, fx: number, fy: number) => {
      const f = force.get(it);
      if (f) {
        f.fx += fx;
        f.fy += fy;
      }
    };
    for (const [netId, members] of nets) {
      if (members.length < 2) continue;
      const w = weight(netId, members.length);
      const ps = members.map((m) => padPos(m.it, m.px, m.py));
      const cx = ps.reduce((s, p) => s + p.x, 0) / ps.length;
      const cy = ps.reduce((s, p) => s + p.y, 0) / ps.length;
      members.forEach((m, i) => add(m.it, (cx - ps[i]!.x) * w, (cy - ps[i]!.y) * w));
    }
    for (const s of springs) {
      const a = padPos(s.it, s.px, s.py);
      const b = padPos(s.to, s.tx, s.ty);
      add(s.it, (b.x - a.x) * s.w, (b.y - a.y) * s.w);
    }
    for (const n of near) {
      const dx = n.b.x - n.a.x;
      const dy = n.b.y - n.a.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= n.max) continue;
      const k = (dist - n.max) / dist;
      add(n.a, dx * k * 2, dy * k * 2);
      add(n.b, -dx * k * 2, -dy * k * 2);
    }
    for (const it of movable) {
      const f = force.get(it)!;
      const len = Math.hypot(f.fx, f.fy);
      const lim = 2;
      const k = len * step > lim ? lim / len : step;
      it.x += f.fx * k;
      it.y += f.fy * k;
    }
    separate(items, 3);
    if (contain) for (const it of movable) contain(it);
  }

  /* ---- rotations of two-pin parts: shortest connections ---- */
  const netCentre = (netId: string, except: Item) => {
    const ms = (nets.get(netId) ?? []).filter((m) => m.it !== except);
    if (!ms.length) return null;
    const ps = ms.map((m) => padPos(m.it, m.px, m.py));
    return { x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length };
  };
  for (const it of movable) {
    if (!isTwoPin(it.card)) continue;
    let best = it.rot;
    let bestLen = Infinity;
    for (const rot of [0, 90, 180, 270]) {
      it.rot = rot;
      let len = 0;
      for (const { pad, net } of padsOf(it)) {
        const c = net ? netCentre(net, it) : null;
        if (!c) continue;
        const p = padPos(it, pad.x, pad.y);
        len += Math.hypot(c.x - p.x, c.y - p.y);
      }
      if (len < bestLen - 1e-6) {
        bestLen = len;
        best = rot;
      }
    }
    it.rot = best;
  }
  for (const it of movable) snapItem(it);
  for (let round = 0; round < (contain ? 6 : 1); round++) {
    separate(items, 40, true);
    if (contain) for (const it of movable) contain(it);
    for (const it of movable) snapItem(it);
  }

  /* ---- outline ---- */
  const margin = 1.5 + rules.edgeClearance;
  const bb = bounds(items);
  let w = settings.width ?? Math.ceil((bb.x1 - bb.x0 + 2 * margin) * 2) / 2;
  let h = settings.height ?? Math.ceil((bb.y1 - bb.y0 + 2 * margin) * 2) / 2;
  if (!items.length) {
    w = settings.width ?? 20;
    h = settings.height ?? 20;
  }
  // move the placement onto the board (pinned parts are in board coordinates already)
  if (!anyFixed && items.length) {
    const dx = snap((w - (bb.x1 - bb.x0)) / 2 - bb.x0);
    const dy = snap((h - (bb.y1 - bb.y0)) / 2 - bb.y0);
    for (const it of items) {
      it.x = r3(it.x + dx);
      it.y = r3(it.y + dy);
    }
  } else if (anyFixed && !settings.width && items.length) {
    // grow the outline to include everything, keeping pinned coordinates
    const b2 = bounds(items);
    const shiftX = b2.x0 < margin ? snap(margin - b2.x0) : 0;
    const shiftY = b2.y0 < margin ? snap(margin - b2.y0) : 0;
    for (const it of movable) {
      it.x = r3(it.x + shiftX);
      it.y = r3(it.y + shiftY);
    }
    const b3 = bounds(items);
    w = Math.ceil((Math.max(b3.x1 + margin, w)) * 2) / 2;
    h = Math.ceil((Math.max(b3.y1 + margin, h)) * 2) / 2;
  }

  /* ---- result ---- */
  const parts: BoardPart[] = items.map((it) => toPart(d, it, layers));
  const diagnostics = placementChecks(parts, w, h, rules.edgeClearance);
  for (const ref of missing) {
    diagnostics.push({ code: 'DRC.NO_FOOTPRINT', severity: 'warning', message: `${ref} has no footprint (no package data); it is left off the board.`, entities: [ref] });
  }
  return {
    outline: { w, h },
    layers,
    rules,
    parts,
    tracks: [],
    vias: [],
    zones: [],
    ratsnest: ratsnest(parts),
    diagnostics,
    stats: { nets: 0, routed: 0, unrouted: 0, trackLength: 0, vias: 0 },
    missing,
    netNames: Object.fromEntries(Object.values(d.nets).map((n) => [n.id, n.name])),
  };
}

/** Place, then route and check the copper. */
export function layoutBoard(d: Design, sch: SchematicView): BoardView {
  const b = placeBoard(d, sch);
  if (!b.parts.length) return b;
  const powerNets = new Set(Object.values(d.nets).filter((n) => isPowerNet(n)).map((n) => n.id));
  // ground plane: the ground net with the most pads, poured on the bottom (2 layers) or In1 (4 layers)
  const padCount = new Map<string, number>();
  for (const p of b.parts) for (const pad of p.pads) if (pad.netId) padCount.set(pad.netId, (padCount.get(pad.netId) ?? 0) + 1);
  const ground = Object.values(d.nets)
    .filter((n) => isGroundNet(n) && (padCount.get(n.id) ?? 0) >= 2)
    .sort((x, y) => (padCount.get(y.id) ?? 0) - (padCount.get(x.id) ?? 0) || x.name.localeCompare(y.name))[0];
  const pour = ground ? { netId: ground.id, layer: (b.layers.length === 4 ? 'In1.Cu' : 'B.Cu') as CopperLayer } : undefined;
  const r = route({ outline: b.outline, layers: b.layers, rules: b.rules, parts: b.parts, powerNets, ...(pour ? { pour } : {}) });
  const routed: BoardView = {
    ...b,
    tracks: r.tracks,
    vias: r.vias,
    zones: r.zones,
    ratsnest: ratsnest(b.parts, r.connected),
    stats: {
      nets: r.netsTotal,
      routed: r.netsDone,
      unrouted: r.failed.length,
      trackLength: Math.round(r.tracks.reduce((s, t) => s + polyLength(t.pts), 0) * 10) / 10,
      vias: r.vias.length,
    },
  };
  const unrouted = new Map<string, number>();
  for (const f of r.failed) unrouted.set(f.netId, (unrouted.get(f.netId) ?? 0) + 1);
  const diags = [...b.diagnostics, ...copperDrc(routed)];
  for (const [netId, n] of unrouted) {
    const f = r.failed.find((x) => x.netId === netId)!;
    diags.push({
      code: 'DRC.UNROUTED',
      severity: 'error',
      message: `${n} connection${n > 1 ? 's' : ''} of ${d.nets[netId]?.name ?? netId} could not be routed.`,
      at: { x: (f.a.x + f.b.x) / 2, y: (f.a.y + f.b.y) / 2 },
      entities: [],
    });
  }
  return { ...routed, diagnostics: diags };
}

function polyLength(pts: number[]): number {
  let len = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) len += Math.hypot(pts[i + 2]! - pts[i]!, pts[i + 3]! - pts[i + 1]!);
  return len;
}

/**
 * Snap so that pad 1 lies on the grid: on fine-pitch parts every pad centre line then falls on
 * the router's grid, which is where a track fits between two neighbouring pads.
 */
function snapItem(it: Item) {
  const p = it.fp.pads[0];
  if (!p) {
    it.x = snap(it.x);
    it.y = snap(it.y);
    return;
  }
  const [px, py] = rotate(p.x, p.y, it.rot);
  it.x = r3(snap(it.x + px) - px);
  it.y = r3(snap(it.y + py) - py);
}

/** Push overlapping courtyards apart along the axis of least overlap. */
function separate(items: Item[], passes: number, strict = false) {
  const sorted = [...items].sort((a, b) => natCmp(a.comp.refdes, b.comp.refdes));
  for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i]!;
      const ea = extent(a);
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j]!;
        if (a.fixed && b.fixed) continue;
        const eb = extent(b);
        const ox = (ea.w + eb.w) / 2 + SPACING - Math.abs(a.x - b.x);
        const oy = (ea.h + eb.h) / 2 + SPACING - Math.abs(a.y - b.y);
        if (ox <= 1e-6 || oy <= 1e-6) continue;
        moved = true;
        const alongX = ox < oy;
        const amount = (alongX ? ox : oy) + (strict ? GRID_MM : 0);
        // deterministic direction when centres coincide
        const sign = alongX ? (a.x < b.x || (a.x === b.x && i < j) ? -1 : 1) : a.y < b.y || (a.y === b.y && i < j) ? -1 : 1;
        const [ka, kb] = a.fixed ? [0, 1] : b.fixed ? [1, 0] : [0.5, 0.5];
        if (alongX) {
          a.x += sign * amount * ka;
          b.x -= sign * amount * kb;
        } else {
          a.y += sign * amount * ka;
          b.y -= sign * amount * kb;
        }
        if (strict) {
          if (!a.fixed) {
            a.x = snap(a.x);
            a.y = snap(a.y);
          }
          if (!b.fixed) {
            b.x = snap(b.x);
            b.y = snap(b.y);
          }
        }
      }
    }
    if (!moved) break;
  }
}

function bounds(items: Item[]) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const it of items) {
    const e = extent(it);
    x0 = Math.min(x0, it.x - e.w / 2);
    y0 = Math.min(y0, it.y - e.h / 2);
    x1 = Math.max(x1, it.x + e.w / 2);
    y1 = Math.max(y1, it.y + e.h / 2);
  }
  return items.length ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: 0, y1: 0 };
}

function toPart(d: Design, it: Item, layers: CopperLayer[]): BoardPart {
  const pads: BoardPad[] = it.fp.pads.map((p) => {
    const [x, y] = rotate(p.x, p.y, it.rot);
    const net = it.comp.pins[p.number];
    return {
      number: p.number,
      x: r3(it.x + x),
      y: r3(it.y + y),
      w: swapped(it.rot) ? p.h : p.w,
      h: swapped(it.rot) ? p.w : p.h,
      shape: p.shape,
      ...(p.drill ? { drill: p.drill } : {}),
      ...(net ? { netId: net } : {}),
      layers: p.drill ? [...layers] : ['F.Cu'],
    };
  });
  const rect = (w: number, h: number) => {
    const [rw, rh] = swapped(it.rot) ? [h, w] : [w, h];
    return { x: r3(it.x - rw / 2), y: r3(it.y - rh / 2), w: rw, h: rh };
  };
  const [p1x, p1y] = rotate(it.fp.pin1.x, it.fp.pin1.y, it.rot);
  return {
    componentId: it.comp.id,
    refdes: it.comp.refdes,
    value: valueOf(d, it.comp),
    part: it.card.id,
    ...((it.comp.params.mpn ?? it.card.mpn) ? { mpn: it.comp.params.mpn ?? it.card.mpn } : {}),
    ...(it.card.manufacturer ? { manufacturer: it.card.manufacturer } : {}),
    pkg: it.pkg,
    pkgInfo: it.info,
    x: r3(it.x),
    y: r3(it.y),
    rot: it.rot,
    side: 'top',
    pads,
    body: rect(it.fp.body.w, it.fp.body.h),
    courtyard: rect(it.cw, it.ch),
    pin1: { x: r3(it.x + p1x), y: r3(it.y + p1y) },
    locked: it.fixed,
  };
}

/** Minimum spanning tree of each net's pads (Prim), as straight lines. */
export function ratsnest(parts: BoardPart[], connected?: (netId: string, a: BoardPad, b: BoardPad) => boolean): RatsLine[] {
  const byNet = new Map<string, BoardPad[]>();
  for (const part of parts) for (const p of part.pads) if (p.netId) byNet.set(p.netId, [...(byNet.get(p.netId) ?? []), p]);
  const out: RatsLine[] = [];
  for (const [netId, pads] of [...byNet.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (pads.length < 2) continue;
    const inTree = [0];
    const dist = pads.map((p) => Math.hypot(p.x - pads[0]!.x, p.y - pads[0]!.y));
    const from = pads.map(() => 0);
    const done = new Set([0]);
    while (inTree.length < pads.length) {
      let best = -1;
      for (let i = 0; i < pads.length; i++) if (!done.has(i) && (best < 0 || dist[i]! < dist[best]!)) best = i;
      done.add(best);
      inTree.push(best);
      const a = pads[from[best]!]!;
      const b = pads[best]!;
      if (!connected?.(netId, a, b)) out.push({ netId, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      for (let i = 0; i < pads.length; i++) {
        if (done.has(i)) continue;
        const dd = Math.hypot(pads[i]!.x - b.x, pads[i]!.y - b.y);
        if (dd < dist[i]!) {
          dist[i] = dd;
          from[i] = best;
        }
      }
    }
  }
  return out;
}

function placementChecks(parts: BoardPart[], w: number, h: number, edge: number): BoardDiagnostic[] {
  const out: BoardDiagnostic[] = [];
  for (let i = 0; i < parts.length; i++) {
    const a = parts[i]!;
    const A = a.courtyard;
    if (A.x < 0 || A.y < 0 || A.x + A.w > w || A.y + A.h > h) {
      out.push({ code: 'DRC.OFF_BOARD', severity: 'error', message: `${a.refdes} is outside the board outline.`, at: { x: a.x, y: a.y }, entities: [a.refdes] });
    } else if (a.pads.some((p) => p.x - p.w / 2 < edge || p.y - p.h / 2 < edge || p.x + p.w / 2 > w - edge || p.y + p.h / 2 > h - edge)) {
      out.push({ code: 'DRC.EDGE_CLEARANCE', severity: 'error', message: `${a.refdes} has copper closer than ${edge} mm to the board edge.`, at: { x: a.x, y: a.y }, entities: [a.refdes] });
    }
    for (let j = i + 1; j < parts.length; j++) {
      const b = parts[j]!;
      const B = b.courtyard;
      if (A.x < B.x + B.w - 1e-6 && B.x < A.x + A.w - 1e-6 && A.y < B.y + B.h - 1e-6 && B.y < A.y + A.h - 1e-6) {
        out.push({ code: 'DRC.COURTYARD_OVERLAP', severity: 'error', message: `${a.refdes} and ${b.refdes} overlap (courtyards).`, at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, entities: [a.refdes, b.refdes] });
      }
    }
  }
  return out;
}
