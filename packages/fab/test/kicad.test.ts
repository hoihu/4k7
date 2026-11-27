/**
 * The KiCad board export (docs/design/kicad-export.md §5): the s-expression writer and reader, the derived
 * UUIDs, the pads put back through each footprint's position, orientation and side, the board read back
 * against the BoardView it was made from, snapshots of a small design's files, and the same bytes twice.
 * Nothing here runs KiCad: whether KiCad 10 opens these files is checked by hand (§9).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Kernel } from '@4k7/kernel';
import { footprintFor } from '@4k7/parts';
import type { BoardView, EditOp } from '@4k7/schema';
import { KICAD_FILE_VERSION, KICAD_ORIGIN, kicadBoard, kicadBoardFiles } from '../src/index.ts';
import { canonicalPolygon, kicadAngle } from '../src/kicad/footprint.ts';
import { child, children, num, quote, read, type SList, type SNode, Sym, sym, text, write, yn } from '../src/kicad/sexpr.ts';
import { sha1, URL_NAMESPACE, uuidsFor, uuidV5 } from '../src/kicad/uuid.ts';
import { buck as buckFixture } from '../../kernel/test/fixtures.ts';
import { spiral2Cards, spiral2Parts } from '../../parts/test/fixtures/spiral2.ts';

const O = KICAD_ORIGIN;

function ok(k: Kernel, ops: unknown[]) {
  const r = k.transact({ summary: 'test', ops: ops as EditOp[] });
  if (r.status !== 'ok') throw new Error(JSON.stringify(r).slice(0, 600));
  return r;
}

/* ---- reading back ---- */

const atOf = (l: SList): [number, number, number] => {
  const a = child(l, 'at')!;
  return [a[1] as number, a[2] as number, (a[3] as number | undefined) ?? 0];
};
const prop = (fp: SList, name: string) => children(fp, 'property').find((p) => p[1] === name);
const layerOf = (l: SList) => child(l, 'layer')?.[1] as string | undefined;
const netOf = (l: SList) => child(l, 'net')?.[1] as string | undefined;

/** KiCad's reading of a footprint's item: turned by the footprint's orientation (RotatePoint, counter-clockwise on screen, y down), then moved to its position. */
function place(fx: number, fy: number, angle: number, x: number, y: number): [number, number] {
  const t = (angle * Math.PI) / 180;
  return [fx + x * Math.cos(t) + y * Math.sin(t), fy - x * Math.sin(t) + y * Math.cos(t)];
}

/** Every uuid in a file. */
function uuids(l: SNode, out: string[] = []): string[] {
  if (!Array.isArray(l)) return out;
  if (l[0] === 'uuid') out.push(l[1] as string);
  for (const x of l) uuids(x, out);
  return out;
}

/* ---- the designs ---- */

/** The buck converter (kernel test fixtures), routed on two layers. */
function buck2(): BoardView {
  const k = buckFixture();
  ok(k, [{ op: 'route' }]);
  return k.board();
}

/** The buck on four layers with planes on In2.Cu and an LM358, routed (as the netlist check of the files tests it). */
function buck4(): BoardView {
  const k = buckFixture();
  ok(k, [
    { op: 'add_part', part: 'ti:LM358DR', refdes: 'U2' },
    { op: 'add_part', part: 'generic:C', refdes: 'C10', params: { capacitance: '100nF', voltage: '16V' } },
    { op: 'connect', pins: ['U2.V+', 'C10.1'], net: '+3V3' },
    { op: 'connect', pins: ['U2.GND', 'C10.2'], net: 'GND' },
    { op: 'connect', pins: ['U2.INA+', 'U2.OUTA', 'U2.INA-'], net: 'BUF' },
    { op: 'set_board', layers: 4 },
    { op: 'set_plane', layer: 'In2.Cu', net: '+12V' },
    { op: 'set_plane', layer: 'In2.Cu', net: '+3V3', under: ['U2'] },
    { op: 'route' },
  ]);
  return k.board();
}

