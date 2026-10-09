/**
 * Fab profiles: what a PCB manufacturer can make (the limits), kept apart from the design rules
 * the board is routed with. A profile is stored in the design (`board.fab`) as a full copy, so a
 * design stays reproducible when a preset is revised later. Millimetres throughout.
 *
 * Presets here are read off the manufacturers' published capability pages (sources and dates in
 * each profile); they go stale, so a profile always says where and when it was checked, and the
 * agent can import a newer one (set_fab_profile with explicit limits).
 */
import type { BoardRules } from './board.ts';

export interface FabLimits {
  /** Narrowest copper track. */
  track: number;
  /** Smallest copper-to-copper gap. */
  clearance: number;
  /** Via: smallest drill and smallest pad diameter. */
  viaDrill?: number;
  viaPad?: number;
  /** Smallest annular ring of a plated component hole, (pad − drill) / 2. */
  annularRing?: number;
  /** Smallest drilled hole of a plated component pad; of a non-plated (mounting) hole. */
  pthDrill?: number;
  npthDrill?: number;
  /** Smallest wall between two drilled holes (edge to edge): vias, and any hole when `padHoleToHole` is absent. */
  holeToHole?: number;
  /** … when a component or mounting hole is involved. */
  padHoleToHole?: number;
  /** Copper to the routed board edge (outer layers) and, when larger, on inner layers. */
  copperToEdge?: number;
  copperToEdgeInner?: number;
  /** Silkscreen: narrowest line and smallest text height (informational for text). */
  silkWidth?: number;
  silkHeight?: number;
  /** Narrowest solder-mask web between pads (informational). */
  maskBridge?: number;
  /** Smallest and largest board, width × height in either orientation. */
  minBoard?: [number, number];
  maxBoard?: [number, number];
}

export interface FabProfile {
  /** "jlcpcb/2l-1oz": the preset id, or "<house>/<tier>" of an imported profile. */
  id: string;
  /** "JLCPCB" */
  house: string;
  /** "2-layer, 1 oz copper" */
  tier: string;
  /** Layer counts this tier is made in. */
  layers: (2 | 4)[];
  limits: FabLimits;
  source: {
    url: string;
    /** YYYY-MM-DD the page was read. */
    checked?: string;
  };
  /** 'preset' ships with the app; 'imported' was entered from a source (by the agent). */
  origin: 'preset' | 'imported';
  /** Caveats a designer should know (not checked by the DRC). */
  notes?: string[];
}

const CHECKED = '2026-10-09';

/* --------------------------------- JLCPCB --------------------------------- */

const JLC_URL = 'https://jlcpcb.com/capabilities/pcb-capabilities';

function jlc(layers: 2 | 4, oz: 1 | 2): FabProfile {
  const track = layers === 2 ? (oz === 1 ? 0.1 : 0.16) : oz === 1 ? 0.09 : 0.15;
  return {
    id: `jlcpcb/${layers}l-${oz}oz`,
    house: 'JLCPCB',
    tier: `${layers}-layer, ${oz} oz copper`,
    layers: [layers],
    limits: {
      track,
      clearance: track,
      viaDrill: 0.15,
      viaPad: 0.25,
      annularRing: oz === 1 ? (layers === 2 ? 0.18 : 0.2) : 0.254,
      pthDrill: 0.15,
      npthDrill: 0.5,
      holeToHole: 0.2,
      padHoleToHole: 0.45,
      copperToEdge: 0.2,
      silkWidth: 0.15,
      silkHeight: 1,
      maskBridge: 0.1,
      minBoard: [3, 3],
      ...(layers === 2 ? { maxBoard: [670, 600] as [number, number] } : {}),
    },
    source: { url: JLC_URL, checked: CHECKED },
    origin: 'preset',
    notes: [
      'Via 0.1 mm hole / 0.2 mm pad exists only for boards ≤ 1 mm thick with ENIG or OSP finish; the limits here are the standard 0.15 / 0.25 mm.',
      'The annular ring is the absolute minimum for plated component holes; JLCPCB recommends 0.25 mm or more.',
      'Hole-to-hole: 0.2 mm between vias, 0.45 mm when a component hole is involved.',
    ],
  };
}

