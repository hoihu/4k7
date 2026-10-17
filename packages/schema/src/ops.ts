/**
 * The operation catalogue: the only way to read or change a design.
 * Defined once with zod; JSON Schemas for agent tools / MCP are generated from it.
 * See docs/design/ops-api.md.
 */
import { z } from 'zod';
import { LandPad, Mating } from './ingest.ts';
import { EnclosureBrief } from './enclosure.ts';
import { PAPER_IDS, type PaperId } from './results.ts';
import { E_SERIES } from './units.ts';

/* ---------------------------------- refs ---------------------------------- */

const componentRef = z
  .string()
  .min(1)
  .describe('Component reference: refdes ("U1") or component id');
const pinRef = z
  .string()
  .min(3)
  .describe('Pin reference "<refdes>.<pin name or number>", e.g. "U1.VIN" or "U1.2". A name shared by several pins (e.g. GND) addresses all of them.');
const netName = z.string().min(1).describe('Net name, e.g. "+3V3", "GND", "SW"');

/* ------------------------------- edit ops --------------------------------- */

export const AddPartOp = z.object({
  op: z.literal('add_part'),
  part: z.string().describe('Part Card id from search_parts, e.g. "generic:C" or "ti:TPS54331DR"'),
  refdes: z.string().regex(/^[A-Z]+[0-9]+$/).optional().describe('Reference designator; auto-assigned if omitted. Give one when later ops in the same transaction refer to the part.'),
  params: z.record(z.string(), z.string()).optional().describe('Engineering parameters, e.g. {"capacitance":"100nF","voltage":"25V","package":"0402"}'),
  sheet: z.string().optional().describe('Sheet name; defaults to the first sheet'),
});

export const RemoveOp = z.object({
  op: z.literal('remove'),
  ref: componentRef,
});

export const SetParamOp = z.object({
  op: z.literal('set_param'),
  ref: componentRef,
  params: z.record(z.string(), z.string().nullable()).describe('Parameters to set; null removes a parameter'),
});

export const RenameOp = z.object({
  op: z.literal('rename'),
  ref: componentRef,
  refdes: z.string().regex(/^[A-Z]+[0-9]+$/).describe('New reference designator, e.g. "U2". Connections, constraints, description blocks and waivers follow the part.'),
}).describe('Change a component\'s reference designator. Ops apply in order, so swap two names through a free one: U1→U99, U2→U1, U99→U2.');

export const ConnectOp = z.object({
  op: z.literal('connect'),
  pins: z.array(pinRef).min(1),
  net: netName.optional().describe('Target net. If omitted, the pins join the net one of them is already on, or a new unnamed net.'),
});

export const DisconnectOp = z.object({
  op: z.literal('disconnect'),
  pins: z.array(pinRef).min(1),
});

export const NoConnectOp = z.object({
  op: z.literal('no_connect'),
  pins: z.array(pinRef).min(1).describe('Pins deliberately left unconnected'),
});

export const SetNetOp = z.object({
  op: z.literal('set_net'),
  net: netName,
  rename: netName.optional(),
  voltage: z.number().nullable().optional().describe('Nominal DC voltage in volts'),
  external: z.boolean().optional().describe('True for nets driven from outside the design (e.g. supply input on a connector)'),
  power: z.boolean().optional().describe('Draw as a power rail'),
  max_current: z.number().nullable().optional().describe('Expected maximum current in amps'),
  track_mm: z.number().positive().nullable().optional().describe('Track width for this net on the board (mm); null = the rules\' signal/power width. For current: about 0.3 mm per amp on 1 oz outer copper (10 °C rise)'),
});

export const AddSheetOp = z.object({
  op: z.literal('add_sheet'),
  name: z.string().min(1),
});

export const MoveToSheetOp = z.object({
  op: z.literal('move_to_sheet'),
  refs: z.array(componentRef).min(1),
  sheet: z.string(),
});

export const ConstrainOp = z.object({
  op: z.literal('constrain'),
  kind: z
    .enum(['left_of', 'right_of', 'above', 'below', 'near', 'param', 'layer', 'arrangement', 'note'])
    .describe('layer: the board side a part is mounted on, a = the part, value "top" (the default) | "bottom"; SMD parts on opposite sides may share the same area (a cap under its IC). arrangement: how a recognised sub-circuit is drawn; a = one of its parts. Bridge rectifier diode: "diamond" (default) | "inline". Regulator IC: "power_flow" (default, datasheet style) | "compact"'),
  a: componentRef.optional().describe('Subject component; for left_of/right_of/above/below also one unit of a split symbol, e.g. "U3B"'),
  b: componentRef.optional().describe('Reference component (left_of/right_of/above/below/near), or a unit such as "U3A"'),
  key: z.string().optional().describe('param: parameter name; layer: omit'),
  value: z.string().optional().describe('param: required value; layer: "top"|"bottom"; arrangement: see kind; note: free text'),
  max_mm: z.number().positive().optional().describe('near: maximum distance on the board in mm'),
  strength: z.enum(['hard', 'soft']).default('soft'),
  quote: z.string().optional().describe("The user's words this constraint comes from"),
});

export const RemoveConstraintOp = z.object({
  op: z.literal('remove_constraint'),
  id: z.string(),
});

export const AddWaiverOp = z.object({
  op: z.literal('add_waiver'),
  code: z.string().describe('Diagnostic code to waive, e.g. "SEM.EN_FLOATING"'),
  entities: z.array(z.string()).min(1).describe('Entities exactly as listed in the diagnostic'),
  reason: z.string().min(8),
});

export const RemoveWaiverOp = z.object({
  op: z.literal('remove_waiver'),
  id: z.string(),
});

