/**
 * The ops on how the schematic is arranged: symbols and blocks put somewhere, the auto-layout asked
 * to draw again, the paper, the description of what the design does.
 */
import { GRID, isTwoPin, unitCount } from '@4k7/parts';
import { DEFAULT_PAPER, type DescriptionView, type Design, type EditOp, type OpResult, PAGE, PAPERS, type Rect } from '@4k7/schema';
import { wirePlaced } from './autowire.ts';
import { cardOf, closest, natCmp, nextId, reject, resolveComponent, resolveUnitRef } from './doc.ts';
import { isDrawn, moveSymbol, ownSheet, redrawBlock, redrawParts, releaseSheet, syncDrawing, viewOf } from './drawing.ts';
import { rewire, wiredPins } from './drawops.ts';
import { overlap } from './geom.ts';
import { blockAssignment } from './layout.ts';

/**
 * Move a part on the schematic (drawing.ts moveSymbol): the first move on a sheet stores its
 * drawing, which is kept from then on. The page is given as the design counts pages. A
 * `sch_position` ledger entry of earlier versions on the part goes: the drawing says it now.
 */
export function placeSymbol(d: Design, op: Extract<EditOp, { op: 'place_symbol' }>, by: 'user' | 'agent'): OpResult {
  const { comp, unit } = resolveUnitRef(d, op.ref);
  const label = `${comp.refdes}${unit ?? ''}`;
  const old = Object.values(d.ledger).filter((k) => k.kind === 'sch_position' && k.a === comp.id && (k.aUnit ?? '') === (unit ?? ''));
  for (const k of old) delete d.ledger[k.id];
  if (op.auto) {
    const again = redrawParts(d, comp.sheet, new Set([comp.id]));
    return { op: op.op, effect: again ? `${label} drawn afresh in free space` : old.length ? `${label} handed back to the layout` : `${label} is drawn by the layout already`, ids: old.map((k) => k.id) };
  }
  if (op.x === undefined || op.y === undefined) reject({ code: 'INVALID_OP', message: `place_symbol needs x and y (the centre of ${label}'s symbol, mils from the paper's top-left corner), or auto: true. design_query get_schematic shows where everything is now.` });
  const card = cardOf(d, comp.part);
  const twoPin = !!card && isTwoPin(card);
  syncDrawing(d); // parts added earlier in this transaction are drawn first
  const view = viewOf(d);
  const sheet = view.sheets.find((s) => s.id === comp.sheet)!;
  const drawnTwoPin = twoPin || !!sheet.symbols.find((s) => s.componentId === comp.id && (unit === undefined || s.unit === unit))?.twoPin;
  if (op.orient && !drawnTwoPin) reject({ code: 'INVALID_OP', message: `orient is for two-pin parts; ${label} is drawn by its symbol: give it rotate (0, 90, 180 or 270 degrees clockwise from how it is usually drawn).` });
  if (op.rotate !== undefined && drawnTwoPin) reject({ code: 'INVALID_OP', message: `rotate is for the symbols that are no two-pin parts; ${label} stands or lies: give it orient "upright" or "lying", and mirror to swap its ends.` });
  const first = sheet.pages[0]!.number;
  const last = sheet.pages.at(-1)!.number;
  let page: number;
  if (op.page === undefined) {
    const sym = sheet.symbols.find((s) => s.componentId === comp.id && (unit === undefined || s.unit === unit));
    const cx = sym ? sym.bbox.x + sym.bbox.w / 2 : 0;
    const cy = sym ? sym.bbox.y + sym.bbox.h / 2 : 0;
    page = Math.max(1, sheet.pages.findIndex((p) => cx >= p.rect.x && cx <= p.rect.x + p.rect.w && cy >= p.rect.y && cy <= p.rect.y + p.rect.h) + 1);
  } else {
    const lastSheet = view.sheets.at(-1)!.id === sheet.id;
    if (op.page < first || (op.page > last && !lastSheet)) {
      reject({ code: 'INVALID_OP', message: `${label} is on sheet ${sheet.name}, pages ${first}–${last}; move it to the other sheet first (move_to_sheet) to put it on page ${op.page}.` });
    }
    page = op.page - first + 1;
  }
  const taken = !isDrawn(d, comp.sheet);
  const unitOf = unit ?? (card && unitCount(card) > 1 ? card.units![0]!.name : undefined);
  // the wires it has now, to wire again what the move cuts
  const wiredBefore = op.rewire ? wiredPins(d, ownSheet(d, comp.sheet)) : [];
  const at = moveSymbol(d, comp.sheet, comp, unitOf, page, op.x, op.y, { ...(op.orient ? { orient: op.orient } : {}), ...(op.mirror !== undefined ? { mirror: op.mirror } : {}), ...(op.rotate !== undefined ? { rotate: op.rotate } : {}) });
  const mine = d.drawing![comp.sheet]!.symbols.find((s) => s.comp === comp.id && (s.unit ?? undefined) === unitOf)!;
  const wasUsers = mine.by === 'user';
  // a drag or turn in the app is the user's decision, kept when the agent redraws; the agent's own move is its own again
  if (by === 'user') mine.by = 'user';
  else delete mine.by;
  // the user's drag joins again what was wired before; an agent's two-pin part on its own is wired to its neighbours where that is clean, else labels connect it
  const wires = wiredBefore.length ? rewire(d, comp.sheet, wiredBefore) : undefined;
  const wired = twoPin && !op.rewire ? wirePlaced(d, comp) : undefined;
  const asked = [op.mirror !== undefined ? (op.mirror ? 'mirrored' : 'not mirrored') : '', op.rotate !== undefined ? `rotated ${op.rotate}°` : ''].filter(Boolean).join(' and ');
  const notes = [
    taken ? `sheet ${sheet.name} is drawn as you arrange it from now on` : '',
    asked && !at.relooked ? `it is ${asked} already, so that changed nothing${op.mirror !== undefined ? `: mirror ${!op.mirror} draws it the other way round` : ''}` : asked && !op.orient ? `now ${asked}` : '',
    at.relooked && at.pins ? `pins: ${at.pins}` : '',
    at.under ? `it lies on ${at.under}: move one of them` : '',
    at.round.length ? `wires of ${at.round.join(', ')} moved round it` : '',
    at.behind.length ? `wires of ${at.behind.join(', ')} still run behind it (no clear way round: a pin of theirs may lie under it)` : '',
    wired?.wired.length ? `wired ${wired.wired.join(', ')}` : '',
    wired?.labelled.length ? `connected by labels: ${wired.labelled.join('; ')}` : '',
    wires ? `${wires.wired} wire${wires.wired === 1 ? '' : 's'} drawn again${wires.left ? `, ${wires.left} connection${wires.left === 1 ? '' : 's'} left to labels (no clear path)` : ''}` : '',
    wasUsers && by === 'agent' ? "it was the user's placement; now yours" : '',
  ].filter(Boolean);
  return { op: op.op, effect: `${label} placed on page ${first + page - 1} at (${at.x}, ${at.y}) mils${notes.length ? `; ${notes.join('; ')}` : ''}`, ids: [comp.id] };
}

