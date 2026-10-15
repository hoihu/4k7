/**
 * The enclosure in 3D (three.js, loaded on demand): the board as the Layout's 3D view draws it,
 * the pieces OpenSCAD rendered (STL), the ways out the brief asks for and what the report found.
 * The Enclosure view shows it; render_enclosure takes pictures of it for the agent
 * (docs/design/enclosure.md §5.3).
 *
 * board.scad coordinates (x right, y up, z up, the board's underside at z = 0) become the board
 * viewer's (x, board top at y = 0, z = the board's y down): (x, y, z) → (x, z − 1.6, h − y).
 */
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { boardBodies } from '@4k7/parts';
import type { BoardView } from '@4k7/schema';
import type { EnclosureFacts, EnclosureFinding, EnclosurePiece } from '@4k7/fab';
import { boardGroup, viewerCore, type Res } from './three-body.ts';

const T = 1.6;
type V3 = readonly [number, number, number] | readonly number[];

export interface EnclosureScene {
  board: BoardView;
  facts: EnclosureFacts;
  pieces: EnclosurePiece[];
  findings: EnclosureFinding[];
  /** Parts the brief says are used from outside: their ways out are drawn. */
  openings: string[];
}

export interface SceneOptions {
  /** Pieces to show (all when absent). */
  show?: string[];
  /** Lift the pieces after the first apart, 0 (closed) to 1 (each by the box's height and 10 mm). */
  open?: number;
  /** Draw the ways out and the findings. */
  marks?: boolean;
}

/** A board.scad point, direction and the matrix for meshes, in the viewer's coordinates. */
const toPoint = (p: V3, h: number) => new THREE.Vector3(p[0]!, p[2]! - T, h - p[1]!);
const toDir = (d: V3) => new THREE.Vector3(d[0]!, d[2]!, -d[1]!);
const toViewer = (h: number) => new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, -T, 0, -1, 0, h, 0, 0, 0, 1);

/** Colours of the pieces (base, lid, more), and of a cut through them. */
const PIECE_COLOURS = [0xc9ced6, 0x9db5d8, 0xd6c49d, 0xa8d1b0];
const CUT = 0xe0703a;

