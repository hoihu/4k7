/**
 * The ops on the board: its size, rules, planes, outline, panel, silkscreen, holes and vias, and
 * where parts stand.
 */
import { footprintFor, packageOf } from '@4k7/parts';
import { autoTabs, type BoardPad, type BoardSettings, type BoardView, type Component, type Constraint, type CopperLayer, type Cutout, DEFAULT_PANEL, type Design, type EditOp, type FabLimits, fabPresets, type FabProfile, findFabPreset, type HoleCorner, type MountingHole, type OpResult, padHasPin, PANEL_SIDES, type PanelSettings, type PanelSide, type PlaneArea, type PlaneStyle, pointBounds, raiseRules, roundPadDist, type RuleKey, ruleLimit, type SilkGraphic, textFigures, unknownGlyphs, VIA_PITCH, viaCurrentFor, type ViaGroup, viasForCurrent } from '@4k7/schema';
import { findArtwork, listArtwork } from './artwork.ts';
import { autoPlanes, dropOffset, keepPlacement, padNet, placedOf, storedPlacement } from './board.ts';
import { routability } from './congestion.ts';
import { boardCopy, cardOf, findNet, madeBy, nextId, pinLabel, reject, resolveComponent, resolvePins } from './doc.ts';
import { underBody } from './drc.ts';
import { r3 } from './geom.ts';
import { constrain } from './netops.ts';
import { boardOutline, pathFigures, pathPolygon } from './outline.ts';
import { refinable, type RefineMove, refinePlacement } from './refine.ts';

/* --------------------------------- parts ---------------------------------- */
/* --------------------------------- board ---------------------------------- */
export function setBoard(d: Design, op: Extract<EditOp, { op: 'set_board' }>): OpResult {
  const b = boardCopy(d);
  const out: string[] = [];
  const size = (key: 'width' | 'height', v: number | null | undefined) => {
    if (v === undefined) return;
    if (v === null) delete b[key];
    else {
      if (v < 5 || v > 500) reject({ code: 'BOARD_INVALID', message: `Board ${key} ${v} mm is outside 5–500 mm.` });
      b[key] = v;
    }
    out.push(`${key} ${v === null ? 'fit to parts' : `${v} mm`}`);
  };
  if (b.shape && (op.width_mm !== undefined || op.height_mm !== undefined)) {
    // a free-form outline is scaled to the new size (one side given: proportionally)
    if (op.width_mm === null || op.height_mm === null) reject({ code: 'BOARD_INVALID', message: 'The board has a free-form outline, so its size is fixed; set_outline rectangle: true first.' });
    const r = boardOutline(b.shape, op.width_mm ?? undefined, op.height_mm ?? undefined);
    if (r.ok) {
      b.shape = r.pts;
      [, , b.width, b.height] = pointBounds([r.pts]);
      out.push(`outline scaled to ${b.width} × ${b.height} mm`);
    }
  } else {
    size('width', op.width_mm);
    size('height', op.height_mm);
  }
  if (op.layers) {
    b.layers = op.layers;
    out.push(`${op.layers} layers`);
    // a stack-up is for one layer count
    if (b.stackup && b.stackup.copper.length !== op.layers) {
      out.push(`stack-up ${b.stackup.name} dropped (it is for ${b.stackup.copper.length} layers; the default for ${op.layers} applies until set_stackup)`);
      delete b.stackup;
    }
  }
  const rule = (key: RuleKey, v: number | undefined, label: string) => {
    if (v === undefined) return;
    if (v < 0.075 || v > 5) reject({ code: 'BOARD_INVALID', message: `${label} ${v} mm is not manufacturable (0.075–5 mm).` });
    // the manufacturer's limit, when one is chosen
    const min = b.fab && ruleLimit(b.fab, key, b.layers);
    if (b.fab && min !== undefined && v < min - 1e-9) {
      reject({ code: 'FAB_LIMIT', message: `${label} ${v} mm is below ${b.fab.house}'s limit (${min} mm, ${b.fab.tier}). Raise it, or choose another profile with set_fab_profile.` });
    }
    b.rules[key] = v;
    out.push(`${label} ${v} mm`);
  };
  rule('clearance', op.clearance_mm, 'clearance');
  rule('track', op.track_mm, 'track');
  rule('powerTrack', op.power_track_mm, 'power track');
  rule('viaDrill', op.via_drill_mm, 'via drill');
  rule('viaPad', op.via_pad_mm, 'via pad');
  rule('edgeClearance', op.edge_clearance_mm, 'edge clearance');
  if (op.layers && b.fab) {
    // a bigger stack can raise the limit (inner-layer edge distance)
    const up = raiseRules(b.rules, b.fab, b.layers);
    b.rules = up.rules;
    out.push(...up.raised.map((r) => `${r} (${b.fab!.house})`));
  }
  if (op.corner_radius_mm !== undefined) {
    if (op.corner_radius_mm > 50) reject({ code: 'BOARD_INVALID', message: `A ${op.corner_radius_mm} mm corner radius is too big.` });
    if (op.corner_radius_mm > 0) b.cornerRadius = op.corner_radius_mm;
    else delete b.cornerRadius;
    out.push(op.corner_radius_mm > 0 ? `corners rounded, r ${op.corner_radius_mm} mm` : 'square corners');
  }
  if (op.via_in_pad !== undefined) {
    if (op.via_in_pad) b.rules.viaInPad = true;
    else delete b.rules.viaInPad;
    out.push(op.via_in_pad ? 'vias in pads allowed' : 'no vias in pads');
  }
  if (!out.length) reject({ code: 'BOARD_INVALID', message: 'set_board needs at least one setting.' });
  d.board = b;
  return { op: 'set_board', effect: `board: ${out.join(', ')}`, ids: ['board'] };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Choose the manufacturer: a preset, an imported set of limits, or none. */
export function setFabProfile(d: Design, op: Extract<EditOp, { op: 'set_fab_profile' }>): OpResult {
  const b = boardCopy(d);
  const imported = op.house !== undefined || op.tier !== undefined || op.limits !== undefined || op.source_url !== undefined;
  if ([op.preset !== undefined, op.none === true, imported].filter(Boolean).length !== 1) {
    reject({ code: 'FAB_INVALID', message: 'set_fab_profile needs exactly one of: preset ("jlcpcb", "pcbway", "eurocircuits/6C" …), none: true, or an import (house, tier, source_url and limits).' });
  }
  if (op.none) {
    if (!b.fab) reject({ code: 'FAB_INVALID', message: 'No fab profile is set.' });
    const was = b.fab!;
    delete b.fab;
    d.board = b;
    return { op: 'set_fab_profile', effect: `fab profile removed (${was.house}); the rules stay as they are`, ids: ['board'] };
  }
  let profile: FabProfile;
  if (op.preset !== undefined) {
    const r = findFabPreset(op.preset, b.layers);
    if (!r.ok) reject({ code: 'FAB_UNKNOWN', message: r.message, candidates: r.candidates });
    profile = r.ok ? r.profile : (undefined as never);
  } else {
    if (!op.house || !op.tier || !op.source_url || !op.limits) {
      reject({ code: 'FAB_INVALID', message: 'An imported profile needs house, tier, source_url (the page the limits were read from) and limits (at least track_mm and clearance_mm).' });
    }
    const i = op.limits!;
    const limits: FabLimits = {
      track: i.track_mm,
      clearance: i.clearance_mm,
      ...(i.via_drill_mm !== undefined ? { viaDrill: i.via_drill_mm } : {}),
      ...(i.via_pad_mm !== undefined ? { viaPad: i.via_pad_mm } : {}),
      ...(i.annular_ring_mm !== undefined ? { annularRing: i.annular_ring_mm } : {}),
      ...(i.pth_drill_mm !== undefined ? { pthDrill: i.pth_drill_mm } : {}),
      ...(i.npth_drill_mm !== undefined ? { npthDrill: i.npth_drill_mm } : {}),
      ...(i.hole_to_hole_mm !== undefined ? { holeToHole: i.hole_to_hole_mm } : {}),
      ...(i.pad_hole_to_hole_mm !== undefined ? { padHoleToHole: i.pad_hole_to_hole_mm } : {}),
      ...(i.copper_to_edge_mm !== undefined ? { copperToEdge: i.copper_to_edge_mm } : {}),
      ...(i.copper_to_edge_inner_mm !== undefined ? { copperToEdgeInner: i.copper_to_edge_inner_mm } : {}),
      ...(i.silk_width_mm !== undefined ? { silkWidth: i.silk_width_mm } : {}),
      ...(i.silk_height_mm !== undefined ? { silkHeight: i.silk_height_mm } : {}),
      ...(i.mask_bridge_mm !== undefined ? { maskBridge: i.mask_bridge_mm } : {}),
      ...(i.min_board_mm ? { minBoard: i.min_board_mm } : {}),
      ...(i.max_board_mm ? { maxBoard: i.max_board_mm } : {}),
    };
    // plausibility: a limit outside these is a unit slip (mil or µm read as mm), not a capability
    for (const [k, v] of Object.entries(limits)) {
      if (typeof v === 'number' && (v < 0.02 || v > 3)) reject({ code: 'FAB_INVALID', message: `${k} = ${v} mm is not a plausible fab limit (0.02–3 mm). Convert mil to mm (1 mil = 0.0254 mm).` });
    }
    if (limits.viaDrill !== undefined && limits.viaPad !== undefined && limits.viaPad <= limits.viaDrill) {
      reject({ code: 'FAB_INVALID', message: `via_pad_mm ${limits.viaPad} must be larger than via_drill_mm ${limits.viaDrill}.` });
    }
    // the same house and tier as a preset (an update check of one): keep its id, so the picker still shows it
    const same = fabPresets().find((p) => p.house.toLowerCase() === op.house!.toLowerCase() && p.tier.toLowerCase() === op.tier!.toLowerCase());
    profile = {
      id: same?.id ?? `${slug(op.house!)}/${slug(op.tier!)}`,
      house: op.house!,
      tier: op.tier!,
      layers: op.layers?.length ? [...new Set(op.layers)].sort() : [2, 4],
      limits,
      source: { url: op.source_url!, ...(op.checked ? { checked: op.checked } : {}) },
      origin: 'imported',
      ...(op.notes?.length ? { notes: op.notes } : {}),
    };
  }
  b.fab = profile;
  const out = [`${profile.house}, ${profile.tier}`];
  if (!op.keep_rules) {
    const up = raiseRules(b.rules, profile, b.layers);
    b.rules = up.rules;
    out.push(...up.raised.map((r) => `${r} (raised to the limit)`));
  }
  if (!profile.layers.includes(b.layers)) out.push(`note: this tier is not made with ${b.layers} layers (${profile.layers.join(' or ')})`);
  d.board = b;
  return { op: 'set_fab_profile', effect: `fab profile: ${out.join('; ')}`, ids: ['board'] };
}

/** Choose the net of a copper plane (or pour) per layer, or go back to automatic planes. */
export function setPlane(d: Design, op: Extract<EditOp, { op: 'set_plane' }>): OpResult {
  const b = boardCopy(d);
  if (op.auto) {
    delete b.planes;
    d.board = b;
    return { op: 'set_plane', effect: 'planes: automatic', ids: ['board'] };
  }
  if (!op.layer) reject({ code: 'BOARD_INVALID', message: 'set_plane needs a layer (or auto: true).' });
  const layers = b.layers === 4 ? ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] : ['F.Cu', 'B.Cu'];
  if (!layers.includes(op.layer!)) {
    reject({ code: 'BOARD_INVALID', message: `${op.layer} does not exist on a ${b.layers}-layer board; use set_board layers: 4 for inner planes.`, candidates: layers });
  }
  // explicit from now on: start from the automatic planes currently in effect
  const planes: NonNullable<BoardSettings['planes']> = b.planes ?? autoPlanes(d, b.layers).map(({ netId, layer }) => ({ netId, layer }));
  const layer = op.layer as CopperLayer;
  const outer = layer === 'F.Cu' || layer === 'B.Cu';
  if (op.net === null || op.net === undefined) {
    if (op.under || op.rect) reject({ code: 'BOARD_INVALID', message: 'An area plane needs its net (net: "+3V3"); net null clears the whole layer.' });
    b.planes = planes.filter((p) => p.layer !== layer);
    d.board = b;
    return { op: 'set_plane', effect: `no plane on ${layer}`, ids: ['board'] };
  }
  const net = findNet(d, op.net);
  if (!net) reject({ code: 'NET_UNKNOWN', message: `No net "${op.net}".`, candidates: Object.values(d.nets).map((n) => n.name) });
  if (op.under || op.rect) {
    if (op.under && op.rect) reject({ code: 'BOARD_INVALID', message: 'Give the area as under (parts) or rect, not both.' });
    // an outer layer: the local pour replaces the net's pour over the whole layer
    const fills = planes.some((p) => p.layer === layer && p.netId === net!.id && !p.area);
    if (fills && !outer) {
      reject({ code: 'BOARD_INVALID', message: `${net!.name} already fills ${layer}; give the layer's full plane to another net first (set_plane ${layer} net …), then the area.` });
    }
    const comps = (op.under ?? []).map((r) => resolveComponent(d, r));
    const area: PlaneArea = op.rect
      ? { rect: [op.rect.x_mm, op.rect.y_mm, op.rect.x_mm + op.rect.width_mm, op.rect.y_mm + op.rect.height_mm] }
      : { under: comps.map((c) => c.id), ...(op.margin_mm !== undefined ? { margin: op.margin_mm } : {}) };
    // (its style stays: the area's, else that of the pour it replaces)
    const was = planes.find((p) => p.layer === layer && p.netId === net!.id && p.area) ?? planes.find((p) => p.layer === layer && p.netId === net!.id);
    b.planes = [...planes.filter((p) => !(p.layer === layer && p.netId === net!.id)), { netId: net!.id, layer, area, ...(was?.style ? { style: was.style } : {}) }];
    d.board = b;
    const where = op.rect ? `${op.rect.width_mm} × ${op.rect.height_mm} mm at (${op.rect.x_mm}, ${op.rect.y_mm})` : `under ${comps.map((c) => c.refdes).join(', ')}`;
    const rest = outer ? (fills ? `; it no longer pours the whole layer` : '') + (b.planes.some((p) => p.layer === layer && !p.area) ? `; the layer's pour goes round it` : '') : `; the layer's full plane goes round it`;
    return { op: 'set_plane', effect: `${net!.name} ${outer ? 'pour' : 'plane'} on ${layer}, ${where}${rest}`, ids: ['board'] };
  }
  // the full plane of the layer; area planes of other nets stay (it goes round them)
  const was = planes.find((p) => p.layer === layer && p.netId === net!.id && !p.area);
  b.planes = [...planes.filter((p) => p.layer !== layer || (p.area && p.netId !== net!.id)), { netId: net!.id, layer, ...(was?.style ? { style: was.style } : {}) }];
  d.board = b;
  return { op: 'set_plane', effect: `${net!.name} plane on ${layer}${outer ? ' (pour)' : ' (dedicated)'}`, ids: ['board'] };
}

