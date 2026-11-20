/**
 * The layout view's current heat map (Layout → layers → Current · heat map): how the copper of the
 * routed board is drawn against its nets' current, from BoardView.current (the kernel's current
 * check, the same numbers as the DRC and get_current_map). See docs/design/layout.md §14 and
 * docs/design/ui.md.
 *
 * Colours follow the estimated heating against the allowed rise (set_board current_rise_c). Copper
 * whose current is known is drawn solid: it carries the net's whole max_current (bound), or its
 * share of the stated loads (split, over or not). Copper that may not carry what it is checked for
 * (unverified) is dashed in its colour, and a power net without max_current (unknown) is grey and
 * dashed: never the cool end of the scale. Dashes, not pattern fills: they survive the PNG snapshot.
 */
import type { BoardView, Diagnostic } from '@4k7/schema';

/** The findings that turn the heat map on by themselves while one is open. */
export const CURRENT_CODES = ['DRC.CURRENT_UNVERIFIED', 'DRC.VIA_CURRENT', 'DRC.CURRENT_UNKNOWN', 'DRC.TRACK_CURRENT', 'DRC.IR_DROP'];

/** The scale: estimated heating as a share of the allowed rise, cool to hot. */
export const HEAT = [
  { upTo: 0.25, colour: '#3987e5', label: '< ¼' },
  { upTo: 0.5, colour: '#3fb39a', label: '¼–½' },
  { upTo: 1, colour: '#e8d04a', label: '½–1×' },
  { upTo: 2, colour: '#f5902a', label: '1–2×' },
  { upTo: Infinity, colour: '#e0303c', label: '> 2×' },
] as const;
/** Copper whose current is unknown. */
export const UNKNOWN_COLOUR = '#8a9099';

/** The bucket (0 coolest … 4 hottest) of an estimated heating `riseC` against the allowed `allowedC`. */
export function heatBucket(riseC: number, allowedC: number): number {
  const r = riseC / allowedC;
  return HEAT.findIndex((h) => r <= h.upTo);
}

/**
 * Whether the heat map is on: forced for one picture (get_board_image overlay), else the user's
 * choice in this session, else on while a current finding is open.
 */
export function currentOverlayOn(diagnostics: readonly Diagnostic[], user: boolean | null, force: 'current' | 'none' | null = null): boolean {
  if (force) return force === 'current';
  if (user !== null) return user;
  return diagnostics.some((d) => !d.waivedBy && CURRENT_CODES.includes(d.code));
}

export interface HeatStyle {
  colour: string;
  dashed: boolean;
  title: string;
}

const n2 = (v: number) => `${Math.round(v * 100) / 100}`;

/** How the heat map draws the copper: tracks by index into BoardView.tracks, the nets whose current is unknown, and the via groups checked. */
export function currentLayer(b: BoardView): { tracks: Map<number, HeatStyle>; unknown: Set<string>; vias: (HeatStyle & { x: number; y: number; r: number; count: number })[] } | null {
  const c = b.current;
  if (!c) return null;
  const name = (id: string) => b.netNames[id] ?? id;
  const unknown = new Set(c.nets.filter((n) => n.status === 'unknown').map((n) => n.netId));
  const tracks = new Map<number, HeatStyle>();
  for (const t of c.tracks) {
    // (bound: the net's whole current; over the capacity, whether that much flows here is not known.
    // split: its share of the stated loads, known: solid even when over)
    const unverified = t.status === 'unverified';
    const drop = t.dropMv !== undefined ? ` · drop ${n2(t.dropMv)} mV` : '';
    const head = `${name(t.netId)} · ${t.width} mm · ${t.copperUm} µm · ${n2(t.amps)} A (${t.basis}${unverified ? '?' : ''}) · needs ${t.needs} mm · ≈ +${Math.round(t.rise)} °C${drop}`;
    tracks.set(t.index, { colour: HEAT[heatBucket(t.rise, c.riseC)]!.colour, dashed: unverified, title: unverified ? `${head} · ? whether ${n2(t.amps)} A flows here is not known` : head });
  }
  b.tracks.forEach((t, i) => {
    if (unknown.has(t.netId)) tracks.set(i, { colour: UNKNOWN_COLOUR, dashed: true, title: `${name(t.netId)} · ${t.width} mm · ${c.copperUm[t.layer] ?? 35} µm · current unknown (no max_current)` });
  });
  const vias = c.vias.map((v) => {
    // the same curve's exponent: heating grows as the ratio to the power 1/0.44
    const rise = c.riseC * Math.pow(v.ratio, 1 / 0.44);
    const unverified = v.status === 'unverified';
    const near = b.vias.filter((x) => x.netId === v.netId && Math.hypot(x.x - v.at.x, x.y - v.at.y) < 3);
    const r = Math.max(0.5, ...near.map((x) => Math.hypot(x.x - v.at.x, x.y - v.at.y) + x.pad / 2)) + 0.25;
    const head = `${name(v.netId)} · ${v.vias} via${v.vias === 1 ? '' : 's'}, ${v.drill} mm drill · ${n2(v.amps)} A (${v.basis}${unverified ? '?' : ''}) · carry ${n2(v.capacity)} A · needs ${v.needs} · ≈ +${Math.round(rise)} °C`;
    return { x: v.at.x, y: v.at.y, r, count: v.vias, colour: HEAT[heatBucket(rise, c.riseC)]!.colour, dashed: unverified, title: unverified ? `${head} · ? the only way between ${v.layers.join(' and ')}: whether ${n2(v.amps)} A crosses here is not known` : v.shared ? `${head} · its share (another way across)` : head };
  });
  return { tracks, unknown, vias };
}

/** What a board picture with the heat map shows, in words (get_board_image's text). */
export function currentLegend(riseC: number): string {
  const names = ['blue', 'green', 'yellow', 'orange', 'red'];
  return (
    `Current heat map on: power copper coloured by its estimated heating at its current against the allowed +${riseC} °C (${HEAT.map((h, i) => `${names[i]} ${h.label}`).join(', ')}): the net's max_current (bound), or its share of the loads stated (split); ` +
    'dashed in its colour: unverified (too small for the whole max_current, or for what no stated load places; whether that much flows there is not known); grey dashed: a power net with no max_current (unknown); ' +
    'a ring with a count: the vias that are the only way between two layers (split: also those carrying a share); signal copper faint; pours and planes in their layer colour (not solved). get_current_map has the numbers.'
  );
}