/** Let the auto-layout draw a sheet again, or some parts afresh in free space (drawing.ts). */
export function autoDraw(d: Design, op: Extract<EditOp, { op: 'auto_draw' }>): OpResult {
  const comps = (op.refs ?? []).map((r) => resolveComponent(d, r));
  const byName = op.sheet !== undefined ? Object.values(d.sheets).find((s) => s.name.toLowerCase() === op.sheet!.toLowerCase()) : undefined;
  if (op.sheet !== undefined && !byName) reject({ code: 'REF_UNKNOWN', message: `No sheet "${op.sheet}".`, candidates: Object.values(d.sheets).map((s) => s.name) });
  if (comps.length) {
    const sheets = new Set(comps.map((c) => c.sheet));
    const done: string[] = [];
    for (const sid of sheets) {
      const mine = comps.filter((c) => c.sheet === sid);
      if (redrawParts(d, sid, new Set(mine.map((c) => c.id)))) done.push(...mine.map((c) => c.refdes));
    }
    const rest = comps.map((c) => c.refdes).filter((r) => !done.includes(r));
    return { op: op.op, effect: [done.length ? `${done.join(', ')} drawn afresh in free space` : '', rest.length ? `${rest.join(', ')}: drawn by the layout already` : ''].filter(Boolean).join('; '), ids: comps.map((c) => c.id) };
  }
  const targets = byName ? [byName] : Object.values(d.sheets);
  const released = targets.filter((s) => releaseSheet(d, s.id));
  // a sheet with a net forced to be drawn one way is stored again once the layout has drawn it
  const forcedOn = (id: string) => Object.values(d.nets).filter((n) => n.attrs.drawAs && Object.values(d.components).some((c) => c.sheet === id && Object.values(c.pins).includes(n.id))).map((n) => n.name);
  const freed = released.filter((s) => !forcedOn(s.id).length).map((s) => s.name);
  const kept = released.filter((s) => forcedOn(s.id).length).map((s) => `${s.name}: drawn afresh by the auto-layout, then kept as drawn, because ${forcedOn(s.id).join(', ')} is forced to be drawn one way (set_net draw_as)`);
  const said = [freed.length ? `${freed.join(', ')}: drawn by the auto-layout again, afresh after every change` : '', ...kept].filter(Boolean).join('; ');
  return { op: op.op, effect: said || `${targets.map((s) => s.name).join(', ')}: drawn by the auto-layout already`, ids: targets.map((s) => s.id) };
}

