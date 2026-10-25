/**
 * Sourcing for assembly, whichever house assembles the board. A house assembles parts it knows by a
 * number: its own catalogue's ("C25804" at JLCPCB), its generic parts' ("GPR06034K7" at Eurocircuits)
 * or the maker's part number. A component records the house's number in the house's parameter
 * (`lcsc`, `eurocircuits`), the BOM carries it, and the house's catalogue says what it has and what
 * it costs.
 *
 * What is particular to a house is its `AssemblyHouse` entry here and its catalogue adapter
 * (packages/parts/src/jlc.ts for JLCPCB, eurocircuits.ts, pcbway.ts). Searching, ranking and the
 * checks work for any house. Stock and prices are snapshots at the time of the call and are never
 * stored in the design. Amounts are in the house's currency (`AssemblyHouse.currency`).
 */
import { normalizeLcsc } from './part.ts';

/** A part as an assembly house lists it, read at the time of the call. */
export interface SupplierPart {
  /** The house's part number, the one its BOM upload reads ("C25804", "GPR06034K7", a maker's part number). */
  sku: string;
  /** Manufacturer part number. */
  mpn: string;
  manufacturer?: string;
  /** Package as the house names it ("0603", "SOT-23", "SMD,5x5mm"). */
  package: string;
  description: string;
  /** Pieces the house has now; null when the source does not say (unknown, not none). */
  stock: number | null;
  /**
   * Where the house gets it when the stock is not counted: `stock`, it keeps the part in its own
   * stock and reorders it (no count published); `order`, it buys the part for each order from its
   * suppliers. Absent: the stock above is all there is to know.
   */
  supply?: 'stock' | 'order';
  /** The house's class of the part ("Basic", "Extended"); '' when it has none. */
  tier: string;
  /** The house charges a fee for using this part (JLCPCB: Extended parts; Eurocircuits: On Demand parts). */
  fee: boolean;
  /** Price breaks per piece in the house's currency, smallest quantity first (may be empty: no price). */
  price: { qty: number; each: number }[];
  /**
   * Catalogue attributes as listed. The checks read Resistance, Capacitance, Inductance, Voltage Rated,
   * Tolerance, Power(Watts), Temperature Coefficient and Value, so an adapter lists a house's own names
   * for these under them.
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
  /** Where the maker is with the part when the catalogue says: "active", "obsolete", "nrnd" … */
  lifecycle?: string;
  /** How the house places it, when its catalogue says (its price depends on it). */
  placement?: PlacementKind;
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
  /** Only parts without a fee. */
  noFee?: boolean;
  limit?: number;
}

/** Stock below this many times what the build needs may be gone by the time the order is placed. */
export const STOCK_MARGIN = 5;

/** A tier of a price that falls with the quantity: it applies up to `upTo` (inclusive). */
export interface PriceTier {
  upTo: number;
  each: number;
}

/**
 * How a part is placed, as a house may price it: by machine (`fine`: chips of 0201 and smaller, and
 * leads at 0.5 mm or less), QFN, BGA and LGA packages (their fine-pitch kinds), through-hole (`th`),
 * through-hole and surface pads together (`mixed`), on the board's edge (`edge`).
 */
export type PlacementKind = 'smd' | 'fine' | 'qfn' | 'qfnFine' | 'bga' | 'bgaFine' | 'lga' | 'th' | 'mixed' | 'edge';

/** Each placement kind in words. */
export const PLACEMENT_NAMES: Record<PlacementKind, string> = {
  smd: 'SMD',
  fine: 'fine-pitch SMD',
  qfn: 'QFN',
  qfnFine: 'fine-pitch QFN',
  bga: 'BGA',
  bgaFine: 'fine-pitch BGA',
  lga: 'LGA',
  th: 'through-hole',
  mixed: 'mixed',
  edge: 'edge-mount',
};

/** A fee per unique part number (a BOM line); `name` says it with `{n}` for their number. */
export interface LineFee {
  name: string;
  each: number;
  /** Only for the part numbers with a fee (`SupplierPart.fee`), on top of what every one costs. */
  only?: 'fee';
}

/**
 * One way a house assembles an order: what it charges besides the parts (as its price list gives it,
 * in the house's currency) and what it takes on. A house whose prices are only known by asking it
 * (`quoted`) has none of the fees: its estimate comes from its quote.
 */