/* --------------------------------- PCBWay --------------------------------- */

const PCBWAY_URL = 'https://www.pcbway.com/capabilities.html';

function pcbway(layers: 2 | 4): FabProfile {
  return {
    id: `pcbway/${layers}l-1oz`,
    house: 'PCBWay',
    tier: `${layers}-layer, 1 oz copper`,
    layers: [layers],
    limits: {
      track: 0.1,
      clearance: 0.127,
      viaDrill: 0.15,
      viaPad: 0.45,
      annularRing: 0.15,
      pthDrill: 0.15,
      holeToHole: 0.28,
      padHoleToHole: 0.41,
      copperToEdge: 0.25,
      silkWidth: 0.15,
      silkHeight: 0.8,
      maskBridge: 0.1,
      minBoard: [3, 3],
      maxBoard: layers === 2 ? [600, 1200] : [560, 1150],
    },
    source: { url: PCBWAY_URL, checked: CHECKED },
    origin: 'preset',
    notes: [
      'Track and gap: the page gives 4 / 4 mil for 1 oz and 4 / 5 mil for 18 µm outer copper; the gap here is the stricter 5 mil (0.127 mm).',
      'Via pad is derived: smallest drill + 2 × the 0.15 mm minimum annular ring.',
      'Hole-to-hole: 11 mil between vias up to 0.45 mm, 16 mil between component holes.',
      '2 oz and heavier copper have larger minimums (see the Advanced PCB table on the page).',
    ],
  };
}

/* ------------------------------- Eurocircuits ------------------------------ */

const EC_URL = 'https://www.eurocircuits.com/pcb-design-guidelines-classification/';

/** Pattern classes: track, gap, outer and inner annular ring (the table's OTW, OTT, OAR, IAR), mm. */
const EC_PATTERN: Record<string, { track: number; gap: number; oar: number; iar: number; service: string }> = {
  '3': { track: 0.25, gap: 0.25, oar: 0.2, iar: 0.2, service: 'all services' },
  '4': { track: 0.2, gap: 0.2, oar: 0.15, iar: 0.15, service: 'all services' },
  '5': { track: 0.175, gap: 0.175, oar: 0.15, iar: 0.15, service: 'all services' },
  '6': { track: 0.15, gap: 0.15, oar: 0.125, iar: 0.125, service: 'all services' },
  '7': { track: 0.125, gap: 0.125, oar: 0.125, iar: 0.125, service: 'standard, defined-impedance, RF and semi-flex pools' },
  '8': { track: 0.1, gap: 0.1, oar: 0.1, iar: 0.125, service: 'standard, defined-impedance and RF pools' },
  '9': { track: 0.09, gap: 0.09, oar: 0.1, iar: 0.1, service: 'standard, defined-impedance and RF pools' },
};

/** Drill classes: smallest finished plated hole, smallest non-plated hole, largest board thickness (mm). */
const EC_DRILL: Record<string, { pth: number; npth: number; thickness: number; service: string }> = {
  A: { pth: 0.5, npth: 0.6, thickness: 3.2, service: 'all services' },
  B: { pth: 0.35, npth: 0.45, thickness: 3.2, service: 'proto, standard, defined-impedance, RF, semi-flex and BINDI pools' },
  C: { pth: 0.25, npth: 0.35, thickness: 2.4, service: 'proto, standard, defined-impedance, RF, semi-flex and BINDI pools' },
  D: { pth: 0.15, npth: 0.25, thickness: 2.0, service: 'standard, defined-impedance, RF and semi-flex pools' },
  E: { pth: 0.1, npth: 0.2, thickness: 1.6, service: 'standard, defined-impedance, RF and semi-flex pools' },
};