/** Shape a plane: the gap round an area plane, its clearance and edge pull-back, thermal reliefs. */
export function setPlaneStyle(d: Design, op: Extract<EditOp, { op: 'set_plane_style' }>): OpResult {
  const b = boardCopy(d);
  const net = findNet(d, op.net);
  if (!net) reject({ code: 'NET_UNKNOWN', message: `No net "${op.net}".`, candidates: Object.values(d.nets).map((n) => n.name) });
  const planes: NonNullable<BoardSettings['planes']> = b.planes ?? autoPlanes(d, b.layers).map(({ netId, layer }) => ({ netId, layer }));
  const plane = planes.find((p) => p.layer === op.layer && p.netId === net!.id);
  if (!plane) {
    const there = planes.filter((p) => p.layer === op.layer).map((p) => d.nets[p.netId]?.name ?? p.netId);
    reject({ code: 'BOARD_INVALID', message: `${net!.name} has no plane on ${op.layer}${there.length ? ` (it holds ${there.join(', ')})` : ''}; set_plane first.`, ...(there.length ? { candidates: there } : {}) });
  }
  const rules = b.rules;
  const style: PlaneStyle = { ...plane!.style };
  const done: string[] = [];
  const mm = (key: 'gap' | 'clearance' | 'edge' | 'spoke', v: number | null | undefined, min: number, what: string) => {
    if (v === undefined) return;
    if (v === null) {
      delete style[key];
      done.push(`${what} default`);
      return;
    }
    if (v < min - 1e-9) reject({ code: 'BOARD_INVALID', message: `A plane's ${what} of ${v} mm is below the board's ${min} mm; raise the board's rules with set_board first, or give at least ${min} mm.` });
    style[key] = v;
    done.push(`${what} ${v} mm`);
  };
  if (op.gap_mm !== undefined && op.gap_mm !== null && !plane!.area) reject({ code: 'BOARD_INVALID', message: `${net!.name} fills ${op.layer}: gap_mm is for an area plane (the gap to the plane round it); set it on the area's net.` });
  mm('gap', op.gap_mm, rules.clearance, 'gap');
  mm('clearance', op.clearance_mm, rules.clearance, 'clearance');
  mm('edge', op.edge_mm, rules.edgeClearance, 'edge pull-back');
  mm('spoke', op.spoke_mm, 0.15, 'spoke width');
  if (op.thermal !== undefined) {
    if (op.thermal === null || op.thermal) delete style.thermal;
    else style.thermal = false;
    done.push(op.thermal === false ? 'joined solid' : 'thermal reliefs');
  }
  if (!done.length) reject({ code: 'BOARD_INVALID', message: 'Nothing to change: give gap_mm, clearance_mm, edge_mm, thermal or spoke_mm.' });
  const next = { ...plane!, ...(Object.keys(style).length ? { style } : {}) };
  if (!Object.keys(style).length) delete next.style;
  b.planes = planes.map((p) => (p === plane ? next : p));
  d.board = b;
  return { op: 'set_plane_style', effect: `${net!.name} plane on ${op.layer}: ${done.join(', ')}`, ids: ['board'] };
}

