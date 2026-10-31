/**
 * The ops on the enclosure: the brief agreed with the user, the script, and the graphics on the box.
 */
import { type Design, type EditOp, type EnclosureGraphic, openQuestions, type OpResult, pointBounds, scriptGraphics, scriptPieces, scriptProblems } from '@4k7/schema';
import { findArtwork, listArtwork } from './artwork.ts';
import { natCmp, reject } from './doc.ts';
import { r3 } from './geom.ts';
import { pathFigures } from './outline.ts';

/** The enclosure's brief (replaced as a whole). */
export function setEnclosureBrief(d: Design, op: Extract<EditOp, { op: 'set_enclosure_brief' }>): OpResult {
  if (!op.brief) {
    if (d.enclosure) delete d.enclosure.brief;
    pruneEnclosure(d);
    return { op: 'set_enclosure_brief', effect: 'enclosure brief removed', ids: ['enclosure'] };
  }
  const refs = new Set(Object.values(d.components).map((c) => c.refdes));
  const unknown = [...new Set([...(op.brief.openings ?? []), ...op.brief.items.flatMap((i) => i.refs ?? [])])].filter((r) => !refs.has(r));
  if (unknown.length) reject({ code: 'REF_UNKNOWN', message: `No part ${unknown.join(', ')} in the design.`, candidates: [...refs].sort(natCmp).slice(0, 40) });
  const bad = op.brief.items.filter((i) => !i.decision && !i.question);
  if (bad.length) reject({ code: 'ENCLOSURE_INVALID', message: `Every item is decided or a question: ${bad.map((i) => i.topic).join(', ')} has neither.` });
  const noOptions = op.brief.items.filter((i) => i.question && !i.decision && !i.options);
  if (noOptions.length) reject({ code: 'ENCLOSURE_INVALID', message: `Give the user 2–4 options (your pick first) for: ${noOptions.map((i) => i.topic).join(', ')}.` });
  d.enclosure = { ...d.enclosure, brief: structuredClone(op.brief) };
  const open = openQuestions(op.brief).length;
  return {
    op: 'set_enclosure_brief',
    effect: `enclosure brief: ${op.brief.items.length} item(s), ${open ? `${open} question(s) for the user (they answer in the app)` : 'all decided'}${op.brief.openings?.length ? `, openings for ${op.brief.openings.join(', ')}` : ''}`,
    ids: ['enclosure'],
  };
}

/** The enclosure's script (replaced as a whole), checked before it can be rendered. */
export function setEnclosureScript(d: Design, op: Extract<EditOp, { op: 'set_enclosure_script' }>): OpResult {
  if (op.script === null) {
    if (d.enclosure) delete d.enclosure.script;
    pruneEnclosure(d);
    return { op: 'set_enclosure_script', effect: 'enclosure script removed', ids: ['enclosure'] };
  }
  const problems = scriptProblems(op.script);
  // graphics it draws must be in the design first (set_enclosure_graphic)
  const have = (d.enclosure?.graphics ?? []).map((g) => g.name);
  for (const name of new Set(scriptGraphics(op.script))) {
    if (!have.includes(name)) problems.push(`graphic('${name}'): there is no such graphic; add it first with set_enclosure_graphic (from the artwork library or an SVG path)${have.length ? `, or use one there is: ${have.join(', ')}` : ''}.`);
  }
  if (problems.length) reject({ code: 'ENCLOSURE_INVALID', message: `The script cannot be rendered yet:\n- ${problems.join('\n- ')}` });
  d.enclosure = { ...d.enclosure, script: op.script };
  const lines = op.script.split('\n').length;
  return { op: 'set_enclosure_script', effect: `enclosure script: ${lines} lines, pieces ${scriptPieces(op.script)!.join(', ')}; render it with render_enclosure`, ids: ['enclosure'] };
}

