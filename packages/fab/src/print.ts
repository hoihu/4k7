/**
 * The enclosure's pieces for printing (docs/design/enclosure.md §5.2, §6): turned the way the
 * script says (`print = [["lid", [180, 0, 0]]];`), set on the bed, laid out on one plate as 3MF;
 * and what the pieces say about printing: overhangs that need supports, ceilings too wide to
 * bridge, walls too thin to print.
 */
import { zip } from './zip.ts';

/** Triangles as a flat list: 9 numbers each (three corners). */
export type Tris = Float32Array;

/** A binary STL (base64 or bytes) as triangles. */
export function parseStl(data: string | Uint8Array): Tris {
  const bytes = typeof data === 'string' ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) : data;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = bytes.byteLength >= 84 ? view.getUint32(80, true) : 0;
  const out = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) {
    const at = 84 + i * 50 + 12; // (the face normal first: recomputed from the corners)
    for (let k = 0; k < 9; k++) out[i * 9 + k] = view.getFloat32(at + k * 4, true);
  }
  return out;
}

/** Triangles as a binary STL. */
export function writeStl(t: Tris, name = 'piece'): Uint8Array {
  const n = t.length / 9;
  const bytes = new Uint8Array(84 + n * 50);
  const view = new DataView(bytes.buffer);
  const head = `4k7 ${name}`.slice(0, 79);
  for (let i = 0; i < head.length; i++) bytes[i] = head.charCodeAt(i) & 0x7f;
  view.setUint32(80, n, true);
  for (let i = 0; i < n; i++) {
    const [nx, ny, nz] = normal(t, i);
    const at = 84 + i * 50;
    view.setFloat32(at, nx, true);
    view.setFloat32(at + 4, ny, true);
    view.setFloat32(at + 8, nz, true);
    for (let k = 0; k < 9; k++) view.setFloat32(at + 12 + k * 4, t[i * 9 + k]!, true);
  }
  return bytes;
}

function normal(t: Tris, i: number): [number, number, number] {
  const o = i * 9;
  const ux = t[o + 3]! - t[o]!, uy = t[o + 4]! - t[o + 1]!, uz = t[o + 5]! - t[o + 2]!;
  const vx = t[o + 6]! - t[o]!, vy = t[o + 7]! - t[o + 1]!, vz = t[o + 8]! - t[o + 2]!;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

function area(t: Tris, i: number): number {
  const o = i * 9;
  const ux = t[o + 3]! - t[o]!, uy = t[o + 4]! - t[o + 1]!, uz = t[o + 5]! - t[o + 2]!;
  const vx = t[o + 6]! - t[o]!, vy = t[o + 7]! - t[o + 1]!, vz = t[o + 8]! - t[o + 2]!;
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
}

export function bounds(t: Tris): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < t.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, t[i + k]!);
      max[k] = Math.max(max[k]!, t[i + k]!);
    }
  }
  return { min, max };
}

/**
 * Turned as OpenSCAD's rotate([x, y, z]) turns (about x, then y, then z; degrees), then set on the
 * bed: its lowest point at z = 0, centred on x = 0, y = 0.
 */
export function orient(t: Tris, rot: [number, number, number] = [0, 0, 0]): Tris {
  const [a, b, c] = rot.map((d) => (d * Math.PI) / 180) as [number, number, number];
  const [ca, sa, cb, sb, cc, sc] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b), Math.cos(c), Math.sin(c)];
  // Rz(c) · Ry(b) · Rx(a)
  const m = [
    cc * cb, cc * sb * sa - sc * ca, cc * sb * ca + sc * sa,
    sc * cb, sc * sb * sa + cc * ca, sc * sb * ca - cc * sa,
    -sb, cb * sa, cb * ca,
  ];
  const out = new Float32Array(t.length);
  for (let i = 0; i < t.length; i += 3) {
    const [x, y, z] = [t[i]!, t[i + 1]!, t[i + 2]!];
    out[i] = m[0]! * x + m[1]! * y + m[2]! * z;
    out[i + 1] = m[3]! * x + m[4]! * y + m[5]! * z;
    out[i + 2] = m[6]! * x + m[7]! * y + m[8]! * z;
  }
  const b0 = bounds(out);
  const dx = -(b0.min[0] + b0.max[0]) / 2, dy = -(b0.min[1] + b0.max[1]) / 2, dz = -b0.min[2];
  for (let i = 0; i < out.length; i += 3) {
    out[i] = out[i]! + dx;
    out[i + 1] = out[i + 1]! + dy;
    out[i + 2] = out[i + 2]! + dz;
  }
  return out;
}