/** A free-form board outline (an SVG path or points, scaled to the size asked for), or back to a rectangle. */
export function setOutline(d: Design, op: Extract<EditOp, { op: 'set_outline' }>): OpResult {
  const b = boardCopy(d);
  d.board = b;
  if (op.rectangle) {
    delete b.shape;
    return { op: 'set_outline', effect: `rectangular board${b.width && b.height ? ` ${b.width} × ${b.height} mm` : ''}`, ids: ['board'] };
  }
  let raw: number[];
  if (op.svg_path) {
    const r = pathPolygon(op.svg_path);
    if (!r.ok) reject({ code: 'BOARD_INVALID', message: `The outline path: ${r.reason}.` });
    raw = (r as { pts: number[] }).pts;
  } else if (op.points) raw = op.points.flat();
  else reject({ code: 'BOARD_INVALID', message: 'set_outline needs svg_path or points (or rectangle: true).' });
  if (!op.width_mm && !op.height_mm) reject({ code: 'BOARD_INVALID', message: 'Give the outline a size: width_mm or height_mm (or both).' });
  const r = boardOutline(raw!, op.width_mm, op.height_mm);
  if (!r.ok) reject({ code: 'BOARD_INVALID', message: `The outline: ${r.reason}.` });
  const pts = (r as { pts: number[] }).pts;
  const [, , w, h] = pointBounds([pts]);
  if (w < 5 || h < 5 || w > 500 || h > 500) reject({ code: 'BOARD_INVALID', message: `The outline would be ${w} × ${h} mm; boards are 5–500 mm.` });
  b.shape = pts;
  b.width = w;
  b.height = h;
  return { op: 'set_outline', effect: `free-form outline, ${pts.length / 2} points, ${w} × ${h} mm`, ids: ['board'] };
}

/** The fabrication panel: changes only what the op gives; the first one starts from the defaults. */
export function setPanel(d: Design, op: Extract<EditOp, { op: 'set_panel' }>): OpResult {
  const b = boardCopy(d);
  d.board = b;
  if (op.none) {
    if (!b.panel) reject({ code: 'BOARD_INVALID', message: 'There is no panel to remove.' });
    delete b.panel;
    return { op: 'set_panel', effect: 'no panel: single boards', ids: ['board'] };
  }
  if (op.tabs && (op.tab_sides || op.tabs_per_side)) reject({ code: 'BOARD_INVALID', message: 'Give either tabs (exact positions) or tab_sides / tabs_per_side, not both.' });
  const p: PanelSettings = b.panel ? structuredClone(b.panel) : { ...structuredClone(DEFAULT_PANEL), tabs: [] };
  const fresh = !b.panel;
  const out: string[] = [];
  if (op.cols !== undefined) p.cols = op.cols;
  if (op.rows !== undefined) p.rows = op.rows;
  if (op.gap_mm !== undefined) p.gap = op.gap_mm;
  if (op.rail_mm !== undefined) p.rails = { top: op.rail_mm, right: op.rail_mm, bottom: op.rail_mm, left: op.rail_mm };
  for (const side of PANEL_SIDES) if (op.rails_mm?.[side] !== undefined) p.rails[side] = op.rails_mm[side]!;
  if (op.tab_width_mm !== undefined) p.tab.width = op.tab_width_mm;
  if (op.hole_mm !== undefined) p.tab.hole = op.hole_mm;
  if (op.hole_pitch_mm !== undefined) p.tab.pitch = op.hole_pitch_mm;
  if (op.frame_holes !== undefined) p.tab.frameSide = op.frame_holes;
  if (p.tab.pitch <= p.tab.hole + 0.1) reject({ code: 'BOARD_INVALID', message: `Mouse-bite holes Ø${p.tab.hole} mm at ${p.tab.pitch} mm pitch leave less than 0.1 mm between them; the pitch must be larger.` });
  if (op.fiducials !== undefined) p.fiducials = op.fiducials;
  if (op.tooling_holes !== undefined) p.toolingHoles = op.tooling_holes;
  if (p.cols * p.rows < 2 && !Object.values(p.rails).some((r) => r > 0)) reject({ code: 'BOARD_INVALID', message: 'A panel of one board without a frame is just the board; give it more copies or rails.' });
  // tabs: exact, regenerated for the sides asked for, or (a new panel) on every side
  const w = b.width ?? b.placement?.outline.w;
  const h = b.height ?? b.placement?.outline.h;
  if (op.tabs) p.tabs = op.tabs.map((t) => ({ side: t.side as PanelSide, at: t.at }));
  else if (op.tab_sides || op.tabs_per_side || fresh) {
    if (!w || !h) reject({ code: 'BOARD_INVALID', message: 'The board has no size yet (propose_placement or set_board first), so tabs cannot be spread along its sides.' });
    const sides = (op.tab_sides as PanelSide[] | undefined) ?? [...new Set(p.tabs.map((t) => t.side))];
    p.tabs = autoTabs(sides.length ? sides : PANEL_SIDES, w!, h!, op.tabs_per_side);
  }
  b.panel = p;
  const pw = (side: PanelSide) => p.rails[side] + (p.rails[side] > 0 ? p.gap : 0);
  if (w && h) {
    const W = pw('left') + p.cols * w + (p.cols - 1) * p.gap + pw('right');
    const H = pw('top') + p.rows * h + (p.rows - 1) * p.gap + pw('bottom');
    out.push(`${Math.round(W * 10) / 10} × ${Math.round(H * 10) / 10} mm`);
  }
  const rails = [...new Set(Object.values(p.rails))].length === 1 ? `${p.rails.top} mm rails` : `rails ${PANEL_SIDES.map((s) => `${s} ${p.rails[s]}`).join(', ')} mm`;
  const sides = [...new Set(p.tabs.map((t) => t.side))];
  return {
    op: 'set_panel',
    effect: `panel ${p.cols} × ${p.rows}${out.length ? ` (${out.join(', ')})` : ''}, ${p.gap} mm gap, ${rails}, ${p.tabs.length} tabs per board (${sides.join(', ') || 'none'}), ${p.tab.width} mm wide with Ø${p.tab.hole} mm mouse bites`,
    ids: ['board'],
  };
}

/** A milled cutout: a rectangle, circle or slot, positioned from an anchor point. */
export function addCutout(d: Design, op: Extract<EditOp, { op: 'add_cutout' }>): OpResult {
  const b = boardCopy(d);
  const cutouts = [...(b.cutouts ?? [])];
  let id = '';
  for (let i = 1; ; i++) if (!cutouts.some((c) => c.id === `CO${i}`)) {
    id = `CO${i}`;
    break;
  }
  let c: Cutout;
  if (op.shape === 'circle') {
    const dia = op.diameter_mm ?? op.width_mm;
    if (!dia) reject({ code: 'BOARD_INVALID', message: 'A circular cutout needs diameter_mm.' });
    c = { id, shape: 'circle', x: r3(op.x_mm), y: r3(op.y_mm), w: dia! };
  } else {
    if (!op.width_mm || !op.height_mm) reject({ code: 'BOARD_INVALID', message: `A ${op.shape} cutout needs width_mm and height_mm${op.shape === 'slot' ? ' (length and width)' : ''}.` });
    if (op.shape === 'slot' && op.height_mm! > op.width_mm!) reject({ code: 'BOARD_INVALID', message: 'A slot is longer than it is wide: width_mm is its length, height_mm its width (use angle_deg to turn it).' });
    c = { id, shape: op.shape, x: r3(op.x_mm), y: r3(op.y_mm), w: op.width_mm!, h: op.height_mm!, ...(op.shape === 'rect' && op.corner_radius_mm ? { r: op.corner_radius_mm } : {}), ...(op.angle_deg ? { angle: op.angle_deg } : {}) };
  }
  if (op.anchor && op.anchor !== 'top_left') c.anchor = op.anchor;
  if (Math.max(c.w, c.h ?? 0) < 0.3) reject({ code: 'BOARD_INVALID', message: 'A cutout smaller than 0.3 mm cannot be milled.' });
  cutouts.push(c);
  b.cutouts = cutouts;
  d.board = b;
  const size = c.shape === 'circle' ? `Ø${c.w} mm` : `${c.w} × ${c.h} mm`;
  return { op: 'add_cutout', effect: `cutout ${id}: ${c.shape} ${size} at (${c.x}, ${c.y}) mm from ${c.anchor ?? 'top_left'}`.replace('_', ' '), ids: ['board'] };
}

