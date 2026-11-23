/**
 * The import_part tool: the datasheet import of the Parts view, started by the agent. A clean result
 * (accepted, both passes agree) goes straight into the library; disagreements between the passes wait
 * for the review in Parts (the user's, or the agent's with pending_import). See docs/design/part-ingest.md.
 */
import type { IngestIssue, PartCard } from '@4k7/schema';
import type { IngestPhase, IngestRequest } from './ingest.svelte.ts';

/** What the tool needs of the app's one import (IngestState). */
export interface IngestSlot {
  readonly phase: IngestPhase;
  readonly request: { mpn: string } | null;
  readonly library: PartCard[];
  readonly log: string[];
  readonly error: string | null;
  readonly card: PartCard | null;
  readonly issues: IngestIssue[];
  readonly disagreements: unknown[];
  readonly secondPassFailed: string | null;
  start(req: IngestRequest): Promise<void>;
  save(): Promise<PartCard | null>;
  discard(): void;
  agentSummary(): string;
  /** Take over another slot's finished extraction for review (and free that slot). */
  adopt(other: this): void;
  /** Read the library again (another slot saved a part into it). */
  refresh(): void;
}

export interface ImportArgs {
  mpn: string;
  datasheet_url: string;
  notes?: string;
  timeout_s: number;
}

export interface ImportOptions<S extends IngestSlot> {
  /**
   * Makes a slot not shown in Parts: a queued import is extracted in one while the shown import waits for
   * review. Its result is saved at once when clean, else it is shown for review once the reviews ahead are settled.
   */
  spare?: () => S;
  flash?: (msg: string) => void;
  /** For tests: the clock and the wait between looks at the import. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Why a finished extraction needs the review, or '' when it can be saved as it is. */
function needsReview(s: IngestSlot): string {
  const warnings = s.issues.filter((i) => i.severity === 'warning').length;
  return [
    s.secondPassFailed && `the cross-check pass did not finish (${s.secondPassFailed})`,
    s.disagreements.length && `the two independent passes read ${s.disagreements.length} fact(s) differently`,
    warnings && `the checks raised ${warnings} warning(s)`,
  ].filter(Boolean).join(', and ');
}

/**
 * The app shows one import at a time (one review in Parts). A second import_part while one runs or waits
 * for review is queued, not refused, and the answer tells the agent what it waits behind. While the shown
 * import only waits for review, the queued ones are extracted meanwhile, one after the other (the server
 * runs one extraction at a time), each in a spare slot: a clean result goes into the library at once, one
 * that needs review is shown once the reviews ahead are saved or discarded.
 */
export class PartImports<S extends IngestSlot = IngestSlot> {
  #ing: S;
  #spare: (() => S) | null;
  /** The spare slot extracting a queued import, if any (one extraction runs at a time). */
  #running: S | null = null;
  /** Spare slots holding an extraction that waits to be shown for review, first first. */
  #waiting: S[] = [];
  /** Spare slots free for reuse. */
  #idle: S[] = [];
  #flash: (msg: string) => void;
  #now: () => number;
  #sleep: (ms: number) => Promise<void>;
  #queue: IngestRequest[] = [];
  /** Queued imports that failed in a spare slot, by part number (lower case): the error for the agent. */
  #failed = new Map<string, string>();
  #pumping: Promise<void> | null = null;
  #again = false;

  constructor(ing: S, opts: ImportOptions<S> = {}) {
    this.#ing = ing;
    this.#spare = opts.spare ?? null;
    this.#flash = opts.flash ?? (() => {});
    this.#now = opts.now ?? Date.now;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** The part numbers waiting for their turn, first first. */
  get queued(): string[] {
    return this.#queue.map((r) => r.mpn);
  }

  /** The slot whose extraction is running (submit_part goes to it). */
  get extracting(): S {
    return this.#running ?? this.#ing;
  }

  /** An import finished, or its review was saved or discarded: show the next review, or start the next queued import. */
  settled(): void {
    void this.#pump();
  }

  #free(): boolean {
    return this.#ing.phase === 'idle' || this.#ing.phase === 'failed';
  }