const layoutEntry = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1), z.null()])
  .describe('A pin name or number; a name several pins share (GND, SW) stacks them at one position, as does an array of numbers; null leaves a gap');
const layoutSide = z.array(layoutEntry).optional();

export const SetSymbolOp = z.object({
  op: z.literal('set_symbol'),
  ref: componentRef.describe('A component using the part, e.g. "U3"'),
  style: z
    .enum(['single', 'units'])
    .optional()
    .describe('units: draw a big IC as several symbols (U1A power/system, U1B… two GPIO ports each); single: one symbol. Pins, nets and refdes stay the same; applies to every component of that part.'),
  layout: z
    .object({
      left: layoutSide.describe('Pins on the left side, top to bottom'),
      right: layoutSide.describe('Pins on the right side, top to bottom'),
      top: layoutSide.describe('Pins along the top, left to right'),
      bottom: layoutSide.describe('Pins along the bottom, left to right'),
    })
    .nullable()
    .optional()
    .describe('Your own pin arrangement for an IC or connector symbol (one symbol), e.g. to match a reference drawing: every pin exactly once, on its side in drawing order. null: back to the generated arrangement. Applies to every component of that part, and goes back to the library part once accepted. Pins, nets and refdes stay the same.'),
}).describe('How a part\'s symbol is drawn: one symbol or units (style), or which pin goes where (layout). Give style or layout.');

export const SetFootprintOp = z.object({
  op: z.literal('set_footprint'),
  ref: componentRef.describe('A component using the part, e.g. "BZ1"; applies to every component of that part'),
  name: z.string().min(2).describe('Package name, e.g. "Buzzer_12x9.5RM7.6"'),
  pads: z.array(LandPad).min(1).describe('One pad per pin (pad number = pin number), from the datasheet\'s recommended footprint or package drawing, mm from the body centre, top view'),
  body_mm: z.tuple([z.number().positive(), z.number().positive()]).optional().describe('Body width × length (round: diameter × diameter); default: around the pads'),
  round: z.boolean().optional().describe('A cylindrical body (buzzer, electrolytic cap)'),
  height_mm: z.number().positive().optional().describe('Body height above the board'),
  page: z.number().int().optional().describe('Datasheet page with the drawing'),
  mating: Mating.optional().describe('Connectors, card slots, switches: where the plug, card or finger comes in (also set_mating)'),
});

export const SetMatingOp = z.object({
  op: z.literal('set_mating'),
  ref: componentRef.describe('A component using the part, e.g. "J1"; applies to every component of that part'),
  face: z
    .enum(['left', 'right', 'top', 'bottom', 'up'])
    .nullable()
    .describe('The side of the footprint drawing (top view, as get_component\'s footprint is drawn, before the part is turned on the board) the plug goes in from; up: from above, straight down onto the board. null: the part is not plugged (forget it)'),
  plug_mm: Mating.shape.plug_mm,
  axis_mm: Mating.shape.axis_mm,
  along_mm: Mating.shape.along_mm,
}).describe('Where a connector, card slot or switch is used from: the face the plug comes in through and the size of the plug (its overmold), read off the datasheet. The enclosure leaves that way clear (board.scad mating_path), get_board shows which way it faces on the board.');

export const SetEnclosureBriefOp = z.object({
  op: z.literal('set_enclosure_brief'),
  brief: EnclosureBrief.nullable().describe('The whole brief (replaces the one before); null removes it'),
}).describe('The enclosure brief: what the box must do, decided items with their reason and questions for the user (2–4 options, your pick first). The user answers the questions in the app; then set it again with their answers as decisions.');

export const SetEnclosureScriptOp = z.object({
  op: z.literal('set_enclosure_script'),
  script: z
    .string()
    .min(20)
    .nullable()
    .describe('The whole OpenSCAD script (replaces the one before): include <board.scad>, parameters at the top, pieces = ["base", "lid"]; one module per piece, built in assembled position, piece = "all"; and the pieces drawn at the end by piece. null removes it'),
}).describe('The enclosure as an OpenSCAD script. Render it with render_enclosure (pictures and the measured report) after every change.');

const pkgName = z.string().nullable().optional();
export const SetPackageDefaultsOp = z.object({
  op: z.literal('set_package_defaults'),
  resistor: pkgName.describe('Package for generic resistors without their own, e.g. "0805", "AXIAL-0.4"; null = the library default (0603)'),
  capacitor: pkgName.describe('Ceramic capacitors, e.g. "0805"'),
  electrolytic: pkgName.describe('Polarized capacitors, e.g. "CAP-8x10", "RADIAL-D8"'),
  inductor: pkgName.describe('e.g. "IND-6x6"'),
  diode: pkgName.describe('e.g. "SMA", "DO-41"'),
  led: pkgName.describe('e.g. "0805", "LED-5mm"'),
  passives: z.string().optional().describe('Shorthand: resistors, ceramic capacitors and LEDs at once, e.g. "0805" for hand soldering'),
  auto_size: z.boolean().optional().describe('Size up where the value demands it (capacitors ≥ 4.7 µF or > 25 V, resistor power, inductor/diode current); default on'),
});

const seriesName = z.enum(E_SERIES).nullable().optional();
export const SetValueSeriesOp = z.object({
  op: z.literal('set_value_series'),
  resistors: seriesName.describe('Series generic resistors take their values from, e.g. "E24" (5 %), "E96" (1 %); null = any value'),
  capacitors: seriesName.describe('Ceramic and electrolytic capacitors, e.g. "E6" or "E12"'),
  inductors: seriesName.describe('Inductors, e.g. "E6"'),
  all: z.enum(E_SERIES).optional().describe('Shorthand: resistors, capacitors and inductors at once'),
}).describe('The standard-value ranges (E-series) of generic resistors, capacitors and inductors. calc rounds to them, and the checks warn about values outside them.');