/** A silkscreen graphic from an SVG path: scaled to its size, centred, placed from an anchor. */
export function addGraphic(d: Design, op: Extract<EditOp, { op: 'add_graphic' }>): OpResult {
  let figs: number[][];
  const art = op.artwork ? findArtwork(op.artwork) : undefined;
  const text = op.text?.replace(/\\n/g, '\n').trim();
  let textScale = 1;
  if (text) {
    const unknown = unknownGlyphs(text);
    if (unknown.length) reject({ code: 'BOARD_INVALID', message: `The silkscreen font has no ${unknown.map((c) => `"${c}"`).join(', ')}; it draws A–Z, 0–9, space and - + . / _ : , ' ( ) = < > ! ? *.` });
    // drawn at its letter height; width_mm alone scales it to that width
    figs = textFigures(text, op.height_mm ?? (op.width_mm ? 1 : 1.5), (op.side ?? 'top') === 'bottom');
    if (op.width_mm && !op.height_mm) {
      const [x0, , x1] = pointBounds(figs);
      textScale = op.width_mm / (x1 - x0);
      figs = figs.map((p) => p.map((v) => v * textScale));
    }
  } else if (op.artwork) {
    if (!art) reject({ code: 'REF_UNKNOWN', message: `No saved artwork "${op.artwork}".`, candidates: listArtwork().map((a) => a.name) });
    figs = art!.polys;
  } else {
    if (!op.svg_path) reject({ code: 'BOARD_INVALID', message: 'add_graphic needs text, svg_path or artwork.' });
    const parsed = pathFigures(op.svg_path!);
    if (!parsed.ok) reject({ code: 'BOARD_INVALID', message: `The graphic's path: ${parsed.reason}.` });
    figs = parsed.figs;
  }
  const [x0, y0, x1, y1] = pointBounds(figs);
  const [bw, bh] = [x1 - x0, y1 - y0];
  if (!(bw > 0) || !(bh > 0)) reject({ code: 'BOARD_INVALID', message: 'The graphic has no area.' });
  const sx = text ? 1 : op.width_mm ? op.width_mm / bw : op.height_mm ? op.height_mm / bh : 1;
  const sy = text ? 1 : op.height_mm ? op.height_mm / bh : op.width_mm ? op.width_mm / bw : 1;
  const polys = figs.map((p) => p.map((v, i) => (i % 2 === 0 ? r3((v - (x0 + x1) / 2) * sx) : r3((v - (y0 + y1) / 2) * sy))));
  const [w, h] = [r3(bw * sx), r3(bh * sy)];
  if (Math.max(w, h) < 0.5) reject({ code: 'BOARD_INVALID', message: `The graphic would be ${w} × ${h} mm; silkscreen needs at least about 1 mm to be readable (give width_mm or height_mm).` });
  const b = boardCopy(d);
  const graphics = [...(b.graphics ?? [])];
  let id = '';
  for (let i = 1; ; i++) if (!graphics.some((g) => g.id === `G${i}`)) {
    id = `G${i}`;
    break;
  }
  const mode = text ? 'outline' : (op.mode ?? art?.mode ?? 'fill');
  const name = op.name ?? art?.name;
  const textLine = r3(Math.max(0.15, (op.height_mm ?? (op.width_mm ? textScale : 1.5)) / 7));
  const g: SilkGraphic = {
    id,
    ...(name ? { name } : {}),
    side: op.side ?? 'top',
    mode,
    ...(mode === 'outline' ? { line: op.line_mm ?? (text ? textLine : (art?.line ?? 0.2)) } : {}),
    ...(text ? { text } : {}),
    polys,
    w,
    h,
    x: r3(op.x_mm),
    y: r3(op.y_mm),
    ...(op.anchor && op.anchor !== 'top_left' ? { anchor: op.anchor } : {}),
    ...(op.angle_deg ? { angle: op.angle_deg } : {}),
  };
  graphics.push(g);
  b.graphics = graphics;
  d.board = b;
  const points = polys.reduce((n, p) => n + p.length / 2, 0);
  return {
    op: 'add_graphic',
    effect: `silkscreen ${text ? `text ${id} "${text.replace(/\n/g, '\\n')}"${g.name ? ` (${g.name})` : ''}: strokes ${g.line} mm` : `graphic ${id}${g.name ? ` (${g.name})` : ''}: ${g.mode === 'fill' ? 'filled' : `outlines ${g.line} mm`}, ${polys.length} figure(s), ${points} points`}, ${w} × ${h} mm on the ${g.side} side at (${g.x}, ${g.y}) mm from ${(g.anchor ?? 'top_left').replace('_', ' ')}`,
    ids: ['board'],
  };
}

/** Move, resize, turn or restyle a silkscreen graphic (a drag in the layout view moves it by dx/dy). */
export function editGraphic(d: Design, op: Extract<EditOp, { op: 'edit_graphic' }>): OpResult {
  const b = boardCopy(d);
  const graphics = b.graphics ?? [];
  const g = graphics.find((x) => x.id.toUpperCase() === op.id.toUpperCase());
  if (!g) reject({ code: 'REF_UNKNOWN', message: `No silkscreen graphic "${op.id}".`, candidates: graphics.map((x) => x.id) });
  const changes: string[] = [];
  if (op.anchor && op.anchor !== (g.anchor ?? 'top_left')) {
    // keep its place unless a new x/y is given: re-measure the centre from the new anchor
    const { w, h } = placedOf(d).outline;
    const at = (a: string) => [a.endsWith('left') ? 0 : a.endsWith('right') ? w : w / 2, a.startsWith('top') ? 0 : a.startsWith('bottom') ? h : h / 2];
    const [ox, oy] = at(g.anchor ?? 'top_left');
    const [nx, ny] = at(op.anchor);
    g.x = r3(g.x + ox! - nx!);
    g.y = r3(g.y + oy! - ny!);
    if (op.anchor === 'top_left') delete g.anchor;
    else g.anchor = op.anchor;
    changes.push(`from ${op.anchor.replace('_', ' ')}`);
  }
  if (op.x_mm !== undefined) g.x = r3(op.x_mm);
  if (op.y_mm !== undefined) g.y = r3(op.y_mm);
  if (op.dx_mm) g.x = r3(g.x + op.dx_mm);
  if (op.dy_mm) g.y = r3(g.y + op.dy_mm);
  if (op.x_mm !== undefined || op.y_mm !== undefined || op.dx_mm || op.dy_mm) changes.push(`at (${g.x}, ${g.y}) mm`);
  if (op.angle_deg !== undefined) {
    if (op.angle_deg % 360) g.angle = op.angle_deg % 360;
    else delete g.angle;
    changes.push(`turned ${op.angle_deg}°`);
  }
  if (op.width_mm || op.height_mm) {
    const sx = op.width_mm ? op.width_mm / g.w : op.height_mm! / g.h;
    const sy = op.height_mm ? op.height_mm / g.h : sx;
    g.polys = g.polys.map((p) => p.map((v, i) => r3(v * (i % 2 === 0 ? sx : sy))));
    g.w = r3(g.w * sx);
    g.h = r3(g.h * sy);
    if (Math.max(g.w, g.h) < 0.5) reject({ code: 'BOARD_INVALID', message: 'That would make the graphic smaller than 0.5 mm.' });
    changes.push(`${g.w} × ${g.h} mm`);
  }
  if (op.mode === 'fill' && g.text) reject({ code: 'BOARD_INVALID', message: `${g.id} is text, drawn as strokes; it cannot be filled (line_mm sets the stroke).` });
  if (op.mode) {
    g.mode = op.mode;
    changes.push(op.mode === 'fill' ? 'filled' : 'outlines');
  }
  if (op.line_mm) g.line = op.line_mm;
  if (g.mode === 'outline') g.line ??= 0.2;
  else delete g.line;
  if (op.side) {
    // text reads from its own side: mirrored when it changes side
    if (g.text && op.side !== g.side) g.polys = g.polys.map((p) => p.map((v, i) => (i % 2 === 0 ? -v : v)));
    g.side = op.side;
    changes.push(`${op.side} side`);
  }
  if (op.name !== undefined) {
    if (op.name) g.name = op.name;
    else delete g.name;
  }
  d.board = b;
  return { op: 'edit_graphic', effect: `silkscreen graphic ${g.id}${g.name ? ` (${g.name})` : ''}: ${changes.join(', ') || 'unchanged'}`, ids: ['board'] };
}

