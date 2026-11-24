/**
 * Executes edit ops on a (cloned) design. Every op either applies fully or throws a
 * RejectError with an actionable reason. Transactions are handled by the Kernel.
 */
import { type Design, type EditOp, type OpResult } from '@4k7/schema';
import { addCutout, addGraphic, addHole, addVias, attach, editGraphic, place, proposePlacement, refineStep, routeStep, setBoard, setFabProfile, setOutline, setPanel, setPlane, setPlaneStyle } from './boardops.ts';
import { drawPair, drawTrack, drawVia, editCopper, eraseCopper, lockCopper, unlockCopper, type OpContext, routeDrawn, setCopperMode } from './copperops.ts';
import { boardCopy, nextId, reject } from './doc.ts';
import { eraseOp, labelOp, moveSupplyOp, textOp, wireOp } from './drawops.ts';
import { setEnclosureBrief, setEnclosureGraphic, setEnclosureScript } from './enclosureops.ts';
import { importBlock, importBoard } from './importops.ts';
import { addKeepout, editKeepout, removeKeepout } from './keepout.ts';
import { removeImpedance, setImpedance, setStackup } from './lineops.ts';
import { addPart, addSheet, clearSheet, connect, constrain, disconnect, moveToSheet, noConnect, remove, removeSheet, rename, setDnp, setNet, setParam, swapPins } from './netops.ts';
import { renamePart, setFootprint, setMating, setPackageDefaults, setPinDescriptions, setPolarity, setSymbol, setValueSeries } from './partops.ts';
import { autoDraw, describe, placeBlock, placeSymbol, setPaper } from './sheetops.ts';
import { addTestPoints } from './testpoints.ts';
import { tuneLength } from './tune.ts';
import { addMate, removeMate, tidyMates } from './mates.ts';
import { addBoard, assignBoard, boardFor, boardList, boardsNow, commitFocus, focusBoard, leftBoard, multiBoard, removeBoard, renameBoard, resolveBoard, settingsOf } from './boards.ts';

/**
 * The ops that work on one board: on a design of several, on the board they name (or the board of
 * the parts they name), through its focus (boards.ts).
 */
export const BOARD_OPS: ReadonlySet<EditOp['op']> = new Set([
  'set_board', 'set_stackup', 'set_impedance', 'remove_impedance', 'place', 'attach', 'add_test_points', 'propose_placement', 'refine_placement',
  'route', 'set_copper_mode', 'draw_track', 'draw_pair', 'draw_via', 'edit_copper', 'tune_length', 'erase_copper', 'lock_copper', 'unlock_copper',
  'set_plane', 'set_plane_style', 'add_hole', 'remove_hole', 'add_vias', 'remove_vias', 'add_cutout', 'remove_cutout', 'add_keepout', 'edit_keepout',
  'remove_keepout', 'add_graphic', 'edit_graphic', 'remove_graphic', 'set_outline', 'set_panel',
]);

/** The board an op works on (BOARD_OPS), or null for an op on the whole design. */
export function opBoard(d: Design, op: EditOp): string | null {
  return BOARD_OPS.has(op.op) ? boardFor(d, op as { op: string; board?: string }) : null;
}

/**
 * Applies one op. `by`: who asked for it (the app's own buttons and drags are the user's; the
 * agent's tool calls are the agent's). `ctx`: where it sits in its transaction (the route helper's
 * results computed elsewhere are found by it).
 */
export function applyOp(d: Design, op: EditOp, by: 'user' | 'agent' = 'agent', ctx?: OpContext): OpResult {
  const r = applyDesignOp(d, op, by, ctx);
  // a mate of a part taken off, or of a design back to one board, goes with it
  tidyMates(d);
  return r;
}