export const SetPaperOp = z.object({
  op: z.literal('set_paper'),
  size: z.enum(PAPER_IDS as [PaperId, ...PaperId[]]).describe('Paper size of the schematic pages, landscape: A4 (297 × 210 mm, the default), A3 (420 × 297) or A2 (594 × 420). Drawn at 1:1, so a bigger sheet holds more per page'),
});

export const RenamePartOp = z.object({
  op: z.literal('rename_part'),
  part: z.string().min(1).describe('Part id ("adi:ADIN2111BCPZ") or a component using it ("U4")'),
  mpn: z.string().min(1).optional().describe('The new part number shown on the symbol and in the BOM; the part id stays'),
  title: z.string().optional().describe('The name a person calls it ("Raspberry Pi Pico"), shown in the parts list; empty = none'),
});

export const SetBoardOp = z.object({
  op: z.literal('set_board'),
  width_mm: z.number().positive().nullable().optional().describe('Board width; null = size to fit the parts'),
  height_mm: z.number().positive().nullable().optional().describe('Board height; null = size to fit the parts'),
  layers: z.union([z.literal(2), z.literal(4)]).optional(),
  clearance_mm: z.number().positive().optional().describe('Copper clearance (default 0.2)'),
  track_mm: z.number().positive().optional().describe('Signal track width (default 0.25)'),
  power_track_mm: z.number().positive().optional().describe('Supply/ground track width (default 0.5)'),
  via_drill_mm: z.number().positive().optional().describe('Via drill (default 0.3)'),
  via_pad_mm: z.number().positive().optional().describe('Via pad diameter (default 0.6)'),
  edge_clearance_mm: z.number().positive().optional().describe('Keep copper this far from the board edge (default 0.5)'),
  via_in_pad: z.boolean().optional().describe('Let the router put its vias inside pads, anywhere on the board (default false; only when the user asks for it, e.g. for tight BGA fan-out). Thermal vias in one pad need no such switch: add_vias kind pad'),
  corner_radius_mm: z.number().min(0).optional().describe('Rounded board corners: the radius (0 = square corners)'),
}).describe('Board size, layers and design rules. With a fab profile chosen (set_fab_profile) a rule below the manufacturer\'s limit is refused.');

const fabLimitsInput = z.object({
  track_mm: z.number().positive().describe('Narrowest copper track the fab makes'),
  clearance_mm: z.number().positive().describe('Smallest copper-to-copper gap'),
  via_drill_mm: z.number().positive().optional().describe('Smallest via drill (finished hole)'),
  via_pad_mm: z.number().positive().optional().describe('Smallest via pad diameter'),
  annular_ring_mm: z.number().positive().optional().describe('Smallest annular ring of a plated component hole, (pad − drill) / 2. If the fab measures it from the drill tool, add half the tool allowance'),
  pth_drill_mm: z.number().positive().optional().describe('Smallest plated component hole'),
  npth_drill_mm: z.number().positive().optional().describe('Smallest non-plated (mounting) hole'),
  hole_to_hole_mm: z.number().positive().optional().describe('Smallest wall between two holes, edge to edge (vias; any hole unless pad_hole_to_hole_mm is given)'),
  pad_hole_to_hole_mm: z.number().positive().optional().describe('The same when a component or mounting hole is involved'),
  copper_to_edge_mm: z.number().positive().optional().describe('Copper to the routed board edge (outer layers)'),
  copper_to_edge_inner_mm: z.number().positive().optional().describe('Copper to the routed board edge on inner layers, when larger'),
  silk_width_mm: z.number().positive().optional().describe('Narrowest silkscreen line'),
  silk_height_mm: z.number().positive().optional().describe('Smallest silkscreen text height'),
  mask_bridge_mm: z.number().positive().optional().describe('Narrowest solder-mask web between pads'),
  min_board_mm: z.tuple([z.number().positive(), z.number().positive()]).optional().describe('Smallest board [width, height]'),
  max_board_mm: z.tuple([z.number().positive(), z.number().positive()]).optional().describe('Largest board [width, height]'),
});
export type FabLimitsInput = z.infer<typeof fabLimitsInput>;

export const SetFabProfileOp = z.object({
  op: z.literal('set_fab_profile'),
  preset: z.string().optional().describe('A built-in profile: "jlcpcb", "pcbway" or "eurocircuits" (the tier matching the board\'s layers; Eurocircuits 6C), or a tier: "jlcpcb/4l-2oz", "pcbway/2l-1oz", "eurocircuits/7D" (any pattern class 3–9 with drill class A–E). design_query get_fab_profiles lists them'),
  none: z.boolean().optional().describe('true: remove the fab profile (no manufacturer limits are checked)'),
  house: z.string().min(1).optional().describe('Import: the manufacturer\'s name ("Seeed Fusion"), with tier, source_url and limits, read from its capabilities page. Never guess a number: leave out what the page does not state'),
  tier: z.string().min(1).optional().describe('Import: the service or class these limits belong to ("2-layer, 1 oz copper", "standard")'),
  layers: z.array(z.union([z.literal(2), z.literal(4)])).optional().describe('Import: layer counts the tier is made in (default both)'),
  source_url: z.string().url().optional().describe('Import: the page the limits were read from (required)'),
  checked: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Import: the date the page was read, YYYY-MM-DD'),
  limits: fabLimitsInput.optional().describe('Import: the limits as the page states them, in mm (convert mil: 1 mil = 0.0254 mm)'),
  notes: z.array(z.string()).max(8).optional().describe('Import: caveats the page gives (conditions, surcharges, what a limit applies to)'),
  keep_rules: z.boolean().optional().describe('true: leave the design rules alone even where they are below the new limits (the DRC then reports the rules as violations). Default: raise rules up to the limits, never lower them'),
}).describe('Choose the manufacturer the board is made by. Its limits are kept apart from the design rules: rules are raised to the limits where they are below (never lowered), set_board refuses rules below them, and the DRC checks tracks, vias, holes, rings, edge distance and board size against them. Give one of: preset, none, or an import (house, tier, source_url, limits).');