/** The pieces on one plate: side by side along x, `gap` apart, the plate centred on 0, 0. */
export function plate(pieces: { name: string; tris: Tris }[], gap = 8): { name: string; tris: Tris }[] {
  const widths = pieces.map((p) => {
    const b = bounds(p.tris);
    return b.max[0] - b.min[0];
  });
  const total = widths.reduce((s, w) => s + w, 0) + gap * Math.max(0, pieces.length - 1);
  let x = -total / 2;
  return pieces.map((p, i) => {
    const shift = x + widths[i]! / 2; // each piece is centred on 0 by orient
    x += widths[i]! + gap;
    const out = Float32Array.from(p.tris);
    for (let k = 0; k < out.length; k += 3) out[k] = out[k]! + shift;
    return { name: p.name, tris: out };
  });
}

/** A 3MF file (the slicers' format: one object per piece, millimetres) as bytes. */
export function threeMf(pieces: { name: string; tris: Tris }[], title = 'enclosure'): Uint8Array {
  const esc = (s: string) => s.replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[ch]!);
  const objects: string[] = [];
  const items: string[] = [];
  pieces.forEach((p, idx) => {
    // shared corners once: 3MF meshes are indexed
    const index = new Map<string, number>();
    const verts: string[] = [];
    const tris: string[] = [];
    const vid = (k: number) => {
      const x = p.tris[k]!, y = p.tris[k + 1]!, z = p.tris[k + 2]!;
      const key = `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
      let id = index.get(key);
      if (id === undefined) {
        id = verts.length;
        index.set(key, id);
        verts.push(`<vertex x="${+x.toFixed(4)}" y="${+y.toFixed(4)}" z="${+z.toFixed(4)}"/>`);
      }
      return id;
    };
    for (let i = 0; i < p.tris.length; i += 9) {
      const [a, b, c] = [vid(i), vid(i + 3), vid(i + 6)];
      if (a !== b && b !== c && a !== c) tris.push(`<triangle v1="${a}" v2="${b}" v3="${c}"/>`);
    }
    const id = idx + 1;
    objects.push(`<object id="${id}" name="${esc(p.name)}" type="model"><mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh></object>`);
    items.push(`<item objectid="${id}"/>`);
  });
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Title">${esc(title)}</metadata>
<metadata name="Application">4k7</metadata>
<resources>${objects.join('')}</resources>
<build>${items.join('')}</build>
</model>
`;
  const files: { name: string; content: string }[] = [
    { name: '[Content_Types].xml', content: `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>\n` },
    { name: '_rels/.rels', content: `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>\n` },
    { name: '3D/3dmodel.model', content: model },
  ];
  return zip(files);
}

/* ------------------------------ printability ------------------------------ */

export interface PrintIssue {
  kind: 'overhang' | 'bridge' | 'thin';
  /** Area concerned (mm²). */
  area: number;
  /** Bridge: its span (mm); thin: the thinnest wall found (mm). */
  size?: number;
  /** Where, in the piece's own (assembled) coordinates. */
  box: { min: [number, number, number]; max: [number, number, number] };
}

/** Steeper than this from vertical needs supports. */
const OVERHANG_DEG = 45;
/** Wider than this, a ceiling with nothing under it sags. */
const BRIDGE_MM = 20;
/** Thinner than two perimeters of a 0.4 mm nozzle. */
const THIN_MM = 0.8;

/**
 * Overhangs and bridges of a piece as it is printed (`printed`: oriented, on the bed), reported in
 * its assembled coordinates (`assembled`: the same triangles before turning).
 */
export function printIssues(assembled: Tris, printed: Tris): PrintIssue[] {
  const issues: PrintIssue[] = [];
  const n = printed.length / 9;
  const lim = -Math.cos(((90 - OVERHANG_DEG) * Math.PI) / 180) - 1e-3; // normal z below this faces down too steeply
  const steep: number[] = [];
  const flat: number[] = [];
  for (let i = 0; i < n; i++) {
    const o = i * 9;
    const zmax = Math.max(printed[o + 2]!, printed[o + 5]!, printed[o + 8]!);
    if (zmax < 0.05) continue; // lies on the bed
    const nz = normal(printed, i)[2];
    if (nz < -0.999) flat.push(i);
    else if (nz < lim) steep.push(i);
  }
  const boxOf = (ids: number[]) => {
    const t = new Float32Array(ids.length * 9);
    ids.forEach((id, k) => t.set(assembled.subarray(id * 9, id * 9 + 9), k * 9));
    return bounds(t);
  };
  // the overhangs, by connected patch
  for (const g of patches(printed, steep)) {
    const a = g.reduce((s, i) => s + area(printed, i), 0);
    if (a >= 4) issues.push({ kind: 'overhang', area: Math.round(a), box: boxOf(g) });
  }
  // ceilings: what each flat patch has to bridge is its narrow side: the narrower of its box and
  // 4 × area / perimeter (a square's side, twice a ledge's width, so a thin ring round a box is no ceiling)
  for (const g of patches(printed, flat)) {
    const b = bounds(Float32Array.from(g.flatMap((i) => [...printed.subarray(i * 9, i * 9 + 9)])));
    const a = g.reduce((s, i) => s + area(printed, i), 0);
    const span = Math.min(b.max[0] - b.min[0], b.max[1] - b.min[1], (4 * a) / Math.max(perimeter(printed, g), 1e-6));
    if (span > BRIDGE_MM) issues.push({ kind: 'bridge', area: Math.round(a), size: Math.round(span * 10) / 10, box: boxOf(g) });
  }
  return issues;
}

/** Length of a patch's outline: the edges only one of its triangles has. */
function perimeter(t: Tris, ids: number[]): number {
  const corner = (i: number, c: number) => {
    const o = i * 9 + c * 3;
    return `${t[o]!.toFixed(3)},${t[o + 1]!.toFixed(3)},${t[o + 2]!.toFixed(3)}`;
  };
  const edges = new Map<string, { n: number; len: number }>();
  for (const i of ids) {
    for (let c = 0; c < 3; c++) {
      const [p, q] = [corner(i, c), corner(i, (c + 1) % 3)];
      const key = p < q ? `${p}|${q}` : `${q}|${p}`;
      const e = edges.get(key);
      if (e) e.n++;
      else {
        const [o1, o2] = [i * 9 + c * 3, i * 9 + ((c + 1) % 3) * 3];
        edges.set(key, { n: 1, len: Math.hypot(t[o1]! - t[o2]!, t[o1 + 1]! - t[o2 + 1]!, t[o1 + 2]! - t[o2 + 2]!) });
      }
    }
  }
  let sum = 0;
  for (const e of edges.values()) if (e.n === 1) sum += e.len;
  return sum;
}

/** Triangles of `ids` grouped by shared corners (connected patches). */
function patches(t: Tris, ids: number[]): number[][] {
  const parent = new Map<number, number>(ids.map((i) => [i, i]));
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const byCorner = new Map<string, number>();
  for (const i of ids) {
    for (let c = 0; c < 3; c++) {
      const o = i * 9 + c * 3;
      const key = `${t[o]!.toFixed(3)},${t[o + 1]!.toFixed(3)},${t[o + 2]!.toFixed(3)}`;
      const j = byCorner.get(key);
      if (j === undefined) byCorner.set(key, i);
      else parent.set(find(i), find(j));
    }
  }
  const groups = new Map<number, number[]>();
  for (const i of ids) {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), i]);
  }
  return [...groups.values()];
}