function applyDesignOp(d: Design, op: EditOp, by: 'user' | 'agent', ctx?: OpContext): OpResult {
  switch (op.op) {
    case 'mate':
      return addMate(d, op);
    case 'remove_mate':
      return removeMate(d, op);
    case 'add_board':
      return addBoard(d, op);
    case 'remove_board':
      return removeBoard(d, op);
    case 'assign_board':
      return assignBoard(d, op);
    case 'move_to_sheet': {
      // a sheet of another board takes the parts there
      const was = boardsNow(d);
      const r = moveToSheet(d, op.refs, op.sheet);
      leftBoard(d, was);
      return r;
    }
    case 'add_test_points':
      // on the whole design (refdes counted across the boards), for the board of the nets
      if (multiBoard(d)) return addTestPoints(d, op, by, boardFor(d, op));
      break;
    case 'set_fab_profile': {
      // one fab house for the design: every board, or one board's tier of it (docs/design/multi-board.md §5)
      const one = op.board !== undefined ? resolveBoard(d, op.board) : undefined;
      if (!multiBoard(d)) break;
      const on = one ? [one] : boardList(d);
      const rs = on.map((b) => {
        const f = focusBoard(d, b.id);
        const r = applyOne(f, op, by, ctx);
        commitFocus(d, b.id, f);
        return r;
      });
      if (one) {
        // the cost check prices every board at one house: one board takes another tier of it, not another house
        const house = (id: string) => settingsOf(d, id)?.fab?.house;
        const other = boardList(d).find((b) => b.id !== one.id && house(one.id) && house(b.id) && house(b.id)!.toLowerCase() !== house(one.id)!.toLowerCase());
        if (other) {
          reject({ code: 'FAB_INVALID', message: `Board "${other.name}" is made by ${house(other.id)}: the boards of a design go to one house (a tier of it per board). Choose a ${house(other.id)} tier for "${one.name}", or set the house on every board (set_fab_profile without board).` });
        }
      }
      return { ...rs[0]!, effect: `${rs[0]!.effect} (${one ? `board "${one.name}"` : 'every board'})` };
    }
  }
  const id = opBoard(d, op);
  if (op.op === 'set_board' && op.name !== undefined) {
    renameBoard(d, id!, op.name);
    const { op: _o, board: _b, name: _n, ...rest } = op;
    if (!Object.values(rest).some((v) => v !== undefined)) return { op: 'set_board', effect: `board renamed "${op.name.trim()}"`, ids: [id!] };
  }
  if (id === null || !multiBoard(d)) return applyOne(d, op, by, ctx);
  const f = focusBoard(d, id);
  const r = applyOne(f, op, by, ctx);
  commitFocus(d, id, f);
  return r;
}