export const SetOutlineOp = z.object({
  op: z.literal('set_outline'),
  svg_path: z.string().optional().describe('The outline as an SVG path (M L H V C S Q T A Z, absolute or relative, y down), in any units: it is scaled to width_mm / height_mm. One closed figure; cutouts are separate (add_cutout). E.g. a Christmas tree, a circle, a shield shape.'),
  points: z.array(z.tuple([z.number(), z.number()])).optional().describe('Or the outline as corner points [x, y] (y down), in any units'),
  width_mm: z.number().positive().optional().describe('Scale the shape to this width (only one of width/height: proportional)'),
  height_mm: z.number().positive().optional().describe('Scale the shape to this height (only one of width/height: proportional)'),
  rectangle: z.boolean().optional().describe('true: back to a rectangular board (keeping width × height)'),
}).describe('A free-form board outline. Parts, copper and pours keep the edge clearance from it; the Edge_Cuts Gerber carries it.');

const cutoutAnchor = z.enum(['top_left', 'top', 'top_right', 'left', 'center', 'right', 'bottom_left', 'bottom', 'bottom_right']);

export const AddCutoutOp = z.object({
  op: z.literal('add_cutout'),
  shape: z.enum(['rect', 'circle', 'slot']).describe('rect: an opening (optionally with rounded corners); circle: a round cutout; slot: an oblong with round ends (e.g. an isolation slot)'),
  x_mm: z.number().describe('Centre x, measured from the anchor point (x right)'),
  y_mm: z.number().describe('Centre y, measured from the anchor point (y down)'),
  anchor: cutoutAnchor.optional().describe('What x/y are measured from (default top_left, the board corner): a corner, the middle of an edge (top, left, right, bottom) or the centre. A cutout anchored to an edge or corner follows the board size.'),
  width_mm: z.number().positive().optional().describe('rect: width; slot: length, end to end'),
  height_mm: z.number().positive().optional().describe('rect: height; slot: width'),
  diameter_mm: z.number().positive().optional().describe('circle: diameter'),
  corner_radius_mm: z.number().min(0).optional().describe('rect: rounded corners'),
  angle_deg: z.number().optional().describe('rect, slot: rotation, degrees clockwise (default 0: along x)'),
});

export const AddGraphicOp = z.object({
  op: z.literal('add_graphic'),
  svg_path: z.string().min(1).optional().describe('SVG path data of the graphic (any units; M L H V C S Q T A Z, absolute or relative; several figures allowed). Filled: figures inside figures are holes (even-odd), as in a logo'),
  artwork: z.string().optional().describe('Instead of svg_path: a saved artwork by name (the artwork library); without width/height it keeps its saved size'),
  mode: z.enum(['fill', 'outline']).optional().describe('fill (default; an artwork: its own): the figures are filled with ink; outline: only their contours are drawn'),
  line_mm: z.number().min(0.1).optional().describe('outline: the line width (default 0.2; at least 0.15 prints reliably)'),
  width_mm: z.number().positive().optional().describe('Scale the graphic to this width (with only one of width/height the other keeps the proportions; neither: path units are mm)'),
  height_mm: z.number().positive().optional(),
  x_mm: z.number().describe('Centre x, measured from the anchor point'),
  y_mm: z.number().describe('Centre y, measured from the anchor point (y down)'),
  anchor: cutoutAnchor.optional().describe('What x/y are measured from (default top_left): a corner, an edge\'s middle or the centre; it then follows the board size'),
  angle_deg: z.number().optional().describe('Rotation, degrees clockwise'),
  side: z.enum(['top', 'bottom']).optional().describe('Silkscreen side (default top)'),
  name: z.string().optional().describe('What it is, e.g. "logo"'),
});

export const EditGraphicOp = z.object({
  op: z.literal('edit_graphic'),
  id: z.string().describe('Graphic id ("G1")'),
  dx_mm: z.number().optional().describe('Move by this much (x right)'),
  dy_mm: z.number().optional().describe('Move by this much (y down)'),
  x_mm: z.number().optional().describe('New centre x from the anchor'),
  y_mm: z.number().optional().describe('New centre y from the anchor'),
  anchor: cutoutAnchor.optional().describe('Measure from another anchor (x/y then from it; without x/y it keeps its place)'),
  angle_deg: z.number().optional().describe('New rotation, degrees clockwise'),
  width_mm: z.number().positive().optional().describe('Scale to this width (height in proportion unless given)'),
  height_mm: z.number().positive().optional(),
  mode: z.enum(['fill', 'outline']).optional(),
  line_mm: z.number().min(0.1).optional(),
  side: z.enum(['top', 'bottom']).optional(),
  name: z.string().optional(),
});

export const RemoveGraphicOp = z.object({
  op: z.literal('remove_graphic'),
  id: z.string().describe('Graphic id ("G1"), or "all"'),
});

export const RemoveCutoutOp = z.object({
  op: z.literal('remove_cutout'),
  id: z.string().describe('Cutout id ("CO1"), or "all"'),
});