/** spiral2 (the October 2026 JLCPCB order's parts, packages/parts/test/fixtures), placed on four layers as on spiral2; not routed. */
function spiral2(): BoardView {
  const k = new Kernel();
  const d = k.committedDesign();
  for (const c of spiral2Cards) d.parts[c.id] = c;
  k.load(d);
  ok(k, [
    { op: 'set_board', width_mm: 110, height_mm: 150, layers: 4 },
    ...spiral2Parts.map((p) => ({ op: 'add_part' as const, part: p.part, refdes: p.refdes, params: { ...p.params, lcsc: p.sku } })),
    ...spiral2Parts.map((p, i) => ({ op: 'place' as const, ref: p.refdes, x_mm: 15 + (i % 4) * 25, y_mm: 15 + Math.floor(i / 4) * 25, rot: p.rot })),
  ]);
  return k.board();
}

/**
 * A small design for the snapshots: a header, a resistor and an LED on the top, a resistor on the bottom,
 * copper drawn by hand (so the router's choices do not enter), two mounting holes (one plated, on GND), a
 * slot and a round cutout, rounded corners.
 */
function small(): BoardView {
  const k = new Kernel();
  ok(k, [
    { op: 'set_board', width_mm: 30, height_mm: 20, corner_radius_mm: 1.5 },
    { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
    { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '1k' } },
    { op: 'add_part', part: 'generic:LED', refdes: 'D1' },
    { op: 'add_part', part: 'generic:R', refdes: 'R2', params: { resistance: '100k' } },
    { op: 'connect', pins: ['J1.1', 'R1.1', 'R2.1'], net: 'VIN' },
    { op: 'connect', pins: ['R1.2', 'D1.A'], net: 'LED_A' },
    { op: 'connect', pins: ['J1.2', 'D1.K', 'R2.2'], net: 'GND' },
    { op: 'place', ref: 'J1', x_mm: 6, y_mm: 10, rot: 0, lock: true },
    { op: 'place', ref: 'R1', x_mm: 14, y_mm: 7, rot: 0, lock: true },
    { op: 'place', ref: 'D1', x_mm: 21, y_mm: 10, rot: 90, lock: true },
    { op: 'place', ref: 'R2', x_mm: 14, y_mm: 13, rot: 90, side: 'bottom', lock: true },
    { op: 'add_hole', diameter_mm: 3.2, x_mm: 26, y_mm: 4 },
    { op: 'add_hole', diameter_mm: 3.2, x_mm: 26, y_mm: 16, plated: true, net: 'GND' },
    { op: 'add_cutout', shape: 'slot', x_mm: 9.5, y_mm: 17.5, width_mm: 5, height_mm: 1, angle_deg: 0 },
    { op: 'add_cutout', shape: 'circle', x_mm: 3.5, y_mm: 3.5, diameter_mm: 2 },
    { op: 'set_copper_mode', mode: 'drawn' },
    { op: 'draw_track', from: 'J1.1', to: 'R1.1', bend: 'diagonal_first' },
    { op: 'draw_track', from: 'R1.2', to: 'D1.A', bend: 'diagonal_first' },
    { op: 'draw_via', at: [18, 13], net: 'GND' },
    { op: 'draw_track', from: 'D1.K', to: 'v3', bend: 'diagonal_first' },
    { op: 'draw_track', from: 'v3', to: 'R2.2', layer: 'B.Cu', bend: 'diagonal_first' },
    { op: 'draw_track', from: 'R2.1', to: 'J1.1', layer: 'B.Cu', bend: 'straight_first' },
  ]);
  return k.board();
}