/** Mounting holes: at fixed positions or anchored to corners (they follow the board size). */
export function addHole(d: Design, op: Extract<EditOp, { op: 'add_hole' }>): OpResult {
  const b = boardCopy(d);
  if (op.diameter_mm < 0.5 || op.diameter_mm > 10) reject({ code: 'BOARD_INVALID', message: `A ${op.diameter_mm} mm hole is outside 0.5–10 mm.` });
  const hasXY = op.x_mm !== undefined && op.y_mm !== undefined;
  if (!op.corner && !hasXY) reject({ code: 'BOARD_INVALID', message: 'add_hole needs a corner or x_mm and y_mm.' });
  let netId: string | undefined;
  if (op.net) {
    if (!op.plated) reject({ code: 'BOARD_INVALID', message: 'Only a plated hole can be on a net; add plated: true.' });
    const net = findNet(d, op.net);
    if (!net) reject({ code: 'NET_UNKNOWN', message: `No net "${op.net}".`, candidates: Object.values(d.nets).map((n) => n.name) });
    netId = net!.id;
  }
  const holes = [...(b.holes ?? [])];
  const nextId = () => {
    for (let i = 1; ; i++) if (!holes.some((h) => h.id === `MH${i}`)) return `MH${i}`;
  };
  const corners: HoleCorner[] = op.corner === 'all' ? ['top_left', 'top_right', 'bottom_left', 'bottom_right'] : op.corner ? [op.corner] : [];
  const added: string[] = [];
  const base = { d: op.diameter_mm, plated: !!op.plated, ...(netId ? { netId } : {}) };
  if (corners.length) {
    for (const corner of corners) {
      // one hole per corner: re-adding replaces it
      const i = holes.findIndex((h) => h.corner === corner);
      const hole: MountingHole = { id: i >= 0 ? holes[i]!.id : nextId(), ...base, corner, inset: op.inset_mm ?? Math.round((op.diameter_mm + 0.5) * 10) / 10 };
      if (i >= 0) holes[i] = hole;
      else holes.push(hole);
      added.push(`${hole.id} ${corner.replace('_', ' ')}`);
    }
  } else {
    const hole: MountingHole = { id: nextId(), ...base, x: op.x_mm!, y: op.y_mm! };
    holes.push(hole);
    added.push(`${hole.id} at (${op.x_mm}, ${op.y_mm}) mm`);
  }
  b.holes = holes;
  d.board = b;
  return { op: 'add_hole', effect: `mounting hole${added.length > 1 ? 's' : ''} Ø${op.diameter_mm} mm${op.plated ? ' plated' : ''}: ${added.join(', ')}`, ids: ['board'] };
}