const panelSide = z.enum(['top', 'right', 'bottom', 'left']);

export const SetPanelOp = z.object({
  op: z.literal('set_panel'),
  none: z.boolean().optional().describe('true: remove the panel (single boards)'),
  cols: z.number().int().min(1).max(20).optional().describe('Copies side by side (default 2)'),
  rows: z.number().int().min(1).max(20).optional().describe('Copies one above the other (default 2)'),
  gap_mm: z.number().min(1).max(10).optional().describe('Milled channel between boards and to the frame, the router width (default 2)'),
  rail_mm: z.number().min(0).max(30).optional().describe('Frame width on all four sides (default 5; 0 = no frame)'),
  rails_mm: z.object({ top: z.number().min(0).max(30).optional(), right: z.number().min(0).max(30).optional(), bottom: z.number().min(0).max(30).optional(), left: z.number().min(0).max(30).optional() }).optional().describe('Frame width per side, e.g. {"left": 0, "right": 0} for rails on top and bottom only'),
  tab_sides: z.array(panelSide).optional().describe('The board sides that get tabs (default all four); the other sides are milled through. Places tabs evenly: one on a side up to 30 mm, then one per 50 mm'),
  tabs_per_side: z.number().int().min(1).max(10).optional().describe('With tab_sides: this many tabs per side instead'),
  tabs: z.array(z.object({ side: panelSide, at: z.number().min(0).max(1).describe('Position along the side, 0–1: left to right, top to bottom') })).optional().describe('Exact tab positions instead of tab_sides (replaces all tabs)'),
  tab_width_mm: z.number().min(2).max(20).optional().describe('Tab width along the edge (default 5; JLCPCB asks for at least 5 with mouse bites)'),
  hole_mm: z.number().min(0.3).max(1.2).optional().describe('Mouse-bite hole diameter (default 0.5)'),
  hole_pitch_mm: z.number().min(0.5).max(2).optional().describe('Mouse-bite hole centre spacing, at most (default 0.75)'),
  frame_holes: z.boolean().optional().describe('A row of mouse bites on the frame\'s end of each tab too, so the whole tab breaks out (default true); false: only at the board edge. Tabs between two boards always get a row at each board'),
  fiducials: z.boolean().optional().describe('Three fiducials on the rails (default true; needs 5 mm rails)'),
  tooling_holes: z.boolean().optional().describe('Four Ø2 mm tooling holes on the rails (default true; needs 5 mm rails)'),
}).describe('Make the board in a fabrication panel: copies in a grid inside a frame, milled apart except at tabs with mouse bites (rows of small holes at each board edge, so the boards snap out). Only the given fields change; the first call starts from the defaults (2 × 2, 2 mm gap, 5 mm rails, tabs on every side, fiducials and tooling holes).');

export const PlaceOp = z.object({
  op: z.literal('place'),
  ref: componentRef,
  x_mm: z.number().describe('Centre x on the board, from the left edge'),
  y_mm: z.number().describe('Centre y on the board, from the top edge'),
  rot: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional().describe('Clockwise rotation; omit it to keep the current one'),
  lock: z.boolean().optional().describe('true: lock the part exactly there (a hard pin, e.g. connectors at the edge). Default: a choice for this part, kept relative to its parent part (a cap next to its IC follows the IC) and nudged only if it must'),
  quote: z.string().optional().describe("The user's words when they asked for this placement: it is then their choice, not yours"),
});

export const AttachOp = z.object({
  op: z.literal('attach'),
  ref: componentRef.describe('The part, e.g. a decoupling cap, a pull-up, a crystal'),
  to: componentRef.nullable().describe('The part it belongs with on the board (an IC it serves): it stays at that part and follows it when it moves. null: it stands on its own (a bulk cap at the input, a part the placer wrongly put at an IC)'),
  pin: z.string().optional().describe('The pin of `to` it serves (number or name), e.g. the VDD pin a decoupling cap is for: it goes right at that pin. It must share a net with it'),
}).describe("Say which part a small part belongs with on the board, where the placer's guess (shown in get_board belongs_to, marked guessed) is wrong. Declared once, it holds for every later placement; remove_constraint goes back to the guess. A part you placed is placed afresh at its new parent; one the user placed stays where it is.");

export const PlaceSymbolOp = z.object({
  op: z.literal('place_symbol'),
  ref: componentRef.describe('Component, or one unit of a split symbol ("U3B")'),
  page: z.number().int().min(1).optional().describe('Page number as get_schematic and get_schematic_image count them, on the part\'s own sheet; omit it to keep the page the part is on now'),
  x: z.number().optional().describe('Centre of the symbol, mils from the left edge of the paper (get_schematic gives the paper size and where everything is now)'),
  y: z.number().optional().describe('Centre of the symbol, mils from the top edge of the paper'),
  orient: z.enum(['upright', 'lying']).optional().describe('Two-pin parts: standing or lying, e.g. a resistor in series in a signal path; omit it to keep how it is drawn'),
  mirror: z.boolean().optional().describe('ICs and connectors: pins of the left side on the right (a connector at the right edge facing the circuit); omit it to keep how it is drawn'),
  auto: z.boolean().optional().describe('true: take the part out of your drawing; it is drawn afresh in free space'),
}).describe('Move a part on the schematic: its symbol\'s centre goes there (the move is rounded to the 100-mil grid; the result says where it ended up). The first move on a sheet makes its drawing yours: from then on it stays as you arrange it, and parts added later are drawn in free space. An IC or connector takes the small parts drawn at its pins with it, wired as before; a two-pin part goes on its own. Wires to parts that stay behind are cut back, and those connections show as net labels. Use it to make a drawing look like a reference or the user\'s sketch.');

