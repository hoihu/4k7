/** The part of opentype.js the script's text() uses (its own .mjs build: the package has no types and no exports map). */
declare module 'opentype.js/dist/opentype.mjs' {
  interface PathCommand {
    type: string;
    x?: number;
    y?: number;
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
  }
  interface Glyph {
    advanceWidth?: number;
    getPath(x: number, y: number, fontSize: number): { commands: PathCommand[] };
  }
  interface Font {
    unitsPerEm: number;
    tables: { os2?: { sCapHeight?: number } };
    stringToGlyphs(text: string): Glyph[];
    getKerningValue(left: Glyph, right: Glyph): number;
  }
  export function parse(data: ArrayBuffer): Font;
}