/** Vias placed on purpose: thermal vias in a pad, at given spots, stitching over an area, a fence round one. */
export function addVias(d: Design, op: Extract<EditOp, { op: 'add_vias' }>): OpResult {
  const b = boardCopy(d);
  const drill = op.drill_mm ?? b.rules.viaDrill;
  const size = op.size_mm ?? Math.max(b.rules.viaPad, drill + 0.2);
  if (size < drill + 0.1) reject({ code: 'BOARD_INVALID', message: `A ${size} mm via pad round a ${drill} mm drill leaves no copper ring; give size_mm at least ${drill + 0.1} mm.` });
  const pitch = op.pitch_mm ?? VIA_PITCH[op.kind];
  if (op.kind !== 'points' && op.kind !== 'drop' && (op.kind !== 'tie' || op.pitch_mm !== undefined) && pitch < size + 0.1) reject({ code: 'BOARD_INVALID', message: `Vias ${size} mm wide ${pitch} mm apart would touch; give pitch_mm at least ${r3(size + 0.1)} mm.` });
  const netOf = (name: string) => {
    const net = findNet(d, name);
    if (!net) reject({ code: 'NET_UNKNOWN', message: `No net "${name}".`, candidates: Object.values(d.nets).map((n) => n.name) });
    return net!;
  };
  const groups = [...(b.vias ?? [])];
  const nextId = () => {
    for (let i = 1; ; i++) if (!groups.some((g) => g.id === `V${i}`)) return `V${i}`;
  };
  const sizes = { ...(op.drill_mm !== undefined ? { drill } : {}), ...(op.size_mm !== undefined ? { size } : {}) };
  let group: ViaGroup;
  let what: string;
  if (op.kind === 'pad' || op.kind === 'drop') {
    if (!op.ref || !op.pad) reject({ code: 'INVALID_OP', message: `add_vias kind "${op.kind}" needs ref (the component) and pad (its pad number, e.g. "9" or "EP").` });
    const comp = resolveComponent(d, op.ref!);
    const card = cardOf(d, comp.part);
    const pkg = card ? packageOf(card, comp.params, d.packageDefaults) : null;
    const fp = card && pkg ? footprintFor(pkg, card.pins.map((p) => p.number)) : null;
    if (!fp?.ok) reject({ code: 'BOARD_INVALID', message: `${comp.refdes} has no footprint yet (set_footprint first).` });
    const pad = fp!.ok ? (fp!.footprint.pads.find((p) => p.number.toUpperCase() === op.pad!.toUpperCase()) ?? fp!.footprint.pads.find((p) => padHasPin(p, op.pad!))) : undefined;
    if (!pad) reject({ code: 'REF_UNKNOWN', message: `${comp.refdes} has no pad "${op.pad}".`, candidates: fp!.ok ? [...new Set(fp!.footprint.pads.map((p) => p.number))] : [] });
    const netId = padNet(comp, pad!);
    if (!netId) reject({ code: 'BOARD_INVALID', message: `${comp.refdes}.${pad!.number} is not connected; connect it (e.g. to GND) before giving it vias.` });
    if (op.net && netOf(op.net).id !== netId) reject({ code: 'BOARD_INVALID', message: `${comp.refdes}.${pad!.number} is on ${d.nets[netId!]!.name}, not ${op.net}: vias in it are on its net.` });
    if (op.kind === 'drop') {
      const net = d.nets[netId!]!;
      const name = `${comp.refdes}.${pad!.number}`;
      if (!op.at) reject({ code: 'INVALID_OP', message: `add_vias kind "drop" needs at: each via's centre (mm), right beside ${name}, at least ${r3(size / 2 + b.rules.clearance)} mm off its edge (get_component gives the pad's position and size).` });
      // the spots against the board as it stands now: beside the pad, clear of it and of every other pad
      const board = placedOf(d);
      const part = board.parts.find((p) => p.componentId === comp.id);
      const here = part?.pads.find((p) => p.number === pad!.number);
      if (!part || !here) reject({ code: 'BOARD_INVALID', message: `${comp.refdes} is not on the board yet (propose_placement first).` });
      const off = (p: BoardPad, x: number, y: number) =>
        p.shape === 'round' ? roundPadDist(p, x, y) : Math.hypot(Math.max(Math.abs(x - p.x) - p.w / 2, 0), Math.max(Math.abs(y - p.y) - p.h / 2, 0));
      const gap = size / 2 + b.rules.clearance;
      const spots = op.at!.map((p) => [r3(p.x_mm), r3(p.y_mm)] as [number, number]);
      spots.forEach(([x, y], i) => {
        const at = `(${x}, ${y})`;
        const d0 = off(here!, x, y);
        if (d0 < gap - 1e-6) reject({ code: 'BOARD_INVALID', message: `The via at ${at} is ${d0 > 0 ? `${r3(d0)} mm off` : 'on'} ${name}: keep it at least ${r3(gap)} mm off the pad's edge (half a via and the clearance), so the solder mask stays between them; its stub joins it to the pad.` });
        if (d0 > 2 + 1e-6) reject({ code: 'BOARD_INVALID', message: `The via at ${at} is ${r3(d0)} mm from ${name}: a drop stands right beside its pad (within 2 mm).` });
        const e = b.rules.edgeClearance + size / 2;
        if (x < e || y < e || x > board.outline.w - e || y > board.outline.h - e) reject({ code: 'BOARD_INVALID', message: `The via at ${at} is too close to the board's edge.` });
        for (const q of board.parts) {
          for (const qp of q.pads) {
            if (qp === here || qp.npth) continue;
            const need = qp.netId === netId ? size / 2 : gap;
            if (off(qp, x, y) < need - 1e-6) reject({ code: 'BOARD_INVALID', message: `The via at ${at} comes too close to ${q.refdes}.${qp.number}${qp.netId === netId ? '' : ` (${d.nets[qp.netId ?? '']?.name ?? 'no net'})`}: keep it ${r3(need)} mm off that pad.` });
          }
          // (between a small part's pads, under its body)
          if (q.pads.length <= 3 && underBody(q, x, y, size / 2 - 1e-6)) reject({ code: 'BOARD_INVALID', message: `The via at ${at} lies under ${q.refdes}'s body (between its pads)${q === part ? `; put it on a side of ${name} facing away from the part` : ''}.` });
        }
        for (const [x2, y2] of spots.slice(0, i)) if (Math.hypot(x - x2, y - y2) < size + b.rules.clearance - 1e-6) reject({ code: 'BOARD_INVALID', message: `The vias at ${at} and (${x2}, ${y2}) are closer than ${r3(size + b.rules.clearance)} mm (a via and the clearance).` });
      });
      const amps = op.amps ?? net.attrs.maxCurrent;
      const need = amps ? viasForCurrent(amps, drill) : 0;
      // one group per pad: giving it again replaces it
      const was = groups.findIndex((g) => g.kind === 'drop' && g.pad?.componentId === comp.id && g.pad.number === pad!.number);
      group = { id: was >= 0 ? groups[was]!.id : nextId(), netId: netId!, kind: 'drop', pad: { componentId: comp.id, number: pad!.number }, offsets: spots.map(([x, y]) => dropOffset(part!, here!, x, y)), ...(op.amps !== undefined ? { amps: op.amps } : {}), ...sizes };
      if (was >= 0) groups.splice(was, 1);
      const n = spots.length;
      const enough = !amps ? '' : n >= need ? `, enough for ${amps} A (about ${Math.round(viaCurrentFor(drill) * 10) / 10} A each)` : `; ${amps} A wants ${need} (about ${Math.round(viaCurrentFor(drill) * 10) / 10} A each): place ${need - n} more beside the pad`;
      what = `${n} via${n > 1 ? 's' : ''} from ${name} (${net.name}) down to its plane at ${spots.map(([x, y]) => `(${x}, ${y})`).join(', ')}, each joined to the pad by its own stub, moving with ${comp.refdes}${enough}`;
      groups.push(group);
      b.vias = groups;
      d.board = b;
      return { op: 'add_vias', effect: `${group.id}: ${what}`, ids: ['board'] };
    }
    if (Math.min(pad!.w, pad!.h) < size) reject({ code: 'BOARD_INVALID', message: `${comp.refdes}.${pad!.number} (${pad!.w} × ${pad!.h} mm) is smaller than a ${size} mm via.` });
    // one group per pad: giving it again replaces it
    const was = groups.findIndex((g) => g.kind === 'pad' && g.pad?.componentId === comp.id && g.pad.number === pad!.number);
    group = { id: was >= 0 ? groups[was]!.id : nextId(), netId: netId!, kind: 'pad', pad: { componentId: comp.id, number: pad!.number }, pitch, ...sizes };
    if (was >= 0) groups.splice(was, 1);
    const cols = Math.floor((pad!.w - size) / pitch + 1e-6) + 1;
    const rows = Math.floor((pad!.h - size) / pitch + 1e-6) + 1;
    what = `${cols} × ${rows} thermal vias in ${comp.refdes}.${pad!.number} (${d.nets[netId!]!.name}), ${pitch} mm apart`;
  } else if (op.kind === 'tie') {
    if (!op.at || op.at.length !== 1) reject({ code: 'INVALID_OP', message: 'add_vias kind "tie" needs at: one point, the spot where the net\'s copper crosses to the other layer (mm).' });
    if (!op.net) reject({ code: 'INVALID_OP', message: 'add_vias needs the vias\' net (net: "+3V3").' });
    const net = netOf(op.net!);
    const [p] = op.at!;
    const amps = op.amps ?? net.attrs.maxCurrent;
    const per = viaCurrentFor(drill);
    const n = Math.max(2, Math.min(16, amps ? Math.ceil(amps / per - 1e-6) : 2));
    group = { id: nextId(), netId: net.id, kind: 'tie', points: [[r3(p!.x_mm), r3(p!.y_mm)]], ...(op.amps !== undefined ? { amps: op.amps } : {}), ...(op.pitch_mm !== undefined ? { pitch: op.pitch_mm } : {}), ...sizes };
    what = `${net.name} tie at (${p!.x_mm}, ${p!.y_mm}): ${n} vias ${amps ? `for ${amps} A (about ${Math.round(per * 10) / 10} A each)` : '(no current known: give amps or the net\'s max_current)'}, laid close together by the route step where they fit and join the net's copper on two layers`;
  } else if (op.kind === 'points') {
    if (!op.at) reject({ code: 'INVALID_OP', message: 'add_vias kind "points" needs at (the via centres, mm).' });
    if (!op.net) reject({ code: 'INVALID_OP', message: 'add_vias needs the vias\' net (net: "GND").' });
    const net = netOf(op.net!);
    group = { id: nextId(), netId: net.id, kind: 'points', points: op.at!.map((p) => [r3(p.x_mm), r3(p.y_mm)]), ...sizes };
    what = `${op.at!.length} ${net.name} via${op.at!.length > 1 ? 's' : ''} at ${op.at!.map((p) => `(${p.x_mm}, ${p.y_mm})`).join(', ')}`;
  } else if (op.kind === 'fence' && op.along) {
    if (!op.net) reject({ code: 'INVALID_OP', message: 'add_vias needs the vias\' net (net: "GND").' });
    if (op.under || op.rect) reject({ code: 'INVALID_OP', message: 'A fence runs along a net (along) or round an area (under, rect), not both.' });
    const net = netOf(op.net!);
    const line = netOf(op.along);
    if (line.id === net.id) reject({ code: 'INVALID_OP', message: `A fence of ${net.name} along ${line.name} itself stitches nothing.` });
    // one fence per line: giving it again replaces it
    const was = groups.findIndex((g) => g.kind === 'fence' && g.along === line.id);
    group = { id: was >= 0 ? groups[was]!.id : nextId(), netId: net.id, kind: 'fence', along: line.id, pitch, ...sizes };
    if (was >= 0) groups.splice(was, 1);
    what = `${net.name} via fence along both sides of ${line.name}, ${pitch} mm apart, at its gap to the ground plus half a via (laid by the route step where they fit and join ${net.name} on two layers)`;
  } else {
    if (!op.net) reject({ code: 'INVALID_OP', message: 'add_vias needs the vias\' net (net: "GND").' });
    if (op.along) reject({ code: 'INVALID_OP', message: 'along is for a fence (kind "fence").' });
    if (!op.under === !op.rect) reject({ code: 'INVALID_OP', message: `add_vias kind "${op.kind}" needs its area: under (parts) or rect, one of them.` });
    const net = netOf(op.net!);
    const comps = (op.under ?? []).map((r) => resolveComponent(d, r));
    const area: PlaneArea = op.rect
      ? { rect: [op.rect.x_mm, op.rect.y_mm, op.rect.x_mm + op.rect.width_mm, op.rect.y_mm + op.rect.height_mm] }
      : { under: comps.map((c) => c.id), ...(op.margin_mm !== undefined ? { margin: op.margin_mm } : {}) };
    group = { id: nextId(), netId: net.id, kind: op.kind, area, pitch, ...sizes };
    const where = op.rect ? `${op.rect.width_mm} × ${op.rect.height_mm} mm at (${op.rect.x_mm}, ${op.rect.y_mm})` : comps.map((c) => c.refdes).join(', ');
    what = `${net.name} ${op.kind === 'grid' ? 'stitching vias over' : 'via fence round'} ${where}, ${pitch} mm apart (laid by the route step where they fit)`;
  }
  groups.push(group);
  b.vias = groups;
  d.board = b;
  return { op: 'add_vias', effect: `${group.id}: ${what}`, ids: ['board'] };
}


/**
 * Place a part: the user's choice (a soft position constraint, relative to the part's parent so
 * it follows when that moves), or with `lock` exactly there (hard). One per part; placing again
 * replaces it, keeping a rotation chosen before unless a new one is given.
 */