/**
 * Walls thinner than `min` mm: from the middle of each face, a short ray into the material; where it
 * comes out again within `min`, the wall there is that thin. A grid of the triangles keeps it local.
 */
export function thinWalls(t: Tris, min = THIN_MM): PrintIssue[] {
  const n = t.length / 9;
  if (!n) return [];
  const cell = 2;
  const b = bounds(t);
  const key = (x: number, y: number, z: number) => `${Math.floor((x - b.min[0]) / cell)},${Math.floor((y - b.min[1]) / cell)},${Math.floor((z - b.min[2]) / cell)}`;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const o = i * 9;
    const lo = [0, 1, 2].map((k) => Math.min(t[o + k]!, t[o + 3 + k]!, t[o + 6 + k]!));
    const hi = [0, 1, 2].map((k) => Math.max(t[o + k]!, t[o + 3 + k]!, t[o + 6 + k]!));
    for (let x = Math.floor((lo[0]! - b.min[0]) / cell); x <= Math.floor((hi[0]! - b.min[0]) / cell); x++)
      for (let y = Math.floor((lo[1]! - b.min[1]) / cell); y <= Math.floor((hi[1]! - b.min[1]) / cell); y++)
        for (let z = Math.floor((lo[2]! - b.min[2]) / cell); z <= Math.floor((hi[2]! - b.min[2]) / cell); z++) {
          const k = `${x},${y},${z}`;
          const list = grid.get(k);
          if (list) list.push(i);
          else grid.set(k, [i]);
        }
  }
  const thin: { i: number; d: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = area(t, i);
    if (a < 0.05) continue; // slivers say little
    const o = i * 9;
    const c = [0, 1, 2].map((k) => (t[o + k]! + t[o + 3 + k]! + t[o + 6 + k]!) / 3) as [number, number, number];
    const nn = normal(t, i);
    const d: [number, number, number] = [-nn[0], -nn[1], -nn[2]];
    const start: [number, number, number] = [c[0] + d[0] * 1e-3, c[1] + d[1] * 1e-3, c[2] + d[2] * 1e-3];
    const near = new Set<number>();
    for (const s of [0, min / 2, min]) {
      const p = [start[0] + d[0] * s, start[1] + d[1] * s, start[2] + d[2] * s];
      for (const j of grid.get(key(p[0]!, p[1]!, p[2]!)) ?? []) near.add(j);
    }
    let best = Infinity;
    for (const j of near) {
      if (j === i) continue;
      const h = hit(start, d, t, j);
      if (h !== null && h < best) best = h;
    }
    if (best < min) thin.push({ i, d: best + 1e-3 });
  }
  if (!thin.length) return [];
  // the faces of one thin wall (its two sides) are separate patches: one finding for patches this close
  const groups = patches(t, thin.map((x) => x.i)).map((g) => ({ g, b: bounds(Float32Array.from(g.flatMap((i) => [...t.subarray(i * 9, i * 9 + 9)]))) }));
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const [a, c] = [groups[i]!.b, groups[j]!.b];
      if ([0, 1, 2].every((k) => a.min[k]! <= c.max[k]! + min && c.min[k]! <= a.max[k]! + min)) {
        groups[i] = { g: [...groups[i]!.g, ...groups[j]!.g], b: { min: a.min.map((v, k) => Math.min(v, c.min[k]!)) as [number, number, number], max: a.max.map((v, k) => Math.max(v, c.max[k]!)) as [number, number, number] } };
        groups.splice(j, 1);
        j = i;
      }
    }
  }
  const out: PrintIssue[] = [];
  for (const { g } of groups) {
    const a = g.reduce((s, i) => s + area(t, i), 0);
    if (a < 2) continue;
    const ids = new Set(g);
    const thinnest = Math.min(...thin.filter((x) => ids.has(x.i)).map((x) => x.d));
    const tt = new Float32Array(g.length * 9);
    g.forEach((id, k) => tt.set(t.subarray(id * 9, id * 9 + 9), k * 9));
    out.push({ kind: 'thin', area: Math.round(a), size: Math.round(thinnest * 100) / 100, box: bounds(tt) });
  }
  return out;
}

