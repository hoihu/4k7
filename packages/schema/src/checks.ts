/**
 * Every code a finding can carry, whoever reports it (the kernel, the production-file check in
 * packages/fab, the enclosure, the panel). A test reads the code literals out of the sources and fails
 * when one is reported that is not listed here, or listed that nothing reports.
 * See docs/design/spec.md §6 and docs/design/scorecard.md.
 */
export interface CheckInfo {
  /**
   * The findings that say this check could not judge (a net with no max_current, a part with no
   * rating). While one of them is open on the same thing, the absence of this check's finding does not
   * mean the check passed.
   */
  unknownWhen?: readonly string[];
}

export const CHECKS: Readonly<Record<string, CheckInfo>> = {
  // ASM
  'ASM.COLLIDES': {},
  // DRAW
  'DRAW.ANGLE': {},
  'DRAW.DANGLING': {},
  // DRC
  'DRC.ACID_TRAP': {},
  'DRC.CLEARANCE': {},
  'DRC.COURTYARD_OVERLAP': {},
  'DRC.CURRENT_UNKNOWN': {},
  'DRC.CURRENT_UNVERIFIED': {},
  'DRC.CUTOUT_OVERLAP': {},
  'DRC.DEAD_COPPER': {},
  'DRC.EDGE_CLEARANCE': {},
  'DRC.FAB_BOARD_SIZE': {},
  'DRC.FAB_HOLE': {},
  'DRC.FAB_HOLE_SPACING': {},
  'DRC.FAB_LAYERS': {},
  'DRC.FAB_MASK_WEB': {},
  'DRC.FAB_RING': {},
  'DRC.FAB_RULES': {},
  'DRC.FAB_SILK': {},
  'DRC.FAB_SILK_TEXT': {},
  'DRC.FAB_SPOKE': {},
  'DRC.FAB_TRACK': {},
  'DRC.FAB_VIA': {},
  'DRC.FLOATING_PLANE': {},
  'DRC.IR_DROP': { unknownWhen: ['DRC.CURRENT_UNKNOWN'] },
  'DRC.KEEPOUT': {},
  'DRC.LOCKED_BROKEN': {},
  'DRC.NECK': {},
  'DRC.NO_FOOTPRINT': {},
  'DRC.OFF_BOARD': {},
  'DRC.PLANE_VIAS': {},
  'DRC.POLARITY_UNKNOWN': {},
  'DRC.ROOM': {},
  'DRC.ROUTING_INCOMPLETE': {},
  'DRC.SHARED_PAD_NETS': {},
  'DRC.SHORT': {},
  'DRC.SILK_OUTSIDE': {},
  'DRC.SILK_OVER_PARTS': {},
  'DRC.SILK_POLARITY': { unknownWhen: ['DRC.POLARITY_UNKNOWN'] },
  'DRC.SPOKE_CURRENT': { unknownWhen: ['DRC.CURRENT_UNKNOWN'] },
  'DRC.THERMAL_SPOKES': {},
  'DRC.TRACK_CURRENT': { unknownWhen: ['DRC.CURRENT_UNKNOWN', 'DRC.CURRENT_UNVERIFIED'] },
  'DRC.TRACK_NOT_LAID': {},
  'DRC.UNROUTED': {},
  'DRC.VIA_CURRENT': { unknownWhen: ['DRC.CURRENT_UNKNOWN', 'DRC.CURRENT_UNVERIFIED'] },
  'DRC.VIA_IN_PAD': {},
  // ENC
  'ENC.BLOCKED': {},
  'ENC.BRIDGE': {},
  'ENC.COLLIDES': {},
  'ENC.LOOSE': {},
  'ENC.LOW_LID': {},
  'ENC.NEAR': {},
  'ENC.NO_MATING': {},
  'ENC.OVERHANG': {},
  'ENC.PIECES_OVERLAP': {},
  'ENC.SCRIPT': {},
  'ENC.SIZE': {},
  'ENC.THIN': {},
  'ENC.WARP': {},
  // ERC
  'ERC.BOARD_CROSSING': {},
  'ERC.INPUT_UNDRIVEN': {},
  'ERC.IO_UNUSED': {},
  'ERC.MATE_CURRENT': { unknownWhen: ['ERC.MATE_CURRENT_UNKNOWN'] },
  'ERC.MATE_CURRENT_UNKNOWN': {},
  'ERC.MATE_FIT': {},
  'ERC.MATE_MISMATCH': {},
  'ERC.MATE_OPEN': {},
  'ERC.MATE_SAME_BOARD': {},
  'ERC.NC_CONNECTED': {},
  'ERC.OUTPUT_CONFLICT': {},
  'ERC.PIN_UNCONNECTED': {},
  'ERC.POWER_UNDRIVEN': {},
  'ERC.SINGLE_PIN_NET': {},
  // FAB
  'FAB.FLOATING': {},
  'FAB.OPEN': {},
  'FAB.PAD_MISSING': {},
  'FAB.SHORT': {},
  // IMP
  'IMP.COPLANAR': {},
  'IMP.CORNER': {},
  'IMP.GAP': {},
  'IMP.LAYER': {},
  'IMP.LENGTH': {},
  'IMP.PAIR': {},
  'IMP.REFERENCE': {},
  'IMP.SKEW': {},
  'IMP.SPACING': {},
  'IMP.VIA': {},
  'IMP.WIDTH': {},
  // LEDGER
  'LEDGER.PARAM': {},
  'LEDGER.PLACEMENT': {},
  'LEDGER.VIOLATED': {},
  // LIB
  'LIB.PART_MISSING': {},
  // PANEL
  'PANEL.HOLE': {},
  'PANEL.LOOSE': {},
  'PANEL.MARKS': {},
  'PANEL.RAILS': {},
  'PANEL.SIZE': {},
  'PANEL.TAB': {},
  'PANEL.TABS': {},
  'PANEL.TAB_OVERHANG': {},
  'PANEL.TAB_ZONE': {},
  // PLANE
  'PLANE.SPLIT_CROSSING': {},
  // SCH
  'SCH.CROSSING': {},
  'SCH.DANGLING': {},
  'SCH.DETOUR': {},
  'SCH.GND_DOWN': {},
  'SCH.JOG': {},
  'SCH.ORTHOGONAL': {},
  'SCH.RAIL_SIDE': {},
  'SCH.RAIL_UP': {},
  'SCH.TEXT_OVERLAP': {},
  // SEM
  'SEM.ABS_MAX': { unknownWhen: ['SEM.VOLTAGE_UNKNOWN'] },
  'SEM.CAP_DERATING': { unknownWhen: ['SEM.VOLTAGE_UNKNOWN', 'SEM.RATING_MISSING'] },
  'SEM.CAP_VOLTAGE': { unknownWhen: ['SEM.VOLTAGE_UNKNOWN', 'SEM.RATING_MISSING'] },
  'SEM.DECOUPLING': {},
  'SEM.EN_FLOATING': {},
  'SEM.LDO_DISSIPATION': {},
  'SEM.PIN_CURRENT': {},
  'SEM.POLARITY': {},
  'SEM.PULL': {},
  'SEM.RATING_MISSING': {},
  'SEM.REQUIREMENT': {},
  'SEM.REQUIREMENT_VALUE': {},
  'SEM.VALUE_MISSING': {},
  'SEM.VALUE_SERIES': {},
  'SEM.VOLTAGE_UNKNOWN': {},
  // XCHK
  'XCHK.BOARD_NET_UNKNOWN': {},
  'XCHK.LAND_OFF_CENTRE': {},
  'XCHK.NET_INCOMPLETE': {},
  'XCHK.NOT_IN_BOM': {},
  'XCHK.PACKAGE_MISMATCH': {},
  'XCHK.PAD_NO_PIN': {},
  'XCHK.PIN_NO_PAD': {},
  'XCHK.PIN_PAD_MAP': {},
};

/** A code some finding can carry. */
export const isCheckCode = (code: string): boolean => Object.hasOwn(CHECKS, code);

/** The codes that say a check could not judge: some check's unknownWhen. */
export const UNKNOWN_CODES: ReadonlySet<string> = new Set(Object.values(CHECKS).flatMap((c) => c.unknownWhen ?? []));

/** A code's family: the part before the dot ("DRC" of "DRC.SHORT"). */
export const checkFamily = (code: string): string => code.slice(0, code.indexOf('.'));
