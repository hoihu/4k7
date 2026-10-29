/**
 * Checks of the board against the manufacturer's limits (the fab profile): what the design rules
 * cannot guarantee by themselves because it comes from parts, holes, per-net widths or the board
 * size. Placement checks need no routing; copper checks (tracks, vias) run with the route.
 */
import { fabRuleIssues, MASK_MARGIN } from '@4k7/schema';
import type { BoardDiagnostic, BoardPad, BoardView, CopperLayer } from '@4k7/schema';
import { padGap } from './drc.ts';
import { segSegDist } from './segments.ts';

interface Hole {
  x: number;
  y: number;
  d: number;
  /** A slot: half its centre line's length along x and y (it runs from x − hx, y − hy to x + hx, y + hy). */
  hx: number;
  hy: number;
  what: string;
  via: boolean;
  part?: string;
}

const EPS = 0.001;
const mm = (v: number) => `${Math.round(v * 1000) / 1000} mm`;

function holes(b: BoardView, vias: boolean): Hole[] {
  const out: Hole[] = [];
  for (const p of b.parts) {
    for (const q of p.pads) {
      if (!q.drill) continue;
      const [hx, hy] = q.slot ? [(q.slot.w - q.drill) / 2, (q.slot.h - q.drill) / 2] : [0, 0];
      out.push({ x: q.x, y: q.y, d: q.drill, hx, hy, what: `${p.refdes}.${q.number}`, via: false, part: p.refdes });
    }
  }
  if (vias) for (const v of b.vias) out.push({ x: v.x, y: v.y, d: v.drill, hx: 0, hy: 0, what: `via ${b.netNames[v.netId] ?? v.netId}`, via: true });
  return out;
}