/** Möller–Trumbore: distance along the ray to triangle j, or null. */
function hit(o: [number, number, number], d: [number, number, number], t: Tris, j: number): number | null {
  const q = j * 9;
  const e1 = [t[q + 3]! - t[q]!, t[q + 4]! - t[q + 1]!, t[q + 5]! - t[q + 2]!];
  const e2 = [t[q + 6]! - t[q]!, t[q + 7]! - t[q + 1]!, t[q + 8]! - t[q + 2]!];
  const p = [d[1] * e2[2]! - d[2] * e2[1]!, d[2] * e2[0]! - d[0] * e2[2]!, d[0] * e2[1]! - d[1] * e2[0]!];
  const det = e1[0]! * p[0]! + e1[1]! * p[1]! + e1[2]! * p[2]!;
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const s = [o[0] - t[q]!, o[1] - t[q + 1]!, o[2] - t[q + 2]!];
  const u = (s[0]! * p[0]! + s[1]! * p[1]! + s[2]! * p[2]!) * inv;
  if (u < -1e-6 || u > 1 + 1e-6) return null;
  const qq = [s[1]! * e1[2]! - s[2]! * e1[1]!, s[2]! * e1[0]! - s[0]! * e1[2]!, s[0]! * e1[1]! - s[1]! * e1[0]!];
  const v = (d[0] * qq[0]! + d[1] * qq[1]! + d[2] * qq[2]!) * inv;
  if (v < -1e-6 || u + v > 1 + 1e-6) return null;
  const dist = (e2[0]! * qq[0]! + e2[1]! * qq[1]! + e2[2]! * qq[2]!) * inv;
  return dist > 0 ? dist : null;
}