  /** Move the queue on: settle what a spare slot finished, start the next import where there is room. */
  #pump(): Promise<void> {
    // one pump at a time; a call meanwhile has it go round once more, and waits for it
    if (this.#pumping) {
      this.#again = true;
      return this.#pumping;
    }
    const run = async () => {
      try {
        do {
          this.#again = false;
          await this.#step();
        } while (this.#again);
      } finally {
        this.#pumping = null;
      }
    };
    return (this.#pumping = run());
  }

  async #step() {
    const done = this.#running;
    if (done && done.phase !== 'running') {
      this.#running = null;
      const mpn = done.request?.mpn.toLowerCase() ?? '';
      if (done.phase === 'review' && done.card && needsReview(done)) this.#waiting.push(done);
      else {
        if (done.phase !== 'review' || !done.card) {
          this.#failed.set(mpn, done.phase === 'review' ? `it produced no usable part:\n${done.issues.map((i) => `- ${i.message}`).join('\n')}` : (done.error ?? 'unknown error'));
          done.discard();
        } else {
          const saved = await done.save();
          this.#ing.refresh();
          if (saved) this.#flash(`${saved.mpn ?? saved.id} added to your library`);
          else this.#failed.set(mpn, 'saving it failed');
        }
        this.#idle.push(done);
      }
    }
    if (this.#free() && this.#waiting.length) {
      const shown = this.#waiting.shift()!;
      this.#ing.adopt(shown);
      this.#idle.push(shown);
      this.#flash(`${this.#ing.request?.mpn}: import waiting for review`);
    }
    const next = this.#queue[0];
    if (!next || this.#running) return;
    if (this.#free() && !this.#waiting.length) await this.#begin(this.#ing, next);
    else if (this.#ing.phase === 'review' && this.#spare) {
      this.#running = this.#idle.pop() ?? this.#spare();
      await this.#begin(this.#running, next);
      this.#again = true; // it may have failed at once
    }
  }

  /** The spare slot holding this part's import, if any. */
  #inSpare(key: string): S | undefined {
    return [...(this.#running ? [this.#running] : []), ...this.#waiting].find((x) => x.request?.mpn.toLowerCase() === key);
  }

  async #begin(slot: S, req: IngestRequest) {
    this.#queue = this.#queue.filter((r) => r.mpn.toLowerCase() !== req.mpn.toLowerCase());
    this.#failed.delete(req.mpn.toLowerCase());
    await slot.start(req);
    this.#flash(`Importing ${req.mpn} from its datasheet`);
  }

  async run(args: ImportArgs): Promise<{ content: string; isError: boolean }> {
    const text = (content: string, isError = false) => ({ content, isError });
    const ing = this.#ing;
    const mpn = args.mpn.trim();
    const key = mpn.toLowerCase();
    const mine = () => ing.request?.mpn.toLowerCase() === key;
    const inLibrary = () => ing.library.find((p) => p.mpn?.toLowerCase() === key);
    const known = inLibrary();
    if (known && !(mine() && ing.phase !== 'idle')) return text(`${mpn} is already in the library as ${known.id}; add it with add_part. To change it, use design_edit on a component using it (set_pin_descriptions, set_footprint, set_symbol, set_mating, set_polarity, rename_part), not a new import.`);
    const req: IngestRequest = { mpn, url: args.datasheet_url, ...(args.notes ? { notes: args.notes } : {}), model: 'sonnet', verify: true };
    this.#failed.delete(key);
    if (this.#free() && !this.#queue.length && !this.#running && !this.#waiting.length) await this.#begin(ing, req);
    else if (!mine() && !this.#inSpare(key)) {
      const at = this.#queue.findIndex((r) => r.mpn.toLowerCase() === key);
      if (at >= 0) this.#queue[at] = req;
      else {
        this.#queue.push(req);
        this.#flash(`${mpn} queued behind the import of ${ing.request?.mpn ?? this.#running?.request?.mpn}`);
      }
    }
    // wait for this import; queued behind a review that stays (more than a moment: a clean import ahead is saved by its own call), answer at once
    const until = this.#now() + args.timeout_s * 1000;
    let held = 0;
    while (this.#now() < until) {
      await this.#pump();
      if (mine()) {
        if (ing.phase !== 'running') break;
      } else if (inLibrary() || this.#failed.has(key)) break;
      else if (this.#inSpare(key)) {
        if (this.#inSpare(key)!.phase !== 'running') break; // extracted, waits to be shown for review
      } else if (ing.phase === 'review') {
        if (++held >= 3) break;
      } else held = 0;
      await this.#sleep(500);
    }
    if (!mine()) {
      const saved = inLibrary();
      if (saved) return text(`Imported ${saved.id}: it is in the library now (add_part part "${saved.id}").`);
      const failed = this.#failed.get(key);
      if (failed !== undefined) {
        this.#failed.delete(key);
        return text(`The import of ${mpn} failed: ${failed}`, true);
      }
      const ahead = ing.request?.mpn ?? 'another part';
      const review = 'settle it with pending_import (get, then pick or correct and save, or discard), or ask the user to save or discard it in Parts';
      const back = this.#inSpare(key);
      if (back) {
        if (back.phase === 'running') return text(`Still importing ${mpn} (${back.log.at(-1) ?? 'working'}) while ${ahead} waits for review. Call import_part again with the same mpn to keep waiting.`);
        return text(`${mpn} was extracted, but ${needsReview(back)}; it is not in the library yet. Its review comes after the one of ${ahead} (${review}). Call import_part again with the same mpn to see it.`);
      }
      const state = ing.phase === 'review' ? `waiting for review: ${review}` : `still importing: ${ing.log.at(-1) ?? 'working'}`;
      return text(`${mpn} is queued behind ${ahead} (${state}); it starts by itself after that. Call import_part again with the same mpn to wait for it.`);
    }
    if (ing.phase === 'running') return text(`Still importing ${mpn} (${ing.log.at(-1) ?? 'working'}). Call import_part again with the same mpn to keep waiting.`);
    if (ing.phase === 'failed') return text(`The import of ${mpn} failed: ${ing.error ?? 'unknown error'}`, true);
    const card = ing.card;
    const warnings = ing.issues.filter((i) => i.severity === 'warning').map((i) => `- ${i.message}`);
    if (!card) return text(`The import of ${mpn} produced no usable part:\n${ing.issues.map((i) => `- ${i.message}`).join('\n')}`, true);
    const why = needsReview(ing);
    if (why) {
      this.#flash(`${mpn}: import waiting for review`);
      const later = [...this.#waiting, ...(this.#running ? [this.#running] : [])].map((x) => x.request?.mpn ?? '?').concat(this.queued);
      const behind = later.length ? `\nQueued behind it (extracted meanwhile; their reviews, if needed, come after this one): ${later.join(', ')}.` : '';
      return text(
        `${card.id} was extracted, but ${why}; it is not in the library yet. Settle it with pending_import (get, then pick or correct pins/package from the datasheet with read_datasheet, then save), ` +
          `or leave it to the user in Parts.\n${ing.agentSummary()}${behind}`,
      );
    }
    const saved = await ing.save();
    if (!saved) return text(`Saving ${mpn} failed.`, true);
    this.#flash(`${saved.mpn ?? saved.id} added to your library`);
    return text(
      `Imported ${saved.id}: ${saved.pins.length} pins, package ${saved.package ?? '?'}, both passes agree; it is in the library now (add_part part "${saved.id}").` +
        (warnings.length ? `\nWarnings (the user can check them in Parts):\n${warnings.join('\n')}` : ''),
    );
  }
}
