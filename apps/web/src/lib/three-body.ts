/**
 * three.js views, loaded on demand: a single package body (Parts view) and the assembled board
 * (Layout view). Both are built from Body3D data (@4k7/parts) and the board view model.
 *
 * Body3D and board coordinates: millimetres, x right and y down as in the top view, z up.
 * three.js is y-up, so (x, y, z) → (x, z, y); a camera above, looking down, then shows the
 * part or board exactly like the footprint / 2D layout (pin 1 top left).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Body3D } from '@4k7/parts';
import { enclosureFacts } from '@4k7/fab';
import { boardPolygon, cutoutPolygon, type BoardView } from '@4k7/schema';

export type ViewPreset = 'iso' | 'isoBelow' | 'top' | 'bottom' | 'front';

export interface BodyViewer {
  /** With `top`: a picture of the part from above (a module's carrier board shows it). */
  setBody(body: Body3D, top?: TopPicture): void;
  view(preset: ViewPreset): void;
  /** Start exactly at this top-down view (the footprint's), then fly into the 3D view. */
  flyFromTop(from: TopView): void;
  /** Fly to straight above (`to`, else the current point); resolves with that top-down view. */
  flyToTop(to?: TopView): Promise<TopView>;
  resize(width: number, height: number): void;
  dispose(): void;
}

/** A picture of a part from above: a data URL and clockwise quarter turns. */
export interface TopPicture {
  src: string;
  rot: 0 | 90 | 180 | 270;
}

/** A straight top-down view of the board: centre (mm, board coordinates) and visible height. */
export interface TopView {
  cx: number;
  cy: number;
  visH: number;
}

export interface BoardViewer {
  /** Keeps the camera when only the content changes (same board size). `mating`: draw where connectors are plugged from. */
  setBoard(board: BoardView, bodies: Map<string, Body3D>, opts?: { mating?: boolean }): void;
  view(preset: ViewPreset): void;
  /** Start exactly at this top-down view (the 2D view's), then fly into the 3D view. */
  flyFromTop(from: TopView): void;
  /** Fly back to straight above the current point; resolves with that top-down view. */
  flyToTop(): Promise<TopView>;
  resize(width: number, height: number): void;
  /** The view as it is now, as a PNG data URL on a transparent background (the design document's cover). */
  picture(): string;
  dispose(): void;
}

const THICKNESS = 1.6;
const CU = 0.035;