/** A Eurocircuits technology class, "6C" = pattern class 6 with drill class C; undefined when it is not one. */
export function eurocircuitsClass(code: string): FabProfile | undefined {
  const m = /^([3-9])([A-Ea-e])$/.exec(code.trim());
  if (!m) return undefined;
  const p = EC_PATTERN[m[1]!]!;
  const dr = m[2]!.toUpperCase();
  const d = EC_DRILL[dr]!;
  // Eurocircuits measures the ring from the drill tool (finished PTH + 0.1 mm); ours is from the finished hole
  const ring = Math.round((Math.max(p.oar, p.iar) + 0.05) * 1000) / 1000;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const notes = [
    `Class ${m[1]}${dr} is pattern class ${m[1]} with drill class ${dr}. Pattern class ${m[1]} is offered in: ${p.service}. Drill class ${dr}: ${d.service}.`,
    'Eurocircuits measures the annular ring from the drill tool (finished plated hole + 0.10 mm); the ring here is that value + 0.05 mm, measured from the finished hole. The via pad is derived from it.',
    `Hole-to-hole is 0.25 mm between drill tools, i.e. 0.35 mm between finished plated holes.`,
    `Copper to the routed edge: 0.25 mm on outer layers, 0.40 mm on inner layers (0.45 mm for scored or V-cut boards).`,
    `Boards up to ${d.thickness} mm thick can be drilled in drill class ${dr}.`,
  ];
  if (p.track < 0.125) notes.push('Tracks below 0.125 mm need thin base copper (18 µm or less).');
  return {
    id: `eurocircuits/${m[1]}${dr}`,
    house: 'Eurocircuits',
    tier: `class ${m[1]}${dr}`,
    layers: [2, 4],
    limits: {
      track: p.track,
      clearance: p.gap,
      viaDrill: d.pth,
      viaPad: r3(d.pth + 2 * ring),
      annularRing: ring,
      pthDrill: d.pth,
      npthDrill: d.npth,
      holeToHole: 0.35,
      copperToEdge: 0.25,
      copperToEdgeInner: 0.4,
    },
    source: { url: EC_URL, checked: CHECKED },
    origin: 'preset',
    notes,
  };
}

/* --------------------------------- library --------------------------------- */

/** The classes listed as presets; any other pattern/drill combination resolves too ("eurocircuits/5C"). */
const EC_LISTED = ['3A', '4B', '5B', '6C', '7D', '8D', '9E'];

export const FAB_HOUSES = [
  { house: 'JLCPCB', key: 'jlcpcb', aliases: ['jlcpcb', 'jlc'], url: JLC_URL },
  { house: 'PCBWay', key: 'pcbway', aliases: ['pcbway'], url: PCBWAY_URL },
  { house: 'Eurocircuits', key: 'eurocircuits', aliases: ['eurocircuits', 'eurocircuit', 'ec'], url: EC_URL },
] as const;

/** Every listed preset. */
export function fabPresets(): FabProfile[] {
  return [
    jlc(2, 1),
    jlc(2, 2),
    jlc(4, 1),
    jlc(4, 2),
    pcbway(2),
    pcbway(4),
    ...EC_LISTED.map((c) => eurocircuitsClass(c)!),
  ];
}

export type FabLookup = { ok: true; profile: FabProfile } | { ok: false; message: string; candidates: string[] };

/**
 * A preset by id ("jlcpcb/4l-1oz"), by house alone ("JLC", "PCB Way": the tier matching the board's
 * layer count, 1 oz; Eurocircuits: 6C) or loosely ("jlcpcb 2l", "Eurocircuits 7D").
 */
export function findFabPreset(query: string, layers: 2 | 4 = 2): FabLookup {
  const all = fabPresets();
  const ids = all.map((p) => p.id);
  const squash = (s: string) => s.toLowerCase().replace(/[\s_/:-]+/g, '');
  const q = squash(query);
  const house = [...FAB_HOUSES].flatMap((h) => h.aliases.map((a) => ({ a, h }))).sort((x, y) => y.a.length - x.a.length).find(({ a }) => q.startsWith(a));
  if (!house) return { ok: false, message: `No fab profile "${query}". Presets: ${ids.join(', ')}; or give explicit limits with a source.`, candidates: ids };
  const rest = q.slice(house.a.length);
  if (house.h.key === 'eurocircuits') {
    const p = eurocircuitsClass(rest || '6C');
    if (p) return { ok: true, profile: p };
    return { ok: false, message: `Eurocircuits classes are a pattern class 3–9 and a drill class A–E, e.g. "eurocircuits/6C"; "${query}" is neither.`, candidates: ids.filter((i) => i.startsWith('eurocircuits/')) };
  }
  const tiers = all.filter((p) => p.id.startsWith(`${house.h.key}/`));
  const key = (p: FabProfile) => squash(p.id.split('/')[1]!);
  const want = !rest ? `${layers}l1oz` : /^[24]l$/.test(rest) ? `${rest}1oz` : /^[12]oz$/.test(rest) ? `${layers}l${rest}` : rest;
  const hit = tiers.find((p) => key(p) === want);
  if (hit) return { ok: true, profile: hit };
  return { ok: false, message: `${house.h.house} has no tier "${rest || want}". Tiers: ${tiers.map((p) => p.id).join(', ')}.`, candidates: tiers.map((p) => p.id) };
}

