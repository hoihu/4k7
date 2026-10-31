/**
 * Lines at a set impedance (docs/design/impedance.md): the board's stack-up (set_stackup) and the
 * impedance rules of its nets (set_impedance, remove_impedance). A rule is worked out for the board
 * as soon as it is set, so its effect says each layer's width and gaps, and a rule no layer can
 * carry is refused with the reasons.
 */
import {
  DEFAULT_BOARD,
  boardStackup,
  findStackupPreset,
  stackupPresets,
  stackupText,
  type BoardSettings,
  type Design,
  type EditOp,
  type ImpedanceRule,
  type OpResult,
  type Stackup,
} from '@4k7/schema';
import { settingsPlanes } from './board.ts';
import { boardCopy, closest, findNet, isGroundNet, natCmp, reject } from './doc.ts';
import { impedanceText, resolveRule, type LineBoard } from './lines.ts';

/** What working the rules out needs, from the board's settings. */
export function lineBoard(d: Design, b: BoardSettings = d.board ?? DEFAULT_BOARD): LineBoard {
  return {
    layers: b.layers === 4 ? ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] : ['F.Cu', 'B.Cu'],
    planes: settingsPlanes({ ...d, board: b }, b.layers),
    rules: b.rules,
    ...(b.fab ? { fab: b.fab } : {}),
    stackup: boardStackup(b),
  };
}

const netName = (d: Design) => (id: string) => d.nets[id]?.name ?? id;

/** The design's rules worked out for its board, in words. */
function rulesText(d: Design): string {
  const lb = lineBoard(d);
  return (d.board?.impedance ?? [])
    .filter((r) => r.nets.every((id) => d.nets[id]))
    .map((r) => impedanceText(resolveRule(r, lb), netName(d)))
    .join('. ');
}

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');

export function setStackup(d: Design, op: Extract<EditOp, { op: 'set_stackup' }>): OpResult {
  const b = boardCopy(d);
  const fits = stackupPresets().filter((s) => s.copper.length === b.layers).map((s) => s.id);
  const imported = op.house !== undefined || op.name !== undefined || op.copper_mm !== undefined || op.dielectric !== undefined || op.source_url !== undefined || op.mask !== undefined;
  if ([op.preset !== undefined, op.none === true, imported].filter(Boolean).length !== 1) {
    reject({ code: 'STACKUP_INVALID', message: 'set_stackup needs exactly one of: preset, none: true, or an import (house, name, copper_mm, dielectric, source_url).', candidates: fits });
  }
  if (op.none) {
    if (!b.stackup) return { op: op.op, effect: `no stack-up was set; the board uses the default, ${boardStackup(b).name}`, ids: [] };
    delete b.stackup;
    d.board = b;
    const s = boardStackup(b);
    const rules = rulesText(d);
    return { op: op.op, effect: `stack-up removed: the default applies, ${s.name}: ${stackupText(s)}${rules ? `. ${rules}` : ''}`, ids: ['board'] };
  }
  let s: Stackup;
  if (op.preset !== undefined) {
    const p = findStackupPreset(op.preset);
    if (!p) reject({ code: 'STACKUP_UNKNOWN', message: `No stack-up "${op.preset}".`, candidates: fits });
    s = p!;
  } else {
    if (!op.house || !op.name || !op.copper_mm || !op.dielectric || !op.source_url) {
      reject({ code: 'STACKUP_INVALID', message: 'An imported stack-up needs house, name, copper_mm (per layer), dielectric (between each two layers) and source_url (the page the numbers come from).' });
    }
    const copper = op.copper_mm!;
    const diel = op.dielectric!;
    if (diel.length !== copper.length - 1) reject({ code: 'STACKUP_INVALID', message: `${copper.length} copper layers have ${copper.length - 1} dielectrics between them, not ${diel.length}.` });
    for (const c of copper) {
      if (c < 0.005 || c > 0.21) reject({ code: 'STACKUP_INVALID', message: `Copper ${c} mm thick is not a PCB's (0.005–0.21 mm; 1 oz = 0.035 mm, 1 mil = 0.0254 mm).` });
    }
    for (const x of diel) {
      if (x.mm < 0.02 || x.mm > 3.2) reject({ code: 'STACKUP_INVALID', message: `A ${x.mm} mm dielectric is out of range (0.02–3.2 mm; 1 mil = 0.0254 mm).` });
      if (x.er < 1.5 || x.er > 12) reject({ code: 'STACKUP_INVALID', message: `εr ${x.er} is not a PCB laminate's (1.5–12; FR-4 is 3.9–4.8).` });
    }
    const m = op.mask;
    if (m && (m.er < 1.5 || m.er > 8 || m.over_copper_mm > 0.1 || m.over_laminate_mm > 0.1)) reject({ code: 'STACKUP_INVALID', message: 'A solder mask is up to 0.1 mm thick with εr 1.5–8 (typically 0.01–0.03 mm, εr 3.5–4).' });
    s = {
      id: `${slug(op.house!)}/${slug(op.name!)}`,
      name: op.name!,
      copper: [...copper],
      dielectric: diel.map((x) => ({ mm: x.mm, er: x.er, ...(x.what ? { what: x.what } : {}) })),
      ...(m ? { mask: { overLaminate: m.over_laminate_mm, overCopper: m.over_copper_mm, er: m.er } } : {}),
      source: { url: op.source_url!, ...(op.checked ? { checked: op.checked } : {}) },
      origin: 'imported',
      ...(op.notes?.length ? { notes: op.notes } : {}),
    };
  }
  if (s.copper.length !== b.layers) {
    reject({ code: 'STACKUP_INVALID', message: `${s.name} has ${s.copper.length} copper layers; the board has ${b.layers} (set_board layers first).`, candidates: fits });
  }
  b.stackup = s;
  d.board = b;
  const rules = rulesText(d);
  return {
    op: op.op,
    effect: `stack-up ${s.name}${s.origin === 'imported' ? ` (imported from ${s.source!.url})` : ''}: ${stackupText(s)}${rules ? `. ${rules}` : ''}`,
    ids: ['board'],
  };
}