describe('KiCad s-expressions (sexpr.ts)', () => {
  it('writes numbers with at most six decimals, no trailing zeros and no -0', () => {
    expect([0, 1, -1.5, 2.5, 100, 0.1 + 0.2, 1.23456789, 1.2345675, -0.0000001, 20260206, 1e-6, 1.10000].map(num)).toEqual(['0', '1', '-1.5', '2.5', '100', '0.3', '1.234568', '1.234568', '0', '20260206', '0.000001', '1.1']);
    expect(() => num(Number.NaN)).toThrow();
  });

  it('quotes every string, writes keywords and Sym bare, and escapes quotes and backslashes', () => {
    expect(quote('a "b" \\c\nd')).toBe('"a \\"b\\" \\\\c\\nd"');
    expect(write(['pad', '1', sym('smd'), sym('rect'), ['at', 1, -2.5], ['layers', 'F.Cu', 'F.Mask'], ['locked', yn(true)]])).toBe(
      '(pad "1" smd rect\n\t(at 1 -2.5)\n\t(layers "F.Cu" "F.Mask")\n\t(locked yes)\n)\n',
    );
    // a list without inner lists stays on one line; a string that looks like a number is still a string
    expect(write(['net', '3V3'])).toBe('(net "3V3")\n');
    expect(write([0, 'F.Cu', sym('signal')])).toBe('(0 "F.Cu" signal)\n');
  });

  it('lays a polygon\'s points several to a line, as KiCad does', () => {
    const pts = Array.from({ length: 12 }, (_, i): SList => ['xy', i * 1.25, -i]);
    const t = write(['fp_poly', ['pts', ...pts]]);
    const lines = t.split('\n');
    expect(lines[0]).toBe('(fp_poly');
    expect(lines[1]).toBe('\t(pts');
    expect(lines[2]!.startsWith('\t\t(xy 0 0) (xy 1.25 -1) (xy 2.5 -2)')).toBe(true);
    expect(lines.length).toBeGreaterThan(6); // wrapped, not one long line
    for (const l of lines) expect(l.length).toBeLessThan(120);
  });

  it('reads back what it wrote, and the same input gives the same text', () => {
    const make = (): SList => ['kicad_pcb', ['version', 20260206], ['generator', '4k7'], ['footprint', '4k7:0603', ['layer', 'F.Cu'], ['at', 1.5, 2, -90], ['property', 'Value', 'say "hi"\\'], ['attr', sym('smd')]]];
    const t = write(make());
    expect(write(make())).toBe(t);
    const back = read(t);
    expect(write(back)).toBe(t);
    const fp = child(back, 'footprint')!;
    expect(fp[1]).toBe('4k7:0603');
    expect(atOf(fp)).toEqual([1.5, 2, -90]);
    expect(prop(fp, 'Value')![2]).toBe('say "hi"\\');
    expect(child(fp, 'attr')![1]).toBeInstanceOf(Sym);
    expect(text(child(fp, 'attr')![1])).toBe('smd');
    expect(() => read('(a (b)')).toThrow();
  });

  it('reads the board KiCad 10 saved (the reference excerpt)', () => {
    const ref = read(readFileSync(new URL('./kicad/reference/pic_programmer-excerpt.kicad_pcb', import.meta.url), 'utf8'));
    expect(ref[0]).toBe('kicad_pcb');
    expect(child(ref, 'version')![1]).toBe(KICAD_FILE_VERSION);
    expect(netOf(child(ref, 'segment')!)).toBe('VCC');
  });
});

describe('derived UUIDs (uuid.ts)', () => {
  it('SHA-1 agrees with Node\'s, at every length round a block', () => {
    for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 200]) {
      const data = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      expect(Buffer.from(sha1(data)).toString('hex'), `${n} bytes`).toBe(createHash('sha1').update(data).digest('hex'));
    }
  });

  it('gives RFC 9562\'s version 5 UUIDs, the same on every call', () => {
    // Python: uuid.uuid5(uuid.NAMESPACE_DNS, 'python.org')
    expect(uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'python.org')).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
    const a = uuidsFor('lamp');
    expect(a('c_1')).toBe(uuidsFor('lamp')('c_1'));
    expect(a('c_1')).not.toBe(a('c_2'));
    expect(a('c_1')).not.toBe(uuidsFor('lamp 2')('c_1'));
    expect(a('c_1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(URL_NAMESPACE).toBe('6ba7b811-9dad-11d1-80b4-00c04fd430c8');
  });
});

