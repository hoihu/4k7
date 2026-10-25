/**
 * Sourcing for assembly, whichever house assembles the board. A house stocks parts under its own
 * part numbers ("C25804" at JLCPCB); a component records the chosen one in the house's parameter
 * (`lcsc`), the BOM carries it, and the house's catalogue says what is in stock and what it costs.
 *
 * What is particular to a house is its `AssemblyHouse` entry here and its catalogue adapter
 * (packages/parts/src/jlc.ts for JLCPCB). Searching, ranking and the stock check work for any house.
 * Stock and prices are snapshots at the time of the call and are never stored in the design.
 */
import { normalizeLcsc } from './part.ts';

/** A part as an assembly house lists it, read at the time of the call. */
export interface SupplierPart {
  /** The house's part number, the one its BOM upload reads ("C25804"). */
  sku: string;
  /** Manufacturer part number. */
  mpn: string;
  manufacturer?: string;
  /** Package as the house names it ("0603", "SOT-23", "SMD,5x5mm"). */
  package: string;
  description: string;
  /** Pieces the house has now; null when the source does not say (unknown, not none). */
  stock: number | null;
  /** The house's class of the part ("Basic", "Extended"); '' when it has none. */
  tier: string;
  /** The house charges a one-off fee for using this part (JLCPCB: Extended parts). */
  fee: boolean;
  /** Price breaks in USD per piece, smallest quantity first (may be empty). */
  price: { qty: number; usd: number }[];
  /**
   * Catalogue attributes as listed. The checks read Resistance, Capacitance, Inductance, Voltage Rated
   * and Value, so an adapter lists a house's own names for these under them.
   */
  attributes: Record<string, string>;
  category?: string;
  /** Datasheet PDF link when the catalogue has one. */
  datasheet?: string;
  /** The part's page at the house. */
  url: string;
  /** Read from the house's own catalogue just now; false: from a copy elsewhere, which may lag. */
  live: boolean;
  /** Pieces the house adds to what the boards need, for losses in assembly. */
  attrition?: number;
  /** The fewest pieces the house assembles from: it buys at least these. */
  minQty?: number;
}

/** A catalogue search. */
export interface PartQuery {
  /** Words of the catalogue description or a part number ("passive buzzer", "AMS1117-3.3"). */
  text?: string;
  /** Parametric search for a jellybean passive (value in `value`); text is ignored. */
  kind?: 'resistor' | 'capacitor';
  value?: string;
  /** Package as the house names it. */
  package?: string;
  /** Only parts without a one-off fee. */
  noFee?: boolean;
  limit?: number;
}

/** Stock below this many times what the build needs may be gone by the time the order is placed. */
export const STOCK_MARGIN = 5;

/** A tier of a price that falls with the quantity: it applies up to `upTo` (inclusive). */
export interface PriceTier {
  upTo: number;
  usd: number;
}

/** One way a house assembles an order: what it charges besides the parts (USD, as its price page lists them) and what it takes on. */
export interface AssemblyService {
  name: string;
  /** Per order: setup and stencil for parts on one side, and on both sides (absent: one side only). */
  setup: number;
  setupBothSides?: number;
  stencil: number;
  stencilBothSides?: number;
  /** A loading fee per unique part number: only for the parts with a fee (`SupplierPart.fee`), or for every part. */
  loading: { usd: number; per: 'fee' | 'part' };
  /** Per solder joint, by the order's number of joints: placed by machine, and soldered by hand (through-hole). */
  smtJoint: readonly PriceTier[];
  handJoint: readonly PriceTier[];
  /** Per order, when anything is soldered by hand. */
  handLabor: number;
  /** What it takes on: sides, boards per order, layer counts, the smallest chip, the board's size (mm, either way round). */
  limits: {
    sides: 1 | 2;
    boards: readonly [number, number];
    layers?: readonly number[];
    smallestChip?: string;
    boardSize?: { min: readonly [number, number]; max: readonly [number, number] };
  };
  /** What it charges besides, left out of an estimate. */
  notCounted?: string;
}

/** What makes the bare board cost more at the house (it makes the boards it assembles), as its pages give it. */
export interface BoardPrices {
  /** Holes (vias, drills) below this diameter (mm) cost extra. */
  smallHoleBelow?: number;
  /** Its cheapest offers: so many boards up to a size, with these layer counts, for a price. */
  offers?: readonly { layers: readonly number[]; maxSize: readonly [number, number]; boards: number; usd: number }[];
  /** In a panel, single boards up to this size (mm) lose their special price. */
  panelLosesPriceUpTo?: readonly [number, number];
  /** A fee per board for a small board: below `below` mm on a side (the smallest that applies). */
  smallBoard?: readonly { below: number; usd: number }[];
  /** Boards larger than this (cm²) cost extra. */
  largeAbove?: number;
  source: { url: string; offersUrl?: string; checked: string };
}