export function place(d: Design, op: Extract<EditOp, { op: 'place' }>, by: 'user' | 'agent' = 'agent'): OpResult {
  const comp = resolveComponent(d, op.ref);
  if (!d.board?.placement) keepPlacement(d); // start from what the user sees
  const flipped = op.side ? setSide(d, comp, op.side) : false;
  const now = placedOf(d);
  let rot: number | undefined = op.rot;
  let prevRel: string | undefined;
  let wasUsers = false;
  for (const k of Object.values(d.ledger)) {
    if (k.kind !== 'position' || k.a !== comp.id) continue;
    if (madeBy(k) === 'user') wasUsers = true;
    if (rot === undefined && k.rot !== undefined) {
      // a rotation relative to an anchor: back to the board frame
      const anchor = k.rel ? now.parts.find((p) => p.componentId === k.rel) : undefined;
      rot = anchor ? (anchor.rot + k.rot) % 360 : k.rot;
    }
    prevRel = k.rel;
    delete d.ledger[k.id];
  }
  const id = nextId(d, 'k');
  const r = (v: number) => Math.round(v * 1000) / 1000;
  // the agent placing a part on the user's word makes it the user's choice
  const source: Constraint['source'] = by === 'user' ? { type: 'user' } : op.quote ? { type: 'user', quote: op.quote } : { type: 'agent' };
  const part = now.parts.find((p) => p.componentId === comp.id);
  const anchorRef = part?.follows ?? (prevRel ? d.components[prevRel]?.refdes : undefined);
  const anchor = !op.lock && anchorRef ? now.parts.find((p) => p.refdes === anchorRef) : undefined;
  if (anchor) {
    // offset and rotation in the anchor's frame
    const dx = op.x_mm - anchor.x;
    const dy = op.y_mm - anchor.y;
    const back = (360 - anchor.rot) % 360;
    const [ox, oy] = back === 90 ? [-dy, dx] : back === 180 ? [-dx, -dy] : back === 270 ? [dy, -dx] : [dx, dy];
    d.ledger[id] = {
      id,
      kind: 'position',
      a: comp.id,
      rel: anchor.componentId,
      xMm: r(ox),
      yMm: r(oy),
      ...(rot !== undefined && { rot: (((rot - anchor.rot) % 360) + 360) % 360 }),
      domain: 'placement',
      strength: 'soft',
      source,
    };
  } else {
    d.ledger[id] = {
      id,
      kind: 'position',
      a: comp.id,
      xMm: r(op.x_mm),
      yMm: r(op.y_mm),
      ...(rot !== undefined && { rot }),
      domain: 'placement',
      strength: op.lock ? 'hard' : 'soft',
      source,
    };
  }
  keepPlacement(d);
  const at = `(${r(op.x_mm)}, ${r(op.y_mm)}) mm${rot !== undefined ? `, ${rot}°` : ''}`;
  const overrode = wasUsers && source.type === 'agent' ? ` (it was the user's placement; now yours)` : '';
  return { op: 'place', effect: `${op.lock ? `${comp.refdes} locked at ${at}` : `${comp.refdes} placed at ${at}${anchor ? ` (kept relative to ${anchor.refdes})` : ''}`}${flipped ? `, on the ${op.side} side` : ''}${overrode}`, ids: [id] };
}

/**
 * Put a part on the top or the bottom side: the `layer` constraint (one per part; top is the
 * default, so it leaves none). Returns whether the side changed. A hard `layer` constraint of the
 * user's is refused like constrain refuses it.
 */
function setSide(d: Design, comp: Component, side: 'top' | 'bottom'): boolean {
  const had = Object.values(d.ledger).some((k) => k.kind === 'layer' && k.a === comp.id && k.value === 'bottom') ? 'bottom' : 'top';
  if (had === side) return false;
  const made = constrain(d, { op: 'constrain', kind: 'layer', a: comp.refdes, value: side, strength: 'soft' });
  if (side === 'top') for (const id of made.ids ?? []) delete d.ledger[id];
  return true;
}

/**
 * Which part a part belongs with on the board (a `belongs` entry, one per part), instead of the
 * placer's guess: it stays at that part (at the pin it serves, if given) and follows it. A part
 * the agent or the placer put somewhere goes to its new parent; one the user placed stays where
 * it is, kept relative to the new parent.
 */
export function attach(d: Design, op: Extract<EditOp, { op: 'attach' }>, by: 'user' | 'agent'): OpResult {
  const comp = resolveComponent(d, op.ref);
  const to = op.to === null ? null : resolveComponent(d, op.to);
  if (to?.id === comp.id) reject({ code: 'BOARD_INVALID', message: `${comp.refdes} cannot belong with itself.` });
  if (!to && op.pin) reject({ code: 'BOARD_INVALID', message: 'pin needs a part to belong with (to).' });
  // no circles: the new parent must not belong with this part, directly or through others
  const declared = (id: string) => Object.values(d.ledger).find((k) => k.kind === 'belongs' && k.a === id);
  for (let at = to?.id, n = 0; at && n < 100; at = declared(at)?.b, n++) {
    if (at === comp.id) reject({ code: 'BOARD_INVALID', message: `${to!.refdes} belongs with ${comp.refdes} (directly or through other parts); ${comp.refdes} cannot belong with ${to!.refdes} as well.` });
  }
  let pin: { number: string; label: string } | undefined;
  if (to && op.pin) {
    const pins = resolvePins(d, `${to.refdes}.${op.pin}`);
    if (pins.length > 1) reject({ code: 'PIN_UNKNOWN', message: `${to.refdes}.${op.pin} is ${pins.length} pins (${pins.map((h) => h.pin.number).join(', ')}): give the number of the one ${comp.refdes} serves.`, candidates: pins.map((h) => `${to.refdes}.${h.pin.number}`) });
    const net = to.pins[pins[0]!.pin.number];
    if (!net || !Object.values(comp.pins).includes(net)) {
      reject({ code: 'BOARD_INVALID', message: `${comp.refdes} is not connected to ${pinLabel(pins[0]!)}${net ? ` (${d.nets[net]?.name ?? net})` : ''}: a part goes at a pin it shares a net with.` });
    }
    pin = { number: pins[0]!.pin.number, label: pinLabel(pins[0]!) };
  }
  if (!d.board?.placement) keepPlacement(d); // start from what the user sees
  const before = placedOf(d).parts.find((p) => p.componentId === comp.id);
  for (const k of Object.values(d.ledger)) if (k.kind === 'belongs' && k.a === comp.id) delete d.ledger[k.id];
  const id = nextId(d, 'k');
  d.ledger[id] = { id, kind: 'belongs', a: comp.id, ...(to ? { b: to.id } : {}), ...(pin ? { key: pin.number } : {}), domain: 'placement', strength: 'soft', source: { type: by } };
  // where it stands: the user's place stays (relative to the new parent); else it goes to the parent
  const own = Object.values(d.ledger).find((k) => k.kind === 'position' && k.a === comp.id);
  let kept = '';
  if (own && (madeBy(own) === 'user' || own.strength === 'hard')) {
    kept = own.strength === 'hard' ? ' (locked: it stays where it is)' : " (the user's placement: it stays where it is)";
    const anchor = to && placedOf(d).parts.find((p) => p.componentId === to.id);
    if (own.strength === 'soft' && before) {
      const r = (v: number) => Math.round(v * 1000) / 1000;
      if (anchor) {
        const [dx, dy] = [before.x - anchor.x, before.y - anchor.y];
        const back = (360 - anchor.rot) % 360;
        const [ox, oy] = back === 90 ? [-dy, dx] : back === 180 ? [-dx, -dy] : back === 270 ? [dy, -dx] : [dx, dy];
        Object.assign(own, { rel: anchor.componentId, xMm: r(ox), yMm: r(oy), rot: (((before.rot - anchor.rot) % 360) + 360) % 360 });
      } else {
        delete own.rel;
        Object.assign(own, { xMm: before.x, yMm: before.y, rot: before.rot });
      }
    }
  } else if (to) {
    if (own) delete d.ledger[own.id];
    delete d.board!.placement!.parts[comp.id]; // placed afresh, at its parent
  }
  keepPlacement(d);
  const what = to ? `${comp.refdes} belongs with ${to.refdes}${pin ? ` at ${pin.label}` : ''}` : `${comp.refdes} stands on its own (no parent part)`;
  return { op: 'attach', effect: `${what}${kept}`, ids: [id] };
}

/**
 * A fresh proposal: board size (unless set) and placement, keeping locked parts (and choices).
 * With parts, the agent's arrangement of the main parts: each a choice (soft, in board
 * coordinates) the placer keeps, placing the small parts round them.
 */
