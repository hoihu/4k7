import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { BoardView } from '@4k7/schema';
import type { EnclosureFacts, EnclosurePiece } from '@4k7/fab';
import { enclosureGroup, sectionCaps } from '../src/lib/enclosure3d.ts';
import { clippingAt, resources } from '../src/lib/three-body.ts';

type Counter = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;

/** A board with one solid of each sort a cut treats differently (no WebGL here: what is drawn, in what order). */
function setup() {
  const res = resources();
  const board = new THREE.Group();
  const substrate = new THREE.Mesh(new THREE.BoxGeometry(100, 1.6, 60), [res.mask, res.edge]);
  const bodies = new THREE.InstancedMesh(res.unitBox, res.body, 2);
  const leads = new THREE.InstancedMesh(res.unitBox, res.lead, 2);
  const pads = new THREE.InstancedMesh(res.unitBox, res.pad, 2);
  const pin1 = new THREE.Mesh(new THREE.CircleGeometry(1, 8), res.mark);
  board.add(substrate, bodies, leads, pads, pin1);
  const before = board.children.length;
  const owned: { dispose(): void }[] = [];
  const clipped = sectionCaps(board, [[1, [res.mask, res.pcb]], [2, [res.body]], [3, [res.lead]]], owned);
  const faces = () => board.children.slice(before) as Counter[];
  return { board, substrate, bodies, leads, pads, pin1, owned, clipped, faces };
}
/** Keeps x ≤ 20. */
const plane = () => new THREE.Plane(new THREE.Vector3(-1, 0, 0), 20);

describe('the faces a cut shows through the board and its parts', () => {
  it('adds nothing until the first cut, so a view never cut pays nothing and the fit sees the content alone', () => {
    const { clipped, faces, substrate, owned } = setup();
    clipped([]);
    expect(faces()).toEqual([]);
    expect(substrate.children).toEqual([]);
    expect(owned).toEqual([]);
  });

  it('counts the solids, not the thin copper or a flat mark', () => {
    const { clipped, substrate, bodies, leads, pads, pin1 } = setup();
    clipped([plane()]);
    for (const solid of [substrate, bodies, leads]) expect(solid.children).toHaveLength(2);
    expect(pads.children).toEqual([]);
    expect(pin1.children).toEqual([]);
  });

  it('adds the back faces and takes away the front ones, over all of an instanced mesh', () => {
    const { clipped, bodies } = setup();
    clipped([plane()]);
    const [back, front] = bodies.children as [Counter & THREE.InstancedMesh, Counter & THREE.InstancedMesh];
    expect([back.material.side, back.material.stencilZPass]).toEqual([THREE.BackSide, THREE.IncrementWrapStencilOp]);
    expect([front.material.side, front.material.stencilZPass]).toEqual([THREE.FrontSide, THREE.DecrementWrapStencilOp]);
    // whatever is in the way counts too: the depth test comes when the face is drawn
    for (const c of [back, front]) expect([c.material.depthTest, c.material.depthWrite, c.material.colorWrite, c.material.stencilFail, c.material.stencilZFail]).toEqual([false, false, false, c.material.stencilZPass, c.material.stencilZPass]);
    expect(back.instanceMatrix).toBe(bodies.instanceMatrix);
    expect(back.count).toBe(bodies.count);
  });

  it('draws each kind after everything else, its count before its face, the next kind after that', () => {
    const { clipped, substrate, bodies, leads, faces } = setup();
    clipped([plane()]);
    const orders = [substrate, bodies, leads].map((solid, i) => [solid.children[0]!.renderOrder, faces()[i]!.renderOrder]);
    expect(orders.flat()).toEqual([...orders.flat()].sort((a, b) => a - b));
    expect(new Set(orders.flat()).size).toBe(6);
    expect(orders[0]![0]).toBeGreaterThan(0);
  });

  it('a face shows where the count is not 0, and leaves it 0 even where it is hidden', () => {
    const { clipped, faces } = setup();
    clipped([plane()]);
    for (const { material: m } of faces()) {
      expect([m.stencilWrite, m.stencilFunc, m.stencilRef]).toEqual([true, THREE.NotEqualStencilFunc, 0]);
      expect([m.stencilFail, m.stencilZFail, m.stencilZPass]).toEqual([THREE.ReplaceStencilOp, THREE.ReplaceStencilOp, THREE.ReplaceStencilOp]);
      expect(m.side).toBe(THREE.DoubleSide);
    }
  });

  it('lies a hair inside what the plane keeps, facing along it and wider than the board', () => {
    const { clipped, faces } = setup();
    const p = plane();
    clipped([p]);
    for (const face of faces()) {
      const inside = p.distanceToPoint(face.position);
      expect(inside).toBeGreaterThan(0);
      expect(inside).toBeLessThan(0.01);
      expect(new THREE.Vector3(0, 0, 1).applyQuaternion(face.quaternion).distanceTo(p.normal)).toBeLessThan(1e-6);
      const { width, height } = (face.geometry as THREE.PlaneGeometry).parameters;
      // (from the middle of the board, as far as its corners)
      expect(Math.min(width, height) / 2).toBeGreaterThan(Math.hypot(50, 30));
      expect(Math.hypot(face.position.y, face.position.z)).toBeLessThan(1);
    }
  });

  it('follows the plane, goes away without one, and comes back without a second set', () => {
    const { clipped, faces, substrate } = setup();
    clipped([plane()]);
    const count = faces().length;
    const moved = new THREE.Plane(new THREE.Vector3(0, 0, 1), 7);
    clipped([moved]);
    for (const face of faces()) expect(moved.distanceToPoint(face.position)).toBeGreaterThan(0);
    for (const face of faces()) expect(moved.distanceToPoint(face.position)).toBeLessThan(0.01);

    clipped([]);
    for (const o of [...faces(), ...(substrate.children as Counter[])]) expect(o.material.visible).toBe(false);

    clipped([plane()]);
    expect(faces()).toHaveLength(count);
    expect(substrate.children).toHaveLength(2);
    for (const o of [...faces(), ...(substrate.children as Counter[])]) expect(o.material.visible).toBe(true);
  });
});