/** Geometry and materials shared by everything one viewer draws. */
export function resources() {
  return {
    unitBox: new THREE.BoxGeometry(1, 1, 1),
    ball: new THREE.SphereGeometry(1, 20, 14),
    cyl: new THREE.CylinderGeometry(1, 1, 1, 24),
    body: new THREE.MeshStandardMaterial({ color: 0x2e3137, roughness: 0.75, metalness: 0.05 }),
    lead: new THREE.MeshStandardMaterial({ color: 0xc9ccd2, roughness: 0.35, metalness: 0.75 }),
    mark: new THREE.MeshStandardMaterial({ color: 0x8a8e96, roughness: 0.9 }),
    pcb: new THREE.MeshStandardMaterial({ color: 0x1f6b3c, roughness: 0.55, metalness: 0.05 }),
    mask: new THREE.MeshStandardMaterial({ color: 0x1d5a33, roughness: 0.55, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
    cuUnderMask: new THREE.MeshStandardMaterial({ color: 0x2f7f4c, roughness: 0.5, metalness: 0.1 }),
    pad: new THREE.MeshStandardMaterial({ color: 0xd6aa55, roughness: 0.3, metalness: 0.85 }),
    hole: new THREE.MeshBasicMaterial({ color: 0x07090c }),
    barrel: new THREE.MeshStandardMaterial({ color: 0xd6aa55, roughness: 0.3, metalness: 0.85, side: THREE.DoubleSide }),
    edge: new THREE.MeshStandardMaterial({ color: 0xc9b98a, roughness: 0.8 }),
  };
}
export type Res = ReturnType<typeof resources>;

/**
 * Where a cut really clips: a hair (mm) into what the planes keep, too little to see. The slider and the
 * scripts like round numbers, and a face exactly on a plane would come and go pixel by pixel.
 */
export const clippingAt = (planes: THREE.Plane[]) => planes.map((p) => new THREE.Plane(p.normal, p.constant - 0.01));

/** A viewer core: renderer, lights, camera and orbit controls around one content group. */
export function viewerCore(canvas: HTMLCanvasElement, opts: { pixelRatio?: number; background?: number } = {}) {
  // (the stencil: the faces a section cuts, enclosure3d.ts)
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, stencil: true });
  renderer.setPixelRatio(opts.pixelRatio ?? Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  if (opts.background !== undefined) scene.background = new THREE.Color(opts.background);
  scene.add(new THREE.HemisphereLight(0xe8eefc, 0x1a1d24, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(-3, 6, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9fb4ff, 0.8);
  rim.position.set(4, 3, -5);
  scene.add(rim);
  const under = new THREE.DirectionalLight(0xd8e0ff, 1.1); // so undersides (BGA balls, bottom copper) are readable
  under.position.set(2, -6, 3);
  scene.add(under);

  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 1000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  controls.maxPolarAngle = Math.PI * 0.95;
  /** Drawn after the content, unlit and never cut by the clipping planes (a section's frame). */
  const overlay = new THREE.Scene();
  const render = () => {
    renderer.render(scene, camera);
    if (!overlay.children.some((o) => o.visible)) return;
    const planes = renderer.clippingPlanes;
    renderer.clippingPlanes = [];
    renderer.autoClear = false;
    renderer.render(overlay, camera);
    renderer.autoClear = true;
    renderer.clippingPlanes = planes;
  };
  controls.addEventListener('change', render);
  const res = resources();
  let group = new THREE.Group();
  scene.add(group);
  let radius = 10;
  /** The content hears of the clipping, to draw what a cut opens in it. */
  const tellClipping = () => (group.userData.clipped as ((planes: THREE.Plane[]) => void) | undefined)?.(renderer.clippingPlanes);

  function disposeGroup(g: THREE.Group) {
    g.traverse((o) => {
      (o.userData.dispose as (() => void) | undefined)?.();
      if (o instanceof THREE.InstancedMesh) o.dispose();
      // (keepGeometry: shared with later content, e.g. an enclosure piece parsed once)
      if (o instanceof THREE.Mesh && !o.userData.keepGeometry && ![res.unitBox, res.ball, res.cyl].includes(o.geometry as never)) o.geometry.dispose();
    });
  }

  let home = new THREE.Vector3(); // the content's centre: where the preset views look
  function presetPose(preset: ViewPreset) {
    const dist = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.08;
    const dir =
      preset === 'top' ? new THREE.Vector3(0, 1, 0.0001) :
      preset === 'bottom' ? new THREE.Vector3(0, -1, 0.0001) :
      preset === 'front' ? new THREE.Vector3(0, 0.25, 1) :
      preset === 'isoBelow' ? new THREE.Vector3(-0.55, -0.75, 0.9) : // the same corner, from underneath
      new THREE.Vector3(-0.55, 0.75, 0.9); // from the front left, above
    return { target: home.clone(), position: home.clone().addScaledVector(dir.normalize(), dist) };
  }
  /** Put the camera there; `free`: without the controls' zoom limits (a flight's poses). */
  function place(pose: { target: THREE.Vector3; position: THREE.Vector3 }, free = false) {
    controls.target.copy(pose.target);
    camera.position.copy(pose.position);
    camera.lookAt(controls.target);
    if (!free) controls.update();
    render();
  }
  function view(preset: ViewPreset) {
    stopFlight();
    place(presetPose(preset));
  }

  /*
   * Camera flights: target, distance and the angles around the target are eased from one pose to
   * the other (so the camera swings round the board instead of cutting through it).
   */
  let flight = 0;
  function stopFlight() {
    if (flight) cancelAnimationFrame(flight);
    flight = 0;
    controls.enabled = true;
  }
  function fly(to: { target: THREE.Vector3; position: THREE.Vector3 }, ms: number, settle = true): Promise<void> {
    stopFlight();
    const t0 = controls.target.clone();
    const s0 = new THREE.Spherical().setFromVector3(camera.position.clone().sub(t0));
    const s1 = new THREE.Spherical().setFromVector3(to.position.clone().sub(to.target));
    // the short way round
    let dTheta = s1.theta - s0.theta;
    if (dTheta > Math.PI) dTheta -= 2 * Math.PI;
    if (dTheta < -Math.PI) dTheta += 2 * Math.PI;
    const start = performance.now();
    controls.enabled = false;
    return new Promise((resolve) => {
      const step = (now: number) => {
        const u = Math.min(1, (now - start) / ms);
        const e = u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2; // ease in-out
        const target = t0.clone().lerp(to.target, e);
        const sph = new THREE.Spherical(Math.exp(Math.log(s0.radius) + (Math.log(s1.radius) - Math.log(s0.radius)) * e), s0.phi + (s1.phi - s0.phi) * e, s0.theta + dTheta * e);
        place({ target, position: target.clone().add(new THREE.Vector3().setFromSpherical(sph)) }, true);
        if (u < 1) flight = requestAnimationFrame(step);
        else {
          flight = 0;
          controls.enabled = true;
          if (settle) controls.update();
          resolve();
        }
      };
      flight = requestAnimationFrame(step);
    });
  }
  const tanHalf = () => Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  /** The camera straight above a board point (board surface at y = 0), showing `visH` mm of height. */
  function topPose(v: TopView) {
    const h = v.visH / (2 * tanHalf());
    const target = new THREE.Vector3(v.cx, 0, v.cy);
    // (a hair towards the front, so screen-up is the board's -y as in the 2D view)
    return { target, position: new THREE.Vector3(v.cx, h, v.cy + h * 1e-4) };
  }

  return {
    res,
    camera,
    overlay,
    /** Let the controls orbit, or not (while something in the view is dragged). */
    orbit(on: boolean) {
      controls.enabled = on;
    },
    /** Replace the content; refit the camera unless `keepView`. */
    setContent(next: THREE.Group, keepView = false) {
      scene.remove(group);
      disposeGroup(group);
      group = next;
      scene.add(group);
      if (!keepView) {
        const sphere = new THREE.Box3().setFromObject(group).getBoundingSphere(new THREE.Sphere());
        radius = Math.max(sphere.radius, 0.5);
        home = sphere.center.clone();
        controls.target.copy(sphere.center);
        controls.minDistance = radius * 0.3;
        controls.maxDistance = radius * 12;
        camera.near = radius / 100;
        camera.far = radius * 50;
        camera.updateProjectionMatrix();
      }
      // (after measuring: what a cut adds is not part of the content's size)
      tellClipping();
      if (!keepView) view('iso');
      else render();
    },
    view,
    redraw: render,
    flyFromTop(from: TopView) {
      place(topPose(from), true);
      void fly(presetPose('iso'), 900);
    },
    async flyToTop(to?: TopView): Promise<TopView> {
      const t = controls.target;
      const visH = 2 * camera.position.distanceTo(t) * tanHalf();
      const v = to ?? { cx: t.x, cy: t.z, visH };
      await fly(topPose(v), 700, false); // (the 2D view takes over from here)
      return v;
    },
    resize(width: number, height: number) {
      if (width < 1 || height < 1) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      render();
    },
    picture() {
      render(); // (the drawing buffer is only kept until the frame is shown)
      return canvas.toDataURL('image/png');
    },
    /** Cut the view: everything on the planes' negative sides is left out (a section). */
    clip(planes: THREE.Plane[]) {
      renderer.clippingPlanes = clippingAt(planes);
      tellClipping();
      render();
    },
    /** Look at `target` from `position` (the controls orbit round `target` from there). */
    pose(target: THREE.Vector3, position: THREE.Vector3) {
      stopFlight();
      place({ target, position });
    },
    dispose() {
      stopFlight();
      controls.removeEventListener('change', render);
      controls.dispose();
      disposeGroup(group);
      for (const v of Object.values(res)) (v as { dispose(): void }).dispose();
      renderer.dispose();
    },
  };
}

/** Silkscreen graphics of one side drawn into an alpha texture (white = ink), kept off pads and vias. */
/** An oval (a slotted hole, or the pad round it) of w × h round (cx, cy), as a polygon: half circles at the ends of its longer side. */
const oval = (cx: number, cy: number, w: number, h: number) => cutoutPolygon({ id: '', shape: 'slot', x: cx, y: cy, w: Math.max(w, h), h: Math.min(w, h), r: 0, angle: h > w ? 90 : 0 });

function polyPath<T extends THREE.Path>(pts: number[], path: T): T {
  path.moveTo(pts[0]!, pts[1]!);
  for (let i = 2; i < pts.length; i += 2) path.lineTo(pts[i]!, pts[i + 1]!);
  path.closePath();
  return path;
}

function polyFill(ctx: CanvasRenderingContext2D, pts: number[]) {
  ctx.beginPath();
  ctx.moveTo(pts[0]!, pts[1]!);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i]!, pts[i + 1]!);
  ctx.fill();
}

type Drill = { x: number; y: number; d: number; slot?: { w: number; h: number } };

function silkTexture(graphics: BoardView['graphics'], b: BoardView, side: 'top' | 'bottom'): THREE.CanvasTexture | null {
  const { w, h } = b.outline;
  const k = Math.min(25, 4096 / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(k, k);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  ctx.lineJoin = 'round';
  for (const g of graphics) {
    ctx.beginPath();
    for (const p of g.polys) {
      ctx.moveTo(p[0]!, p[1]!);
      for (let i = 2; i + 1 < p.length; i += 2) ctx.lineTo(p[i]!, p[i + 1]!);
      ctx.closePath();
    }
    if (g.mode === 'fill') ctx.fill('evenodd');
    else {
      ctx.lineWidth = g.line;
      ctx.stroke();
    }
  }
  // no ink on pads (with their clearance) or vias
  ctx.globalCompositeOperation = 'destination-out';
  const gap = 0.15;
  for (const part of b.parts) {
    for (const p of part.pads) {
      if (!p.drill && !p.npth && !p.layers.includes(side === 'top' ? 'F.Cu' : 'B.Cu')) continue;
      if (p.slot && p.npth) polyFill(ctx, oval(p.x, p.y, p.slot.w + 2 * gap, p.slot.h + 2 * gap));
      else if (p.shape === 'round' && p.w !== p.h && !p.npth) polyFill(ctx, oval(p.x, p.y, p.w + 2 * gap, p.h + 2 * gap));
      else if (p.shape === 'round' || p.npth) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, (p.npth ? p.drill! : Math.min(p.w, p.h)) / 2 + gap, 0, Math.PI * 2);
        ctx.fill();
      } else ctx.fillRect(p.x - p.w / 2 - gap, p.y - p.h / 2 - gap, p.w + 2 * gap, p.h + 2 * gap);
    }
  }
  for (const v of b.vias) {
    ctx.beginPath();
    ctx.arc(v.x, v.y, v.pad / 2 + gap, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  return tex;
}

/** A pour's exact shape drawn into an alpha texture (white = copper), ~25 px/mm. */
function zoneTexture(z: BoardView['zones'][number], w: number, h: number, drills: Drill[] = []): THREE.CanvasTexture | null {
  const k = Math.min(25, 4096 / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(k, k);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const stroke = (pts: number[], width: number) => {
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(pts[0]!, pts[1]!);
    for (let i = 2; i + 1 < pts.length; i += 2) ctx.lineTo(pts[i]!, pts[i + 1]!);
    if (pts.length === 2) ctx.lineTo(pts[0]! + 1e-3, pts[1]!);
    ctx.stroke();
  };
  if (z.shape) {
    const [x0, y0, x1, y1] = z.shape.outline;
    if (z.shape.clip) {
      // a shaped board: the pour fills the outline polygon
      const c = z.shape.clip;
      ctx.beginPath();
      ctx.moveTo(c[0]!, c[1]!);
      for (let i = 2; i < c.length; i += 2) ctx.lineTo(c[i]!, c[i + 1]!);
      ctx.closePath();
      ctx.fill();
    } else ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.globalCompositeOperation = 'destination-out';
    for (const c of z.shape.cuts) {
      if (c.k === 'circle') {
        ctx.beginPath();
        ctx.arc(c.x, c.y, c.d / 2, 0, Math.PI * 2);
        ctx.fill();
      } else if (c.k === 'rect') ctx.fillRect(c.x, c.y, c.w, c.h);
      else if (c.k === 'poly') polyFill(ctx, c.pts);
      else stroke(c.pts, c.w);
    }
    ctx.globalCompositeOperation = 'source-over';
    for (const a of z.shape.adds) stroke(a.pts, a.w);
  } else {
    for (let i = 0; i + 3 < z.rects.length; i += 4) ctx.fillRect(z.rects[i]!, z.rects[i + 1]!, z.rects[i + 2]!, z.rects[i + 3]!);
  }
  // no copper over a drilled hole
  ctx.globalCompositeOperation = 'destination-out';
  for (const d of drills) {
    if (d.slot) {
      polyFill(ctx, oval(d.x, d.y, d.slot.w, d.slot.h));
      continue;
    }
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.d / 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  return tex;
}

/** Meshes of one package body, in its own coordinates (origin = package centre, board surface at 0). */
function bodyGroup(body: Body3D, res: Res, mark = true, top?: TopPicture, redraw?: () => void): THREE.Group {
  const group = new THREE.Group();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  // a module with its picture: the picture shows its chips, the generic chip block goes
  const pictured = !!(top && body.board);
  for (const mat of ['body', 'lead', 'mark', 'pcb'] as const) {
    if (pictured && mat === 'body') continue;
    const boxes = body.boxes.filter((b) => b.mat === mat);
    if (!boxes.length) continue;
    const mesh = new THREE.InstancedMesh(res.unitBox, res[mat], boxes.length);
    boxes.forEach((b, i) => {
      const [x0, y0, z0] = b.min;
      const [x1, y1, z1] = b.max;
      m.compose(new THREE.Vector3((x0 + x1) / 2, (z0 + z1) / 2, (y0 + y1) / 2), q, new THREE.Vector3(Math.max(x1 - x0, 1e-4), Math.max(z1 - z0, 1e-4), Math.max(y1 - y0, 1e-4)));
      mesh.setMatrixAt(i, m);
    });
    group.add(mesh);
  }
  if (body.balls.length) {
    const mesh = new THREE.InstancedMesh(res.ball, res.lead, body.balls.length);
    body.balls.forEach((b, i) => {
      m.compose(new THREE.Vector3(b.c[0], b.c[2], b.c[1]), q, new THREE.Vector3(b.r, b.r * 0.85, b.r));
      mesh.setMatrixAt(i, m);
    });
    group.add(mesh);
  }
  // (a lying cylinder: its axis along x, turned from three's upright one)
  const lying = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  for (const mat of ['body', 'lead', 'mark'] as const) {
    const cyls = (body.cylinders ?? []).filter((c) => c.mat === mat);
    if (!cyls.length) continue;
    const mesh = new THREE.InstancedMesh(res.cyl, res[mat], cyls.length);
    cyls.forEach((c, i) => {
      if (c.lying) m.compose(new THREE.Vector3(c.x, c.z0, c.y), lying, new THREE.Vector3(c.r, c.lying, c.r));
      else m.compose(new THREE.Vector3(c.x, (c.z0 + c.z1) / 2, c.y), q, new THREE.Vector3(c.r, c.z1 - c.z0, c.r));
      mesh.setMatrixAt(i, m);
    });
    group.add(mesh);
  }
  if (body.board) {
    // a module's carrier board: drilled through, a copper ring round every hole, plated walls
    const { w, h, t, holes } = body.board;
    const plate = new THREE.Shape();
    plate.moveTo(-w / 2, -h / 2);
    plate.lineTo(w / 2, -h / 2);
    plate.lineTo(w / 2, h / 2);
    plate.lineTo(-w / 2, h / 2);
    plate.closePath();
    for (const hole of holes) {
      const path = new THREE.Path();
      path.absarc(hole.x, hole.y, hole.d / 2, 0, Math.PI * 2, true);
      plate.holes.push(path);
    }
    const geo = new THREE.ExtrudeGeometry(plate, { depth: t, bevelEnabled: false, curveSegments: 24 });
    geo.rotateX(Math.PI / 2); // (x, y) → (x, 0, y), t thick downwards
    const pcb = new THREE.Mesh(geo, [res.pcb, res.edge]);
    pcb.position.y = t;
    group.add(pcb);
    if (top) {
      // the picture on the top face (under the pads' rings), turned as the user set it
      const tex = new THREE.TextureLoader().load(top.src, () => redraw?.());
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.center.set(0.5, 0.5);
      tex.rotation = -(top.rot * Math.PI) / 180;
      tex.anisotropy = 4;
      const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
      const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      face.rotation.x = -Math.PI / 2; // facing up; the picture's top towards the board's −y
      face.position.y = t + 0.002;
      face.userData.dispose = () => {
        tex.dispose();
        mat.dispose();
      };
      group.add(face);
    }
    const rings = new Map<number, THREE.BufferGeometry>();
    for (const hole of holes) {
      let ring = rings.get(hole.d);
      if (!ring) {
        const r = new THREE.Shape();
        r.absarc(0, 0, hole.d / 2 + 0.4, 0, Math.PI * 2, false);
        const inner = new THREE.Path();
        inner.absarc(0, 0, hole.d / 2, 0, Math.PI * 2, true);
        r.holes.push(inner);
        ring = new THREE.ExtrudeGeometry(r, { depth: 0.03, bevelEnabled: false, curveSegments: 24 });
        ring.rotateX(Math.PI / 2);
        rings.set(hole.d, ring);
      }
      const top = new THREE.Mesh(ring, res.pad);
      top.position.set(hole.x, t + 0.03, hole.y);
      group.add(top);
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(hole.d / 2, hole.d / 2, t, 24, 1, true), res.barrel);
      barrel.position.set(hole.x, t / 2, hole.y);
      group.add(barrel);
    }
  }
  if (mark) {
    // the pin-1 dot (only where the orientation matters)
    const p = body.pin1;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(p.r, 24), res.mark);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(p.x, p.z + 0.002, p.y);
    group.add(disc);
  }
  return group;
}

/** The assembled board: substrate with solder mask, copper, holes and every part body. */
export function boardGroup(b: BoardView, bodies: Map<string, Body3D>, res: Res, redraw?: () => void): THREE.Group {
  const group = new THREE.Group();
  const { w, h } = b.outline;
  /*
   * The substrate: the outline extruded, with every drilled hole (mounting holes, through-hole
   * pads) cut through it. Caps get the solder mask, the outer edge and the hole walls bare FR4.
   * (Vias stay tented: covered by the mask, as usual.)
   */
  const drills: Drill[] = b.parts.flatMap((p) => p.pads.filter((q) => q.drill).map((q) => ({ x: q.x, y: q.y, d: q.drill!, ...(q.slot ? { slot: q.slot } : {}) })));
  const outline = new THREE.Shape();
  const ring = boardPolygon(b);
  outline.moveTo(ring[0]!, ring[1]!);
  for (let i = 2; i < ring.length; i += 2) outline.lineTo(ring[i]!, ring[i + 1]!);
  outline.closePath();
  // milled cutouts go through, like the holes
  for (const c of b.cutouts ?? []) {
    outline.holes.push(polyPath(cutoutPolygon(c), new THREE.Path()));
  }
  for (const d of drills) {
    if (d.slot) {
      outline.holes.push(polyPath(oval(d.x, d.y, d.slot.w, d.slot.h), new THREE.Path()));
      continue;
    }
    const hole = new THREE.Path();
    hole.absarc(d.x, d.y, d.d / 2, 0, Math.PI * 2, true);
    outline.holes.push(hole);
  }
  const substrate = new THREE.ExtrudeGeometry(outline, { depth: THICKNESS, bevelEnabled: false, curveSegments: 32 });
  substrate.rotateX(Math.PI / 2); // shape (x, y) → board (x, y): three (x, 0, y); thickness downwards
  const board = new THREE.Mesh(substrate, [res.mask, res.edge]);
  group.add(board);

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const surfaceY = (layer: string) => (layer === 'B.Cu' ? -THICKNESS - CU / 2 : CU / 2);
  const onBottom = (layer: string) => layer === 'B.Cu';
  const layerY = (layer: string) => (onBottom(layer) ? -THICKNESS : 0);

  /* pads (exposed copper) */
  const rects: THREE.Matrix4[] = [];
  const rounds: THREE.Matrix4[] = [];
  const holes: THREE.Matrix4[] = [];
  // drilled, plated pads: a copper ring (round or square) on both sides and a barrel through the hole
  const ringGeos = new Map<string, THREE.BufferGeometry>();
  const ringGeo = (p: (typeof b.parts)[number]['pads'][number]) => {
    const key = `${p.shape}/${p.w}/${p.h}/${p.drill}/${p.slot?.w}/${p.slot?.h}`;
    let geo = ringGeos.get(key);
    if (!geo) {
      let s2 = new THREE.Shape();
      if (p.shape === 'round' && p.w !== p.h) s2 = polyPath(oval(0, 0, p.w, p.h), s2);
      else if (p.shape === 'round') s2.absarc(0, 0, Math.min(p.w, p.h) / 2, 0, Math.PI * 2, false);
      else {
        s2.moveTo(-p.w / 2, -p.h / 2);
        s2.lineTo(p.w / 2, -p.h / 2);
        s2.lineTo(p.w / 2, p.h / 2);
        s2.lineTo(-p.w / 2, p.h / 2);
        s2.closePath();
      }
      if (p.slot) s2.holes.push(polyPath(oval(0, 0, p.slot.w, p.slot.h), new THREE.Path()));
      else s2.holes.push(new THREE.Path().absarc(0, 0, p.drill! / 2, 0, Math.PI * 2, true));
      geo = new THREE.ExtrudeGeometry(s2, { depth: CU, bevelEnabled: false, curveSegments: 32 });
      geo.rotateX(Math.PI / 2); // (x, y) → (x, 0, y), CU thick downwards
      ringGeos.set(key, geo);
    }
    return geo;
  };
  for (const part of b.parts) {
    for (const p of part.pads) {
      if (p.drill) {
        if (p.npth) continue; // a bare hole: cut into the substrate, no copper
        for (const top of [true, false]) {
          const ring = new THREE.Mesh(ringGeo(p), res.pad);
          ring.position.set(p.x, top ? CU : -THICKNESS, p.y);
          group.add(ring);
        }
        if (p.slot) {
          // a slot's plated wall: a thin oval ring through the board
          const wall = polyPath(oval(0, 0, p.slot.w, p.slot.h), new THREE.Shape());
          wall.holes.push(polyPath(oval(0, 0, p.slot.w - 0.05, p.slot.h - 0.05), new THREE.Path()));
          const geo = new THREE.ExtrudeGeometry(wall, { depth: THICKNESS, bevelEnabled: false });
          geo.rotateX(Math.PI / 2);
          const barrel = new THREE.Mesh(geo, res.barrel);
          barrel.position.set(p.x, 0, p.y);
          group.add(barrel);
          continue;
        }
        const barrel = new THREE.Mesh(new THREE.CylinderGeometry(p.drill / 2, p.drill / 2, THICKNESS, 32, 1, true), res.barrel);
        barrel.position.set(p.x, -THICKNESS / 2, p.y);
        group.add(barrel);
        continue;
      }
      for (const l of p.layers.filter((x) => x === 'F.Cu' || x === 'B.Cu')) {
        const y = surfaceY(l);
        const mm = new THREE.Matrix4();
        if (p.shape === 'round') rounds.push(mm.compose(new THREE.Vector3(p.x, y, p.y), q, new THREE.Vector3(Math.min(p.w, p.h) / 2, CU, Math.min(p.w, p.h) / 2)));
        else rects.push(mm.compose(new THREE.Vector3(p.x, y, p.y), q, new THREE.Vector3(p.w, CU, p.h)));
      }
    }
  }
  group.userData.dispose = () => ringGeos.forEach((g) => g.dispose());
  const instanced = (geo: THREE.BufferGeometry, mat: THREE.Material, list: THREE.Matrix4[]) => {
    if (!list.length) return;
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((mx, i) => mesh.setMatrixAt(i, mx));
    group.add(mesh);
  };
  instanced(res.unitBox, res.pad, rects);
  instanced(res.cyl, res.pad, rounds);

  /* tracks (under the solder mask) */
  const segs: THREE.Matrix4[] = [];
  const joints: THREE.Matrix4[] = [];
  for (const t of b.tracks) {
    if (t.layer !== 'F.Cu' && t.layer !== 'B.Cu') continue; // inner layers are hidden inside the board
    const y = surfaceY(t.layer);
    for (let i = 0; i + 3 < t.pts.length; i += 2) {
      const [ax, ay, bx, by] = [t.pts[i]!, t.pts[i + 1]!, t.pts[i + 2]!, t.pts[i + 3]!];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1e-6) continue;
      const rot = new THREE.Quaternion().setFromAxisAngle(up, -Math.atan2(by - ay, bx - ax));
      segs.push(new THREE.Matrix4().compose(new THREE.Vector3((ax + bx) / 2, y, (ay + by) / 2), rot, new THREE.Vector3(len, CU * 0.9, t.width)));
      // round joints so bends look continuous
      joints.push(new THREE.Matrix4().compose(new THREE.Vector3(bx, y, by), q, new THREE.Vector3(t.width / 2, CU * 0.9, t.width / 2)));
      if (i === 0) joints.push(new THREE.Matrix4().compose(new THREE.Vector3(ax, y, ay), q, new THREE.Vector3(t.width / 2, CU * 0.9, t.width / 2)));
    }
  }
  instanced(res.unitBox, res.cuUnderMask, segs);
  instanced(res.cyl, res.cuUnderMask, joints);

  /* copper pours (under the solder mask): the exact shape as a texture on a thin sheet */
  for (const z of b.zones) {
    if (z.layer !== 'F.Cu' && z.layer !== 'B.Cu') continue;
    const bottom = z.layer === 'B.Cu';
    const tex = zoneTexture(z, w, h, drills);
    if (!tex) continue;
    if (bottom) tex.flipY = false;
    const mat = new THREE.MeshStandardMaterial({ color: 0x2f7f4c, roughness: 0.5, metalness: 0.1, alphaMap: tex, alphaTest: 0.5, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    sheet.rotation.x = bottom ? Math.PI / 2 : -Math.PI / 2;
    // just outside the board surface, under the tracks
    sheet.position.set(w / 2, bottom ? -THICKNESS - CU * 0.3 : CU * 0.3, h / 2);
    sheet.userData.dispose = () => {
      tex.dispose();
      mat.dispose();
    };
    group.add(sheet);
  }

  /* silkscreen graphics (logos): white ink on the solder mask */
  for (const side of ['top', 'bottom'] as const) {
    const gs = (b.graphics ?? []).filter((g) => g.side === side);
    if (!gs.length) continue;
    const bottom = side === 'bottom';
    const tex = silkTexture(gs, b, side);
    if (!tex) continue;
    if (bottom) tex.flipY = false;
    const mat = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.8, metalness: 0, alphaMap: tex, alphaTest: 0.5, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    sheet.rotation.x = bottom ? Math.PI / 2 : -Math.PI / 2;
    // on the solder mask, above the tracks under it
    sheet.position.set(w / 2, bottom ? -THICKNESS - CU * 1.3 : CU * 1.3, h / 2);
    sheet.userData.dispose = () => {
      tex.dispose();
      mat.dispose();
    };
    group.add(sheet);
  }

  /* vias: tented rings on both sides, hole in the middle */
  const vias: THREE.Matrix4[] = [];
  for (const v of b.vias) {
    for (const l of ['F.Cu', 'B.Cu']) {
      vias.push(new THREE.Matrix4().compose(new THREE.Vector3(v.x, surfaceY(l), v.y), q, new THREE.Vector3(v.pad / 2, CU, v.pad / 2)));
      holes.push(new THREE.Matrix4().compose(new THREE.Vector3(v.x, layerY(l) + (onBottom(l) ? -CU - 0.002 : CU + 0.002), v.y), q, new THREE.Vector3(v.drill / 2, 0.001, v.drill / 2)));
    }
  }
  instanced(res.cyl, res.cuUnderMask, vias);
  instanced(res.cyl, res.hole, holes);

  /* parts */
  for (const part of b.parts) {
    const body = bodies.get(part.componentId);
    if (!body) continue;
    const g = bodyGroup(body, res, part.polarized, part.topImage, redraw);
    g.rotation.y = -(part.rot * Math.PI) / 180; // clockwise in the top view
    // on the bottom side: turned over about its vertical axis (as the footprint is mirrored), hanging below the board
    if (part.side === 'bottom') g.rotation.z = Math.PI;
    g.position.set(part.x, part.side === 'bottom' ? -THICKNESS - CU : CU, part.y);
    group.add(g);
  }
  return group;
}

export function createBodyViewer(canvas: HTMLCanvasElement): BodyViewer {
  const core = viewerCore(canvas);
  return {
    setBody: (body, top) => core.setContent(bodyGroup(body, core.res, true, top, core.redraw)),
    view: core.view,
    flyFromTop: core.flyFromTop,
    flyToTop: core.flyToTop,
    resize: core.resize,
    dispose: core.dispose,
  };
}

/**
 * Where the board's connectors are plugged from: a faint orange box from each mating face outwards,
 * as wide as the plug (the way the enclosure leaves clear), so a wrong face shows on the board.
 */
function matingMarks(b: BoardView): THREE.Group {
  const g = new THREE.Group();
  const owned: { dispose(): void }[] = [];
  const h = b.outline.h;
  // board coordinates (y up, underside at z = 0) → the viewer's (board top at y = 0, z = board y)
  const pt = (p: readonly number[]) => new THREE.Vector3(p[0]!, p[2]! - THICKNESS, h - p[1]!);
  const dir = (d: readonly number[]) => new THREE.Vector3(d[0]!, d[2]!, -d[1]!);
  const mat = new THREE.MeshBasicMaterial({ color: 0xff9a3c, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide });
  owned.push(mat);
  const len = 12;
  for (const p of enclosureFacts(b).parts) {
    const m = p.mating;
    if (!m) continue;
    const geo = new THREE.BoxGeometry(m.size[0], m.size[1], len);
    owned.push(geo);
    const box = new THREE.Mesh(geo, mat);
    box.matrixAutoUpdate = false;
    const d = dir(m.dir);
    box.matrix.makeBasis(dir(m.u), dir(m.v), d).setPosition(pt(m.origin).addScaledVector(d, len / 2));
    box.userData.keepGeometry = true;
    g.add(box);
  }
  g.userData.dispose = () => owned.forEach((x) => x.dispose());
  return g;
}

export function createBoardViewer(canvas: HTMLCanvasElement): BoardViewer {
  const core = viewerCore(canvas);
  let size = '';
  return {
    setBoard(board, bodies, opts = {}) {
      const key = `${board.outline.w}x${board.outline.h}`;
      const group = boardGroup(board, bodies, core.res, core.redraw);
      if (opts.mating) group.add(matingMarks(board));
      core.setContent(group, key === size);
      size = key;
    },
    view: core.view,
    flyFromTop: core.flyFromTop,
    flyToTop: core.flyToTop,
    resize: core.resize,
    picture: core.picture,
    dispose: core.dispose,
  };
}
