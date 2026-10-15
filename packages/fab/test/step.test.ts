import { describe, expect, it } from 'vitest';
import { Kernel } from '@4k7/kernel';
import type { BoardView } from '@4k7/schema';
import { boardStep } from '../src/index.ts';
import { buckTransaction } from '../../kernel/test/fixtures.ts';

function kernel() {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  return k;
}

/** The DATA section as id → entity text (one entity per line, as the writer puts them). */
function entities(step: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of step.split('\n')) {
    const m = /^#(\d+)=(.*);$/.exec(line);
    if (m) {
      expect(map.has(Number(m[1])), `#${m[1]} defined twice`).toBe(false);
      map.set(Number(m[1]), m[2]!);
    }
  }
  return map;
}
const refs = (text: string) => [...text.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));

/** Every solid's name and its faces' surfaces. */
function solids(e: Map<number, string>) {
  return [...e.entries()]
    .filter(([, t]) => t.startsWith('MANIFOLD_SOLID_BREP'))
    .map(([id, t]) => {
      const faces = refs(e.get(refs(t)[0]!)!).map((f) => e.get(f)!);
      return { id, name: /^MANIFOLD_SOLID_BREP\('([^']*)'/.exec(t)![1]!, faces, surfaces: faces.map((f) => e.get(refs(f).at(-1)!)!) };
    });
}

/** A plane's location and normal. */
function plane(e: Map<number, string>, text: string) {
  const [ax] = refs(text);
  const [p, z] = refs(e.get(ax!)!);
  const nums = (t: string) => /\(([^()]*)\)\)$/.exec(t)![1]!.split(',').map(Number);
  return { at: nums(e.get(p!)!), normal: nums(e.get(z!)!) };
}