export interface AssemblyService {
  name: string;
  /** Per order: setup and stencil for parts on one side, and on both sides (absent: one side only). */
  setup: number;
  setupBothSides?: number;
  stencil: number;
  stencilBothSides?: number;
  /** Per unique part number: JLCPCB's loading fee; Eurocircuits' fees per BOM line and per part. */
  loading: readonly LineFee[];
  /** Per solder joint, by the order's number of joints: placed by machine, and soldered by hand (through-hole). */
  smtJoint: readonly PriceTier[];
  handJoint: readonly PriceTier[];
  /** Per order, when anything is soldered by hand. */
  handLabor: number;
  /**
   * Per part placed, per board, by how it is placed; `kind`: once per order for each kind of placement
   * the order has; `volume`: the placement prices fall with the order's placements (the factor of the
   * first step the order's placements are at or under; the last beyond).
   */
  placement?: { each: Partial<Record<PlacementKind, number>>; kind?: number; volume?: readonly { upTo: number; factor: number }[] };
  /** Per board; and, for boards delivered one by one rather than in a panel, once and per board. */
  perBoard?: number;
  singleBoards?: { order: number; board: number };
  /** The house prices it only when asked (an online quote); the fees above are not used. */
  quoted?: boolean;
  /** What it takes on: sides, boards per order, layer counts, the smallest chip, the board's size (mm, either way round), placements per order. */
  limits: {
    sides: 1 | 2;
    boards: readonly [number, number];
    layers?: readonly number[];
    smallestChip?: string;
    boardSize?: { min: readonly [number, number]; max: readonly [number, number] };
    placements?: { smd?: number; th?: number };
  };
  /** What it charges besides, left out of an estimate. */
  notCounted?: string;
}

/** What makes the bare board cost more at the house (it makes the boards it assembles), as its pages give it. */
export interface BoardPrices {
  /** Holes (vias, drills) below this diameter (mm) cost extra; and above this one. */
  smallHoleBelow?: number;
  largeHoleAbove?: number;
  /** Tracks or gaps below this (mm) cost extra (Eurocircuits' pattern classes 8 and 9). */
  fineTrackBelow?: number;
  /** Its cheapest offers: so many boards up to a size, with these layer counts, for a price. */
  offers?: readonly { layers: readonly number[]; maxSize: readonly [number, number]; boards: number; price: number }[];
  /** In a panel, single boards up to this size (mm) lose their special price. */
  panelLosesPriceUpTo?: readonly [number, number];
  /** A fee per board for a small board: below `below` mm on a side (the smallest that applies). */
  smallBoard?: readonly { below: number; fee: number }[];
  /** Boards larger than this (cm²) cost extra. */
  largeAbove?: number;
  source: { url: string; offersUrl?: string; checked: string };
}

/** A special price the house's quote takes for small orders: what it is called, and what an order must keep to. */
export interface AssemblyOffer {
  name: string;
  /** In words, for people and the agent. */
  terms: string;
  url: string;
}

/** What is particular to an assembly house. */
export interface AssemblyHouse {
  /** "jlcpcb": the catalogue adapter's key (the server's /api/sourcing/<id>/…). */
  id: string;
  name: string;
  /** Other names people use for it ("JLC"). */
  aliases?: readonly string[];
  /** What its prices are in. */
  currency: 'USD' | 'EUR';
  /** The component parameter that holds the house's part number; absent: the house orders by the maker's part number only. */
  param?: string;
  /** A component without the house's own number is ordered by its manufacturer part number. */
  byMpn?: boolean;
  /** A resistor or capacitor without one is ordered by its value and package ("10k 1% 0603"). */
  byValue?: boolean;
  /** What its part numbers are called, and the short label where room is short. */
  numberName: string;
  numberLabel: string;
  example: string;
  /** Its classes of parts, cheapest to assemble first, and whether one costs a fee. */
  tiers: readonly { name: string; fee: boolean }[];
  /** The fee, for people and the agent. */
  feeNote: string;
  /** How sourcing works at the house, in a sentence for the agent: its numbers and parameter, its classes, what its catalogue says. */
  agentNote: string;
  /** How to keep a scarce part for an order, as a suggestion to the user ("buy it ahead …"). */
  reserveNote: string;
  /** Why the app cannot look its parts up, when it cannot (it keeps no catalogue the app can read). */
  noCatalogue?: string;
  /** Its ways of assembling an order, cheapest first, and where their prices and limits were read (`name`: what the source is, "price page" when absent). */
  services: readonly AssemblyService[];
  prices: { url: string; name?: string; limitsUrl?: string; checked: string };
  /** What an estimate of an order leaves out, for people ("the bare boards, shipping …"). */
  notInEstimate: string;
  /** What makes its bare boards cost more. */
  board?: BoardPrices;
  /** Its offer for small orders, when it has one. */
  offer?: AssemblyOffer;
  /** The part's page at the house (absent: it has none). */
  partUrl?(sku: string): string;
  /** The house's part number in its usual form; null when `s` is not one. */
  normalize(s: string): string | null;
  /**
   * What a number its catalogue does not list means, when the house still orders it (it looks for
   * parts outside its catalogue): a warning for people; absent or null, the order stops there.
   */
  unlisted?(sku: string): string | null;
}

