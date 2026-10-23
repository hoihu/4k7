/**
 * Minimal stroke font for silkscreen text (refdes, text graphics): glyphs as polylines on a 4 × 6 grid,
 * baseline at y = 0, y up. Lower case is drawn as upper case.
 */
type Glyph = number[][][];

const O: Glyph = [[[1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 1], [3, 0], [1, 0]]];
const P: Glyph = [[[0, 0], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]]];

const GLYPHS: Record<string, Glyph> = {
  A: [[[0, 0], [0, 4], [2, 6], [4, 4], [4, 0]], [[0, 3], [4, 3]]],
  B: [[[0, 0], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]], [[3, 3], [4, 2], [4, 1], [3, 0], [0, 0]]],
  C: [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0], [3, 0], [4, 1]]],
  D: [[[0, 0], [0, 6], [3, 6], [4, 5], [4, 1], [3, 0], [0, 0]]],
  E: [[[4, 6], [0, 6], [0, 0], [4, 0]], [[0, 3], [3, 3]]],
  F: [[[4, 6], [0, 6], [0, 0]], [[0, 3], [3, 3]]],
  G: [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0], [3, 0], [4, 1], [4, 3], [2, 3]]],
  H: [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
  I: [[[1, 6], [3, 6]], [[2, 6], [2, 0]], [[1, 0], [3, 0]]],
  J: [[[4, 6], [4, 1], [3, 0], [1, 0], [0, 1]]],
  K: [[[0, 0], [0, 6]], [[4, 6], [0, 2]], [[1, 3], [4, 0]]],
  L: [[[0, 6], [0, 0], [4, 0]]],
  M: [[[0, 0], [0, 6], [2, 3], [4, 6], [4, 0]]],
  N: [[[0, 0], [0, 6], [4, 0], [4, 6]]],
  O,
  P,
  Q: [...O, [[2, 2], [4, 0]]],
  R: [...P, [[2, 3], [4, 0]]],
  S: [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 4], [1, 3], [3, 3], [4, 2], [4, 1], [3, 0], [1, 0], [0, 1]]],
  T: [[[0, 6], [4, 6]], [[2, 6], [2, 0]]],
  U: [[[0, 6], [0, 1], [1, 0], [3, 0], [4, 1], [4, 6]]],
  V: [[[0, 6], [2, 0], [4, 6]]],
  W: [[[0, 6], [1, 0], [2, 3], [3, 0], [4, 6]]],
  X: [[[0, 0], [4, 6]], [[0, 6], [4, 0]]],
  Y: [[[0, 6], [2, 3], [4, 6]], [[2, 3], [2, 0]]],
  Z: [[[0, 6], [4, 6], [0, 0], [4, 0]]],
  '0': [...O, [[0, 1], [4, 5]]],
  '1': [[[1, 5], [2, 6], [2, 0]], [[1, 0], [3, 0]]],
  '2': [[[0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [0, 0], [4, 0]]],
  '3': [[[0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3], [4, 2], [4, 1], [3, 0], [1, 0], [0, 1]], [[1, 3], [3, 3]]],
  '4': [[[3, 0], [3, 6], [0, 2], [4, 2]]],
  '5': [[[4, 6], [0, 6], [0, 3], [3, 3], [4, 2], [4, 1], [3, 0], [0, 0]]],
  '6': [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]]],
  '7': [[[0, 6], [4, 6], [1, 0]]],
  '8': [[[1, 3], [0, 4], [0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3], [1, 3], [0, 2], [0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [3, 3]]],
  '9': [[[4, 3], [1, 3], [0, 4], [0, 5], [1, 6], [3, 6], [4, 5], [4, 1], [3, 0], [1, 0]]],
  '-': [[[1, 3], [3, 3]]],
  '+': [[[1, 3], [3, 3]], [[2, 2], [2, 4]]],
  '.': [[[2, 0], [2, 0.5]]],
  '/': [[[0, 0], [4, 6]]],
  _: [[[0, 0], [4, 0]]],
  ':': [[[2, 1], [2, 1.5]], [[2, 4], [2, 4.5]]],
  ',': [[[2, 0.5], [1.5, -1]]],
  "'": [[[2, 6], [2, 4.5]]],
  '(': [[[3, 6], [2, 5], [2, 1], [3, 0]]],
  ')': [[[1, 6], [2, 5], [2, 1], [1, 0]]],
  '=': [[[1, 2], [3, 2]], [[1, 4], [3, 4]]],
  '<': [[[4, 5], [0, 3], [4, 1]]],
  '>': [[[0, 5], [4, 3], [0, 1]]],
  '!': [[[2, 6], [2, 2]], [[2, 0], [2, 0.5]]],
  '?': [[[0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [2, 3], [2, 2]], [[2, 0], [2, 0.5]]],
  '*': [[[2, 1], [2, 5]], [[0, 2], [4, 4]], [[0, 4], [4, 2]]],
};

/** Characters the font draws (lower case as upper case), besides space. */
export function unknownGlyphs(text: string): string[] {
  return [...new Set([...text.toUpperCase()].filter((ch) => ch !== ' ' && ch !== '\n' && !GLYPHS[ch]))];
}

const ADVANCE = 5.5;

/** Width of a text at a cap height, mm. */
export function textWidth(text: string, height: number): number {
  return text.length ? ((text.length - 1) * ADVANCE + 4) * (height / 6) : 0;
}

/**
 * Strokes of a text, centred on (cx, cy), in board coordinates (y down). Returns polylines.
 */
export function textStrokes(text: string, cx: number, cy: number, height: number): number[][] {
  const k = height / 6;
  const x0 = cx - textWidth(text, height) / 2;
  const out: number[][] = [];
  [...text.toUpperCase()].forEach((ch, i) => {
    for (const line of GLYPHS[ch] ?? []) {
      out.push(line.flatMap(([gx, gy]) => [x0 + (i * ADVANCE + gx!) * k, cy + height / 2 - gy! * k]));
    }
  });
  return out;
}

/**
 * Text as silkscreen outline figures (lines centred on 0, 0, one below the other, y down): each
 * stroke goes out and back, so drawn as a closed outline with the line width it is the stroke.
 * Mirrored for the bottom side, so it reads from below.
 */
export function textFigures(text: string, height: number, mirror = false): number[][] {
  const lines = text.split('\n');
  const pitch = height * 1.6;
  return lines.flatMap((line, i) =>
    textStrokes(line, 0, (i - (lines.length - 1) / 2) * pitch, height).map((s) => {
      const back: number[] = [];
      for (let j = s.length - 4; j >= 0; j -= 2) back.push(s[j]!, s[j + 1]!);
      const loop = [...s, ...back.slice(0, -2)];
      return mirror ? loop.map((v, j) => (j % 2 === 0 ? -v : v)) : loop;
    }),
  );
}
