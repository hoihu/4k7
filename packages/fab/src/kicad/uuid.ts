/**
 * The UUIDs of a KiCad export, derived (UUID version 5, RFC 9562: SHA-1 of a namespace and a name)
 * from the design's name and an entity's id, so a second export of the same design writes the same
 * UUIDs, and differs only where the design does. No time and no randomness. See
 * docs/design/kicad-export.md §2.
 */

/** SHA-1 of bytes (FIPS 180-4); small, as the export runs in the browser as well as in Node. */
export function sha1(data: Uint8Array): Uint8Array {
  const len = data.length;
  const words = new Uint32Array((((len + 8) >> 6) + 1) * 16);
  for (let i = 0; i < len; i++) words[i >> 2]! |= data[i]! << (24 - (i % 4) * 8);
  words[len >> 2]! |= 0x80 << (24 - (len % 4) * 8);
  // the length in bits, in the last two words (only the low 32 bits are ever needed here)
  words[words.length - 1] = (len * 8) >>> 0;
  words[words.length - 2] = Math.floor((len * 8) / 0x100000000);
  let [h0, h1, h2, h3, h4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
  for (let blk = 0; blk < words.length; blk += 16) {
    for (let t = 0; t < 16; t++) w[t] = words[blk + t]!;
    for (let t = 16; t < 80; t++) w[t] = rotl(w[t - 3]! ^ w[t - 8]! ^ w[t - 14]! ^ w[t - 16]!, 1);
    let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
    for (let t = 0; t < 80; t++) {
      const [f, k] = t < 20 ? [(b & c) | (~b & d), 0x5a827999] : t < 40 ? [b ^ c ^ d, 0x6ed9eba1] : t < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const tmp = (rotl(a, 5) + f + e + k + w[t]!) >>> 0;
      [e, d, c, b, a] = [d, c, rotl(b, 30) >>> 0, a, tmp];
    }
    [h0, h1, h2, h3, h4] = [(h0 + a) >>> 0, (h1 + b) >>> 0, (h2 + c) >>> 0, (h3 + d) >>> 0, (h4 + e) >>> 0];
  }
  const out = new Uint8Array(20);
  [h0, h1, h2, h3, h4].forEach((h, i) => {
    out[4 * i] = h >>> 24;
    out[4 * i + 1] = (h >>> 16) & 0xff;
    out[4 * i + 2] = (h >>> 8) & 0xff;
    out[4 * i + 3] = h & 0xff;
  });
  return out;
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const bytesOf = (uuid: string) => Uint8Array.from(uuid.replace(/-/g, '').match(/../g)!.map((x) => parseInt(x, 16)));

/** A version 5 UUID of a name in a namespace (both as RFC 9562 says: the namespace's 16 bytes, then the name in UTF-8). */
export function uuidV5(namespace: string, name: string): string {
  const ns = bytesOf(namespace);
  const nm = new TextEncoder().encode(name);
  const data = new Uint8Array(ns.length + nm.length);
  data.set(ns);
  data.set(nm, ns.length);
  const h = sha1(data).slice(0, 16);
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const s = hex(h);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** RFC 9562's namespace for URLs. */
export const URL_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
/** The namespace of every UUID 4k7 writes into a KiCad file. */
export const KICAD_NAMESPACE = uuidV5(URL_NAMESPACE, 'https://4k7.dev/kicad-export');

/** The UUIDs of one export: of the design's name and an entity's id (`c_12`, `c_12/pad/0`, `track/GND/F.Cu/3`). */
export function uuidsFor(design: string): (id: string) => string {
  return (id) => uuidV5(KICAD_NAMESPACE, JSON.stringify([design, id]));
}