function decode(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Geometry of the pieces, parsed once per report. */
const parsed = new WeakMap<EnclosurePiece, THREE.BufferGeometry>();
function pieceGeometry(p: EnclosurePiece, h: number): THREE.BufferGeometry {
  let g = parsed.get(p);
  if (!g) {
    g = new STLLoader().parse(decode(p.stl));
    g.applyMatrix4(toViewer(h));
    parsed.set(p, g);
  }
  return g;
}

/** How far the open view lifts each piece after the first. */
function liftStep(s: EnclosureScene) {
  const zs = s.pieces.flatMap((p) => [p.bbox.min[2], p.bbox.max[2]]);
  return zs.length ? Math.max(...zs) - Math.min(...zs) + 10 : 20;
}

/** The board, the pieces and the marks, as one group for the viewer core. */
export function enclosureGroup(s: EnclosureScene, res: Res, o: SceneOptions = {}, redraw?: () => void): THREE.Group {
  const h = s.board.outline.h;
  const group = boardGroup(s.board, boardBodies(s.board), res, redraw);
  const owned: { dispose(): void }[] = [];
  const lift = liftStep(s) * (o.open ?? 0);
  s.pieces.forEach((p, i) => {
    if (o.show && !o.show.includes(p.name)) return;
    const geo = pieceGeometry(p, h);
    // the outside in the piece's colour; where a section cuts it open, its inside shows in the cut colour
    const front = new THREE.MeshStandardMaterial({ color: PIECE_COLOURS[i % PIECE_COLOURS.length], roughness: 0.7, metalness: 0.02, side: THREE.FrontSide });
    const back = new THREE.MeshBasicMaterial({ color: CUT, side: THREE.BackSide });
    owned.push(front, back);
    for (const mat of [front, back]) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = lift * i;
      mesh.userData.keepGeometry = true;
      group.add(mesh);
    }
  });
  if (o.marks !== false) {
    // the ways out the brief asks for: faint orange boxes from each face outwards
    for (const ref of s.openings) {
      const m = s.facts.parts.find((x) => x.ref === ref)?.mating;
      if (!m) continue;
      const u = toDir(m.u);
      const v = toDir(m.v);
      const d = toDir(m.dir);
      const len = 30;
      const geo = new THREE.BoxGeometry(m.size[0], m.size[1], len);
      const mat = new THREE.MeshBasicMaterial({ color: 0xff9a3c, transparent: true, opacity: 0.18, depthWrite: false });
      owned.push(geo, mat);
      const box = new THREE.Mesh(geo, mat);
      box.matrixAutoUpdate = false;
      const centre = toPoint(m.origin, h).addScaledVector(d, len / 2);
      box.matrix.makeBasis(u, v, d).setPosition(centre);
      box.userData.keepGeometry = true;
      group.add(box);
    }
    // what the report found: red boxes round each spot
    for (const f of s.findings) {
      if (!f.box) continue;
      const a = toPoint(f.box.min, h);
      const b = toPoint(f.box.max, h);
      const helper = new THREE.Box3Helper(new THREE.Box3(a.clone().min(b), a.clone().max(b)).expandByScalar(0.2), f.code === 'ENC.BLOCKED' ? 0xff9a3c : 0xff3344);
      owned.push(helper.geometry, helper.material as THREE.Material);
      helper.userData.keepGeometry = true;
      group.add(helper);
    }
  }
  const before = group.userData.dispose as (() => void) | undefined;
  group.userData.dispose = () => {
    before?.();
    for (const x of owned) x.dispose();
  };
  return group;
}

