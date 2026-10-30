/**
 * The enclosure in 3D (three.js, loaded on demand): the board as the Layout's 3D view draws it,
 * the pieces the script made, the ways out the brief asks for and what the report found.
 * The Enclosure view shows it; render_enclosure takes pictures of it for the agent
 * (docs/design/enclosure.md §5.3).
 *
 * Board coordinates (x right, y up, z up, the board's underside at z = 0) become the board
 * viewer's (x, board top at y = 0, z = the board's y down): (x, y, z) → (x, z − 1.6, h − y).
 */
import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { boardBodies } from '@4k7/parts';
import type { BoardView } from '@4k7/schema';
import type { EnclosureFacts, EnclosureFinding, EnclosurePiece } from '@4k7/fab';
import { boardGroup, viewerCore, type Res } from './three-body.ts';
import { extent, liftStep, type Box } from './section.ts';

const T = 1.6;
type V3 = readonly [number, number, number] | readonly number[];

export interface EnclosureScene {
  board: BoardView;
  facts: EnclosureFacts;
  pieces: EnclosurePiece[];
  findings: EnclosureFinding[];
  /** Parts the brief says are used from outside: their ways out are drawn. */
  openings: string[];
  /** Pieces in another colour that belong to a host piece (the script's inlays): drawn in their colour, lifted with the host. */
  inlays?: Record<string, { host: string; colour?: string }>;
}

export interface SceneOptions {
  /** Pieces to show (all when absent); inlays follow their host. */
  show?: string[];
  /** The board with its parts (default true): off, to see how the box holds it. */
  board?: boolean;
  /** Lift the pieces after the first apart, 0 (closed) to 1 (each by the box's height and 10 mm). */
  open?: number;
  /** Draw the ways out and the findings. */
  marks?: boolean;
}

/** A board point, direction and the matrix for meshes, in the viewer's coordinates. */
const toPoint = (p: V3, h: number) => new THREE.Vector3(p[0]!, p[2]! - T, h - p[1]!);
const toDir = (d: V3) => new THREE.Vector3(d[0]!, d[2]!, -d[1]!);
const toViewer = (h: number) => new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, -T, 0, -1, 0, h, 0, 0, 0, 1);

/**
 * Colours of the pieces (base, lid, more): muted mid tones, so the lights shade them as they do the
 * Layout's 3D view (pale ones wash out); of an inlay the script gives no colour; their edges a darker
 * line; a cut through them.
 */
const PIECE_COLOURS = [0x6b727d, 0x4d6688, 0x8c7b5a, 0x5c7d66];
const INLAY = 0x2a2e35;
const EDGE = 0x10141a;
const CUT = 0xe0703a;
/** Facets meeting at less than this are shaded smooth (rounded corners, holes), and get no edge line. */
const CREASE = 30;

/** Geometry of the pieces and their edges, made once per report. */
const parsed = new WeakMap<EnclosurePiece, { faces: THREE.BufferGeometry; edges: THREE.EdgesGeometry }>();
function pieceGeometry(p: EnclosurePiece, h: number) {
  let g = parsed.get(p);
  if (!g) {
    const mesh = new THREE.BufferGeometry();
    // (a copy: the report keeps its board coordinates)
    mesh.setAttribute('position', new THREE.BufferAttribute(p.tris.slice(), 3));
    mesh.applyMatrix4(toViewer(h));
    // (normals per facet would show every facet of a curved face)
    g = { faces: toCreasedNormals(mesh, THREE.MathUtils.degToRad(CREASE)), edges: new THREE.EdgesGeometry(mesh, CREASE) };
    mesh.dispose();
    parsed.set(p, g);
  }
  return g;
}

/** The pieces that are not inlays, in order: the open view lifts each by its place here, its inlays with it. */
function hosts(s: EnclosureScene): EnclosurePiece[] {
  return s.pieces.filter((p) => !s.inlays?.[p.name] || !s.pieces.some((h) => h.name === s.inlays![p.name]!.host));
}

