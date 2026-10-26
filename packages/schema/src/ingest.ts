/**
 * Datasheet ingest: what the AI extracts (facts only) and what the app derives from it.
 * The AI never draws; symbols and footprints are generated deterministically from this.
 * See docs/design/part-ingest.md.
 */
import { z } from 'zod';

export const PackageFamily = z.enum(['QFP', 'QFN', 'DFN', 'SOIC', 'SSOP', 'TSSOP', 'MSOP', 'SOT', 'BGA', 'CSP', 'DIP', 'CHIP', 'SOD', 'HEADER', 'MODULE', 'AXIAL', 'RADIAL', 'other']);
export type PackageFamily = z.infer<typeof PackageFamily>;

const mm = z.number().positive();
const dims = z.tuple([mm, mm]);

/** One pad of an explicit land pattern (mm, top view, y down, origin at the body centre). */
export const LandPad = z.object({
  number: z.string().min(1).describe('The pin number this pad belongs to (the first one, when pins share the pad: also)'),
  x: z.number().describe('Pad centre from the body centre, mm (right is +)'),
  y: z.number().describe('Pad centre from the body centre, mm (down is +, top view)'),
  w: mm.describe('Pad width (x); through-hole: the copper ring diameter'),
  h: mm.optional().describe('Pad height (y); default = w'),
  shape: z.enum(['rect', 'round']).optional().describe('Default round for drilled pads, rect otherwise'),
  drill: mm.optional().describe('Through-hole drill diameter (the datasheet hole size, else lead diameter + 0.2–0.3 mm)'),
  slot: dims
    .optional()
    .describe('A slotted (oval) hole instead of a round drill, where the datasheet draws one (USB-C shell legs, flat tabs): its width × height (x × y, top view), e.g. [0.6, 1.7]; the pad must be larger than it on both axes'),
  also: z
    .array(z.string().min(1))
    .optional()
    .describe('Further pins that share this one pad, where the datasheet lands several pins on a single pad (USB-C: A1 and B12 on one GND pad, A4 and B9 on one VBUS pad): give the pad once, number the first pin, also the others. Never split such a pad into halves'),
});
export type LandPad = z.infer<typeof LandPad>;

/**
 * Where a connector (or a button, a card slot) is used from: the face a plug, card or finger comes in
 * through, and the size of what comes in. The enclosure leaves its way out clear (docs/design/enclosure.md §3).
 */
export const Mating = z.object({
  face: z
    .enum(['left', 'right', 'top', 'bottom', 'up'])
    .describe('The side of the footprint drawing (top view, pin 1 as drawn) the plug goes in from: left, right, top (the drawing\'s top), bottom; up: plugged from above, straight down onto the board (pin headers, IDC, most wire-to-board connectors)'),
  plug_mm: dims
    .optional()
    .describe('What goes in, measured across the way it goes in: width along the face × height above the board (up: width × length as the footprint is drawn). For a cable, its plug\'s overmold (the plastic body, roughly 12–13 × 6.5–7 for a USB-C cable), not the metal part. Default: the body\'s face'),
  axis_mm: z.number().optional().describe('Edge faces: height of the plug\'s centre above the board (default: the middle of the body)'),
  along_mm: z.number().optional().describe('Edge faces: the plug\'s centre along the face from the body centre, right/down is + (default 0)'),
});
export type Mating = z.infer<typeof Mating>;

export const PackageInfo = z.object({
  name: z.string().min(2).describe('Package name as in the datasheet, e.g. "LQFP100", "UFQFPN48", "TFBGA216"'),
  family: PackageFamily.describe('AXIAL (through-hole, leads out of both ends: body_mm = length × diameter, pitch_mm = lead spacing) and RADIAL (both leads underneath: body_mm = diameter × diameter) for THT passives; QFP for LQFP/TQFP, QFN for (U)FQFPN/VQFN, BGA for (T/U)FBGA; MODULE for a small carrier board with its pins in two rows along the long edges (Raspberry Pi Pico, ESP32/WROOM modules, Arduino Nano …): body_mm = the board, span_mm[0] = distance between the two pin rows, height_mm = board thickness'),
  pins: z.number().int().positive().describe('Number of pins/balls, excluding an exposed pad'),
  pitch_mm: mm.optional().describe('Lead or ball pitch'),
  body_mm: dims.optional().describe('Body width × length, nominal (E1 × D1 for QFP; E × D for QFN/BGA)'),
  span_mm: dims.optional().describe('Leaded packages: lead tip to lead tip, width × length (E × D for QFP); DIP/MODULE: distance between the pin rows (centre to centre)'),
  lead_length_mm: mm.optional().describe('Foot length L (QFP/SOIC) or terminal length (QFN)'),
  lead_width_mm: mm.optional().describe('Lead width b'),
  height_mm: mm.optional(),
  exposed_pad_mm: dims.optional().describe('QFN/DFN thermal pad width × length'),
  grid: z.object({ rows: z.number().int().positive(), cols: z.number().int().positive() }).optional().describe('BGA ball matrix'),
  ball_mm: mm.optional().describe('BGA ball diameter'),
  page: z.number().int().optional().describe('Datasheet page with the package drawing'),
  body_shape: z.enum(['rect', 'round']).optional().describe('round: a cylindrical body (buzzers, electrolytic caps), body_mm = diameter × diameter'),
  body_chamfer: z
    .object({ mm: mm.describe('How much each corner is cut back along both edges'), corners: z.array(z.enum(['tl', 'tr', 'br', 'bl'])).min(1).describe('Top view as drawn: top left, top right, bottom right, bottom left') })
    .optional()
    .describe("Corners cut off the body's outline: an SMD electrolytic's base plate is chamfered on its + side (tl and bl with pin 1 on the left)"),
  pads: z
    .array(LandPad)
    .optional()
    .describe('Explicit land pattern, for packages no family fits (buzzers, relays, switches, terminal blocks, odd connectors; family "other"): one pad per pin, from the recommended footprint or the package drawing. Overrides the generated pads.'),
  mating: Mating.optional().describe('Connectors, card slots, switches: where the plug, card or finger comes in (from the package drawing)'),
});
export type PackageInfo = z.infer<typeof PackageInfo>;