describe('STEP export', () => {
  it('writes an AP214 file whose every reference resolves', () => {
    const b = kernel().board();
    const step = boardStep(b, 'buck converter', new Date(Date.UTC(2026, 0, 1)));
    expect(step.name).toBe('buck_converter.step');
    const text = step.content;
    expect(text.startsWith('ISO-10303-21;\nHEADER;')).toBe(true);
    expect(text).toContain("FILE_NAME('buck_converter.step','2026-01-01T00:00:00'");
    expect(text).toContain("FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));");
    expect(text.trimEnd().endsWith('END-ISO-10303-21;')).toBe(true);
    const e = entities(text);
    for (const [id, t] of e) for (const r of refs(t)) expect(e.has(r), `#${id} refers to #${r}`).toBe(true);
    // reals always carry a decimal point (an integer there is a different type)
    for (const t of e.values()) if (t.startsWith('CARTESIAN_POINT') || t.startsWith('DIRECTION')) expect(t).toMatch(/\((-?\d+\.\d*(E-?\d+)?,){2}-?\d+\.\d*(E-?\d+)?\)\)$/);
  });

  it('is an assembly of the PCB and one component per part, named by designator', () => {
    const b = kernel().board();
    const step = boardStep(b, 'buck');
    const e = entities(step.content);
    const uses = [...e.values()].filter((t) => t.startsWith('NEXT_ASSEMBLY_USAGE_OCCURRENCE')).map((t) => /^NEXT_ASSEMBLY_USAGE_OCCURRENCE\('([^']*)'/.exec(t)![1]);
    const parts = b.parts.filter((p) => !p.componentId.startsWith('hole:'));
    expect(step.without).toEqual([]);
    expect(step.parts).toBe(parts.length);
    expect(uses.sort()).toEqual(['PCB', ...parts.map((p) => p.refdes)].sort());
    const products = [...e.values()].filter((t) => t.startsWith('PRODUCT(')).map((t) => /^PRODUCT\('[^']*','([^']*)'/.exec(t)![1]);
    for (const p of parts) expect(products).toContain(p.refdes);
    // every solid is coloured
    const styled = new Set([...e.values()].filter((t) => t.startsWith('STYLED_ITEM')).map((t) => refs(t).at(-1)));
    for (const s of solids(e)) expect(styled.has(s.id)).toBe(true);
  });

  it('writes closed solids: every edge of a shell used once each way', () => {
    const e = entities(boardStep(kernel().board(), 'buck').content);
    const shells = [...e.values()].filter((t) => t.startsWith('CLOSED_SHELL'));
    expect(shells.length).toBeGreaterThan(10);
    for (const shell of shells) {
      const uses = new Map<number, string[]>();
      for (const face of refs(shell)) {
        const bounds = refs(e.get(face)!).slice(0, -1);
        for (const bound of bounds) {
          for (const oe of refs(e.get(refs(e.get(bound)!)[0]!)!)) {
            const t = e.get(oe)!;
            const edge = refs(t)[0]!;
            uses.set(edge, [...(uses.get(edge) ?? []), t.endsWith('.T.)') ? 'T' : 'F']);
          }
        }
      }
      for (const [edge, u] of uses) expect(u.sort(), `edge #${edge}`).toEqual(['F', 'T']);
    }
  });

  it('cuts every drilled hole and round cutout as a cylinder through a 1.6 mm board, top up, bottom down', () => {
    const k = kernel();
    k.transact({ summary: 'size', ops: [{ op: 'set_board', width_mm: 40, height_mm: 30 }, { op: 'add_hole', diameter_mm: 3.2, corner: 'all' }, { op: 'add_cutout', shape: 'circle', x_mm: 34, y_mm: 15, diameter_mm: 3 }, { op: 'add_cutout', shape: 'slot', x_mm: 20, y_mm: 26, width_mm: 6, height_mm: 1 }] });
    k.accept();
    const b = k.board();
    const e = entities(boardStep(b, 'holes').content);
    const pcb = solids(e).find((s) => s.name === 'PCB')!;
    const drills = b.parts.flatMap((p) => p.pads.filter((q) => q.drill)).length;
    expect(drills).toBe(2 + 4); // the header pins and the mounting holes
    expect(pcb.surfaces.filter((s) => s.startsWith('CYLINDRICAL_SURFACE'))).toHaveLength(drills + 1);
    // the slot: a polygon through the board (its side faces are planes), so more than the outline's 4 sides + 2 caps
    const planes = pcb.surfaces.filter((s) => s.startsWith('PLANE')).map((s) => plane(e, s));
    expect(planes.length).toBeGreaterThan(6 + 8);
    const caps = planes.filter((p) => Math.abs(p.normal[2]!) === 1);
    expect(caps.map((p) => [p.at[2], p.normal[2]]).sort()).toEqual([[0, -1], [1.6, 1]]);
  });

  it('places parts on the copper, turned over on the bottom side', () => {
    const k = kernel();
    const u1 = k.board().parts.find((p) => p.refdes === 'U1')!;
    k.transact({ summary: 'bottom', ops: [{ op: 'constrain', kind: 'layer', a: 'U1', value: 'bottom' }, { op: 'place', ref: 'U1', x_mm: u1.x, y_mm: u1.y, rot: 90 }] });
    k.accept();
    const b = k.board();
    const placed = b.parts.find((p) => p.refdes === 'U1')!;
    const e = entities(boardStep(b, 'buck').content);
    // the assembly's placement of each component: location, z axis, x axis
    const at = (ref: string) => {
      const nauo = [...e.entries()].find(([, t]) => t.startsWith(`NEXT_ASSEMBLY_USAGE_OCCURRENCE('${ref}'`))![0];
      const cdsr = [...e.values()].find((t) => t.startsWith('CONTEXT_DEPENDENT_SHAPE_REPRESENTATION') && e.get(refs(t)[1]!)!.endsWith(`#${nauo})`))!;
      const idt = e.get(refs(e.get(refs(cdsr)[0]!)!)[2]!)!;
      return refs(e.get(refs(idt)[1]!)!).map((r) => /\(([^()]*)\)\)$/.exec(e.get(r)!)![1]!.split(',').map(Number));
    };
    const [loc, z, x] = at('U1');
    expect(loc).toEqual([placed.x, b.outline.h - placed.y, -0.035]);
    expect(z).toEqual([0, 0, -1]);
    // flipped over about its y axis (x → −x), then turned 90° clockwise as seen from the top: x points up (+y)
    expect(x![0]).toBeCloseTo(0);
    expect(x![1]).toBeCloseTo(1);
    const r1 = b.parts.find((p) => p.refdes === 'R1')!;
    const [loc1, z1] = at('R1');
    expect(loc1).toEqual([r1.x, b.outline.h - r1.y, 1.635]);
    expect(z1).toEqual([0, 0, 1]);
  });

  it('lists parts without a 3D body and escapes names', () => {
    const b = kernel().board();
    const odd: BoardView = { ...b, parts: b.parts.map((p) => (p.refdes === 'U1' ? { ...p, pkgInfo: { ...p.pkgInfo, family: 'OTHER' as never, pads: undefined } } : p)) };
    const step = boardStep(odd, "Wärme 'Test'");
    expect(step.without).toEqual(['U1']);
    expect(step.content).not.toMatch(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\('U1'/);
    expect(step.content).toContain("PRODUCT('W\\X2\\00E4\\X0\\rme ''Test''',");
    expect(step.name).toBe('W_rme_Test_.step');
    expect(/[^\x20-\x7e\n]/.test(step.content)).toBe(false);
  });
});
