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
  agentSummary(): string;
}

export interface ImportArgs {
  mpn: string;
  datasheet_url: string;
  notes?: string;
  timeout_s: number;
}

export interface ImportOptions {
  flash?: (msg: string) => void;
  /** For tests: the clock and the wait between looks at the import. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The app has one import at a time (one review in Parts). A second import_part while one runs or waits
 * for review is queued, not refused: it starts by itself once the slot is free (the review saved or
 * discarded, or the import ahead failed), and the answer tells the agent what it waits behind.
 */
export class PartImports {
  #ing: IngestSlot;
  #flash: (msg: string) => void;
  #now: () => number;
  #sleep: (ms: number) => Promise<void>;
  #queue: IngestRequest[] = [];

  constructor(ing: IngestSlot, opts: ImportOptions = {}) {
    this.#ing = ing;
    this.#flash = opts.flash ?? (() => {});
    this.#now = opts.now ?? Date.now;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** The part numbers waiting for their turn, first first. */
  get queued(): string[] {
    return this.#queue.map((r) => r.mpn);
  }

  /** The review was saved or discarded: start the next queued import. */
  settled(): void {
    if (!this.#free()) return;
    const next = this.#queue.shift();
    if (next) void this.#begin(next);
  }

  #free(): boolean {
    return this.#ing.phase === 'idle' || this.#ing.phase === 'failed';
  }

  async #begin(req: IngestRequest) {
    this.#queue = this.#queue.filter((r) => r.mpn.toLowerCase() !== req.mpn.toLowerCase());
    await this.#ing.start(req);
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
    if (this.#free()) await this.#begin(req);
    else if (!mine()) {
      const at = this.#queue.findIndex((r) => r.mpn.toLowerCase() === key);
      if (at >= 0) this.#queue[at] = req;
      else {
        this.#queue.push(req);
        this.#flash(`${mpn} queued behind the import of ${ing.request?.mpn}`);
      }
    }
    // wait for this import; behind a review that stays (more than a moment: a clean import ahead is saved by its own call), answer at once
    const until = this.#now() + args.timeout_s * 1000;
    let held = 0;
    while (this.#now() < until) {
      if (mine()) {
        if (ing.phase !== 'running') break;
      } else if (this.#free()) {
        if (inLibrary()) break;
        await this.#begin(req);
        continue;
      } else if (ing.phase === 'review') {
        if (++held >= 3) break;
      } else held = 0;
      await this.#sleep(500);
    }
    if (!mine()) {
      const saved = inLibrary();
      if (saved) return text(`Imported ${saved.id}: it is in the library now (add_part part "${saved.id}").`);
      const ahead = ing.request?.mpn ?? 'another part';
      const state =
        ing.phase === 'review'
          ? 'waiting for review: settle it with pending_import (get, then pick or correct and save, or discard), or ask the user to save or discard it in Parts'
          : `still importing: ${ing.log.at(-1) ?? 'working'}`;
      return text(`${mpn} is queued behind ${ahead} (${state}); it starts by itself after that. Call import_part again with the same mpn to wait for it.`);
    }
    if (ing.phase === 'running') return text(`Still importing ${mpn} (${ing.log.at(-1) ?? 'working'}). Call import_part again with the same mpn to keep waiting.`);
    if (ing.phase === 'failed') return text(`The import of ${mpn} failed: ${ing.error ?? 'unknown error'}`, true);
    const card = ing.card;
    const warnings = ing.issues.filter((i) => i.severity === 'warning').map((i) => `- ${i.message}`);
    if (!card) return text(`The import of ${mpn} produced no usable part:\n${ing.issues.map((i) => `- ${i.message}`).join('\n')}`, true);
    if (ing.disagreements.length || ing.secondPassFailed || warnings.length) {
      const why = [
        ing.secondPassFailed && `the cross-check pass did not finish (${ing.secondPassFailed})`,
        ing.disagreements.length && `the two independent passes read ${ing.disagreements.length} fact(s) differently`,
        warnings.length && `the checks raised ${warnings.length} warning(s)`,
      ].filter(Boolean).join(', and ');
      this.#flash(`${mpn}: import waiting for review`);
      const behind = this.#queue.length ? `\nQueued behind it (they start once it is saved or discarded): ${this.queued.join(', ')}.` : '';
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
