/**
 * How much a package can dissipate, for the linear-regulator check (SEM.LDO_DISSIPATION in
 * packages/kernel/src/checks.ts). Part cards carry no θJA, so these are typical junction-to-ambient
 * values per package on a JEDEC-style test board (JESD51-7, about the minimum copper a datasheet's
 * layout asks for), taken at the conservative end of what LDO datasheets in that package state
 * (e.g. MCP1700, AP2112, MIC5205, AMS1117, LM1117, LM317, LM7805 families). The limit is the power
 * that raises the junction from 25 °C ambient to 125 °C: 100 °C / θJA. They are typical, not the
 * part's own datasheet figure: a large copper pour under the tab can do far better, a hot enclosure
 * worse. See docs/ARCHITECTURE.md (Checks).
 */

/** θJA (°C/W) by package name. */
const THETA_JA: Record<string, number> = {
  'SC-70': 400,
  'SOT-23': 340,
  'SOT-23-5': 250,
  'SOT-89': 160,
  'SOT-223': 90,
  'TO-92': 180,
  'SOIC-8': 150,
  'MSOP-8': 200,
  DPAK: 70,
  D2PAK: 50,
  'TO-220': 60,
};

/** Other names of the same outlines. */
const ALIASES: Record<string, string> = {
  'SOT-23-3': 'SOT-23',
  'SOT-323': 'SC-70',
  'SC-70-3': 'SC-70',
  'SC-70-5': 'SC-70',
  'SOT-353': 'SC-70',
  'SOT-23-6': 'SOT-23-5',
  'SOT-25': 'SOT-23-5',
  'SOT-753': 'SOT-23-5',
  'TSOT-23-5': 'SOT-23-5',
  'SOT-89-3': 'SOT-89',
  'SOT-89-5': 'SOT-89',
  'SOT-223-3': 'SOT-223',
  'SOT-223-4': 'SOT-223',
  'SOIC-8-208MIL': 'SOIC-8',
  SO8: 'SOIC-8',
  'SO-8': 'SOIC-8',
  'TO-252': 'DPAK',
  'TO-252-2': 'DPAK',
  'TO-252-3': 'DPAK',
  'TO-263': 'D2PAK',
  'TO-263-3': 'D2PAK',
  'TO-263-5': 'D2PAK',
  'TO-220-3': 'TO-220',
};

/** Ambient and junction temperature the limit is worked out for (°C). */
export const THERMAL_AMBIENT_C = 25;
export const THERMAL_JUNCTION_C = 125;

export interface PackageThermal {
  /** The table's name for the package. */
  name: string;
  thetaJA: number;
  /** Dissipation (W) that takes the junction to 125 °C at 25 °C ambient. */
  maxW: number;
}

/** The typical dissipation limit of a package by name; null when the table does not know it. */
export function packageThermal(name: string | undefined): PackageThermal | null {
  if (!name) return null;
  const n = name.trim().toUpperCase().replace(/[_ ]/g, '-').replace(/^(SOT|SC|TO|SOD)(?=\d)/, '$1-');
  const key = THETA_JA[n] !== undefined ? n : ALIASES[n];
  if (!key) return null;
  const thetaJA = THETA_JA[key]!;
  return { name: key, thetaJA, maxW: Math.round(((THERMAL_JUNCTION_C - THERMAL_AMBIENT_C) / thetaJA) * 100) / 100 };
}
