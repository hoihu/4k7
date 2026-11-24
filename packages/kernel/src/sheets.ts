/**
 * Finding a sheet by name or id, shared by the circuit, drawing and board ops.
 * This module must not import boards.ts, netops.ts, drawops.ts or netdraw.ts: they all use it, and an import here
 * would bring back the cycles between them.
 */
import type { Design } from '@4k7/schema';
import { reject } from './doc.ts';

export function sheetByName(d: Design, name: string, hint = ' Add it with add_sheet first.'): string {
  const s = Object.values(d.sheets).find((x) => x.name.toLowerCase() === name.toLowerCase() || x.id === name);
  if (!s) reject({ code: 'SHEET_UNKNOWN', message: `No sheet "${name}".${hint}`, candidates: Object.values(d.sheets).map((x) => x.name) });
  return s.id;
}
