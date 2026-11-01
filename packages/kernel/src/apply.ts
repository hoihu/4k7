/**
 * Executes edit ops on a (cloned) design. Every op either applies fully or throws a
 * RejectError with an actionable reason. Transactions are handled by the Kernel.
 */
import { type Design, type EditOp, type OpResult } from '@4k7/schema';
import { addCutout, addGraphic, addHole, addVias, attach, editGraphic, place, proposePlacement, refineStep, routeStep, setBoard, setFabProfile, setOutline, setPanel, setPlane, setPlaneStyle } from './boardops.ts';
import { drawPair, drawTrack, drawVia, editCopper, eraseCopper, type OpContext, routeDrawn, setCopperMode } from './copperops.ts';
import { boardCopy, nextId, reject } from './doc.ts';
import { eraseOp, labelOp, moveSupplyOp, textOp, wireOp } from './drawops.ts';
import { setEnclosureBrief, setEnclosureGraphic, setEnclosureScript } from './enclosureops.ts';
import { addKeepout, editKeepout, removeKeepout } from './keepout.ts';
import { removeImpedance, setImpedance, setStackup } from './lineops.ts';
import { addPart, addSheet, clearSheet, connect, constrain, disconnect, moveToSheet, noConnect, remove, removeSheet, rename, setNet, setParam } from './netops.ts';
import { renamePart, setFootprint, setMating, setPackageDefaults, setPinDescriptions, setPolarity, setSymbol, setValueSeries } from './partops.ts';
import { autoDraw, describe, placeBlock, placeSymbol, setPaper } from './sheetops.ts';
import { tuneLength } from './tune.ts';

/**
 * Applies one op. `by`: who asked for it (the app's own buttons and drags are the user's; the
 * agent's tool calls are the agent's). `ctx`: where it sits in its transaction (the route helper's
 * results computed elsewhere are found by it).
 */
export function applyOp(d: Design, op: EditOp, by: 'user' | 'agent' = 'agent', ctx?: OpContext): OpResult {
  switch (op.op) {
    case 'add_part':
      return addPart(d, op);
    case 'remove':
      return remove(d, op.ref);
    case 'set_param':
      return setParam(d, op.ref, op.params);
    case 'rename':
      return rename(d, op.ref, op.refdes);
    case 'connect':
      return connect(d, op.pins, op.net);
    case 'disconnect':
      return disconnect(d, op.pins);
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
      d.waivers[id] = { id, code: op.code, entities: [...op.entities], reason: op.reason, by };
      return { op: op.op, effect: `waived ${op.code} for ${op.entities.join(', ')}`, ids: [id] };
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