/** Hole walls thinner than the fab's limit; `viaPairs` = only pairs where a via is involved (the rest was checked at placement). */
function spacing(b: BoardView, viaPairs: boolean): BoardDiagnostic[] {
  const l = b.fab!.limits;
  const out: BoardDiagnostic[] = [];
  const hs = holes(b, viaPairs).sort((p, q) => p.x - q.x);
  const seen = new Set<string>();
  const widest = Math.max(l.holeToHole ?? 0, l.padHoleToHole ?? 0);
  if (!widest) return out;
  const biggest = Math.max(0, ...hs.map((x) => x.d + 2 * x.hx));
  for (let i = 0; i < hs.length; i++) {
    const A = hs[i]!;
    for (let j = i + 1; j < hs.length; j++) {
      const B = hs[j]!;
      if (B.x - A.x - (A.d + 2 * A.hx + biggest) / 2 >= widest) break;
      if (viaPairs && !A.via && !B.via) continue;
      const min = A.via && B.via ? l.holeToHole : (l.padHoleToHole ?? l.holeToHole);
      if (min === undefined) continue;
      const wall = segSegDist(A.x - A.hx, A.y - A.hy, A.x + A.hx, A.y + A.hy, B.x - B.hx, B.y - B.hy, B.x + B.hx, B.y + B.hy) - (A.d + B.d) / 2;
      if (wall >= min - EPS) continue;
      const key = A.part && A.part === B.part ? `${A.part}` : `${A.what}|${B.what}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const same = !!A.part && A.part === B.part;
      out.push({
        code: 'DRC.FAB_HOLE_SPACING',
        // between pads of one part the footprint decides: worth knowing, not the layout's to fix
        severity: same ? 'warning' : 'error',
        message: `${A.what} and ${B.what}: ${mm(Math.max(0, wall))} of material between the holes (${b.fab!.house} needs ${mm(min)}).`,
        at: { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 },
        entities: [A.part, B.part].filter((x): x is string => !!x),
      });
    }
  }
  return out;
}

/**
 * Solder-mask webs thinner than the fab's minimum. The mask opens 0.05 mm past each pad; what is
 * left between two openings is the web, and a house cannot hold one thinner than its limit (it
 * drops the web, and the two pads share one opening: solder bridges). Pads of one net are let be
 * (they join anyway). Between pads of one part the footprint decides (a warning); between parts
 * the layout does (an error). One finding per pair of parts, at its narrowest web.
 */
function maskWebs(b: BoardView): BoardDiagnostic[] {
  const min = b.fab!.limits.maskBridge;
  if (min === undefined) return [];
  const pads = b.parts.flatMap((p) => p.pads.filter((q) => !q.npth).map((q) => ({ p: p.refdes, q })));
  pads.sort((a, c) => a.q.x - c.q.x);
  const reach = Math.max(0, ...pads.map((a) => a.q.w)) + min + 2 * MASK_MARGIN;
  // (a through-hole pad is open on both sides; the inner layers have no mask)
  const faces = (q: BoardPad): CopperLayer[] => (q.drill ? ['F.Cu', 'B.Cu'] : q.layers.filter((l) => l === 'F.Cu' || l === 'B.Cu'));
  const worst = new Map<string, { web: number; a: (typeof pads)[number]; c: (typeof pads)[number] }>();
  for (let i = 0; i < pads.length; i++) {
    const A = pads[i]!;
    for (let j = i + 1; j < pads.length; j++) {
      const C = pads[j]!;
      if (C.q.x - A.q.x > reach) break; // sweep on x
      if (A.q.netId && A.q.netId === C.q.netId) continue;
      if (!faces(A.q).some((l) => faces(C.q).includes(l))) continue;
      const web = padGap(A.q, C.q) - 2 * MASK_MARGIN;
      if (web >= min - EPS) continue;
      const key = [A.p, C.p].sort().join('|');
      const w = worst.get(key);
      if (!w || web < w.web) worst.set(key, { web, a: A, c: C });
    }
  }
  const out: BoardDiagnostic[] = [];
  for (const { web, a, c } of worst.values()) {
    const same = a.p === c.p;
    out.push({
      code: 'DRC.FAB_MASK_WEB',
      severity: same ? 'warning' : 'error',
      message: `${a.p}.${a.q.number} and ${c.p}.${c.q.number}: ${mm(Math.max(0, web))} of solder mask between the pad openings (${b.fab!.house} holds ${mm(min)}); the web is dropped and the two pads share one opening, which bridges in reflow.${same ? ' The footprint sets that spacing.' : ' Move the parts apart.'}`,
      at: { x: (a.q.x + c.q.x) / 2, y: (a.q.y + c.q.y) / 2 },
      entities: [...new Set([a.p, c.p])],
    });
  }
  return out;
}

/** Layers, board size, rules, component holes and rings, mask webs, silkscreen lines and text: everything known at placement. */
export function fabPlacementDrc(b: BoardView): BoardDiagnostic[] {
  const fab = b.fab;
  if (!fab) return [];
  const l = fab.limits;
  const who = `${fab.house} ${fab.tier}`;
  const out: BoardDiagnostic[] = [];

  const layerCount = b.layers.length as 2 | 4;
  if (!fab.layers.includes(layerCount)) {
    out.push({ code: 'DRC.FAB_LAYERS', severity: 'error', message: `${who} is not made with ${layerCount} layers (${fab.layers.join(' or ')}). Choose another tier with set_fab_profile.`, entities: [] });
  }
  for (const i of fabRuleIssues(b.rules, fab, layerCount)) {
    out.push({ code: 'DRC.FAB_RULES', severity: 'error', message: `The ${i.rule} rule (${mm(i.value)}) is below ${fab.house}'s limit (${mm(i.min)}); raise it with set_board.`, entities: [] });
  }

  const [w, h] = [b.outline.w, b.outline.h];
  const [lo, hi] = [Math.min(w, h), Math.max(w, h)];
  const small = l.minBoard && (lo < Math.min(...l.minBoard) - EPS || hi < Math.max(...l.minBoard) - EPS);
  const big = l.maxBoard && (lo > Math.min(...l.maxBoard) + EPS || hi > Math.max(...l.maxBoard) + EPS);
  if (small || big) {
    const lim = small ? l.minBoard! : l.maxBoard!;
    out.push({ code: 'DRC.FAB_BOARD_SIZE', severity: 'error', message: `The board (${w} × ${h} mm) is ${small ? 'smaller' : 'larger'} than ${who} makes (${small ? 'min' : 'max'} ${lim[0]} × ${lim[1]} mm).`, entities: [] });
  }
  // the panel is what goes through the machines: its size and its holes
  if (b.panel) {
    const [pw, ph] = [b.panel.w, b.panel.h];
    if (l.maxBoard && (Math.min(pw, ph) > Math.min(...l.maxBoard) + EPS || Math.max(pw, ph) > Math.max(...l.maxBoard) + EPS)) {
      out.push({ code: 'PANEL.SIZE', severity: 'error', message: `The panel (${pw} × ${ph} mm) is larger than ${who} makes (max ${l.maxBoard[0]} × ${l.maxBoard[1]} mm); use fewer copies (set_panel).`, entities: ['panel'] });
    }
    const hole = b.panel.settings.tab.hole;
    if (l.npthDrill !== undefined && hole < l.npthDrill - EPS) {
      out.push({ code: 'PANEL.HOLE', severity: 'error', message: `The mouse-bite holes (Ø${mm(hole)}) are smaller than ${who}'s smallest non-plated hole (${mm(l.npthDrill)}); set_panel hole_mm.`, entities: ['panel'] });
    }
  }

  const flagged = new Set<string>();
  for (const p of b.parts) {
    for (const q of p.pads) {
      if (!q.drill) continue;
      const at = { x: q.x, y: q.y };
      const hole = q.npth ? l.npthDrill : l.pthDrill;
      const kind = q.npth ? 'non-plated' : 'plated';
      if (hole !== undefined && q.drill < hole - EPS && !flagged.has(`${p.refdes}|drill`)) {
        flagged.add(`${p.refdes}|drill`);
        out.push({ code: 'DRC.FAB_HOLE', severity: 'error', message: `${p.refdes}.${q.number}: the ${kind} hole ${mm(q.drill)} is below ${fab.house}'s smallest (${mm(hole)}).`, at, entities: [p.refdes] });
      }
      if (!q.npth && l.annularRing !== undefined) {
        const ring = q.slot ? Math.min(q.w - q.slot.w, q.h - q.slot.h) / 2 : (Math.min(q.w, q.h) - q.drill) / 2;
        if (ring < l.annularRing - EPS && !flagged.has(`${p.refdes}|ring`)) {
          flagged.add(`${p.refdes}|ring`);
          out.push({ code: 'DRC.FAB_RING', severity: 'error', message: `${p.refdes}.${q.number}: annular ring ${mm(Math.max(0, ring))} is below ${fab.house}'s minimum (${mm(l.annularRing)}); a bigger pad (set_footprint) or a smaller drill fixes it.`, at, entities: [p.refdes] });
        }
      }
    }
  }
  out.push(...spacing(b, false));
  out.push(...maskWebs(b));

  if (l.silkHeight !== undefined) {
    // text graphics: the shorter side of the text's box is its height (a line of text, turned 0 or 90°)
    for (const g of b.graphics) {
      const th = Math.min(g.bounds[2] - g.bounds[0], g.bounds[3] - g.bounds[1]);
      if (g.text && g.text.trim().length > 1 && th < l.silkHeight - EPS) {
        out.push({ code: 'DRC.FAB_SILK_TEXT', severity: 'warning', message: `Silkscreen text ${g.id} ("${g.text}") is ${mm(th)} high; ${fab.house} prints ${mm(l.silkHeight)} at the smallest; use edit_graphic to enlarge it.`, entities: [g.id] });
      }
    }
  }

  if (l.silkWidth !== undefined) {
    for (const g of b.graphics) {
      if (g.mode === 'outline' && g.line < l.silkWidth - EPS) {
        out.push({ code: 'DRC.FAB_SILK', severity: 'warning', message: `Silkscreen graphic ${g.id}: the ${mm(g.line)} line is thinner than ${fab.house} prints (${mm(l.silkWidth)}); use edit_graphic to thicken it.`, entities: [g.id] });
      }
    }
  }
  return out;
}

/** Track widths, via sizes and hole spacing around vias, once the board is routed. */
export function fabCopperDrc(b: BoardView): BoardDiagnostic[] {
  const fab = b.fab;
  if (!fab) return [];
  const l = fab.limits;
  const out: BoardDiagnostic[] = [];
  const seen = new Set<string>();
  for (const t of b.tracks) {
    if (t.width >= l.track - EPS) continue;
    const name = b.netNames[t.netId] ?? t.netId;
    const key = `${name}|${t.width}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ code: 'DRC.FAB_TRACK', severity: 'error', message: `Track ${name} is ${mm(t.width)} wide; ${fab.house} makes ${mm(l.track)} at the narrowest.`, at: { x: t.pts[0]!, y: t.pts[1]! }, entities: [] });
  }
  for (const v of b.vias) {
    const key = `via|${v.drill}|${v.pad}`;
    if (seen.has(key)) continue;
    if ((l.viaDrill !== undefined && v.drill < l.viaDrill - EPS) || (l.viaPad !== undefined && v.pad < l.viaPad - EPS)) {
      seen.add(key);
      out.push({ code: 'DRC.FAB_VIA', severity: 'error', message: `Vias ${mm(v.drill)} drill / ${mm(v.pad)} pad are below ${fab.house}'s smallest (${l.viaDrill !== undefined ? mm(l.viaDrill) : '–'} / ${l.viaPad !== undefined ? mm(l.viaPad) : '–'}).`, at: { x: v.x, y: v.y }, entities: [] });
    }
  }
  // thermal-relief spokes are copper too
  for (const z of b.zones) {
    const w = Math.min(Infinity, ...(z.shape?.adds ?? []).map((a) => a.w));
    if (w < l.track - EPS) out.push({ code: 'DRC.FAB_SPOKE', severity: 'error', message: `The thermal spokes of ${b.netNames[z.netId] ?? z.netId} on ${z.layer} are ${mm(w)} wide; ${fab.house} makes ${mm(l.track)} at the narrowest (set_plane_style spoke_mm).`, entities: [] });
  }
  out.push(...spacing(b, true));
  return out;
}