/* ---------------------------------- JLCPCB ---------------------------------- */

/** JLCPCB's price per hand-soldered (through-hole) joint, the same in both its services. */
const JLC_HAND_JOINT: readonly PriceTier[] = [
  { upTo: 10_000, each: 0.0164 },
  { upTo: 30_000, each: 0.015 },
  { upTo: 100_000, each: 0.012 },
];

const JLC_LOADING = 'loading {n} part number{s}';

/** Prices and limits as JLCPCB's pages gave them on the date in `prices` (they change; the pages say so). */
export const JLCPCB_ASSEMBLY: AssemblyHouse = {
  id: 'jlcpcb',
  name: 'JLCPCB',
  aliases: ['JLC'],
  currency: 'USD',
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
  agentNote:
    'JLCPCB assembles parts from its own catalogue by LCSC number (set_param lcsc "C25804"); its search gives the stock now and the prices; Basic and Preferred parts have no loading fee in Economic assembly, Extended parts do; a component without an LCSC number is not on its order',
  reserveNote: 'buy it ahead into their JLCPCB parts inventory (a parts pre-order, or the whole BOM at once with JLCPCB\'s BOM tool, jlcpcb.com/parts/bom-tool), so the pieces are kept for their order',
  services: [
    {
      name: 'Economic',
      setup: 8.18,
      stencil: 1.53,
      loading: [{ name: JLC_LOADING, each: 3.07, only: 'fee' }],
      smtJoint: [{ upTo: 100_000, each: 0.0016 }],
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
      loading: [{ name: JLC_LOADING, each: 1.53 }],
      smtJoint: [
        { upTo: 50_000, each: 0.0016 },
        { upTo: 100_000, each: 0.0013 },
        { upTo: 1_000_000, each: 0.0012 },
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
      { layers: [1, 2], maxSize: [100, 100], boards: 5, price: 2 },
      { layers: [4, 6, 8], maxSize: [50, 50], boards: 5, price: 2 },
    ],
    panelLosesPriceUpTo: [102, 102],
    smallBoard: [
      { below: 15, fee: 0.05 },
      { below: 30, fee: 0.02 },
    ],
    largeAbove: 650,
    source: { url: 'https://jlcpcb.com/help/article/In-what-cases-will-there-be-charged-extra', offersUrl: 'https://jlcpcb.com/blog/4-free', checked: '2026-10-25' },
  },
  partUrl: (sku) => `https://jlcpcb.com/partdetail/${sku}`,
  normalize: normalizeLcsc,
};

/* ------------------------------- Eurocircuits ------------------------------- */

/**
 * Eurocircuits' assembly prices: the price table its online calculator runs on (version 261001_1,
 * read 2026-10-25; it publishes no price list), each value × its assembly factor 1.1, in EUR without
 * VAT. Checked against the calculator's own quotes (5, 10 and 50 boards of 20 On Demand parts and 100
 * placements, 5 with 10 through-hole ones): the same within a few cents, as it rounds per board, less its panel cost.
 */
export const EUROCIRCUITS_ASSEMBLY: AssemblyHouse = {
  id: 'eurocircuits',
  name: 'Eurocircuits',
  aliases: ['EC', 'Eurocircuit'],
  currency: 'EUR',
  param: 'eurocircuits',
  byMpn: true,
  numberName: 'Eurocircuits part number',
  numberLabel: 'EC part',
  example: 'GPR06034K7',
  tiers: [
    { name: 'Generic', fee: false },
    { name: 'eC-stock', fee: false },
    { name: 'On Demand', fee: true },
  ],
  feeNote:
    'Eurocircuits charges €1.93 per BOM line and €3.85 per unique part, €5.50 for an On Demand part (bought for the order) instead of a Generic or eC-stock one (kept in stock); Generic resistors and capacitors are free when they cost €0.02 or less (most do)',
  agentNote:
    'Eurocircuits assembles from its component database: a resistor or capacitor as one of its Generic parts (set_param eurocircuits "GPR06034K7"; kept in stock, free at €0.02 or less), other parts by manufacturer part number (set_param eurocircuits only for another part than the component\'s own MPN, which it orders otherwise), as eC-stock (kept in stock) or On Demand (bought for the order, a higher fee per part); the database gives no stock counts and no prices besides, and says when a part is obsolete; per BOM line, per unique part, per side and per placement fees make one part number less, one side and fewer through-hole parts the big savings',
  reserveNote: "pre-order it with Eurocircuits' Parts Pre-Order service (PPO, eurocircuits.com/user-guides/parts-pre-order-user-guide), so the pieces are in-house when the order goes in",
  services: [
    {
      name: 'Assembly',
      // per SMD side
      setup: 55,
      setupBothSides: 110,
      stencil: 0,
      loading: [
        { name: '{n} BOM line{s}', each: 1.925 },
        { name: '{n} unique part{s}', each: 3.85 },
        { name: '{n} of them On Demand', each: 1.65, only: 'fee' },
      ],
      smtJoint: [],
      handJoint: [],
      handLabor: 0,
      placement: {
        each: { smd: 0.11, fine: 0.55, bga: 0.55, bgaFine: 1.1, qfn: 0.88, qfnFine: 1.1, lga: 1.1, th: 0.6875, mixed: 0.825, edge: 1.375 },
        kind: 22,
        volume: [
          { upTo: 1000, factor: 1 },
          { upTo: 2500, factor: 0.95 },
          { upTo: 5000, factor: 0.9 },
          { upTo: 10_000, factor: 0.85 },
          { upTo: 15_000, factor: 0.8 },
          { upTo: 20_000, factor: 0.75 },
          { upTo: 30_000, factor: 0.74 },
          { upTo: 40_000, factor: 0.73 },
          { upTo: 50_000, factor: 0.72 },
          { upTo: 60_000, factor: 0.71 },
          { upTo: 75_000, factor: 0.7 },
        ],
      },
      perBoard: 0.275,
      singleBoards: { order: 27.5, board: 0.55 },
      limits: { sides: 2, boards: [1, 50], smallestChip: '0201', boardSize: { min: [5, 5], max: [340, 440] }, placements: { smd: 25_000, th: 800 } },
      notCounted:
        "the assembly panel the calculator adds (€12.70 for 5 boards of 100 × 80 mm, €25.10 for 10), a shorter lead time than the standard one, and above 200 BOM lines or 1000 placements Eurocircuits prices by hand",
    },
  ],
  prices: { url: 'https://be.eurocircuits.com/shop/assembly/configurator.aspx', name: 'online calculator', limitsUrl: 'https://www.eurocircuits.com/services/pcb-assembly-capabilities/', checked: '2026-10-25' },
  notInEstimate:
    'the bare boards (Eurocircuits prices them by size, layers, class and service in the same calculator), parts other than Generic ones (it prices them from its suppliers when the BOM is uploaded), VAT and shipping',
  board: {
    smallHoleBelow: 0.15,
    fineTrackBelow: 0.125,
    source: { url: 'https://www.eurocircuits.com/technical-guidelines/pcb-design-guidelines/classification/', checked: '2026-10-25' },
  },
  partUrl: (sku) => `https://be.eurocircuits.com/shop/assembly/partdetail.aspx?mpn=${encodeURIComponent(sku)}`,
  normalize: (s) => {
    const t = s.trim().replace(/\s+/g, ' ');
    return t.length >= 2 && t.length <= 60 ? (/^gp[rch]/i.test(t) ? t.toUpperCase() : t) : null;
  },
  // a Generic number it does not list is a wrong number; a manufacturer's it looks for when the order goes in
  unlisted: (sku) => (/^GP[RCH]/i.test(sku) ? null : "not in Eurocircuits' database: check the number; it looks for a part outside it when the order goes in, or asks for another"),
};

/* ---------------------------------- PCBWay ---------------------------------- */

/**
 * PCBWay publishes no assembly fees: its online quote (pcbway.com/quotesmt.aspx) prices the assembly
 * by the boards, the sides, the unique parts and the parts placed per board, and the app asks it
 * (through the local server, like a catalogue). It keeps no parts catalogue the app can read: it buys
 * the parts for the order and prices them after the BOM is uploaded. Limits as its pages gave them on
 * 2026-10-25 (two pages disagree on the smallest board: 10 × 10 mm assembled, 50 × 100 mm without a panel).
 */
export const PCBWAY_ASSEMBLY: AssemblyHouse = {
  id: 'pcbway',
  name: 'PCBWay',
  aliases: ['PCB Way'],
  currency: 'USD',
  byMpn: true,
  byValue: true,
  numberName: 'manufacturer part number',
  numberLabel: 'MPN',
  example: 'AMS1117-3.3',
  tiers: [],
  feeNote: 'PCBWay publishes no fees: its online quote prices the assembly by the boards, the sides, the unique parts and the parts placed per board (large ICs and through-hole parts apart)',
  agentNote:
    'PCBWay buys every part for the order by its manufacturer part number (resistors and capacitors may go by value and package) and prices them after the BOM is uploaded: no catalogue to search, no stock to check, no part prices here; its online quote prices the assembly (with its special price for small orders), so cost is the one check that tells something new',
  reserveNote: 'ask PCBWay to buy it when it quotes the BOM, or send it to PCBWay with the order (combo assembly)',
  noCatalogue:
    'PCBWay keeps no parts catalogue the app can read: it buys the parts for the order from distributors (Digi-Key, Mouser, Farnell, Arrow …) and prices them after the BOM is uploaded, usually within a business day',
  services: [
    {
      name: 'Turnkey',
      setup: 0,
      stencil: 0,
      loading: [],
      smtJoint: [],
      handJoint: [],
      handLabor: 0,
      quoted: true,
      limits: { sides: 2, boards: [1, 100_000], smallestChip: '01005', boardSize: { min: [50, 100], max: [250, 500] } },
      notCounted: 'depaneling, coating, programming and testing beyond AOI',
    },
  ],
  prices: { url: 'https://www.pcbway.com/quotesmt.aspx', name: 'online quote', limitsUrl: 'https://www.pcbway.com/assembly-capabilities.html', checked: '2026-10-25' },
  notInEstimate:
    'the parts (PCBWay buys them for the order and prices them after the BOM is uploaded), the bare boards (10 two-layer boards up to 100 × 100 mm from $5, with leaded HASL), shipping, taxes and duties',
  board: {
    smallHoleBelow: 0.2,
    largeHoleAbove: 6,
    offers: [{ layers: [1, 2], maxSize: [100, 100], boards: 10, price: 5 }],
    source: { url: 'https://www.pcbway.com/capabilities.html', offersUrl: 'https://www.pcbway.com/', checked: '2026-10-25' },
  },
  offer: {
    name: 'special price',
    terms:
      "PCBWay's quote takes a special price off small orders: $29 for up to 20 boards with up to 200 parts a board and 600 in the order, 100 kinds of part, 100 through-hole joints and no BGA or QFP part, every part bought by PCBWay; a higher one ($88 seen) for some orders past these; a new customer can use it once a month, others twice",
    url: 'https://www.pcbway.com/blog/PCB_Assembly/How_to_Get_29_PCB_Assembly_and_Meet_the_Requirements_e334dbde.html',
  },
  normalize: (s) => {
    const t = s.trim().replace(/\s+/g, ' ');
    return t.length >= 2 && t.length <= 60 ? t : null;
  },
};

/* --------------------------------- registry --------------------------------- */

/** The houses the app sources for, each with its catalogue adapter; another plugs in here. */
export const ASSEMBLY_HOUSES: readonly AssemblyHouse[] = [JLCPCB_ASSEMBLY, EUROCIRCUITS_ASSEMBLY, PCBWAY_ASSEMBLY];

/** The house sourced for until the user picks another (Layout → Sourcing). */
export const ASSEMBLY_HOUSE: AssemblyHouse = JLCPCB_ASSEMBLY;

/** A house by its id or name, loosely ("JLC", "jlcpcb"); undefined when there is none. */
export function assemblyHouse(name: string | undefined): AssemblyHouse | undefined {
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const q = squash(name ?? '');
  if (!q) return undefined;
  return ASSEMBLY_HOUSES.find((h) => squash(h.id) === q || squash(h.name) === q || (h.aliases ?? []).some((a) => squash(a) === q));
}

/** "Basic and Preferred": the house's classes without a fee, for people. */
export function feeFreeTiers(house: AssemblyHouse): string {
  const names = house.tiers.filter((t) => !t.fee).map((t) => t.name);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? 'parts without a fee');
}

/** "JLCPCB's", "Eurocircuits'". */
export const whose = (house: Pick<AssemblyHouse, 'name'>) => (/s$/i.test(house.name) ? `${house.name}'` : `${house.name}'s`);

/** "$" or "€". */
export const currencySymbol = (house: Pick<AssemblyHouse, 'currency'>) => (house.currency === 'EUR' ? '€' : '$');

/** An amount in the house's currency: "$3.07", "€5.50". */
export function money(v: number, house: Pick<AssemblyHouse, 'currency'>): string {
  return `${currencySymbol(house)}${v.toFixed(2)}`;
}

/** A fee's name for `n` part numbers: "{n} BOM line{s}" → "3 BOM lines". */
export function feeName(name: string, n: number): string {
  return name.replace('{n}', n.toLocaleString('en-US')).replace('{s}', n === 1 ? '' : 's');
}