/** What is particular to an assembly house. */
export interface AssemblyHouse {
  /** "jlcpcb": the catalogue adapter's key (the server's /api/sourcing/<id>/…). */
  id: string;
  name: string;
  /** The component parameter that holds the house's part number. */
  param: string;
  /** What its part numbers are called, and the short label where room is short. */
  numberName: string;
  numberLabel: string;
  example: string;
  /** Its classes of parts, cheapest to assemble first, and whether one costs a one-off fee. */
  tiers: readonly { name: string; fee: boolean }[];
  /** The fee, for people and the agent. */
  feeNote: string;
  /** How to keep a scarce part for an order, as a suggestion to the user ("buy it ahead …"). */
  reserveNote: string;
  /** Its ways of assembling an order, cheapest first, and where their prices and limits were read. */
  services: readonly AssemblyService[];
  prices: { url: string; limitsUrl?: string; checked: string };
  /** What an estimate of an order leaves out, for people ("the bare boards, shipping …"). */
  notInEstimate: string;
  /** What makes its bare boards cost more. */
  board?: BoardPrices;
  partUrl(sku: string): string;
  /** The house's part number in its usual form; null when `s` is not one. */
  normalize(s: string): string | null;
}

/** JLCPCB's price per hand-soldered (through-hole) joint, the same in both its services. */
const JLC_HAND_JOINT: readonly PriceTier[] = [
  { upTo: 10_000, usd: 0.0164 },
  { upTo: 30_000, usd: 0.015 },
  { upTo: 100_000, usd: 0.012 },
];

/** Prices and limits as JLCPCB's pages gave them on the date in `prices` (they change; the pages say so). */
export const JLCPCB_ASSEMBLY: AssemblyHouse = {
  id: 'jlcpcb',
  name: 'JLCPCB',
  param: 'lcsc',
  numberName: 'LCSC number',
  numberLabel: 'LCSC',
  example: 'C25804',
  tiers: [
    { name: 'Basic', fee: false },
    { name: 'Preferred', fee: false },
    { name: 'Extended', fee: true },
  ],
  feeNote: 'in Economic assembly JLCPCB charges a loading fee once per unique Extended part in an order (Basic and Preferred parts have none); Standard assembly charges one for every unique part',
  reserveNote: 'buy it ahead into their JLCPCB parts inventory (a parts pre-order, or the whole BOM at once with JLCPCB\'s BOM tool, jlcpcb.com/parts/bom-tool), so the pieces are kept for their order',
  services: [
    {
      name: 'Economic',
      setup: 8.18,
      stencil: 1.53,
      loading: { usd: 3.07, per: 'fee' },
      smtJoint: [{ upTo: 100_000, usd: 0.0016 }],
      handJoint: JLC_HAND_JOINT,
      handLabor: 3.58,
      limits: { sides: 1, boards: [2, 50], layers: [2, 4, 6], smallestChip: '0402', boardSize: { min: [10, 10], max: [470, 500] } },
    },
    {
      name: 'Standard',
      setup: 25.56,
      setupBothSides: 51.12,
      stencil: 8.21,
      stencilBothSides: 16.42,
      loading: { usd: 1.53, per: 'part' },
      smtJoint: [
        { upTo: 50_000, usd: 0.0016 },
        { upTo: 100_000, usd: 0.0013 },
        { upTo: 1_000_000, usd: 0.0012 },
      ],
      handJoint: JLC_HAND_JOINT,
      handLabor: 3.58,
      limits: { sides: 2, boards: [2, 80_000], smallestChip: '01005', boardSize: { min: [70, 70], max: [460, 500] } },
      notCounted: 'packing ($0.50 + the board area), fixtures, and a minimum of $0.48 assembly per board on bulk orders',
    },
  ],
  prices: { url: 'https://jlcpcb.com/help/article/pcb-assembly-price', limitsUrl: 'https://jlcpcb.com/capabilities/pcb-assembly-capabilities', checked: '2026-10-24' },
  notInEstimate:
    "the bare boards (JLCPCB quotes them by size, layers and options; 5 two-layer boards up to 100 × 100 mm are $2), shipping, taxes and duties, and coupons and offers (JLCPCB's monthly assembly coupons can cover the setup fee)",
  board: {
    smallHoleBelow: 0.3,
    offers: [
      { layers: [1, 2], maxSize: [100, 100], boards: 5, usd: 2 },
      { layers: [4, 6, 8], maxSize: [50, 50], boards: 5, usd: 2 },
    ],
    panelLosesPriceUpTo: [102, 102],
    smallBoard: [
      { below: 15, usd: 0.05 },
      { below: 30, usd: 0.02 },
    ],
    largeAbove: 650,
    source: { url: 'https://jlcpcb.com/help/article/In-what-cases-will-there-be-charged-extra', offersUrl: 'https://jlcpcb.com/blog/4-free', checked: '2026-10-25' },
  },
  partUrl: (sku) => `https://jlcpcb.com/partdetail/${sku}`,
  normalize: normalizeLcsc,
};

/** The house the app sources for. JLCPCB is the only one so far; another plugs in here and with its catalogue adapter. */
export const ASSEMBLY_HOUSE: AssemblyHouse = JLCPCB_ASSEMBLY;

/** "Basic and Preferred": the house's classes without a fee, for people. */
export function feeFreeTiers(house: AssemblyHouse): string {
  const names = house.tiers.filter((t) => !t.fee).map((t) => t.name);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? 'parts without a fee');
}