describe('footprints in their own frame (footprint.ts)', () => {
  it('turns the other way round from 4k7, and flips to the bottom as KiCad does (180° − rot)', () => {
    expect([0, 90, 180, 270].map((r) => kicadAngle(r, 'top'))).toEqual([0, -90, 180, 90]);
    expect([0, 90, 180, 270].map((r) => kicadAngle(r, 'bottom'))).toEqual([180, 90, 0, -90]);
  });

  it('puts a polygon in one order whichever corner it started at and whichever way it ran', () => {
    const sq = [0, 0, 2, 0, 2, 1, 0, 1];
    expect(canonicalPolygon([2, 1, 0, 1, 0, 0, 2, 0])).toEqual(sq);
    expect(canonicalPolygon([0, 0, 0, 1, 2, 1, 2, 0])).toEqual(sq);
  });

  it('each pad, put through the footprint\'s position, orientation and side again, lands where the board has it', () => {
    const k = buckFixture();
    const design = k.committedDesign();
    // U1 (SOIC-8 with its thermal pad: pads off centre on both axes), D1 (two pads, polarised), J1 (through hole)
    for (const side of ['top', 'bottom'] as const) {
      for (const rot of [0, 90, 180, 270]) {
        const at = { U1: [12, 10], D1: [22, 6], J1: [4, 14] } as const;
        ok(k, Object.entries(at).map(([ref, [x, y]]) => ({ op: 'place', ref, x_mm: x, y_mm: y, rot, side })));
        const b = k.board();
        const pcb = read(kicadBoard(b, 'pads').pcb);
        const fps = children(pcb, 'footprint');
        for (const ref of Object.keys(at)) {
          const part = b.parts.find((p) => p.refdes === ref)!;
          const fp = fps.find((f) => prop(f, 'Reference')![2] === ref)!;
          const [fx, fy, angle] = atOf(fp);
          const where = `${ref} at ${rot}° on the ${side}`;
          expect(layerOf(fp), where).toBe(side === 'top' ? 'F.Cu' : 'B.Cu');
          expect(angle, where).toBe(kicadAngle(rot, side));
          expect(fx - O).toBeCloseTo(part.x, 6);
          expect(fy - O).toBeCloseTo(part.y, 6);
          const pads = children(fp, 'pad');
          expect(pads.length, where).toBe(part.pads.length);
          part.pads.forEach((q, i) => {
            const pad = pads[i]!;
            const [px, py, pa] = atOf(pad);
            const [x, y] = place(fx - O, fy - O, angle, px, py);
            expect(x, `${where}, pad ${q.number} x`).toBeCloseTo(q.x, 6);
            expect(y, `${where}, pad ${q.number} y`).toBeCloseTo(q.y, 6);
            // a pad's orientation is written absolute (the footprint's), its size in its own frame
            expect(pa, where).toBe(angle);
            const [, w, h] = child(pad, 'size')! as [string, number, number];
            const turned = Math.abs(angle) === 90;
            expect(turned ? [h, w] : [w, h], `${where}, pad ${q.number} size`).toEqual([q.w, q.h]);
            const layers = child(pad, 'layers')!.slice(1);
            if (q.drill) expect(layers).toEqual(['*.Cu', '*.Mask']);
            else expect(layers).toEqual(side === 'top' ? ['F.Cu', 'F.Mask', 'F.Paste'] : ['B.Cu', 'B.Mask', 'B.Paste']);
          });
          // the graphics go to the part's side
          for (const g of children(fp, 'fp_poly')) expect(layerOf(g)!.startsWith(side === 'top' ? 'F.' : 'B.')).toBe(true);
        }
        // the library holds each package as 4k7's own footprint draws it: on the top, not turned
        const files = kicadBoardFiles(b, 'pads');
        for (const ref of Object.keys(at)) {
          const part = b.parts.find((p) => p.refdes === ref)!;
          const card = design.parts[design.components[part.componentId]!.part]!;
          const own = footprintFor(part.pkgInfo, card.pins.map((p) => p.number));
          if (!own.ok) throw new Error(own.reason);
          const libId = fps.find((f) => prop(f, 'Reference')![2] === ref)![1] as string;
          const mod = read(files.find((f) => f.name === `4k7.pretty/${libId.slice(4)}.kicad_mod`)!.content);
          expect(layerOf(mod)).toBe('F.Cu');
          const pads = children(mod, 'pad');
          expect(pads.length).toBe(own.footprint.pads.length);
          own.footprint.pads.forEach((q, i) => {
            const [x, y, a] = atOf(pads[i]!);
            expect([x, y, a], `${ref}'s library pad ${q.number}`).toEqual([q.x, q.y, 0]);
            expect(child(pads[i]!, 'size')!.slice(1)).toEqual([q.w, q.h]);
            expect(child(pads[i]!, 'net')).toBeUndefined();
          });
        }
      }
    }
  });
});

