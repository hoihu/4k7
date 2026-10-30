/**
 * The enclosure's geometry engine (docs/design/enclosure.md §5.1): Manifold (WASM) and what the script
 * finds on it. Its own entry of @4k7/fab, so only the worker that renders and the tests load the WASM.
 *
 * A script is the body of a function, and returns its pieces: scriptSource wraps it, the host evaluates
 * that (a worker in the app, node:vm in the tests) and hands over the function.
 */
import { enclosureKey, type EnclosureBrief, type EnclosureGraphic } from '@4k7/schema';
import Module, { type ManifoldToplevel } from 'manifold-3d';
import type { EnclosureFinding, EnclosurePiece, EnclosureReport } from '../enclosure.ts';
import { scriptLine, SCRIPT_GLOBAL } from '../enclosure.ts';
import type { EnclosureFacts, PartSolids } from '../scad.ts';
import { createApi } from './api.ts';
import { createBoardLib } from './board.ts';
import { geometryFindings, printFindings, trisOf } from './check.ts';
import { textMaker } from './text.ts';

export { scriptSource } from '../enclosure.ts';

/** What Module() takes: the bytes, for a worker that cannot fetch them. */
type ModuleOptions = { wasmBinary?: ArrayBuffer };

export interface Csg {
  w: ManifoldToplevel;
  font: ArrayBuffer | undefined;
}

/** The engine. `wasm`: its bytes (a worker has no fetch); without them Node finds its file. `font`: for text(). */
export async function loadCsg(o: { wasm?: ArrayBuffer; font?: ArrayBuffer } = {}): Promise<Csg> {
  const w = await (Module as unknown as (o: ModuleOptions) => Promise<ManifoldToplevel>)(o.wasm ? { wasmBinary: o.wasm } : {});
  w.setup();
  return { w, font: o.font };
}

/** A render: the board's facts, the script and what goes with it. */
export interface EnclosureRenderJob {
  facts: EnclosureFacts & { solids: PartSolids };
  script: string;
  brief?: EnclosureBrief;
  graphics?: EnclosureGraphic[];
}

function describe(e: unknown, scriptUrl: string): string {
  const line = scriptLine(e, scriptUrl);
  // (a bare number is a C++ exception, from a method called on a solid or shape: the script's functions say more)
  const text = e instanceof Error ? `${e.name === 'Error' ? '' : `${e.name}: `}${e.message}` : 'the geometry engine could not do something a method of a solid or shape asked of it';
  return line === null ? text : `line ${line}: ${text}`;
}

/**
 * Run a script (`fn`, the function scriptSource made, evaluated by the host; `scriptUrl`: where it says
 * it runs, to find its lines in a stack) and measure what it makes.
 */
export function renderEnclosure(csg: Csg, job: EnclosureRenderJob, fn: () => Record<string, unknown>, scriptUrl: string): EnclosureReport {
  const { w } = csg;
  const { facts, script, brief, graphics } = job;
  const key = enclosureKey({ script, ...(graphics ? { graphics } : {}) });
  const t0 = performance.now();
  const log: string[] = [];
  const stop = (findings: EnclosureFinding[]): EnclosureReport => ({ script, key, pieces: [], findings, size: null, ms: Math.round(performance.now() - t0), ...(log.length ? { log } : {}) });

  const api = createApi(w, textMaker(csg.font), log);
  const lib = createBoardLib(w, api, facts, brief, graphics);
  const { centeredText: _text, fnNow: _fn, ...globals } = api;
  Object.assign(globalThis, globals, lib);

  let made: Record<string, unknown>;
  try {
    made = fn();
  } catch (e) {
    return stop([{ code: 'ENC.SCRIPT', severity: 'error', message: `The script stopped: ${describe(e, scriptUrl)}` }]);
  }

  // a set_fn at the script's top holds for every piece; one inside a piece, only there: no piece depends on the order
  const topFn = api.fnNow();
  // every piece's error at once, so one render tells all of them
  const errors: EnclosureFinding[] = [];
  const solids: { name: string; solid: InstanceType<ManifoldToplevel['Manifold']> }[] = [];
  for (const [name, draw] of Object.entries(made)) {
    try {
      if (typeof draw !== 'function') throw new Error('it is not a function');
      api.set_fn(topFn);
      let out: unknown = (draw as () => unknown)();
      if (Array.isArray(out)) out = api.union(out);
      if (out instanceof w.CrossSection) throw new Error('it returned a 2D shape: extrude it (linear_extrude)');
      if (!(out instanceof w.Manifold)) throw new Error(`it has to return a solid, and it returned ${out === undefined ? 'nothing' : typeof out}`);
      const status = out.status();
      if (status !== 'NoError') throw new Error(`the geometry engine could not make it (${status})`);
      if (out.isEmpty()) errors.push({ code: 'ENC.SCRIPT', severity: 'error', message: `The piece ${name}() is empty: it draws nothing.` });
      else solids.push({ name, solid: out });
    } catch (e) {
      errors.push({ code: 'ENC.SCRIPT', severity: 'error', message: `The piece ${name}() stopped: ${describe(e, scriptUrl)}` });
    }
  }
  if (errors.length) return stop(errors);

  const pieces: EnclosurePiece[] = solids.map(({ name, solid }) => {
    const b = solid.boundingBox();
    return { name, tris: trisOf(solid), bbox: { min: [...b.min] as EnclosurePiece['bbox']['min'], max: [...b.max] as EnclosurePiece['bbox']['max'] } };
  });
  const findings = [...geometryFindings(w, lib, facts, solids, script, brief), ...printFindings(pieces, script, brief)];

  const min = [0, 1, 2].map((i) => Math.min(...pieces.map((p) => p.bbox.min[i]!)));
  const max = [0, 1, 2].map((i) => Math.max(...pieces.map((p) => p.bbox.max[i]!)));
  const r2 = (v: number) => Math.round(v * 100) / 100 || 0;
  const size: [number, number, number] = [r2(max[0]! - min[0]!), r2(max[1]! - min[1]!), r2(max[2]! - min[2]!)];
  const limit = brief?.max_size_mm;
  if (limit && size.some((v, i) => v > limit[i]! + 1e-6)) findings.push({ code: 'ENC.SIZE', severity: 'error', message: `The box is ${size.join(' × ')} mm; the brief allows ${limit.join(' × ')} mm.` });

  return { script, key, pieces, findings, size, ms: Math.round(performance.now() - t0), ...(log.length ? { log } : {}) };
}

export { SCRIPT_GLOBAL };