const pagePoint = z.object({ x: z.number(), y: z.number() }).describe('Page coordinates in mils from the paper\'s top-left corner (as get_schematic gives them)');

export const WireOp = z.object({
  op: z.literal('wire'),
  from: pinRef,
  to: pinRef.describe('Another pin on the same net, on the same page'),
  via: z.array(pagePoint).max(8).optional().describe('Corners the wire must pass, in order; omit them and the kernel finds a clear orthogonal path'),
}).describe('Draw a wire between two pins that are on one net in the netlist (a wire never makes a connection, it shows one). The kernel finds an orthogonal path that leaves each pin outwards and keeps clear of parts and other wires; where either pin is already wired, the new wire may start or end with a T on that wire, and pins already joined by wires get nothing. Net labels at the two pins are taken away. After every change the kernel tidies the wires (no loops, runs drawn twice or U-turns; a wire given via corners keeps them), so wire pin by pin and let it straighten. Use it for paths the reader should follow (feedback, sense lines, a signal chain).');

export const LabelOp = z.object({
  op: z.literal('label'),
  pin: pinRef,
  dir: z.enum(['left', 'right', 'up', 'down']).optional().describe('Net labels: the way the label points. Default: the way the pin leaves the part. Across that (e.g. right on a top pin) a short lead runs out first, so a label at a top or bottom pin can still be horizontal. Supply symbols always point their own way (rails up, ground down)'),
}).describe('Show a pin\'s net by a net label, or a supply symbol for a rail or ground, at that pin; it replaces the labels there. Labels of one net connect by name, so use them between blocks and across pages.');

export const EraseOp = z.object({
  op: z.literal('erase'),
  pins: z.array(pinRef).optional().describe('Erase the wires and labels drawn at these pins'),
  net: netName.optional().describe('Erase every wire and label of this net'),
}).describe('Take wires and labels out of the drawing (the netlist does not change). Connections no longer drawn show as automatic labels until you draw them again (wire, label).');

export const AutoDrawOp = z.object({
  op: z.literal('auto_draw'),
  sheet: z.string().optional().describe('Sheet name; omit it for every sheet (or the sheet of the parts in refs)'),
  refs: z.array(componentRef).optional().describe('Only these parts: taken out of your drawing and drawn afresh together, in free space'),
}).describe('Let the auto-layout draw: without refs it redraws the whole sheet from the netlist and the left_of/right_of/above/below hints, and keeps redrawing it after every change until you arrange it again (place_symbol); with refs it redraws just those parts in free space and the rest of your drawing stays.');

/** A main part's place in an arrangement the agent decides (propose_placement, try_placements). */
export const PartPlacement = z.object({
  ref: componentRef,
  x_mm: z.number().describe('Centre x on the board, from the left edge'),
  y_mm: z.number().describe('Centre y on the board, from the top edge'),
  rot: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional().describe('Clockwise rotation (default 0): turn the part so its pins face what they connect to'),
});
export type PartPlacement = z.infer<typeof PartPlacement>;

export const ProposePlacementOp = z.object({
  op: z.literal('propose_placement'),
  parts: z
    .array(PartPlacement)
    .optional()
    .describe('Your arrangement of the main parts (ICs, connectors, big parts): where each goes and how it is turned. The placer puts the small parts round them (decoupling and support parts at the pins they serve) and fits the board. Leave out for a placement the placer proposes alone (a starting point)'),
  width_mm: z.number().positive().optional().describe('With parts: the board size to arrange in (as set_board); omit to keep the size set, or let the board fit the parts'),
  height_mm: z.number().positive().optional(),
  keep_choices: z.boolean().optional().describe('Keep your earlier placement choices for parts not in parts (default true); false forgets them. Locked parts and the parts the user placed always stay'),
}).describe('Propose the placement afresh: a board size (unless set) and a placement. With parts, the main parts go where you decide (soft: kept, nudged only where parts would overlap); the placer does the rest. Parts the user placed or locked stay where they are and cannot be in parts. Try arrangements with design_query try_placements first and apply the best one with this. Replaces the current placement.');

export const RouteOp = z.object({
  op: z.literal('route'),
}).describe('Route the board as it is placed now (the last step), aiming at every connection: passes are repeated, pushing the nets in the way of open connections aside, which can take a minute on a big board (the user watches it fill in). get_board then lists any open connection with what blocks it and the parts near it. A later placement change shows the routing as out of date until route runs again.');

