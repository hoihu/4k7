import { describe, expect, it } from 'vitest';
import { SCHEMATIC_THEMES, schematicTheme, schematicThemeStyle } from '../src/lib/schematicThemes.ts';

/** WCAG relative luminance of a #rrggbb colour. */
function lum(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

describe('schematic themes', () => {
  it('"app" and unknown ids leave the app colours', () => {
    expect(schematicThemeStyle('app')).toBe('');
    expect(schematicThemeStyle(undefined)).toBe('');
    expect(schematicTheme('gone').id).toBe('app');
  });

  it('every theme sets the canvas variables', () => {
    for (const t of SCHEMATIC_THEMES.filter((t) => t.colors)) {
      const s = schematicThemeStyle(t.id);
      for (const v of ['--canvas', '--paper', '--wire', '--sym', '--sym-fill', '--sch-txt', '--ref', '--label', '--supply', '--frame', '--accent']) expect(s).toContain(`${v}:`);
    }
  });

  it('wires, symbols and text read on the paper', () => {
    for (const t of SCHEMATIC_THEMES) {
      const c = t.colors;
      if (!c) continue;
      for (const [what, col] of Object.entries({ wire: c.wire, sym: c.sym, text: c.text, ref: c.ref ?? c.sym, label: c.label ?? c.wire })) {
        expect(contrast(col, c.paper), `${t.id} ${what}`).toBeGreaterThan(3);
      }
      expect(contrast(c.text, c.symFill), `${t.id} text on a filled body`).toBeGreaterThan(3);
    }
  });
});