function applyOne(d: Design, op: EditOp, by: 'user' | 'agent', ctx?: OpContext): OpResult {
  switch (op.op) {
    case 'add_board':
    case 'remove_board':
    case 'assign_board':
    case 'mate':
    case 'remove_mate':
      throw new Error('applyOne: a design op');
    case 'add_part':
      return addPart(d, op);
    case 'remove':
      return remove(d, op.ref);
    case 'set_param':
      return setParam(d, op.ref, op.params);
    case 'set_dnp':
      return setDnp(d, op.refs, op.dnp);
    case 'rename':
      return rename(d, op.ref, op.refdes);
    case 'connect':
      return connect(d, op.pins, op.net);
    case 'disconnect':
      return disconnect(d, op.pins);
    case 'swap_pins':
      return swapPins(d, op.a, op.b);
    case 'no_connect':
      return noConnect(d, op.pins);
    case 'set_net':
      return setNet(d, op);
    case 'add_sheet':
      return addSheet(d, op.name);
    case 'move_to_sheet':
      return moveToSheet(d, op.refs, op.sheet);
    case 'remove_sheet':
      return removeSheet(d, op.sheet);
    case 'clear_sheet':
      return clearSheet(d, op);
    case 'constrain':
      return constrain(d, op);
    case 'remove_constraint': {
      if (!d.ledger[op.id]) reject({ code: 'REF_UNKNOWN', message: `No constraint ${op.id}.`, candidates: Object.keys(d.ledger) });
      delete d.ledger[op.id];
      return { op: op.op, effect: `removed constraint ${op.id}`, ids: [op.id] };
    }
    case 'add_waiver': {
      const id = nextId(d, 'w');
      // a board check's finding is waived on its board (the same check finds the same on another); a board the design does not have is refused
      const on = op.board !== undefined ? resolveBoard(d, op.board) : undefined;
      d.waivers[id] = { id, code: op.code, entities: [...op.entities], reason: op.reason, by, ...(on ? { board: on.id } : {}) };
      return { op: op.op, effect: `waived ${op.code} for ${op.entities.join(', ')}${on ? ` on board "${on.name}"` : ''}`, ids: [id] };
    }
    case 'set_symbol':
      return setSymbol(d, op);
    case 'set_footprint':
      return setFootprint(d, op);
    case 'set_mating':
      return setMating(d, op);
    case 'set_polarity':
      return setPolarity(d, op);
    case 'set_pin_descriptions':
      return setPinDescriptions(d, op);
    case 'set_enclosure_brief':
      return setEnclosureBrief(d, op);
    case 'set_enclosure_script':
      return setEnclosureScript(d, op);
    case 'set_enclosure_graphic':
      return setEnclosureGraphic(d, op);
    case 'rename_part':
      return renamePart(d, op);
    case 'describe':
      return describe(d, op);
    case 'import_block':
      return importBlock(d, op, ctx?.sources);
    case 'import_board':
      return importBoard(d, op, ctx?.sources);
    case 'set_package_defaults':
      return setPackageDefaults(d, op);
    case 'set_value_series':
      return setValueSeries(d, op);
    case 'set_paper':
      return setPaper(d, op);
    case 'set_board':
      return setBoard(d, op);
    case 'set_fab_profile':
      return setFabProfile(d, op);
    case 'place':
      return place(d, op, by);
    case 'attach':
      return attach(d, op, by);
    case 'add_test_points':
      return addTestPoints(d, op, by);
    case 'place_symbol':
      return placeSymbol(d, op, by);
    case 'place_text':
      return textOp(d, op, by);
    case 'auto_draw':
      return autoDraw(d, op);
    case 'place_block':
      return placeBlock(d, op, by);
    case 'wire':
      return wireOp(d, op);
    case 'label':
      return labelOp(d, op);
    case 'erase':
      return eraseOp(d, op);
    case 'move_supply':
      return moveSupplyOp(d, op);
    case 'propose_placement':
      return proposePlacement(d, op, by);
    case 'refine_placement':
      return refineStep(d, op);
    case 'route':
      return d.board?.drawn ? routeDrawn(d, op, ctx) : routeStep(d);
    case 'set_copper_mode':
      return setCopperMode(d, op);
    case 'set_stackup':
      return setStackup(d, op);
    case 'set_impedance':
      return setImpedance(d, op);
    case 'remove_impedance':
      return removeImpedance(d, op);
    case 'draw_pair':
      return drawPair(d, op);
    case 'draw_track':
      return drawTrack(d, op);
    case 'draw_via':
      return drawVia(d, op);
    case 'edit_copper':
      return editCopper(d, op);
    case 'tune_length':
      return tuneLength(d, op);
    case 'erase_copper':
      return eraseCopper(d, op);
    case 'lock_copper':
      return lockCopper(d, op);
    case 'unlock_copper':
      return unlockCopper(d, op);
    case 'set_plane':
      return setPlane(d, op);
    case 'set_plane_style':
      return setPlaneStyle(d, op);
    case 'add_hole':
      return addHole(d, op);
    case 'add_vias':
      return addVias(d, op);
    case 'remove_vias': {
      const b = boardCopy(d);
      const before = b.vias ?? [];
      const keep = op.id.toLowerCase() === 'all' ? [] : before.filter((g) => g.id.toUpperCase() !== op.id.toUpperCase());
      if (keep.length === before.length) reject({ code: 'REF_UNKNOWN', message: `No via group "${op.id}".`, candidates: before.map((g) => g.id) });
      if (keep.length) b.vias = keep;
      else delete b.vias;
      d.board = b;
      return { op: 'remove_vias', effect: `removed ${before.length - keep.length} via group(s)`, ids: ['board'] };
    }
    case 'add_cutout':
      return addCutout(d, op);
    case 'add_keepout':
      return addKeepout(d, op);
    case 'edit_keepout':
      return editKeepout(d, op);
    case 'remove_keepout':
      return removeKeepout(d, op);
    case 'set_outline':
      return setOutline(d, op);
    case 'set_panel':
      return setPanel(d, op);
    case 'add_graphic':
      return addGraphic(d, op);
    case 'edit_graphic':
      return editGraphic(d, op);
    case 'remove_graphic': {
      const b = boardCopy(d);
      const before = b.graphics ?? [];
      const keep = op.id.toLowerCase() === 'all' ? [] : before.filter((g) => g.id.toUpperCase() !== op.id.toUpperCase());
      if (keep.length === before.length) reject({ code: 'REF_UNKNOWN', message: `No silkscreen graphic "${op.id}".`, candidates: before.map((g) => g.id) });
      if (keep.length) b.graphics = keep;
      else delete b.graphics;
      d.board = b;
      return { op: 'remove_graphic', effect: `removed ${before.length - keep.length} silkscreen graphic(s)`, ids: ['board'] };
    }
    case 'remove_cutout': {
      const b = boardCopy(d);
      const before = b.cutouts ?? [];
      const keep = op.id.toLowerCase() === 'all' ? [] : before.filter((c) => c.id.toUpperCase() !== op.id.toUpperCase());
      if (keep.length === before.length) reject({ code: 'REF_UNKNOWN', message: `No cutout "${op.id}".`, candidates: before.map((c) => c.id) });
      if (keep.length) b.cutouts = keep;
      else delete b.cutouts;
      d.board = b;
      return { op: 'remove_cutout', effect: `removed ${before.length - keep.length} cutout(s)`, ids: ['board'] };
    }
    case 'remove_hole': {
      const b = boardCopy(d);
      const before = b.holes ?? [];
      const keep = op.id.toLowerCase() === 'all' ? [] : before.filter((h) => h.id.toUpperCase() !== op.id.toUpperCase());
      if (keep.length === before.length) reject({ code: 'REF_UNKNOWN', message: `No mounting hole "${op.id}".`, candidates: before.map((h) => h.id) });
      b.holes = keep;
      d.board = b;
      return { op: 'remove_hole', effect: `removed ${before.length - keep.length} mounting hole(s)`, ids: ['board'] };
    }
    case 'remove_waiver': {
      if (!d.waivers[op.id]) reject({ code: 'WAIVER_UNKNOWN', message: `No waiver ${op.id}.`, candidates: Object.keys(d.waivers) });
      delete d.waivers[op.id];
      return { op: op.op, effect: `removed waiver ${op.id}`, ids: [op.id] };
    }
  }
}