export function setImpedance(d: Design, op: Extract<EditOp, { op: 'set_impedance' }>): OpResult {
  const b = boardCopy(d);
  const names = Object.values(d.nets).map((n) => n.name);
  const nets = op.nets.map((n) => {
    const net = findNet(d, n);
    if (!net) reject({ code: 'NET_UNKNOWN', message: `No net "${n}".`, candidates: closest(n, names) });
    if (isGroundNet(net!)) reject({ code: 'INVALID_OP', message: `${net!.name} is ground: the return of a line, not a line.` });
    return net!;
  });
  const pair = nets.length === 2;
  if (pair && nets[0]!.id === nets[1]!.id) reject({ code: 'INVALID_OP', message: 'A differential pair is two different nets.' });
  if (!pair && (op.gap_mm !== undefined || op.max_skew_mm !== undefined)) reject({ code: 'INVALID_OP', message: 'gap_mm and max_skew_mm are for a differential pair: give its two nets.' });
  if (pair && op.width_mm !== undefined && op.gap_mm !== undefined) reject({ code: 'INVALID_OP', message: 'Give a pair width_mm or gap_mm, not both: the kernel finds the other.' });
  if (op.style === 'microstrip' && op.coplanar_gap_mm !== undefined) reject({ code: 'INVALID_OP', message: 'coplanar_gap_mm is for a coplanar line (style coplanar).' });
  const fab = b.fab;
  if (fab) {
    if (op.width_mm !== undefined && op.width_mm < fab.limits.track - 1e-9) reject({ code: 'FAB_LIMIT', message: `A ${op.width_mm} mm track is below ${fab.house}'s ${fab.limits.track} mm.` });
    for (const [what, v] of [['gap_mm', op.gap_mm], ['coplanar_gap_mm', op.coplanar_gap_mm]] as const) {
      if (v !== undefined && v < fab.limits.clearance - 1e-9) reject({ code: 'FAB_LIMIT', message: `${what} ${v} mm is below ${fab.house}'s ${fab.limits.clearance} mm clearance.` });
    }
  }
  // (a pour keeps at least the board's clearance from other copper, and a pair's two tracks are two
  // nets: a gap below it cannot be had)
  for (const [what, v] of [['gap_mm', op.gap_mm], ['coplanar_gap_mm', op.coplanar_gap_mm]] as const) {
    if (v !== undefined && v < b.rules.clearance - 1e-9) {
      reject({ code: 'INVALID_OP', message: `${what} ${v} mm is below the board's clearance (${b.rules.clearance} mm), which ${what === 'gap_mm' ? 'the pair\'s two tracks keep from each other' : 'the pour keeps from the line'}. Lower the clearance first (set_board clearance_mm${fab ? `; ${fab.house} makes ${fab.limits.clearance} mm` : ''}), or give a gap at or above it.` });
    }
  }
  const ids = nets.map((n) => n.id);
  // (a net belongs to one rule: setting it again replaces the rule it was in)
  const rules = b.impedance ?? [];
  const replaced = rules.filter((r) => r.nets.some((id) => ids.includes(id)));
  const used = new Set(rules.map((r) => r.id));
  let id = replaced[0]?.id;
  for (let k = 1; !id; k++) if (!used.has(`Z${k}`)) id = `Z${k}`;
  // (a gap to the ground beside it asks for a coplanar line)
  const style = op.style ?? (op.coplanar_gap_mm !== undefined ? 'coplanar' : undefined);
  const rule: ImpedanceRule = {
    id,
    nets: ids,
    ohms: op.ohms,
    ...(op.tolerance_pct !== undefined ? { tolerance: op.tolerance_pct } : {}),
    ...(style ? { style } : {}),
    ...(op.width_mm !== undefined ? { width: op.width_mm } : {}),
    ...(op.gap_mm !== undefined ? { gap: op.gap_mm } : {}),
    ...(op.coplanar_gap_mm !== undefined ? { side: op.coplanar_gap_mm } : {}),
    ...(op.max_skew_mm !== undefined ? { skew: op.max_skew_mm } : {}),
    ...(op.max_length_mm !== undefined ? { maxLength: op.max_length_mm } : {}),
    ...(op.keep_mm !== undefined ? { keep: op.keep_mm } : {}),
    ...(op.label ? { label: op.label } : {}),
  };
  const v = resolveRule(rule, lineBoard(d, b));
  if (!v.layers.length) {
    reject({ code: 'IMPEDANCE_IMPOSSIBLE', message: `${op.ohms} Ω${pair ? ' differential' : ''} cannot be built on this board: ${v.unusable.map((u) => `${u.layer}: ${u.why}`).join('; ')}.` });
  }
  b.impedance = [...rules.filter((r) => !replaced.includes(r)), rule].sort((x, y) => natCmp(x.id, y.id));
  d.board = b;
  const name = netName(d);
  const how = pair
    ? `The router takes the width but routes the two nets apart: draw the pair yourself with draw_pair (drawn copper) to keep the gap.`
    : 'The router and draw_track take the width.';
  const ground = v.style === 'coplanar'
    ? ` The ground pour on its layer keeps ${v.layers[0]!.side} mm from it: pour ground round it on its layer (set_plane) and stitch that to the plane below with a via fence along it (add_vias fence).`
    : v.layers.some((l) => l.pourGap !== undefined) ? ` Ground pours on its layer keep ${Math.max(...v.layers.map((l) => l.pourGap ?? 0))} mm from it.` : '';
  return { op: op.op, effect: `${replaced.length ? 'replaced' : 'set'} ${impedanceText(v, name)}. ${how}${ground}`, ids: ['board', ...ids] };
}

export function removeImpedance(d: Design, op: Extract<EditOp, { op: 'remove_impedance' }>): OpResult {
  const b = boardCopy(d);
  const rules = b.impedance ?? [];
  const name = netName(d);
  if (op.id.toLowerCase() === 'all') {
    if (!rules.length) reject({ code: 'REF_UNKNOWN', message: 'No impedance rules are set.' });
    delete b.impedance;
    d.board = b;
    return { op: op.op, effect: `removed ${rules.length} impedance rule${rules.length > 1 ? 's' : ''}`, ids: ['board'] };
  }
  const r = rules.find((x) => x.id.toLowerCase() === op.id.toLowerCase());
  if (!r) reject({ code: 'REF_UNKNOWN', message: `No impedance rule ${op.id}.`, candidates: rules.map((x) => `${x.id} (${x.nets.map(name).join('/')})`) });
  b.impedance = rules.filter((x) => x !== r);
  if (!b.impedance.length) delete b.impedance;
  d.board = b;
  return { op: op.op, effect: `removed ${r!.id} (${r!.nets.map(name).join('/')}): back to the rules' track width`, ids: ['board', ...r!.nets] };
}
