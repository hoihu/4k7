import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Design } from '@tracewise/schema';
import { Kernel, SOLVER_VERSION, canonicalJson, designKey, freezeBoard, readDesignFile, rekeySolved, writeDesignFile } from '../src/index.ts';
import { buckTransaction } from './fixtures.ts';

/** A routed buck converter as solver 1 wrote it. Never regenerate it: old files must keep opening. */
const GOLDEN = fileURLToPath(new URL('./golden/buck-solver1.twd.json', import.meta.url));

function routedBuck() {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  k.transact({ summary: 'route', ops: [{ op: 'route' }] });
  k.accept();
  return k;
}

function file(k: Kernel) {
  const design = k.committedDesign();
  return writeDesignFile(design, freezeBoard(designKey(design), k.board(), 'test', new Date(0)));
}

if (!existsSync(GOLDEN)) writeFileSync(GOLDEN, file(routedBuck()));

describe('solved board', () => {
  it('travels with the design and comes back as it was stored', () => {
    const k = routedBuck();
    expect(designKey(k.draftDesign())).toBe(designKey(k.committedDesign()));
    const text = file(k);
    const { design, solved } = readDesignFile(JSON.parse(text));
    expect(solved?.solver).toBe(SOLVER_VERSION);
    expect(JSON.stringify(solved!.board)).toBe(JSON.stringify(k.board()));
    expect(solved!.board.routing).toBe('done');
    // the design part of the file is the plain canonical design, and writing it again changes nothing
    expect(design).toEqual(k.committedDesign());
    expect(writeDesignFile(design, solved)).toBe(text);
    expect(writeDesignFile(design)).toBe(k.exportDesign());
  });

  it('is dropped when the design is not the one it was solved from', () => {
    const k = routedBuck();
    const parsed = JSON.parse(file(k)) as Design & { solved: unknown };
    expect(readDesignFile({ ...parsed, name: 'edited by hand' }).solved).toBeNull();
    expect(readDesignFile({ ...parsed, solved: { design: 'x' } }).solved).toBeNull();
    const { solved: _, ...plain } = parsed;
    expect(readDesignFile(plain)).toEqual({ design: plain, solved: null });
  });

  it('opens a file written by solver 1 with its board unchanged', () => {
    const { design, solved } = readDesignFile(JSON.parse(readFileSync(GOLDEN, 'utf8')));
    // canonicalJson and designKey still give what they gave when the file was written
    expect(solved).not.toBeNull();
    expect(solved!.solver).toBe(1);
    expect(solved!.board.tracks.length).toBeGreaterThan(10);
    // the kernel loads (and migrates) the design; the board is found under the loaded design's key
    const k = new Kernel(design);
    expect(rekeySolved(solved!, k.draftDesign()).design).toBe(designKey(k.draftDesign()));
    // solving it again gives the stored board, or the solver has changed and must say so
    if (canonicalJson(k.board()) !== canonicalJson(solved!.board)) {
      expect(SOLVER_VERSION, 'the solver lays this board out differently now: raise SOLVER_VERSION in src/solved.ts').toBeGreaterThan(solved!.solver);
    }
  });
});

describe('pinning the layout', () => {
  /** What the Layout view's "Pin layout" does: every part locked where it is, the board size set. */
  function pin(k: Kernel) {
    const b = k.board();
    const ops = [
      ...b.parts.filter((p) => !p.componentId.startsWith('hole:')).map((p) => ({ op: 'place', ref: p.refdes, x_mm: p.x, y_mm: p.y, rot: p.rot, lock: true })),
      { op: 'set_board', width_mm: b.outline.w, height_mm: b.outline.h },
    ];
    expect(k.transact({ summary: 'pin', ops }).status).toBe('ok');
    k.accept();
  }

  it('keeps every part and the copper where they were', () => {
    const k = routedBuck();
    const before = k.board();
    // the copper as an earlier router left it (here: marked by dropping all but three tracks)
    const earlier = { ...before, tracks: before.tracks.slice(0, 3) };
    pin(k);
    const after = new Kernel(k.committedDesign()).board([earlier]);
    expect(after.parts.every((p) => p.locked)).toBe(true);
    expect(after.sizeBy).toBe('user');
    expect(after.parts.map((p) => [p.refdes, p.x, p.y, p.rot])).toEqual(before.parts.map((p) => [p.refdes, p.x, p.y, p.rot]));
    expect(after.outline).toEqual(before.outline);
    expect(after.routing).toBe('done');
    expect(after.tracks).toEqual(earlier.tracks);
    expect(after.vias).toEqual(before.vias);
    // without the earlier board it is routed afresh, to the same result with this router
    expect(canonicalJson(new Kernel(k.committedDesign()).board().tracks)).toBe(canonicalJson(before.tracks));
  });

  it('routes afresh when what the copper depends on changes', () => {
    const k = routedBuck();
    const before = k.board();
    const earlier = { ...before, tracks: before.tracks.slice(0, 3) };
    pin(k);
    expect(k.transact({ summary: 'wider', ops: [{ op: 'set_board', track_mm: 0.3 }] }).status).toBe('ok');
    k.accept();
    const after = new Kernel(k.committedDesign()).board([earlier]);
    expect(after.routeKey).not.toBe(before.routeKey);
    if (after.routing === 'done') expect(after.tracks.length).toBeGreaterThan(3);
  });
});