/**
 * Put a functional block roughly where it belongs (docs/design/schematic-drawing.md §2b): on a
 * sheet the layout draws, a sch_block ledger entry the layout puts the block's frame at, flowing
 * the other blocks around it; on a sheet drawn as the agent arranged it, the block drawn afresh
 * there (drawing.ts redrawBlock). The page is given as the design counts pages.
 */
export function placeBlock(d: Design, op: Extract<EditOp, { op: 'place_block' }>, by: 'user' | 'agent'): OpResult {
  const blocks = d.description?.blocks ?? [];
  const want = op.block.trim();
  const block = blocks.find((b) => b.title === want) ?? blocks.find((b) => b.title.toLowerCase() === want.toLowerCase());
  if (!block) {
    reject({
      code: 'REF_UNKNOWN',
      message: blocks.length ? `No block "${op.block}".` : 'The design has no functional blocks yet: group its parts first (describe blocks: a title and the parts of each).',
      candidates: closest(want, blocks.map((b) => b.title)),
    });
  }
  const title = block!.title;
  if (op.auto) {
    const gone = Object.values(d.ledger).filter((k) => k.kind === 'sch_block' && k.key === title);
    for (const k of gone) delete d.ledger[k.id];
    return { op: 'place_block', effect: gone.length ? `block "${title}" flows with the others again` : `block "${title}" was not placed; it flows with the others`, ids: gone.map((k) => k.id) };
  }
  if (op.x === undefined || op.y === undefined) {
    reject({ code: 'INVALID_OP', message: `place_block needs x and y (the centre of the block's frame, mils from the paper's top-left corner), or auto: true. design_query get_schematic shows the blocks, their frames and the pages.` });
  }
  syncDrawing(d); // parts added earlier in this transaction are drawn first
  const view = viewOf(d);
  // the sheets the block has parts on (the ones put with it included)
  const on = view.sheets.filter((s) => blockAssignment(d, s.id)?.blocks.some((b) => b.title === title));
  if (!on.length) reject({ code: 'INVALID_OP', message: `Block "${title}" has no parts drawn on any sheet.` });
  let sheet = on[0]!;
  let page: number;
  if (op.page !== undefined) {
    const s = view.sheets.find((v) => v.pages.some((p) => p.number === op.page)) ?? (op.page > view.sheets.at(-1)!.pages.at(-1)!.number ? view.sheets.at(-1) : undefined);
    if (!s || !on.includes(s)) {
      reject({ code: 'INVALID_OP', message: `Page ${op.page} is ${s ? `on sheet ${s.name}` : 'not in the design'}; block "${title}" has its parts on ${on.map((x) => `sheet ${x.name} (pages ${x.pages[0]!.number}–${x.pages.at(-1)!.number})`).join(', ')}. Move its parts to that sheet first (move_to_sheet).` });
    }
    sheet = s!;
    page = op.page - sheet.pages[0]!.number + 1;
  } else {
    const frame = sheet.blocks?.find((b) => b.title === title);
    const cx = frame ? frame.rect.x + frame.rect.w / 2 : 0;
    const cy = frame ? frame.rect.y + frame.rect.h / 2 : 0;
    page = Math.max(1, sheet.pages.findIndex((p) => cx >= p.rect.x && cx <= p.rect.x + p.rect.w && cy >= p.rect.y && cy <= p.rect.y + p.rect.h) + 1);
  }
  const first = sheet.pages[0]!.number;
  const x = Math.round(op.x! / GRID) * GRID;
  const y = Math.round(op.y! / GRID) * GRID;
  if (isDrawn(d, sheet.id)) {
    const at = redrawBlock(d, sheet.id, title, page, x, y);
    // what it runs into: the agent's sheet stays as the agent puts it
    const frames = viewOf(d).sheets.find((s) => s.id === sheet.id)?.blocks ?? [];
    const mine = frames.find((b) => b.title === title);
    const into = mine ? frames.filter((b) => b !== mine && overlap(b.rect, mine.rect)).map((b) => `"${b.title}"`) : [];
    const clash = at.under
      ? `; it lies on ${at.under}: move one of them`
      : !mine
        ? '; it is not clear of the other blocks, so no frame is drawn round it: move it clear'
        : into.length
          ? `; its frame runs into the frame of ${into.join(' and ')}: move it clear`
          : '';
    return {
      op: 'place_block',
      effect: `block "${title}" drawn afresh on page ${first + page - 1} at (${at.x}, ${at.y}) mils, its parts together and wired${clash}${pastArea(at.frame, at.page) ? PAST_AREA : ''}`,
      ids: [sheet.id],
    };
  }
  for (const k of Object.values(d.ledger)) if (k.kind === 'sch_block' && k.key === title && k.sheet === sheet.id) delete d.ledger[k.id];
  const id = nextId(d, 'k');
  d.ledger[id] = { id, kind: 'sch_block', key: title, sheet: sheet.id, page, x, y, domain: 'schematic', strength: 'soft', source: { type: by } };
  // where it ended up: a block that would lie on one placed before it moved aside, or flows with
  // the others when its page has no room
  const now = viewOf(d).sheets.find((s) => s.id === sheet.id)!;
  const frame = now.blocks?.find((b) => b.title === title);
  if (!frame) return { op: 'place_block', effect: `block "${title}" placed on page ${first + page - 1} at (${x}, ${y}) mils`, ids: [id] };
  const c = { x: frame.rect.x + frame.rect.w / 2, y: frame.rect.y + frame.rect.h / 2 };
  const landed = Math.max(0, now.pages.findIndex((p) => c.x >= p.rect.x && c.x <= p.rect.x + p.rect.w && c.y >= p.rect.y && c.y <= p.rect.y + p.rect.h));
  const pg = now.pages[landed]!;
  const cx = Math.round(c.x - pg.rect.x);
  const cy = Math.round(c.y - pg.rect.y);
  const moved =
    landed !== page - 1
      ? `; page ${first + page - 1} has no room for it at (${x}, ${y}) clear of the blocks placed before it, so it flows with the others`
      : Math.abs(cx - x) > GRID || Math.abs(cy - y) > GRID
        ? `; it moved aside from (${x}, ${y}) to clear a block placed before it`
        : '';
  return {
    op: 'place_block',
    effect: `block "${title}" (${frame.rect.w} × ${frame.rect.h} mils) on page ${first + landed} at (${cx}, ${cy}) mils${moved}${pastArea(frame.rect, pg.rect) ? PAST_AREA : ''}`,
    ids: [id],
  };
}