/** No brief, script or graphics: no enclosure. */
function pruneEnclosure(d: Design) {
  const e = d.enclosure;
  if (e && !e.graphics?.length) delete e.graphics;
  if (e && !e.brief && !e.script && !e.graphics) delete d.enclosure;
}

/** Most points a graphic for the box may have (a traced picture with fine dots has many). */
const MAX_GRAPHIC_POINTS = 100_000;

/** A graphic for the box (a logo, an icon), copied into the design: the script draws it as graphic(name). */
export function setEnclosureGraphic(d: Design, op: Extract<EditOp, { op: 'set_enclosure_graphic' }>): OpResult {
  const list = [...(d.enclosure?.graphics ?? [])];
  const at = list.findIndex((g) => g.name === op.name);
  if (op.remove) {
    if (at < 0) reject({ code: 'REF_UNKNOWN', message: `No graphic "${op.name}" for the box.`, candidates: list.map((g) => g.name) });
    const used = d.enclosure?.script ? scriptGraphics(d.enclosure.script).includes(op.name) : false;
    list.splice(at, 1);
    d.enclosure = { ...d.enclosure, graphics: list };
    pruneEnclosure(d);
    return { op: 'set_enclosure_graphic', effect: `graphic "${op.name}" removed${used ? '; the script still draws it: take it out of the script, or the render fails' : ''}`, ids: ['enclosure'] };
  }
  if (!!op.artwork === !!op.svg_path) reject({ code: 'ENCLOSURE_INVALID', message: 'set_enclosure_graphic needs artwork (a saved one, by name) or svg_path, one of them.' });
  let figs: number[][];
  let mode: EnclosureGraphic['mode'] = 'fill';
  let line: number | undefined;
  let source: string;
  if (op.artwork) {
    const art = findArtwork(op.artwork);
    if (!art) reject({ code: 'REF_UNKNOWN', message: `No saved artwork "${op.artwork}". The user imports logos (SVG, or a picture traced) in Parts → Artwork.`, candidates: listArtwork().map((a) => a.name) });
    figs = art!.polys;
    mode = art!.mode;
    if (mode === 'outline') line = art!.line ?? 0.2;
    source = `artwork ${art!.name}`;
  } else {
    const parsed = pathFigures(op.svg_path!);
    if (!parsed.ok) reject({ code: 'ENCLOSURE_INVALID', message: `The graphic's path: ${parsed.reason}.` });
    figs = parsed.figs;
    source = 'SVG path';
  }
  const [x0, y0, x1, y1] = pointBounds(figs);
  const [w, h] = [x1 - x0, y1 - y0];
  if (!(w > 0) || !(h > 0)) reject({ code: 'ENCLOSURE_INVALID', message: 'The graphic has no area.' });
  const points = figs.reduce((n, p) => n + p.length / 2, 0);
  if (points > MAX_GRAPHIC_POINTS) reject({ code: 'ENCLOSURE_INVALID', message: `The graphic has ${points} points, more than ${MAX_GRAPHIC_POINTS}: trace the picture with larger dots, or simplify the SVG.` });
  const g: EnclosureGraphic = {
    name: op.name,
    mode,
    ...(line ? { line } : {}),
    polys: figs.map((p) => p.map((v, i) => r3(v - (i % 2 === 0 ? (x0 + x1) / 2 : (y0 + y1) / 2)))),
    w: r3(w),
    h: r3(h),
    source,
  };
  if (at >= 0) list[at] = g;
  else list.push(g);
  d.enclosure = { ...d.enclosure, graphics: list };
  return {
    op: 'set_enclosure_graphic',
    effect: `graphic "${g.name}" for the box (${source}): ${g.mode === 'fill' ? 'filled' : `outlines ${g.line} mm`}, ${figs.length} figure(s), ${points} points, ${g.w} × ${g.h} as stored; draw it with graphic('${g.name}', { width: … }) (2D, centred) and emboss, engrave or inlay it like a label`,
    ids: ['enclosure'],
  };
}