/* ---------------------------- rules against limits ---------------------------- */

export type RuleKey = 'clearance' | 'track' | 'powerTrack' | 'viaDrill' | 'viaPad' | 'edgeClearance';

/** What each design rule is called, in the order they are listed. */
export const RULE_LABELS: Record<RuleKey, string> = {
  clearance: 'clearance',
  track: 'track width',
  powerTrack: 'power track width',
  viaDrill: 'via drill',
  viaPad: 'via pad',
  edgeClearance: 'edge clearance',
};

/** The profile's limit for a design rule (undefined when it states none). */
export function ruleLimit(fab: FabProfile, key: RuleKey, layers: 2 | 4): number | undefined {
  const l = fab.limits;
  switch (key) {
    case 'clearance':
      return l.clearance;
    case 'track':
    case 'powerTrack':
      return l.track;
    case 'viaDrill':
      return l.viaDrill;
    case 'viaPad':
      return l.viaPad;
    case 'edgeClearance':
      return edgeLimit(fab, layers);
  }
}

/** One rule that is below the profile's limit. */
export interface FabRuleIssue {
  rule: string;
  value: number;
  min: number;
}

/** The design rules (as set) that the profile cannot make. */
export function fabRuleIssues(rules: BoardRules, fab: FabProfile, layers: 2 | 4): FabRuleIssue[] {
  const out: FabRuleIssue[] = [];
  for (const key of Object.keys(RULE_LABELS) as RuleKey[]) {
    const min = ruleLimit(fab, key, layers);
    if (min !== undefined && rules[key] < min - 1e-9) out.push({ rule: RULE_LABELS[key], value: rules[key], min });
  }
  return out;
}

/** Copper to board edge for a board of this many layers. */
export function edgeLimit(fab: FabProfile, layers: 2 | 4): number | undefined {
  const l = fab.limits;
  return layers === 4 && l.copperToEdgeInner !== undefined ? Math.max(l.copperToEdge ?? 0, l.copperToEdgeInner) : l.copperToEdge;
}

/** The rules raised to the profile's limits (never lowered), and what was raised. */
export function raiseRules(rules: BoardRules, fab: FabProfile, layers: 2 | 4): { rules: BoardRules; raised: string[] } {
  const next = { ...rules };
  const raised: string[] = [];
  for (const key of Object.keys(RULE_LABELS) as RuleKey[]) {
    const min = ruleLimit(fab, key, layers);
    if (min === undefined || next[key] >= min - 1e-9) continue;
    raised.push(`${RULE_LABELS[key]} ${next[key]} → ${min} mm`);
    next[key] = min;
  }
  return { rules: next, raised };
}

/** One line for people and agents: "JLCPCB 2-layer, 1 oz copper: track/gap ≥ 0.1/0.1 mm, via 0.15/0.25 mm". */
export function fabSummary(fab: FabProfile): string {
  const l = fab.limits;
  const bits = [`track ≥ ${l.track} mm`, `gap ≥ ${l.clearance} mm`];
  if (l.viaDrill !== undefined) bits.push(`via drill ≥ ${l.viaDrill} mm`);
  if (l.viaPad !== undefined) bits.push(`via pad ≥ ${l.viaPad} mm`);
  return `${fab.house} ${fab.tier}: ${bits.join(', ')}`;
}
