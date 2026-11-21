import { describe, expect, it } from 'vitest';
import type { PartCard } from '@4k7/schema';
import type { IngestPhase, IngestRequest } from '../src/lib/ingest.svelte.ts';
import { PartImports, type IngestSlot } from '../src/lib/importPart.ts';

const part = (mpn: string) => ({ id: mpn.toLowerCase(), mpn, pins: [{ number: '1' }, { number: '2' }], package: 'SOT-23' }) as unknown as PartCard;

/**
 * The app's one import, as IngestState runs it: start() runs, finish() ends the run clean or with disagreements
 * (then it waits for review), save() and discard() free it. `imports` is told when the review is settled.
 */
class FakeSlot implements IngestSlot {
  phase: IngestPhase = 'idle';
  request: { mpn: string } | null = null;
  library: PartCard[] = [];
  log: string[] = [];
  error: string | null = null;
  card: PartCard | null = null;
  issues = [];
  disagreements: unknown[] = [];
  secondPassFailed: string | null = null;
  started: string[] = [];
  imports!: PartImports;
  async start(req: IngestRequest) {
    this.started.push(req.mpn);
    this.request = { mpn: req.mpn };
    this.phase = 'running';
    this.card = null;
    this.disagreements = [];
  }
  finish(disputed: number) {
    this.card = part(this.request!.mpn);
    this.disagreements = Array.from({ length: disputed }, (_, i) => `pin:${i}`);
    this.phase = 'review';
  }
  fail(error: string) {
    this.error = error;
    this.phase = 'failed';
  }
  async save() {
    const c = this.card!;
    this.library.push(c);
    this.#free();
    return c;
  }
  discard() {
    this.#free();
  }
  #free() {
    this.phase = 'idle';
    this.request = null;
    this.card = null;
    this.imports.settled();
  }
  agentSummary() {
    return this.phase === 'review' ? `${this.request?.mpn}: pending` : '';
  }
}

/** A clock that moves on with every wait, running `onWait` each time (the import going on meanwhile). */
function setup(onWait: (slot: FakeSlot, waits: number) => void = () => {}) {
  const slot = new FakeSlot();
  let t = 0;
  let waits = 0;
  const flashed: string[] = [];
  slot.imports = new PartImports(slot, {
    flash: (m) => flashed.push(m),
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      onWait(slot, ++waits);
    },
  });
  return { slot, imports: slot.imports, flashed };
}

const args = (mpn: string, timeout_s = 60) => ({ mpn, datasheet_url: `https://example.com/${mpn}.pdf`, timeout_s });

describe('import_part', () => {
  it('saves a clean import straight into the library', async () => {
    const { slot, imports } = setup((s, n) => n === 2 && s.finish(0));
    const out = await imports.run(args('TPS54331'));
    expect(out).toMatchObject({ isError: false });
    expect(out.content).toContain('Imported tps54331');
    expect(slot.library.map((p) => p.mpn)).toEqual(['TPS54331']);
  });

  it('queues a second import while the first waits for review, and starts it once the review is settled', async () => {
    const { slot, imports } = setup((s, n) => s.phase === 'running' && n % 3 === 0 && s.finish(s.request!.mpn === 'XPE2' ? 3 : 0));
    // the first import ends with disagreements: it waits for review
    expect((await imports.run(args('XPE2'))).content).toContain('pending_import');
    expect(slot.phase).toBe('review');

    // a second import is not refused: it is queued, and the answer says behind what and how to go on
    const second = await imports.run(args('LM3414'));
    expect(second.isError).toBe(false);
    expect(second.content).toContain('LM3414 is queued');
    expect(second.content).toContain('XPE2');
    expect(second.content).toContain('pending_import');
    expect(imports.queued).toEqual(['LM3414']);
    expect(slot.started).toEqual(['XPE2']);

    // settling the review (here: saved in Parts) starts the queued import by itself
    await slot.save();
    expect(slot.started).toEqual(['XPE2', 'LM3414']);
    expect(imports.queued).toEqual([]);
    const done = await imports.run(args('LM3414'));
    expect(done.content).toContain('Imported lm3414');
    expect(slot.library.map((p) => p.mpn)).toEqual(['XPE2', 'LM3414']);
  });

  it('a discarded review frees the slot as well', async () => {
    const { slot, imports } = setup();
    await slot.start({ mpn: 'XPE2' });
    slot.finish(2);
    await imports.run(args('LM3414'));
    slot.discard();
    expect(slot.started).toEqual(['XPE2', 'LM3414']);
  });

  it('waits behind a running import and then runs its own', async () => {
    const { slot, imports } = setup((s, n) => {
      if (n === 2) s.finish(0); // the first, clean …
      if (n === 3) void s.save(); // … saved by the call waiting for it
      if (n === 6) s.finish(0);
    });
    await slot.start({ mpn: 'XPE2' });
    const out = await imports.run(args('LM3414'));
    expect(slot.started).toEqual(['XPE2', 'LM3414']);
    expect(out.content).toContain('Imported lm3414');
  });

  it('starts a queued import itself when the one ahead failed', async () => {
    const { slot, imports } = setup((s, n) => {
      if (n === 2) s.fail('download failed');
      if (n === 5) s.finish(0);
    });
    await slot.start({ mpn: 'XPE2' });
    const out = await imports.run(args('LM3414'));
    expect(slot.started).toEqual(['XPE2', 'LM3414']);
    expect(out.content).toContain('Imported lm3414');
  });

  it('says it is still queued when the import ahead outlasts the wait', async () => {
    const { slot, imports } = setup();
    await slot.start({ mpn: 'XPE2' });
    const out = await imports.run(args('LM3414', 30));
    expect(out.isError).toBe(false);
    expect(out.content).toMatch(/LM3414 is queued behind XPE2 \(still importing/);
    expect(imports.queued).toEqual(['LM3414']);
    // asking again does not queue it twice (the newer link counts)
    await imports.run(args('lm3414', 30));
    expect(imports.queued).toEqual(['lm3414']);
  });
});