/** The board, the pieces and the marks, as one group for the viewer core. */
export function enclosureGroup(s: EnclosureScene, res: Res, o: SceneOptions = {}, redraw?: () => void): THREE.Group {
  const h = s.board.outline.h;
  const group = o.board === false ? new THREE.Group() : boardGroup(s.board, boardBodies(s.board), res, redraw);
  const owned: { dispose(): void }[] = [];
  const lift = liftStep(s.pieces) * (o.open ?? 0);
  const order = hosts(s).map((p) => p.name);
  /** The piece a piece moves and shows with: an inlay's host, else itself. */
  const hostOf = (name: string) => {
    const inlay = s.inlays?.[name];
    return inlay && order.includes(inlay.host) ? inlay.host : name;
  };
  s.pieces.forEach((p) => {
    const inlay = s.inlays?.[p.name];
    const host = hostOf(p.name);
    // an inlay shows with its host
    if (o.show && !o.show.includes(host)) return;
    const i = order.indexOf(host);
    const geo = pieceGeometry(p, h);
    // the outside in the piece's colour; where a section cuts it open, its inside shows in the cut colour
    let colour: THREE.ColorRepresentation = PIECE_COLOURS[i % PIECE_COLOURS.length]!;
    if (host !== p.name) {
      colour = INLAY;
      try {
        if (inlay?.colour) colour = new THREE.Color().setStyle(inlay.colour);
      } catch {
        // not a CSS colour: the default
      }
    }
    // (pushed back, so the inside never shows through where the outside meets another piece's)
    const front = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.6, metalness: 0.05, side: THREE.FrontSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const back = new THREE.MeshBasicMaterial({ color: CUT, side: THREE.BackSide, polygonOffset: true, polygonOffsetFactor: 3, polygonOffsetUnits: 3 });
    const edge = new THREE.LineBasicMaterial({ color: EDGE, transparent: true, opacity: 0.55 });
    owned.push(front, back, edge);
    const parts: THREE.Object3D[] = [new THREE.Mesh(geo.faces, front), new THREE.Mesh(geo.faces, back), new THREE.LineSegments(geo.edges, edge)];
    for (const o of parts) {
      o.position.y = lift * i;
      o.userData.keepGeometry = true;
      group.add(o);
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
      const mat = new THREE.MeshBasicMaterial({ color: 0xff9a3c, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide });
      owned.push(geo, mat);
      const box = new THREE.Mesh(geo, mat);
      box.matrixAutoUpdate = false;
      const centre = toPoint(m.origin, h).addScaledVector(d, len / 2);
      box.matrix.makeBasis(u, v, d).setPosition(centre);
      box.userData.keepGeometry = true;
      group.add(box);
    }
    // what the report found: boxes round each spot (errors red, warnings amber), lifted with their piece
    for (const f of s.findings) {
      if (!f.box) continue;
      const at = f.piece ? order.indexOf(hostOf(f.piece)) : -1;
      if (at >= 0 && o.show && !o.show.includes(order[at]!)) continue;
      const up = new THREE.Vector3(0, lift * Math.max(at, 0), 0);
      const a = toPoint(f.box.min, h).add(up);
      const b = toPoint(f.box.max, h).add(up);
      const colour = f.code === 'ENC.BLOCKED' ? 0xff9a3c : f.severity === 'warning' ? 0xf2b53a : 0xff3344;
      const helper = new THREE.Box3Helper(new THREE.Box3(a.clone().min(b), a.clone().max(b)).expandByScalar(0.2), colour);
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

/** A cut for the viewer (board coordinates): the plane n · p = at through `box` (what it may move through; its frame goes round it). */
export interface ViewerSection {
  normal: [number, number, number];
  at: number;
  /** Cut away the half the normal points away from (else the one it points to). */
  flip?: boolean;
  box: Box;
}

export interface EnclosureViewer {
  setScene(s: EnclosureScene, o: SceneOptions): void;
  /** A section with a frame round it, to drag it by; null: whole. */
  section(cut: ViewerSection | null): void;
  /** Where the camera is (board coordinates). */
  eye(): [number, number, number];
  view(preset: 'iso' | 'top' | 'bottom' | 'front'): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

/** The frame round a cut and its grip: brighter while the pointer is on them. */
const FRAME = 0xe0703a;
const FRAME_HOT = 0xffb37a;
/** How close (CSS pixels) the pointer must come to the frame to take it. */
const REACH = 7;

/** 2D distance from (x, y) to the segment a–b. */
function segmentDistance(x: number, y: number, a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = dx || dy ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(x - a.x - t * dx, y - a.y - t * dy);
}

/** `moved`: the user dragged the cut's frame to `at` (mm along its normal, within its box). */
export function createEnclosureViewer(canvas: HTMLCanvasElement, moved?: (at: number) => void): EnclosureViewer {
  const core = viewerCore(canvas);
  let key = '';
  let h = 0;
  let cut: ViewerSection | null = null;

  /*
   * The frame: a band on the plane round the box's cross-section (a line along its outer edge, for
   * when it is seen edge on) and a grip in the middle of its top edge (a horizontal cut: its back
   * edge), arrows both ways along the normal. Drawn in the core's overlay, so the cut never hides it.
   */
  const lineMat = new THREE.LineBasicMaterial({ color: FRAME, transparent: true, opacity: 0.9 });
  const bandMat = new THREE.MeshBasicMaterial({ color: FRAME, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });
  const gripMat = new THREE.MeshBasicMaterial({ color: FRAME });
  const line = new THREE.LineLoop(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3)), lineMat);
  const bandGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(24), 3));
  // the ring between the outer corners (0–3) and the inner ones (4–7)
  bandGeo.setIndex([0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
  const band = new THREE.Mesh(bandGeo, bandMat);
  const shaftGeo = new THREE.CylinderGeometry(0.35, 0.35, 5, 12);
  const coneGeo = new THREE.ConeGeometry(1, 2.2, 20);
  const grip = new THREE.Group();
  grip.add(new THREE.Mesh(shaftGeo, gripMat));
  for (const s of [1, -1]) {
    const cone = new THREE.Mesh(coneGeo, gripMat);
    cone.position.y = s * 3.6;
    if (s < 0) cone.rotation.x = Math.PI;
    grip.add(cone);
  }
  const frame = new THREE.Group();
  frame.add(band, line, grip);
  frame.traverse((o) => (o.frustumCulled = false));
  frame.visible = false;
  core.overlay.add(frame);
  /** The frame's outer corners and the grip's ends (viewer coordinates), for picking. */
  let corners: THREE.Vector3[] = [];
  let gripEnds: [THREE.Vector3, THREE.Vector3] | null = null;
  let gripR = 1;

  function placeFrame(c: ViewerSection) {
    const n = c.normal;
    // two directions in the plane: across it and up it (a horizontal cut: x and y)
    const pick = Math.abs(n[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
    const k = pick[0]! * n[0] + pick[1]! * n[1] + pick[2]! * n[2];
    const up = new THREE.Vector3(pick[0]! - k * n[0], pick[1]! - k * n[1], pick[2]! - k * n[2]).normalize();
    const nb = new THREE.Vector3(...n);
    let across = new THREE.Vector3().crossVectors(up, nb).normalize();
    let along = up;
    if (Math.abs(n[2]) > 0.9) [across, along] = [up, new THREE.Vector3().crossVectors(nb, up).normalize()];
    // the box's corners on the plane, as far across and up as they reach
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3((i & 1 ? c.box.max : c.box.min)[0], (i & 2 ? c.box.max : c.box.min)[1], (i & 4 ? c.box.max : c.box.min)[2]);
      a0 = Math.min(a0, p.dot(across));
      a1 = Math.max(a1, p.dot(across));
      b0 = Math.min(b0, p.dot(along));
      b1 = Math.max(b1, p.dot(along));
    }
    const size = Math.max(a1 - a0, b1 - b0, 1);
    const margin = Math.max(2, size * 0.04);
    const width = Math.max(0.3, size * 0.008);
    const on = nb.clone().multiplyScalar(c.at);
    /** The point of the plane `s` across and `t` up (viewer coordinates). */
    const point = (s: number, t: number) => {
      const p = on.clone().addScaledVector(across, s).addScaledVector(along, t);
      return toPoint([p.x, p.y, p.z], h);
    };
    const outer = [point(a0 - margin, b0 - margin), point(a1 + margin, b0 - margin), point(a1 + margin, b1 + margin), point(a0 - margin, b1 + margin)];
    const inner = [point(a0 - margin + width, b0 - margin + width), point(a1 + margin - width, b0 - margin + width), point(a1 + margin - width, b1 + margin - width), point(a0 - margin + width, b1 + margin - width)];
    const lp = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    outer.forEach((p, i) => lp.setXYZ(i, p.x, p.y, p.z));
    lp.needsUpdate = true;
    const bp = bandGeo.getAttribute('position') as THREE.BufferAttribute;
    [...outer, ...inner].forEach((p, i) => bp.setXYZ(i, p.x, p.y, p.z));
    bp.needsUpdate = true;
    // the grip: scaled with the box, its arrows along the normal
    gripR = Math.min(2.5, Math.max(0.7, size * 0.018));
    const nv = toDir(n).normalize();
    grip.position.copy(point((a0 + a1) / 2, b1 + margin));
    grip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), nv);
    grip.scale.setScalar(gripR);
    gripEnds = [grip.position.clone().addScaledVector(nv, -4.7 * gripR), grip.position.clone().addScaledVector(nv, 4.7 * gripR)];
    corners = outer;
  }

  /** A point in the viewer on the canvas (CSS pixels from its top left); null behind the camera. */
  function screen(p: THREE.Vector3) {
    const v = p.clone().project(core.camera);
    return v.z > 1 ? null : { x: ((v.x + 1) / 2) * canvas.clientWidth, y: ((1 - v.y) / 2) * canvas.clientHeight };
  }
  /** The pointer is on the frame or its grip. */
  function onFrame(x: number, y: number): boolean {
    if (!cut || !frame.visible) return false;
    const s = corners.map(screen);
    for (let i = 0; i < 4; i++) {
      const a = s[i];
      const b = s[(i + 1) % 4];
      if (a && b && segmentDistance(x, y, a, b) < REACH) return true;
    }
    const g = gripEnds?.map(screen);
    const centre = screen(grip.position);
    const side = centre && screen(grip.position.clone().add(new THREE.Vector3(gripR, 0, 0).applyQuaternion(core.camera.quaternion)));
    const r = centre && side ? Math.hypot(side.x - centre.x, side.y - centre.y) : 0;
    return !!(g?.[0] && g[1] && segmentDistance(x, y, g[0], g[1]) < Math.max(REACH + 2, r + 4));
  }

  let hot = false;
  function heat(on: boolean) {
    if (on === hot) return;
    hot = on;
    for (const m of [lineMat, bandMat, gripMat]) m.color.setHex(on ? FRAME_HOT : FRAME);
    core.redraw();
  }
  /** Which way the normal runs on screen: the cursor to show over the frame. */
  function cursor(): string {
    if (!cut || !gripEnds) return '';
    const a = screen(gripEnds[0]);
    const b = screen(gripEnds[1]);
    if (!a || !b || Math.hypot(b.x - a.x, b.y - a.y) < 4) return 'move';
    const angle = ((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 180) % 180;
    return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][Math.round(angle / 45) % 4]!;
  }

  /*
   * Dragging the frame moves the cut along its normal: the pointer's travel along the normal as it
   * runs on screen. Seen nearly straight on (the normal pointing at the camera), up and down push the
   * cut away and pull it nearer. OrbitControls sees the same pointer down; it is held meanwhile.
   */
  let drag: { id: number; x: number; y: number; at: number; dir: { x: number; y: number }; px: number; towards: boolean } | null = null;
  const local = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  function down(e: PointerEvent) {
    if (e.button !== 0 || !cut) return;
    const p = local(e);
    if (!onFrame(p.x, p.y)) return;
    e.preventDefault();
    core.orbit(false);
    canvas.setPointerCapture(e.pointerId);
    const centre = grip.position.clone();
    const nv = toDir(cut.normal).normalize();
    const reach = Math.max(1, corners[0]!.distanceTo(corners[2]!) * 0.1);
    const a = screen(centre);
    const b = screen(centre.clone().addScaledVector(nv, reach));
    const px = canvas.clientHeight / (2 * core.camera.position.distanceTo(centre) * Math.tan(THREE.MathUtils.degToRad(core.camera.fov / 2)));
    drag = {
      id: e.pointerId,
      ...p,
      at: cut.at,
      dir: a && b ? { x: (b.x - a.x) / reach, y: (b.y - a.y) / reach } : { x: 0, y: 0 },
      px,
      towards: nv.dot(core.camera.position.clone().sub(centre)) > 0,
    };
    heat(true);
  }
  function move(e: PointerEvent) {
    const p = local(e);
    if (!drag) {
      // (not while the controls orbit)
      if (e.buttons) return;
      const on = onFrame(p.x, p.y);
      heat(on);
      canvas.style.cursor = on ? cursor() : '';
      return;
    }
    if (e.pointerId !== drag.id || !cut) return;
    const dx = p.x - drag.x;
    const dy = p.y - drag.y;
    const len2 = drag.dir.x ** 2 + drag.dir.y ** 2;
    const mm = len2 > (0.2 * drag.px) ** 2 ? (dx * drag.dir.x + dy * drag.dir.y) / len2 : (-dy / drag.px) * (drag.towards ? -1 : 1);
    const [lo, hi] = extent(cut.normal, cut.box);
    const at = Math.round(Math.min(hi, Math.max(lo, drag.at + mm)) * 10) / 10;
    if (at !== cut.at) moved?.(at);
  }
  function up(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    core.orbit(true);
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    const p = local(e);
    heat(onFrame(p.x, p.y));
  }
  const leave = () => {
    if (drag) return;
    heat(false);
    canvas.style.cursor = '';
  };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointerleave', leave);

  return {
    setScene(s, o) {
      h = s.board.outline.h;
      // keep the camera while only the script or the pieces shown change on the same board (opening it refits)
      const k = `${s.board.outline.w}x${s.board.outline.h}/${o.open ? 'open' : 'closed'}`;
      core.setContent(enclosureGroup(s, core.res, o, core.redraw), k === key);
      key = k;
    },
    section(c) {
      cut = c;
      frame.visible = !!c;
      if (!c) {
        heat(false);
        canvas.style.cursor = '';
        return core.clip([]);
      }
      placeFrame(c);
      const n = toDir(c.normal).normalize();
      const d = n.dot(toPoint(c.normal.map((v) => v * c.at), h));
      core.clip([c.flip ? new THREE.Plane(n, -d) : new THREE.Plane(n.clone().negate(), d)]);
    },
    eye() {
      const p = core.camera.position;
      // (toPoint the other way round)
      return [p.x, h - p.z, p.y + T];
    },
    view: (p) => core.view(p),
    resize: core.resize,
    dispose() {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('pointerleave', leave);
      for (const x of [line.geometry, bandGeo, shaftGeo, coneGeo, lineMat, bandMat, gripMat]) x.dispose();
      core.dispose();
    },
  };
}

export type PictureName = 'front_left' | 'back_right' | 'open' | 'sections' | 'base_top' | 'bottom';
export type FaceName = 'left' | 'right' | 'top' | 'bottom' | 'above' | 'below';

/**
 * Where the camera stands to read a face (board directions, as the script's on_face): out from
 * it, tilted about 20° so engraved and raised edges catch the light (straight on, a groove's floor
 * shades like the face round it). Walls lean towards the text's top and left; the lid and the floor
 * only towards the text's foot, which keeps the face's up at the top of the picture (the camera does
 * not roll). `out` is the axis the face looks along.
 */
const FACE_VIEW: Record<FaceName, { dir: [number, number, number]; out: 0 | 1 | 2 }> = {
  left: { dir: [-1, 0.2, 0.35], out: 0 },
  right: { dir: [1, -0.2, 0.35], out: 0 },
  top: { dir: [0.2, 1, 0.35], out: 1 },
  bottom: { dir: [-0.2, -1, 0.35], out: 1 },
  above: { dir: [0, -0.35, 1], out: 2 },
  below: { dir: [0, -0.35, -1], out: 2 },
};

/** Pictures of the enclosure for the agent: JPEGs with a title each. */
export async function enclosurePictures(
  s: EnclosureScene,
  req: { views?: PictureName[]; faces?: FaceName[]; section?: { axis: 'x' | 'y' | 'z'; at_mm: number }; width?: number },
): Promise<{ data: string; mimeType: string; title: string }[]> {
  const width = req.width ?? 900;
  const height = Math.round(width * 0.68);
  const canvas = document.createElement('canvas');
  const core = viewerCore(canvas, { pixelRatio: 1, background: 0x1b2028 });
  core.resize(width, height);
  const h = s.board.outline.h;
  const out: { data: string; mimeType: string; title: string }[] = [];
  const views = req.views ?? ['front_left', 'back_right', 'open', 'sections', 'base_top'];
  const main = hosts(s);
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
      } else if (v === 'open' && main.length > 1) {
        const f = show({ open: 1 });
        look(f.centre, new THREE.Vector3(-0.55, 0.6, 0.9), f.dist);
        core.redraw();
        snap(`opened: ${main.slice(1).map((p) => p.name).join(', ')} lifted off ${main[0]!.name}`);
      } else if (v === 'base_top') {
        const f = show({ show: [main[0]!.name] });
        look(f.centre, new THREE.Vector3(0, 1, 0.0001), f.dist * 0.95);
        core.redraw();
        snap(`${main[0]!.name} from above, without the other pieces`);
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
    for (const face of req.faces ?? []) {
      core.clip([]);
      // without the plug paths and findings, which would hide labels; framed on the face, not the whole box
      const g = enclosureGroup(s, core.res, { marks: false });
      core.setContent(g);
      const v = FACE_VIEW[face];
      const box = new THREE.Box3().setFromObject(g);
      const size = box.getSize(new THREE.Vector3());
      // board x, y, z are the viewer's x, z, y
      const across = ([size.x, size.z, size.y] as number[]).filter((_, i) => i !== v.out);
      const r = Math.hypot(across[0]!, across[1]!) / 2;
      look(box.getCenter(new THREE.Vector3()), toDir(v.dir), (r / Math.sin(THREE.MathUtils.degToRad(fov / 2))) * 1.1 + ([size.x, size.z, size.y][v.out]! / 2));
      core.redraw();
      snap(`the ${face === 'above' ? 'lid from above' : face === 'below' ? 'floor from below (the box tipped towards you)' : `${face} face`}, as a reader sees it (tilted a little, so engraving shows)`);
    }
    if (req.section) {
      core.clip([]);
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
