/**
 * three.js scene for a generated package body (Body3D from @tracewise/parts). Loaded on demand;
 * the board's 3D view will build its meshes from the same Body3D data.
 *
 * Body3D coordinates: millimetres, x right and y down as in the footprint's top view, z up.
 * three.js is y-up, so (x, y, z) → (x, z, y); a camera above, looking down, then shows the part
 * exactly like the footprint (pin 1 top left).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Body3D } from '@tracewise/parts';

export type ViewPreset = 'iso' | 'top' | 'bottom' | 'front';

export interface BodyViewer {
  setBody(body: Body3D): void;
  view(preset: ViewPreset): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

const COLORS = { body: 0x2e3137, lead: 0xc9ccd2, mark: 0x8a8e96 };

export function createBodyViewer(canvas: HTMLCanvasElement): BodyViewer {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xe8eefc, 0x1a1d24, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(-3, 6, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9fb4ff, 0.8);
  rim.position.set(4, 3, -5);
  scene.add(rim);
  const under = new THREE.DirectionalLight(0xd8e0ff, 1.1); // so the underside (BGA balls) is readable
  under.position.set(2, -6, 3);
  scene.add(under);

  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 1000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  controls.maxPolarAngle = Math.PI * 0.95; // allow a look underneath (BGA balls), not a full flip
  const render = () => renderer.render(scene, camera);
  controls.addEventListener('change', render);

  const mats = {
    body: new THREE.MeshStandardMaterial({ color: COLORS.body, roughness: 0.75, metalness: 0.05 }),
    lead: new THREE.MeshStandardMaterial({ color: COLORS.lead, roughness: 0.35, metalness: 0.75 }),
    mark: new THREE.MeshStandardMaterial({ color: COLORS.mark, roughness: 0.9 }),
  };
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const ballGeo = new THREE.SphereGeometry(1, 20, 14);
  let group = new THREE.Group();
  scene.add(group);
  let radius = 10;

  function clear() {
    scene.remove(group);
    group.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) o.dispose();
      if (o instanceof THREE.Mesh && o.geometry !== unitBox && o.geometry !== ballGeo) o.geometry.dispose();
    });
    group = new THREE.Group();
    scene.add(group);
  }

  function setBody(body: Body3D) {
    clear();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    // boxes, one instanced mesh per material (hundreds of leads are one draw call)
    for (const mat of ['body', 'lead', 'mark'] as const) {
      const boxes = body.boxes.filter((b) => b.mat === mat);
      if (!boxes.length) continue;
      const mesh = new THREE.InstancedMesh(unitBox, mats[mat], boxes.length);
      boxes.forEach((b, i) => {
        const [x0, y0, z0] = b.min;
        const [x1, y1, z1] = b.max;
        m.compose(
          new THREE.Vector3((x0 + x1) / 2, (z0 + z1) / 2, (y0 + y1) / 2),
          q,
          new THREE.Vector3(Math.max(x1 - x0, 1e-4), Math.max(z1 - z0, 1e-4), Math.max(y1 - y0, 1e-4)),
        );
        mesh.setMatrixAt(i, m);
      });
      group.add(mesh);
    }
    if (body.balls.length) {
      const mesh = new THREE.InstancedMesh(ballGeo, mats.lead, body.balls.length);
      body.balls.forEach((b, i) => {
        m.compose(new THREE.Vector3(b.c[0], b.c[2], b.c[1]), q, new THREE.Vector3(b.r, b.r * 0.85, b.r)); // slightly flattened
        mesh.setMatrixAt(i, m);
      });
      group.add(mesh);
    }
    // pin-1 mark: a shallow dimple disc on the top face
    const p = body.pin1;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(p.r, 24), mats.mark);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(p.x, p.z + 0.002, p.y);
    group.add(disc);

    const box = new THREE.Box3().setFromObject(group);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    radius = Math.max(sphere.radius, 0.5);
    controls.target.copy(sphere.center);
    controls.minDistance = radius * 0.6;
    controls.maxDistance = radius * 12;
    camera.near = radius / 100;
    camera.far = radius * 50;
    camera.updateProjectionMatrix();
    view('iso');
  }

  function view(preset: ViewPreset) {
    const dist = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.08;
    const dir =
      preset === 'top' ? new THREE.Vector3(0, 1, 0.0001) :
      preset === 'bottom' ? new THREE.Vector3(0, -1, 0.0001) :
      preset === 'front' ? new THREE.Vector3(0, 0.25, 1) :
      new THREE.Vector3(-0.55, 0.75, 0.9); // from the front left, above
    camera.position.copy(controls.target).addScaledVector(dir.normalize(), dist);
    camera.lookAt(controls.target);
    controls.update();
    render();
  }

  function resize(width: number, height: number) {
    if (width < 1 || height < 1) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    render();
  }

  return {
    setBody,
    view,
    resize,
    dispose() {
      controls.removeEventListener('change', render);
      controls.dispose();
      clear();
      unitBox.dispose();
      ballGeo.dispose();
      for (const mt of Object.values(mats)) mt.dispose();
      renderer.dispose();
    },
  };
}