describe('the board read back (board.ts)', () => {
  const designs: [string, () => BoardView][] = [['buck, two layers, routed', buck2], ['buck, four layers with planes, routed', buck4], ['spiral2, placed', spiral2], ['the small design', small]];
  for (const [name, make] of designs) {
    it(`${name}: a footprint per part with its pads and their nets, a segment per piece of track, every via`, () => {
      const b = make();
      const pcb = read(kicadBoard(b, name).pcb);
      expect(child(pcb, 'version')![1]).toBe(KICAD_FILE_VERSION);
      // the copper layers, front to back, with KiCad's ids
      const ids: Record<string, number> = { 'F.Cu': 0, 'In1.Cu': 4, 'In2.Cu': 6, 'B.Cu': 2 };
      expect(child(pcb, 'layers')!.slice(1).filter((l) => (l as SList)[2] instanceof Sym && ((l as SList)[2] as Sym).name === 'signal')).toEqual(b.layers.map((l) => [ids[l], l, sym('signal')]));

      const fps = children(pcb, 'footprint');
      expect(fps.length).toBe(b.parts.length);
      b.parts.forEach((part, i) => {
        const fp = fps[i]!;
        expect(prop(fp, 'Reference')![2]).toBe(part.refdes);
        expect(prop(fp, 'Value')![2]).toBe(part.value);
        const pads = children(fp, 'pad');
        const pins = part.pads.flatMap((q) => [q, ...(q.also ?? []).map((pin) => ({ ...q, number: pin }))]);
        expect(pads.map((p) => p[1])).toEqual(pins.map((q) => q.number));
        pads.forEach((p, j) => {
          const q = pins[j]!;
          expect(netOf(p), `${part.refdes}.${q.number}`).toBe(q.netId ? b.netNames[q.netId] : undefined);
          expect(text(p[2])).toBe(q.npth ? 'np_thru_hole' : q.drill ? 'thru_hole' : 'smd');
        });
        if (part.dnp) expect(child(fp, 'attr')!.map(text)).toContain('dnp');
      });

      const pieces = b.tracks.flatMap((t) => Array.from({ length: t.pts.length / 2 - 1 }, (_, j) => ({ t, x0: t.pts[2 * j]!, y0: t.pts[2 * j + 1]!, x1: t.pts[2 * j + 2]!, y1: t.pts[2 * j + 3]! })).filter((s) => Math.hypot(s.x1 - s.x0, s.y1 - s.y0) > 1e-9));
      const segs = children(pcb, 'segment');
      expect(segs.length).toBe(pieces.length);
      segs.forEach((s, i) => {
        const p = pieces[i]!;
        expect(child(s, 'start')!.slice(1)).toEqual([+(p.x0 + O).toFixed(6), +(p.y0 + O).toFixed(6)]);
        expect(child(s, 'end')!.slice(1)).toEqual([+(p.x1 + O).toFixed(6), +(p.y1 + O).toFixed(6)]);
        expect(child(s, 'width')![1]).toBe(p.t.width);
        expect(layerOf(s)).toBe(p.t.layer);
        expect(netOf(s)).toBe(b.netNames[p.t.netId]);
      });
      const vias = children(pcb, 'via');
      expect(vias.length).toBe(b.vias.length);
      vias.forEach((v, i) => {
        const w = b.vias[i]!;
        expect(atOf(v).slice(0, 2)).toEqual([+(w.x + O).toFixed(6), +(w.y + O).toFixed(6)]);
        expect([child(v, 'size')![1], child(v, 'drill')![1]]).toEqual([w.pad, w.drill]);
        expect(child(v, 'layers')!.slice(1)).toEqual([b.layers[0], b.layers.at(-1)]);
        expect(netOf(v)).toBe(b.netNames[w.netId]);
      });
      // the outline is on Edge.Cuts; every uuid once
      expect(['gr_line', 'gr_arc', 'gr_poly', 'gr_circle'].flatMap((h) => children(pcb, h)).every((g) => layerOf(g) === 'Edge.Cuts')).toBe(true);
      const all = uuids(pcb);
      expect(new Set(all).size).toBe(all.length);
    });
  }

  it('writes the outline with its rounded corners, the cutouts, mounting holes as footprints, and the bottom part flipped', () => {
    const b = small();
    const pcb = read(kicadBoard(b, 'small').pcb);
    // four straight edges and four corner arcs of 1.5 mm; the slot as two lines and its round ends (two quarter arcs each); the round cutout as a circle
    const arcs = children(pcb, 'gr_arc');
    expect(children(pcb, 'gr_line').length).toBe(4 + 2);
    expect(arcs.length).toBe(4 + 4);
    const [sx, sy] = child(arcs[0]!, 'start')!.slice(1) as number[];
    const [mx, my] = child(arcs[0]!, 'mid')!.slice(1) as number[];
    expect(Math.hypot(mx! - sx!, my! - sy!)).toBeCloseTo(2 * 1.5 * Math.sin(Math.PI / 8), 5);
    const circles = children(pcb, 'gr_circle');
    expect(circles.map((c) => child(c, 'center')!.slice(1))).toEqual([[3.5 + O, 3.5 + O]]);
    // the board's top-left corner at the origin, the auxiliary origin there too
    expect(child(child(pcb, 'setup')!, 'aux_axis_origin')!.slice(1)).toEqual([O, O]);
    const xs = children(pcb, 'gr_line').flatMap((l) => [child(l, 'start')![1] as number, child(l, 'end')![1] as number]);
    expect(Math.min(...xs)).toBe(O);
    expect(Math.max(...xs)).toBe(O + 30);

    const fps = children(pcb, 'footprint');
    const holes = b.parts.filter((p) => p.componentId.startsWith('hole:'));
    expect(holes.length).toBe(2);
    for (const h of holes) {
      const fp = fps.find((f) => prop(f, 'Reference')![2] === h.refdes)!;
      expect(fp[1]).toBe(`4k7:${h.pkg}`);
      const [pad] = children(fp, 'pad');
      expect(child(fp, 'attr')!.slice(1).map(text)).toEqual(['exclude_from_pos_files', 'exclude_from_bom']);
      if (h.pads[0]!.npth) {
        expect(text(pad![2])).toBe('np_thru_hole');
        expect(child(pad!, 'size')!.slice(1)).toEqual([3.2, 3.2]);
      } else {
        expect(text(pad![2])).toBe('thru_hole');
        expect(netOf(pad!)).toBe('GND');
      }
    }
    const r2 = fps.find((f) => prop(f, 'Reference')![2] === 'R2')!;
    expect(layerOf(r2)).toBe('B.Cu');
    expect(atOf(r2)[2]).toBe(90);
    const ref = prop(r2, 'Reference')!;
    expect(layerOf(ref)).toBe('B.SilkS');
    expect(child(child(ref, 'effects')!, 'justify')!.map(text)).toEqual(['justify', 'mirror']);
  });

  it('writes a slotted hole as an oval drill in the pad\'s frame', () => {
    const b = structuredClone(small());
    const part = b.parts.find((p) => p.refdes === 'J1')!;
    Object.assign(part.pads[0]!, { w: 1.2, h: 2.4, shape: 'round', drill: 0.6, slot: { w: 0.6, h: 1.8 } });
    part.rot = 90; // the board view as if it were turned: its pads' sizes are already turned (only the frame's angle matters here)
    const fp = children(read(kicadBoard(b, 'slot').pcb), 'footprint').find((f) => prop(f, 'Reference')![2] === 'J1')!;
    const pad = children(fp, 'pad')[0]!;
    expect(text(pad[3])).toBe('oval');
    expect(child(pad, 'size')!.slice(1)).toEqual([2.4, 1.2]);
    expect(child(pad, 'drill')!.map(text)).toEqual(['drill', 'oval', 1.8, 0.6]);
  });

  it('follows the order of sections and the layer table of a board KiCad 10 saved', () => {
    const ref = read(readFileSync(new URL('./kicad/reference/pic_programmer-excerpt.kicad_pcb', import.meta.url), 'utf8'));
    const ours = read(kicadBoard(small(), 'small').pcb);
    const heads = (l: SList) => [...new Set(l.slice(1).filter(Array.isArray).map((x) => (x as SList)[0] as string))];
    // the reference's sections in its order, ours in the same order where both have them
    const refOrder = heads(ref);
    const shared = heads(ours).filter((h) => refOrder.includes(h));
    expect(shared).toEqual(refOrder.filter((h) => shared.includes(h)));
    expect(shared).toEqual(['version', 'generator', 'generator_version', 'general', 'paper', 'title_block', 'layers', 'segment', 'via', 'embedded_fonts']);
    // the same layers with the same ids, types and names; only the copper layers' own names are that board's
    const strip = (l: SNode) => ((l as SList)[2] instanceof Sym && ((l as SList)[2] as Sym).name === 'signal' ? (l as SList).slice(0, 3) : l);
    expect(child(ours, 'layers')!.map(strip)).toEqual(child(ref, 'layers')!.map(strip));
    // a segment's and a via's fields in the reference's order
    const fields = (l: SList) => l.slice(1).filter(Array.isArray).map((x) => (x as SList)[0]);
    expect(fields(child(ours, 'segment')!)).toEqual(fields(child(ref, 'segment')!));
    expect(fields(child(ours, 'via')!).filter((f) => fields(child(ref, 'via')!).includes(f))).toEqual(fields(child(ours, 'via')!));
  });
});