/** A block's frame runs past the drawing area of its page (inside the margins, above the title strip). */
const pastArea = (r: Rect, page: Rect) => r.x < page.x + PAGE.margin || r.y < page.y + PAGE.margin || r.x + r.w > page.x + page.w - PAGE.margin || r.y + r.h > page.y + page.h - PAGE.margin - PAGE.title;

const PAST_AREA = '; it runs past the drawing area of the page: move it in, or put it on a page of its own';

/** The paper size of the schematic pages; A4 is the default and stored as nothing. */
export function setPaper(d: Design, op: Extract<EditOp, { op: 'set_paper' }>): OpResult {
  if (op.size === DEFAULT_PAPER) delete d.paper;
  else d.paper = op.size;
  syncDrawing(d); // stored drawings: the pages take the new size
  const pages = viewOf(d).sheets.reduce((n, s) => n + s.pages.length, 0);
  return { op: 'set_paper', effect: `schematic paper: ${op.size} landscape (${PAPERS[op.size].mm.w} × ${PAPERS[op.size].mm.h} mm), ${pages} page${pages === 1 ? '' : 's'}`, ids: ['paper'] };
}

/** The design description: the overview, the functional blocks, or both. Blocks share no part. */
export function describe(d: Design, op: Extract<EditOp, { op: 'describe' }>): OpResult {
  if (op.overview === undefined && !op.blocks) reject({ code: 'INVALID_OP', message: 'describe needs an overview, blocks, or both.' });
  const taken = new Map<string, string>();
  const blocks = op.blocks?.map((b) => {
    const components = [...new Set(b.refs.map((r) => resolveComponent(d, r).id))];
    for (const id of components) {
      const other = taken.get(id);
      if (other) reject({ code: 'INVALID_OP', message: `${d.components[id]!.refdes} is in two blocks ("${other}" and "${b.title}"); every part belongs to one block.` });
      taken.set(id, b.title);
    }
    const title = b.title.trim();
    // without a text, the block keeps the one it had (same title): grouping the drawing does not erase the document
    const text = b.text?.trim() ?? d.description?.blocks.find((x) => x.title === title)?.text ?? '';
    return { title, components, text };
  });
  d.description = { overview: op.overview?.trim() ?? d.description?.overview ?? '', blocks: blocks ?? d.description?.blocks ?? [] };
  // a block placed on the schematic that is gone (or renamed) leaves its placement behind
  const titles = new Set(d.description.blocks.map((b) => b.title));
  for (const k of Object.values(d.ledger)) if (k.kind === 'sch_block' && !titles.has(k.key ?? '')) delete d.ledger[k.id];
  const left = descriptionView(d)!.undescribed;
  return {
    op: 'describe',
    effect:
      `description: ${[op.overview !== undefined && 'overview', blocks && `${blocks.length} block${blocks.length === 1 ? '' : 's'}`].filter(Boolean).join(', ')}` +
      (left.length ? `; in no block yet: ${left.join(', ')}` : ''),
    ids: ['description'],
  };
}

/** The description with its parts by refdes; parts removed since it was written drop out. */
export function descriptionView(d: Design): DescriptionView | null {
  if (!d.description) return null;
  const covered = new Set<string>();
  const blocks = d.description.blocks.map((b) => {
    const parts = b.components.flatMap((id) => (d.components[id] ? [d.components[id]!] : []));
    for (const c of parts) covered.add(c.id);
    return { title: b.title, refs: parts.map((c) => c.refdes).sort(natCmp), text: b.text };
  });
  const undescribed = Object.values(d.components).filter((c) => !covered.has(c.id)).map((c) => c.refdes).sort(natCmp);
  return { overview: d.description.overview, blocks, undescribed };
}