export const SetPlaneOp = z.object({
  op: z.literal('set_plane'),
  layer: z.enum(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']).optional().describe('Copper layer; inner layers (4-layer boards) become dedicated planes, outer layers get a pour around the tracks'),
  net: netName.nullable().optional().describe('Net to pour on that layer (e.g. "GND", "+3V3"); null removes every plane from the layer'),
  under: z.array(componentRef).min(1).optional().describe('The plane covers only the area under these parts (their box plus margin_mm; it follows them when they move), e.g. +3V3 under the MCU while +5V fills the rest of an inner layer, or GND on F.Cu only round a regulator. Pads inside the area join it (drop onto an inner one with vias); the net\'s other pads are joined with tracks'),
  margin_mm: z.number().min(0).max(20).optional().describe('With under: how far the area reaches past the parts (default 1.5 mm)'),
  rect: z
    .object({ x_mm: z.number(), y_mm: z.number(), width_mm: z.number().positive(), height_mm: z.number().positive() })
    .optional()
    .describe('The plane covers only this rectangle (top-left corner and size, mm) instead of the whole layer'),
  auto: z.boolean().optional().describe('true: back to the automatic planes (GND on B.Cu; on 4 layers GND on In1.Cu and the main supply on In2.Cu)'),
}).describe('A net\'s copper plane on a layer. Without under/rect it fills the layer (replacing the layer\'s full plane; area planes on it stay, and it goes round them). With under or rect it covers only that area (replacing that net\'s area there): on an inner layer a split plane (In2.Cu +5V everywhere and +3V3 under U1), on an outer layer a local pour (F.Cu GND only round a switching regulator, as its layout guidelines ask; it replaces the net\'s pour over the whole layer). net null clears the layer.');

const planeMm = (what: string) => z.number().min(0).max(10).nullable().optional().describe(`${what} (mm); null: back to the default`);
export const SetPlaneStyleOp = z.object({
  op: z.literal('set_plane_style'),
  layer: z.enum(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']),
  net: netName.describe('The net of the plane on that layer (a full plane or an area plane)'),
  gap_mm: planeMm('An area plane: the gap between it and the plane round it, e.g. 0.5 to separate +3V3 from +5V clearly (default: the board\'s clearance)'),
  clearance_mm: planeMm('How far the plane keeps from other nets\' pads, tracks and vias (default: the board\'s clearance); only the plane, tracks keep theirs'),
  edge_mm: planeMm('How far the plane is pulled back from the board edge and cutouts (default: the board\'s edge clearance)'),
  thermal: z.boolean().nullable().optional().describe('Thermal reliefs (a ring with four spokes) where the plane meets its own pads and vias: true (default, easier to solder), false: joined solid (lower resistance, better for heat)'),
  spoke_mm: z.number().min(0.15).max(2).nullable().optional().describe('Width of the relief spokes (mm); null: the default'),
}).describe('Shape a plane or pour: its gap to the plane round it (area planes), its clearance to other copper, its pull-back from the edge, thermal reliefs or solid joints. Only the given fields change. Never below the board\'s own clearances (raise those with set_board).');

export const AddHoleOp = z.object({
  op: z.literal('add_hole'),
  diameter_mm: z.number().positive().describe('Drill diameter, e.g. 3.2 for M3 clearance, 3.5'),
  corner: z.enum(['top_left', 'top_right', 'bottom_left', 'bottom_right', 'all']).optional().describe('Anchor to a board corner ("all" = one in each corner); the hole follows the board size'),
  inset_mm: z.number().positive().optional().describe('Corner holes: centre distance from both edges (default diameter + 0.5)'),
  x_mm: z.number().optional().describe('Fixed position instead of a corner: centre x from the left edge'),
  y_mm: z.number().optional().describe('Fixed position: centre y from the top edge'),
  plated: z.boolean().optional().describe('Plated with an annular ring (default false: NPTH, no copper)'),
  net: netName.optional().describe('Plated holes only: connect to this net, e.g. "GND" (chassis/earth)'),
});

export const RemoveHoleOp = z.object({
  op: z.literal('remove_hole'),
  id: z.string().describe('Hole id ("MH1") or "all"'),
});

const viaArea = {
  under: z.array(componentRef).min(1).optional().describe('grid, fence: the area round these parts (their box plus margin_mm; it follows them)'),
  margin_mm: z.number().min(0).max(20).optional().describe('With under: how far the area reaches past the parts (default 1.5 mm)'),
  rect: z
    .object({ x_mm: z.number(), y_mm: z.number(), width_mm: z.number().positive(), height_mm: z.number().positive() })
    .optional()
    .describe('grid, fence: the area as a rectangle (top-left corner and size, mm)'),
};
export const AddViasOp = z.object({
  op: z.literal('add_vias'),
  kind: z
    .enum(['pad', 'points', 'grid', 'fence'])
    .describe('pad: thermal vias, a grid filling one exposed or thermal pad (not a passive\'s pad: they wick its solder), allowed in the pad and moving with the part; points: vias at the given spots; grid: stitching vias over an area (e.g. a top pour to an inner plane, many vias sharing the current); fence: a row of vias round the edge of an area (GND round an antenna or an RF part)'),
  net: netName.optional().describe('The vias\' net (pad: default the pad\'s net)'),
  ref: componentRef.optional().describe('pad: the component, e.g. "U1"'),
  pad: z.string().min(1).optional().describe('pad: the pad (pin) number, e.g. "9" or "EP"'),
  at: z.array(z.object({ x_mm: z.number(), y_mm: z.number() })).min(1).optional().describe('points: via centres (mm from the board\'s top-left corner)'),
  ...viaArea,
  pitch_mm: z.number().positive().optional().describe('Centre to centre (default: pad 1.0, grid 3.0, fence 2.0 mm); the datasheet\'s layout example gives it for thermal vias, a fence wants under a tenth of the wavelength'),
  drill_mm: z.number().positive().optional().describe('Drill (default the board\'s via drill)'),
  size_mm: z.number().positive().optional().describe('Via pad diameter (default the board\'s via pad)'),
}).describe('Place vias on purpose, of one net: thermal vias in a pad, stitching over an area, a fence round one, or at given spots. pad and points vias are copper from the start (the routing goes round them); grid and fence vias are laid by the route step where a via fits (no other net in the way, clear of pads) and joins the net\'s planes or pours on two layers or more. get_board lists each group (via_groups) with how many it got. Replaces nothing: remove_vias takes a group away.');

export const RemoveViasOp = z.object({
  op: z.literal('remove_vias'),
  id: z.string().describe('Via group id ("V1", from get_board via_groups) or "all"'),
});

export const DescribeOp = z.object({
  op: z.literal('describe'),
  overview: z.string().min(1).optional().describe('The whole design in a few short paragraphs (Markdown): what it is for, its inputs and outputs, the supplies, how the blocks work together. Omit to keep the current one'),
  blocks: z
    .array(
      z.object({
        title: z.string().min(1).describe('Name of the block, e.g. "3.3 V buck regulator", "USB-C input and protection"'),
        refs: z.array(componentRef).min(1).describe('The parts of the block; every part of the design belongs to exactly one block'),
        text: z.string().min(1).describe('How the block works (Markdown): its job, the key parts and why they have their values, the nets it takes and gives, anything to know when bringing it up'),
      }),
    )
    .min(1)
    .optional()
    .describe('The functional blocks, in the order a reader should meet them (power first, then along the signal path). Replaces all blocks; omit to keep the current ones'),
}).describe('Write the design description: the text of the design document, printed with each block\'s schematic, its place on the board, the layout, the assembly drawing and the BOM.');

export const EditOp = z.discriminatedUnion('op', [
  AddPartOp,
  RemoveOp,
  SetParamOp,
  RenameOp,
  ConnectOp,
  DisconnectOp,
  NoConnectOp,
  SetNetOp,
  AddSheetOp,
  MoveToSheetOp,
  ConstrainOp,
  RemoveConstraintOp,
  AddWaiverOp,
  RemoveWaiverOp,
  SetSymbolOp,
  SetFootprintOp,
  RenamePartOp,
  SetPackageDefaultsOp,
  SetValueSeriesOp,
  SetPaperOp,
  SetBoardOp,
  SetFabProfileOp,
  PlaceOp,
  AttachOp,
  PlaceSymbolOp,
  WireOp,
  LabelOp,
  EraseOp,
  AutoDrawOp,
  ProposePlacementOp,
  RouteOp,
  SetPlaneOp,
  SetPlaneStyleOp,
  AddHoleOp,
  RemoveHoleOp,
  AddViasOp,
  RemoveViasOp,
  AddCutoutOp,
  RemoveCutoutOp,
  AddGraphicOp,
  EditGraphicOp,
  RemoveGraphicOp,
  SetOutlineOp,
  SetPanelOp,
  DescribeOp,
  SetMatingOp,
  SetEnclosureBriefOp,
  SetEnclosureScriptOp,
]);
export type EditOp = z.infer<typeof EditOp>;
export type EditOpName = EditOp['op'];

export const Transaction = z.object({
  summary: z.string().min(1).describe('One line describing the intent of this change'),
  ops: z.array(EditOp).min(1),
  dry_run: z.boolean().optional().describe('Validate and report diff + diagnostics without applying'),
});
export type Transaction = z.infer<typeof Transaction>;

/* ------------------------------- query ops -------------------------------- */

export const QueryOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('get_summary') }),
  z.object({
    op: z.literal('find'),
    text: z.string().optional().describe('Substring of refdes, part id, value or net name'),
    category: z.string().optional(),
  }),
  z.object({ op: z.literal('get_component'), ref: componentRef }),
  z.object({ op: z.literal('get_net'), net: netName }),
  z.object({ op: z.literal('get_diagnostics') }),
  z.object({ op: z.literal('get_ledger') }),
  z.object({ op: z.literal('get_description') }).describe('The design description (describe): overview, functional blocks with their parts, and the parts no block covers yet'),
  z.object({ op: z.literal('get_fab_profiles') }).describe('The built-in manufacturer profiles (JLCPCB, PCBWay, Eurocircuits: ids, limits, source pages) and the one this board uses'),
  z.object({ op: z.literal('get_schematic') }).describe('Schematic drawing: each page (number, name, paper size in mils, drawn by the auto-layout or as you arranged it), where each symbol stands (centre and size in mils from the paper\'s top-left) and the net labels with the pins they sit on (auto: a connection your drawing does not show yet)'),
  z.object({ op: z.literal('get_board') }).describe('Board layout: outline, part positions (mm, centre, clockwise rotation, pinned or placed automatically), routing stats and DRC results'),
  z.object({
    op: z.literal('try_placements'),
    candidates: z
      .array(
        z.object({
          name: z.string().optional().describe('What this option is, e.g. "U1 turned 90°, J1 left"'),
          parts: z.array(PartPlacement).min(1).describe('The main parts\' places and rotations, as propose_placement takes them'),
          width_mm: z.number().positive().optional(),
          height_mm: z.number().positive().optional(),
        }),
      )
      .min(1)
      .max(8),
    route: z.boolean().optional().describe('Also route each option for a few seconds (a trial: how many connections it closes). Slower; use it to choose between options whose ratsnest is close'),
  }).describe('Compare arrangements of the main parts without changing the design: each is placed as propose_placement would place it (small parts round them) and measured (ratsnest length, crossing ratsnest lines, overlaps, board size; with route a trial routing). Lists the current placement too, then the options best first. Apply the winner with design_edit propose_placement'),
  z.object({
    op: z.literal('search_parts'),
    text: z.string().describe('Search text: function, MPN, category ("buck", "capacitor", "555")'),
  }),
  z.object({ op: z.literal('get_part'), id: z.string() }),
  z.object({ op: z.literal('get_enclosure') }).describe('The enclosure: the brief, the script, the board as an OpenSCAD library (board.scad: its variables and modules, the parts with where they are and which way they are plugged), OpenSCAD on this computer, the last render\'s report'),
  z.object({ op: z.literal('get_guide'), topic: z.enum(['mechanics']) }).describe('A guide: mechanics = how to design an enclosure (the brief\'s questions, connectors, holding the board, fits, printing, the script). Read it before the first brief'),
]);
export type QueryOp = z.infer<typeof QueryOp>;