export const DraftPin = z.object({
  number: z.string().min(1).describe('Pin number, or ball name for BGA (e.g. "A1")'),
  name: z.string().min(1).describe('Main pin name (function after reset), e.g. "PA0", "VDD", "NRST", "BOOT0"'),
  type: z
    .enum(['in', 'out', 'bidir', 'tri', 'pwr_in', 'pwr_out', 'passive', 'oc', 'nc'])
    .describe('GPIO → bidir; supply and ground pins → pwr_in; regulator outputs → pwr_out; reset/boot inputs → in; VCAP/crystal → passive; not connected → nc'),
  functions: z.array(z.string()).optional().describe('Alternate/additional functions, e.g. ["USART2_TX","TIM2_CH1"]'),
  description: z.string().optional(),
  page: z.number().int().positive().optional().describe('PDF page (the NNN of pages/page-NNN.txt) with this pin\'s table row'),
});
export type DraftPin = z.infer<typeof DraftPin>;

export const PartDraft = z.object({
  mpn: z.string().min(2).describe('Exact orderable part number, e.g. "STM32F777VIT6"'),
  manufacturer: z.string().min(2),
  title: z.string().min(2).max(30).optional().describe('The part\'s short name, no description: the base part number without ordering suffixes ("ADIN2111", "STM32F777", "TPS54331"), or its product name if it has one ("Raspberry Pi Pico")'),
  description: z.string().min(5).describe('One line: what the part is, key specs'),
  category: z.enum(['ic', 'connector', 'transistor', 'crystal', 'other']).default('ic'),
  datasheet: z.string().optional().describe('Datasheet URL if known'),
  package: PackageInfo,
  pins: z.array(DraftPin).min(1).describe('EVERY pin of this package, including every supply, ground and NC pin'),
  supply_max_v: z.number().positive().optional().describe('Absolute maximum supply voltage'),
  decoupling: z
    .array(z.object({ pin: z.string(), min: z.string().describe('e.g. "100nF", "4.7uF"'), note: z.string().optional() }))
    .optional()
    .describe('Datasheet decoupling requirements per supply pin name'),
  notes: z.array(z.string()).optional().describe('Short facts a designer needs (VCAP values, BOOT0 handling, …)'),
  pages: z
    .object({
      pinout: z.array(z.number().int()).optional(),
      package: z.array(z.number().int()).optional(),
      application: z.array(z.number().int()).optional().describe('Typical application circuits, reference and example schematics, application information'),
      design: z.array(z.number().int()).optional().describe('How to design with the part: design procedure, design requirements, component selection and formulas (inductor, capacitors, feedback divider, crystal load caps …)'),
      layout: z.array(z.number().int()).optional().describe('Layout guidelines and layout examples, thermal and PCB recommendations'),
    })
    .optional()
    .describe('PDF pages (the NNN of pages/page-NNN.txt) of each section, every page the section covers'),
});
export type PartDraft = z.infer<typeof PartDraft>;

/**
 * Explicit symbol arrangement: per side, rows (left/right) or columns (top/bottom) of pin
 * numbers. An entry with several numbers stacks pins at one position (repeated VDD/VSS);
 * null leaves a gap between groups.
 */
export interface SymbolLayout {
  left: (string[] | null)[];
  right: (string[] | null)[];
  top: (string[] | null)[];
  bottom: (string[] | null)[];
}

export interface IngestIssue {
  severity: 'error' | 'warning';
  message: string;
}