/** A closed box, as the script's pieces come (board coordinates). */
function box(name: string, min: [number, number, number], max: [number, number, number]): EnclosurePiece {
  const g = new THREE.BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2]).toNonIndexed();
  g.translate((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  return { name, tris: g.getAttribute('position').array as Float32Array, bbox: { min, max } };
}

const isFace = (o: THREE.Object3D): o is Counter => o instanceof THREE.Mesh && o.material.stencilFunc === THREE.NotEqualStencilFunc;
const facesOf = (g: THREE.Group) => g.children.filter(isFace);
const hex = (o: Counter) => o.material.color.getHex(THREE.SRGBColorSpace);

describe('the faces a cut shows through the box', () => {
  const base = box('base', [-2, -2, -5], [102, 62, 10]);
  const lid = box('lid', [-2, -2, 10], [102, 62, 13]);
  const logo = box('logo', [40, 20, 12], [60, 40, 13]);
  const scene = (pieces: EnclosurePiece[], inlays = {}) => ({ board: { outline: { w: 100, h: 60 } } as BoardView, facts: {} as EnclosureFacts, pieces, findings: [], openings: [], inlays });
  const group = (pieces = [base, lid], o = {}, inlays = {}) => enclosureGroup(scene(pieces, inlays), resources(), { board: false, marks: false, ...o });
  const cut = (g: THREE.Group, p = plane()) => (g.userData.clipped as (planes: THREE.Plane[]) => void)([p]);

  it('never draws the inside of a piece: seen through a cut it would show the far side, not a face', () => {
    const g = group();
    const drawn = () => {
      const sides: THREE.Side[] = [];
      g.traverse((o) => {
        if (o instanceof THREE.Mesh && o.material.colorWrite) sides.push(o.material.side);
      });
      return sides;
    };
    expect(drawn()).not.toContain(THREE.BackSide);
    cut(g);
    expect(drawn()).not.toContain(THREE.BackSide);
  });

  it('counts each piece on its own, without the board too, and adds nothing before the first cut', () => {
    const g = group();
    const size = g.children.length;
    (g.userData.clipped as (planes: THREE.Plane[]) => void)([]);
    expect(g.children).toHaveLength(size);
    cut(g);
    expect(facesOf(g)).toHaveLength(2);
    const pieces = g.children.filter((o) => o instanceof THREE.Mesh && !isFace(o));
    expect(pieces).toHaveLength(2);
    for (const piece of pieces) expect(piece.children).toHaveLength(2);
    expect(new Set(pieces.flatMap((p) => p.children.map((c) => c.renderOrder))).size).toBe(2);
  });

  it('has nothing to do with the board off and every piece hidden', () => {
    const g = group([base, lid], { show: [] });
    cut(g);
    cut(g, new THREE.Plane(new THREE.Vector3(0, 1, 0), 3));
    expect(facesOf(g)).toEqual([]);
  });

  it('tells pieces that touch apart: a shade of its own for each, the first the plain orange', () => {
    const g = group();
    cut(g);
    const [first, second] = facesOf(g);
    expect(hex(first!)).toBe(0xe0703a);
    expect(hex(second!)).not.toBe(hex(first!));
  });

  it('shows an inlay in its own colour, with no shade of its host', () => {
    const g = group([base, lid, logo], {}, { logo: { host: 'lid', colour: '#ffffff' } });
    cut(g);
    expect(facesOf(g).map(hex)).toContain(0xffffff);
    expect(new Set(facesOf(g).map(hex)).size).toBe(3);
  });

  it('counts a lifted piece where it is, and its face reaches it', () => {
    const g = group([base, lid], { open: 1 });
    cut(g);
    const pieces = g.children.filter((o) => o instanceof THREE.Mesh && !isFace(o));
    const lifted = pieces[1]!;
    expect(lifted.position.y).toBeGreaterThan(0);
    // (the copies stand in the piece, so they lift with it)
    expect(lifted.children.every((c) => c.position.y === 0)).toBe(true);
    const face = facesOf(g)[0]!;
    const { height } = (face.geometry as THREE.PlaneGeometry).parameters;
    const top = lifted.position.y + 13 - 1.6;
    expect(face.position.y + height / 2).toBeGreaterThan(top);
  });

  it("does not take a piece's geometry with it: it is parsed once per report, and the counts share it", () => {
    const g = group();
    cut(g);
    const pieces = g.children.filter((o) => o instanceof THREE.Mesh && !isFace(o));
    for (const piece of pieces) {
      expect(piece.userData.keepGeometry).toBe(true);
      for (const copy of piece.children as Counter[]) {
        expect(copy.geometry).toBe((piece as Counter).geometry);
        expect(copy.userData.keepGeometry).toBe(true);
      }
    }
  });
});

describe('where a cut really clips', () => {
  it('leaves out a face exactly on the plane, however the plane faces, and keeps what is a slider step further', () => {
    for (const p of [plane(), new THREE.Plane(new THREE.Vector3(1, 0, 0), -20)]) {
      const [at] = clippingAt([p]);
      const on = new THREE.Vector3(20, 3, 4);
      expect(at!.distanceToPoint(on)).toBeLessThan(0);
      expect(at!.distanceToPoint(on.clone().addScaledVector(p.normal, 0.1))).toBeGreaterThan(0);
    }
  });

  it('is well off what rounding can reach, and thinner than the copper', () => {
    const p = plane();
    const [at] = clippingAt([p]);
    const hair = p.constant - at!.constant;
    expect(hair).toBeGreaterThan(0.002);
    expect(hair).toBeLessThan(0.035);
    expect(at!.normal.equals(p.normal)).toBe(true);
    // (the plane given stays as it is: the frame round the cut goes by it)
    expect(p.constant).toBe(20);
  });
});
