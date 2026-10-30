/** The real geometry engine for the enclosure tests: once per test file (its process), and a script run as the app runs it. */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { scriptPieces, type BoardView, type EnclosureBrief, type EnclosureGraphic } from '@4k7/schema';
import { loadCsg, renderEnclosure, scriptSource, SCRIPT_GLOBAL, type Csg } from '../src/csg/index.ts';
import { enclosureFacts, type EnclosureReport } from '../src/index.ts';

const file = readFileSync(new URL('../fonts/LiberationSans-Bold.ttf', import.meta.url));

let loading: Promise<Csg> | null = null;
export const csg = (): Promise<Csg> => (loading ??= loadCsg({ font: file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer }));

/** Render a script on a board. */
export async function render(board: BoardView, script: string, brief?: EnclosureBrief, graphics?: EnclosureGraphic[]): Promise<EnclosureReport> {
  const engine = await csg();
  vm.runInThisContext(scriptSource(script, scriptPieces(script) ?? []), { filename: 'enclosure.js' });
  const fn = (globalThis as unknown as Record<string, () => Record<string, unknown>>)[SCRIPT_GLOBAL]!;
  return renderEnclosure(engine, { facts: enclosureFacts(board), script, ...(brief ? { brief } : {}), ...(graphics ? { graphics } : {}) }, fn, 'enclosure.js');
}