describe('the files of a small design', () => {
  it('are as in the snapshots', async () => {
    const files = kicadBoardFiles(small(), 'small', { version: '0.6.1' });
    // one footprint per package: R1, R2 (on the bottom, turned) and D1 are all one 0603
    expect(files.map((f) => f.name)).toEqual(['small.kicad_pcb', 'fp-lib-table', '4k7.pretty/0603.kicad_mod', '4k7.pretty/HDR-1x2.kicad_mod', '4k7.pretty/MH-3.2-PTH.kicad_mod', '4k7.pretty/MH-3.2.kicad_mod']);
    for (const f of files) await expect(f.content).toMatchFileSnapshot(`./kicad/__snapshots__/small/${f.name}`);
  });

  it('are the same bytes when exported twice, and from the design built twice', () => {
    const b = small();
    const once = kicadBoardFiles(b, 'small', { version: '0.6.1' });
    expect(kicadBoardFiles(b, 'small', { version: '0.6.1' })).toEqual(once);
    expect(kicadBoardFiles(small(), 'small', { version: '0.6.1' })).toEqual(once);
    // another design name gives other uuids (and title), nothing else
    expect(kicadBoard(b, 'big').pcb).not.toBe(kicadBoard(b, 'small').pcb);
    expect(kicadBoard(b, 'big').pcb.replace(/"[0-9a-f-]{36}"/g, 'U').replace('(title "big")', '(title "small")')).toBe(kicadBoard(b, 'small').pcb.replace(/"[0-9a-f-]{36}"/g, 'U'));
  });
});
