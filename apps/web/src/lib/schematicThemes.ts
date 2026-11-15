/**
 * Colour themes for the schematic canvas (Settings → Appearance). "app" keeps the canvas in the app's light or dark
 * colours; every other theme sets the canvas's own CSS variables on its SVG, so the rest of the app is untouched.
 * Printing and the design document stay black on white (print.ts has its own stylesheet); the agent's renders of the
 * schematic show it in the theme the user sees.
 */

export type SchematicThemeId = 'app' | 'pale-yellow' | 'navy-cream' | 'green-black' | 'blueprint' | 'black-white';

/** What a theme colours. Optional ones fall back to a neighbour (frame → grid, ref → sym, label and supply → wire). */
export interface SchematicColors {
  /** Around the pages, and its dots. */
  canvas: string;
  grid: string;
  /** The page, and its border and title block. */
  paper: string;
  frame?: string;
  wire: string;
  /** Net names on labels; supply symbols and their names. */
  label?: string;
  supply?: string;
  /** Symbol outlines and pins, and the fill of filled bodies. */
  sym: string;
  symFill: string;
  /** Part names (R1); values and pin names; pin numbers and the title block's small print. */
  ref?: string;
  text: string;
  pinText: string;
  /** A symbol under the pointer. */
  hover: string;
  hoverFill: string;
  glow: string;
  /** Selection, the selected net, the agent's working area. */
  accent: string;
  /** No-connect marks. */
  noConnect: string;
}

export interface SchematicTheme {
  id: SchematicThemeId;
  label: string;
  hint: string;
  /** undefined: the app's own colours. */
  colors?: SchematicColors;
}

export const SCHEMATIC_THEMES: readonly SchematicTheme[] = [
  { id: 'app', label: 'Follow the app', hint: 'The app’s light or dark colours.' },
  {
    id: 'pale-yellow',
    label: 'Pale yellow',
    hint: 'Green wires, red symbols on pale yellow bodies, teal text, on warm white.',
    colors: {
      canvas: '#e4e2d9', grid: '#c4c0b2', paper: '#f5f4ef', frame: '#8a2b2b',
      wire: '#008400', label: '#1a1a1a', supply: '#840000',
      sym: '#840000', symFill: '#ffffc2', ref: '#006464', text: '#006464', pinText: '#a90000',
      hover: '#c80000', hoverFill: '#ffff9e', glow: 'rgba(200, 0, 0, .3)',
      accent: '#0b63ce', noConnect: '#0000c8',
    },
  },
  {
    id: 'navy-cream',
    label: 'Navy on cream',
    hint: 'Navy wires, dark red outlines on light yellow bodies, on cream paper.',
    colors: {
      canvas: '#d9d5c9', grid: '#bdb7a6', paper: '#fffcf0', frame: '#5c5544',
      wire: '#000080', label: '#000080', supply: '#800000',
      sym: '#800000', symFill: '#ffffb0', ref: '#000080', text: '#000000', pinText: '#333333',
      hover: '#c00000', hoverFill: '#ffff80', glow: 'rgba(160, 0, 0, .3)',
      accent: '#0a64d6', noConnect: '#c00000',
    },
  },
  {
    id: 'green-black',
    label: 'Green on black',
    hint: 'Green nets, dark red symbols, grey text, on black.',
    colors: {
      canvas: '#000000', grid: '#2a2a2a', paper: '#050505', frame: '#7a1f1f',
      wire: '#3cb43c', label: '#3cb43c', supply: '#3cb43c',
      sym: '#c43a3a', symFill: '#1c0808', ref: '#b4b4b4', text: '#b4b4b4', pinText: '#7d7d7d',
      hover: '#ff6a6a', hoverFill: '#2e0d0d', glow: 'rgba(255, 90, 90, .4)',
      accent: '#ffd23f', noConnect: '#4c7dff',
    },
  },
  {
    id: 'blueprint',
    label: 'Blueprint',
    hint: 'White lines on deep blue.',
    colors: {
      canvas: '#0b2447', grid: '#244a7f', paper: '#123666', frame: '#7fa3d6',
      wire: '#ffffff', label: '#ffffff', supply: '#ffffff',
      sym: '#dce9ff', symFill: '#1a4682', ref: '#ffffff', text: '#cfe0f7', pinText: '#8fb0dd',
      hover: '#ffffff', hoverFill: '#245499', glow: 'rgba(255, 255, 255, .35)',
      accent: '#ffcf4d', noConnect: '#ff8a7a',
    },
  },
  {
    id: 'black-white',
    label: 'Black on white',
    hint: 'As it prints.',
    colors: {
      canvas: '#d4d4d4', grid: '#b5b5b5', paper: '#ffffff', frame: '#000000',
      wire: '#000000', label: '#000000', supply: '#000000',
      sym: '#000000', symFill: '#f2f2f2', ref: '#000000', text: '#000000', pinText: '#555555',
      hover: '#2563eb', hoverFill: '#e6eeff', glow: 'rgba(37, 99, 235, .3)',
      accent: '#2563eb', noConnect: '#000000',
    },
  },
];

export function schematicTheme(id: string | undefined): SchematicTheme {
  return SCHEMATIC_THEMES.find((t) => t.id === id) ?? SCHEMATIC_THEMES[0]!;
}

/** The canvas variables a theme sets, as an inline style; '' for "app" (the app's variables apply). */
export function schematicThemeStyle(id: string | undefined): string {
  const c = schematicTheme(id).colors;
  if (!c) return '';
  const vars: Record<string, string> = {
    '--canvas': c.canvas,
    '--grid': c.grid,
    '--paper': c.paper,
    '--flag': c.paper,
    '--frame': c.frame ?? c.grid,
    '--wire': c.wire,
    '--label': c.label ?? c.wire,
    '--supply': c.supply ?? c.wire,
    '--sym': c.sym,
    '--sym-fill': c.symFill,
    '--ref': c.ref ?? c.sym,
    '--sch-txt': c.text,
    '--pin-txt': c.pinText,
    '--sym-hover': c.hover,
    '--sym-fill-hover': c.hoverFill,
    '--sym-glow': c.glow,
    '--accent': c.accent,
    '--nc': c.noConnect,
  };
  return Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';');
}