export function proposePlacement(d: Design, op: Extract<EditOp, { op: 'propose_placement' }>, by: 'user' | 'agent' = 'agent'): OpResult {
  const given = (op.parts ?? []).map((p) => ({ p, comp: resolveComponent(d, p.ref) }));
  const twice = given.find((g, i) => given.findIndex((h) => h.comp.id === g.comp.id) !== i);
  if (twice) reject({ code: 'BOARD_INVALID', message: `${twice.comp.refdes} is given twice in parts.` });
  if ((op.width_mm === undefined) !== (op.height_mm === undefined)) reject({ code: 'BOARD_INVALID', message: 'Give both width_mm and height_mm, or neither.' });
  const ids = new Set(given.map((g) => g.comp.id));
  for (const k of Object.values(d.ledger)) {
    if (k.kind === 'position' && k.strength === 'hard' && k.a && ids.has(k.a)) {
      reject({ code: 'BOARD_INVALID', message: `${d.components[k.a]?.refdes} is locked (${k.id}); leave it out of parts, or unlock it first (remove_constraint ${k.id}).`, fixHints: [{ op: 'remove_constraint', id: k.id }] });
    }
  }
  // the parts the user placed are their decision: the agent arranges round them
  const users = (k: Constraint) => by === 'agent' && madeBy(k) === 'user';
  const theirs = Object.values(d.ledger).filter((k) => k.kind === 'position' && k.a && ids.has(k.a) && users(k));
  if (theirs.length) {
    const refs = theirs.map((k) => d.components[k.a!]?.refdes ?? k.a!);
    reject({ code: 'BOARD_INVALID', message: `${refs.join(', ')} ${refs.length > 1 ? 'were' : 'was'} placed by the user: leave ${refs.length > 1 ? 'them' : 'it'} out of parts and arrange round ${refs.length > 1 ? 'them' : 'it'}. Move a part of theirs only where routing cannot do without it, with place, and tell the user.` });
  }
  let forgot = 0;
  for (const k of Object.values(d.ledger)) {
    if (k.kind !== 'position' || k.strength !== 'soft' || !k.a) continue;
    if (ids.has(k.a)) delete d.ledger[k.id];
    else if (op.keep_choices === false && !users(k)) {
      delete d.ledger[k.id];
      forgot++;
    }
  }
  if (op.width_mm !== undefined) setBoard(d, { op: 'set_board', width_mm: op.width_mm, height_mm: op.height_mm });
  const r = (v: number) => Math.round(v * 1000) / 1000;
  // (the sides first: turning a part over keeps the placement as it stands, which must not hold the new choices yet)
  for (const { p, comp } of given) if (p.side) setSide(d, comp, p.side);
  const choices = given.map(({ p, comp }) => {
    const id = nextId(d, 'k');
    d.ledger[id] = { id, kind: 'position', a: comp.id, xMm: r(p.x_mm), yMm: r(p.y_mm), rot: p.rot ?? 0, domain: 'placement', strength: 'soft', source: { type: by } };
    return d.ledger[id]!;
  });
  const b = boardCopy(d);
  delete b.placement;
  delete b.routed;
  d.board = b;
  const now = placedOf(d);
  b.placement = storedPlacement(now);
  // each choice where its part ended up (the board fitted round the arrangement may have moved it over)
  for (const k of choices) {
    const part = now.parts.find((x) => x.componentId === k.a);
    if (part) Object.assign(k, { xMm: part.x, yMm: part.y });
  }
  const placed = now.parts.filter((p) => !p.componentId.startsWith('hole:')).length;
  // (by default with the agent's arrangement of the main parts; the placer's own proposal routed
  // no better refined on the benches, its arrangement being the placer's guess anyway)
  const refined = (op.refine ?? given.length > 0) ? refineSmallParts(d) : null;
  const m = refined?.after ?? now.measures;
  return {
    op: 'propose_placement',
    effect: `placement proposed: ${now.outline.w} × ${now.outline.h} mm${now.sizeBy === 'user' ? ' (your size)' : ''}, ${placed} parts${given.length ? `, ${given.map((g) => g.comp.refdes).join(', ')} where you put them` : ''}${forgot ? `, ${forgot} placement choice(s) forgotten` : ''}; ratsnest ${m.ratsnestMm} mm, ${m.crossings} crossing(s), congestion ${m.congestion.overflowMm} mm${refined?.moved.length ? ` (the small parts refined: ${refined.moved.length} moved or turned, from ${refined.before.ratsnestMm} mm, ${refined.before.crossings} crossings, congestion ${refined.before.congestion.overflowMm} mm)` : ''}`,
    ids: ['board', ...given.map((g) => g.comp.id)],
  };
}

/**
 * Refine the small parts the placer put down (refine.ts): moved a little and turned where that
 * untangles the ratsnest and eases the congestion. Checked on the placement as the placer then
 * makes it, and kept only if its measures are better (the routability score: 4 × crossings +
 * ratsnest mm + 8 × congestion mm). `only`: these components at most.
 */
export function refineSmallParts(d: Design, only?: Set<string>): { moved: RefineMove[]; before: BoardView['measures']; after: BoardView['measures'] } {
  if (!d.board?.placement) keepPlacement(d);
  const b0 = placedOf(d);
  const before = b0.measures;
  const movable = new Set([...refinable(b0)].filter((id) => !only || only.has(id)));
  const none = { moved: [], before, after: before };
  if (!movable.size) return none;
  const planeNets = new Set(b0.planes.filter((pl) => pl.layer !== 'F.Cu' && pl.layer !== 'B.Cu' && !pl.area).map((pl) => pl.netId));
  const r = refinePlacement(b0, movable, planeNets, 1.5 + b0.rules.edgeClearance);
  if (!r.moves.length) return none;
  const saved = structuredClone(d.board!.placement!);
  for (const mv of r.moves) d.board!.placement!.parts[mv.componentId] = { x: mv.x, y: mv.y, rot: mv.rot };
  const b1 = placedOf(d);
  const after = b1.measures;
  if (!(routability(after) < routability(before) - 0.05)) {
    d.board!.placement = saved;
    return none;
  }
  // as the placer left it (a part it had to nudge clear of another is stored where it ended up)
  d.board!.placement = storedPlacement(b1);
  return { moved: r.moves, before, after };
}

/** What refinement did, in words: "R3 turned 90°, C5 moved 0.5 mm right, …". */
function refineText(moves: RefineMove[]): string {
  const dir = (dx: number, dy: number) => {
    const d = Math.round(Math.hypot(dx, dy) * 10) / 10;
    const h = Math.abs(dx) < 0.05 ? '' : dx > 0 ? 'right' : 'left';
    const v = Math.abs(dy) < 0.05 ? '' : dy > 0 ? 'down' : 'up';
    return `moved ${d} mm ${[v, h].filter(Boolean).join(' and ')}`;
  };
  const one = (mv: RefineMove) => {
    const turn = (((mv.rot - mv.was.rot) % 360) + 360) % 360;
    const moved = Math.hypot(mv.x - mv.was.x, mv.y - mv.was.y) >= 0.05;
    return `${mv.refdes} ${[turn ? `turned ${turn}°` : '', moved ? dir(mv.x - mv.was.x, mv.y - mv.was.y) : ''].filter(Boolean).join(', ')}`;
  };
  return moves.slice(0, 12).map(one).join('; ') + (moves.length > 12 ? `; ${moves.length - 12} more` : '');
}

/** refine_placement: the small parts refined, all of them or those given (parts) or near some (near). */
export function refineStep(d: Design, op: Extract<EditOp, { op: 'refine_placement' }>): OpResult {
  if (!d.board?.placement) keepPlacement(d);
  const b = placedOf(d);
  if (!b.parts.length) reject({ code: 'BOARD_INVALID', message: 'Nothing to refine: the board has no parts.' });
  let only: Set<string> | undefined;
  if (op.parts) only = new Set(op.parts.map((r) => resolveComponent(d, r).id));
  if (op.near) {
    const around = op.near.map((r) => b.parts.find((p) => p.componentId === resolveComponent(d, r).id)).filter((p) => !!p);
    const near = (p: (typeof b.parts)[number]) => around.some((a) => Math.max(a.courtyard.x - (p.courtyard.x + p.courtyard.w), p.courtyard.x - (a.courtyard.x + a.courtyard.w), a.courtyard.y - (p.courtyard.y + p.courtyard.h), p.courtyard.y - (a.courtyard.y + a.courtyard.h)) <= 5);
    const ids = new Set(b.parts.filter(near).map((p) => p.componentId));
    only = only ? new Set([...only].filter((id) => ids.has(id))) : ids;
  }
  const mine = new Set([...refinable(b)].filter((id) => !only || only.has(id)));
  if (!mine.size) return { op: 'refine_placement', effect: 'nothing to refine: no small part the placer put down among them (parts you or the user placed or locked, and connectors, stay as they are)', ids: [] };
  const r = refineSmallParts(d, only);
  if (!r.moved.length) return { op: 'refine_placement', effect: `no better place found for the ${mine.size} small part(s): ratsnest ${r.before.ratsnestMm} mm, ${r.before.crossings} crossing(s), congestion ${r.before.congestion.overflowMm} mm as they are. If the tangle remains, move or turn the main parts (try_placements)`, ids: [] };
  return {
    op: 'refine_placement',
    effect: `${r.moved.length} small part(s) moved or turned: ratsnest ${r.before.ratsnestMm} → ${r.after.ratsnestMm} mm, crossings ${r.before.crossings} → ${r.after.crossings}, congestion ${r.before.congestion.overflowMm} → ${r.after.congestion.overflowMm} mm. ${refineText(r.moved)}`,
    ids: ['board', ...r.moved.map((m) => m.componentId)],
  };
}

/** The route step: route the board as placed now (the board view routes while this placement stays). */
export function routeStep(d: Design): OpResult {
  if (!d.board?.placement) keepPlacement(d);
  const now = placedOf(d);
  if (!now.parts.length) reject({ code: 'BOARD_INVALID', message: 'Nothing to route: the board has no parts.' });
  d.board!.routed = now.placementKey;
  // a routing the user stopped is routed again from the start
  if (d.board!.copper?.stopped) delete d.board!.copper;
  return { op: 'route', effect: 'board routed as placed', ids: ['board'] };
}