export interface EnclosureViewer {
  setScene(s: EnclosureScene, o: SceneOptions): void;
  /** A section: the plane through `at` (board.scad), its `normal` side cut away; null: whole. */
  section(cut: { at: V3; normal: V3 } | null): void;
  view(preset: 'iso' | 'top' | 'bottom' | 'front'): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

export function createEnclosureViewer(canvas: HTMLCanvasElement): EnclosureViewer {
  const core = viewerCore(canvas);
  let key = '';
  let h = 0;
  return {
    setScene(s, o) {
      h = s.board.outline.h;
      // keep the camera while only the options or the script change on the same board
      const k = `${s.board.outline.w}x${s.board.outline.h}`;
      core.setContent(enclosureGroup(s, core.res, o, core.redraw), k === key);
      key = k;
    },
    section(cut) {
      if (!cut) return core.clip([]);
      const n = toDir(cut.normal).normalize();
      core.clip([new THREE.Plane(n.clone().negate(), n.dot(toPoint(cut.at, h)))]);
    },
    view: (p) => core.view(p),
    resize: core.resize,
    dispose: core.dispose,
  };
}

export type PictureName = 'front_left' | 'back_right' | 'open' | 'sections' | 'base_top' | 'bottom';

/** Pictures of the enclosure for the agent: JPEGs with a title each. */
export async function enclosurePictures(
  s: EnclosureScene,
  req: { views?: PictureName[]; section?: { axis: 'x' | 'y' | 'z'; at_mm: number }; width?: number },
): Promise<{ data: string; mimeType: string; title: string }[]> {
  const width = req.width ?? 900;
  const height = Math.round(width * 0.68);
  const canvas = document.createElement('canvas');
  const core = viewerCore(canvas, { pixelRatio: 1, background: 0x1b2028 });
  core.resize(width, height);
  const h = s.board.outline.h;
  const out: { data: string; mimeType: string; title: string }[] = [];
  const views = req.views ?? ['front_left', 'back_right', 'open', 'sections', 'base_top'];
  const fov = 30;
  /** Camera `dist` away from `target` along `dir` (viewer coordinates). */
  const look = (target: THREE.Vector3, dir: THREE.Vector3, dist: number) => core.pose(target, target.clone().addScaledVector(dir.normalize(), dist));
  const snap = (title: string) => {
    const url = canvas.toDataURL('image/jpeg', 0.86);
    out.push({ data: url.slice(url.indexOf(',') + 1), mimeType: 'image/jpeg', title });
  };
  /** Frame the whole content: its bounding sphere. */
  const frame = (group: THREE.Group) => {
    const sphere = new THREE.Box3().setFromObject(group).getBoundingSphere(new THREE.Sphere());
    return { centre: sphere.center, dist: (sphere.radius / Math.sin(THREE.MathUtils.degToRad(fov / 2))) * 1.05 };
  };
  const show = (o: SceneOptions) => {
    const g = enclosureGroup(s, core.res, o);
    core.setContent(g);
    return frame(g);
  };
  try {
    for (const v of views) {
      core.clip([]);
      if (v === 'front_left' || v === 'back_right' || v === 'bottom') {
        const f = show({});
        const dir = v === 'front_left' ? new THREE.Vector3(-0.55, 0.75, 0.9) : v === 'back_right' ? new THREE.Vector3(0.55, 0.75, -0.9) : new THREE.Vector3(-0.4, -0.85, 0.6);
        look(f.centre, dir, f.dist);
        core.redraw();
        snap(v === 'front_left' ? 'closed, from the front left above' : v === 'back_right' ? 'closed, from the back right above' : 'from below');
      } else if (v === 'open' && s.pieces.length > 1) {
        const f = show({ open: 1 });
        look(f.centre, new THREE.Vector3(-0.55, 0.6, 0.9), f.dist);
        core.redraw();
        snap(`opened: ${s.pieces.slice(1).map((p) => p.name).join(', ')} lifted off ${s.pieces[0]!.name}`);
      } else if (v === 'base_top') {
        const f = show({ show: [s.pieces[0]!.name] });
        look(f.centre, new THREE.Vector3(0, 1, 0.0001), f.dist * 0.95);
        core.redraw();
        snap(`${s.pieces[0]!.name} from above, without the other pieces`);
      } else if (v === 'sections') {
        for (const ref of s.openings) {
          const m = s.facts.parts.find((x) => x.ref === ref)?.mating;
          if (!m) continue;
          show({});
          const at = toPoint(m.origin, h);
          const u = toDir(m.u).normalize();
          // cut across the wall along the plug's way, through its middle: the near half (the u side) cut away
          core.clip([new THREE.Plane(u.clone().negate(), u.dot(at))]);
          const d = toDir(m.dir).normalize();
          const target = at.clone().addScaledVector(d, 4);
          look(target, u.clone().add(new THREE.Vector3(0, 0.25, 0)), Math.max(28, Math.max(...m.size) * 4) / (2 * Math.tan(THREE.MathUtils.degToRad(fov / 2))));
          snap(`section through ${ref}'s opening (plugged from ${m.facing}), cut across the wall: the cut surfaces are orange, the plug's way is the faint orange box`);
        }
      }
    }
    if (req.section) {
      const f = show({});
      const axis = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[req.section.axis] as [number, number, number];
      const n = toDir(axis).normalize();
      const at = toPoint(axis.map((a) => a * req.section!.at_mm) as [number, number, number], h);
      // only the plane's own coordinate matters: keep the rest at the content's centre
      const plane = new THREE.Plane(n.clone().negate(), n.dot(at));
      core.clip([plane]);
      const target = f.centre.clone().sub(n.clone().multiplyScalar(n.dot(f.centre) - n.dot(at)));
      look(target, n.clone().add(new THREE.Vector3(0, n.y === 0 ? 0.2 : 0, n.y === 0 ? 0 : 0.0001)), f.dist);
      snap(`section at ${req.section.axis} = ${req.section.at_mm} mm, looking from the + side`);
    }
  } finally {
    core.dispose();
  }
  return out;
}
