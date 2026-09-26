/**
 * Datasheet import: the local Claude Code (through the bridge) reads the datasheet and submits
 * a draft; this tab checks every submission deterministically (draftToCard) and answers with
 * the problems to fix. The last accepted card waits for the user's review before it is saved.
 */
import { draftToCard, listUserParts, registerUserParts, unregisterUserPart } from '@tracewise/parts';
import type { BridgeContent, IngestIssue, PartCard } from '@tracewise/schema';
import { bridge } from './bridge.svelte.ts';
import { deleteLibraryPart, loadLibrary, saveLibraryPart } from './persist.ts';

export interface IngestRequest {
  mpn: string;
  file?: File;
  url?: string;
  notes?: string;
  model?: string;
}

export type IngestPhase = 'idle' | 'running' | 'review' | 'failed';

interface KernelParts {
  registerParts(cards: PartCard[]): Promise<void>;
  unregisterPart(id: string): Promise<void>;
}

const MAX_BYTES = 24 * 1024 * 1024;

export class IngestState {
  phase = $state<IngestPhase>('idle');
  /** Progress lines (downloading, reading page 69, submitting …). */
  log = $state<string[]>([]);
  /** Claude's closing words. */
  reply = $state('');
  error = $state<string | null>(null);
  /** The last submission and what the checks said about it. */
  card = $state<PartCard | null>(null);
  issues = $state<IngestIssue[]>([]);
  submissions = $state(0);
  costUsd = $state<number | null>(null);
  /** Imported parts saved in this browser. */
  library = $state<PartCard[]>([]);
  request = $state<{ mpn: string; source: string } | null>(null);

  #kernel: KernelParts;
  #run: string | null = null;

  constructor(kernel: KernelParts) {
    this.#kernel = kernel;
  }

  /** Load saved parts and make them known to the kernel (agent) and the UI. */
  async init() {
    const cards = await loadLibrary();
    registerUserParts(cards);
    await this.#kernel.registerParts(cards);
    this.library = listUserParts();
  }

  get available(): boolean {
    return bridge.status === 'connected' && !!bridge.chat?.available;
  }

  async start(req: IngestRequest): Promise<void> {
    if (this.phase === 'running') return;
    const mpn = req.mpn.trim();
    this.#reset();
    this.request = { mpn, source: req.file?.name ?? req.url ?? '' };
    this.phase = 'running';
    const fail = (msg: string) => {
      this.error = msg;
      this.phase = 'failed';
    };
    if (!mpn) return fail('Enter the full part number (the ordering code picks the package).');
    if (!this.available) return fail('Pair the Claude Code bridge first (Settings → Claude Code).');
    let pdf: { name: string; base64: string } | undefined;
    if (req.file) {
      if (req.file.size > MAX_BYTES) return fail(`The PDF is larger than ${MAX_BYTES >> 20} MB.`);
      this.log.push(`Uploading ${req.file.name} to the bridge`);
      pdf = { name: req.file.name, base64: await toBase64(req.file) };
    } else if (!req.url?.trim()) return fail('Attach the datasheet PDF or paste its link.');

    const id = `ingest-${Date.now().toString(36)}`;
    this.#run = id;
    const sent = bridge.sendIngest(
      {
        id,
        mpn,
        ...(pdf ? { pdf } : { url: req.url!.trim() }),
        ...(req.notes?.trim() ? { notes: req.notes.trim() } : {}),
        ...(req.model ? { model: req.model } : {}),
      },
      (e) => {
        if (this.#run !== id) return;
        switch (e.kind) {
          case 'status':
            this.log.push(e.text);
            break;
          case 'text':
            this.reply += e.text;
            break;
          case 'done':
            this.#run = null;
            if (typeof e.costUsd === 'number') this.costUsd = e.costUsd;
            if (this.card) this.phase = 'review';
            else fail(e.ok ? 'Claude Code finished without an accepted part.' : (e.error ?? 'The import failed.'));
            break;
        }
      },
    );
    if (!sent) fail('The bridge is not connected.');
  }

  cancel() {
    if (this.#run) bridge.cancelChat(this.#run);
  }

  /** submit_part from the importer: check the draft, answer with what to fix. */
  submit(input: unknown): { isError: boolean; content: BridgeContent[] } {
    const text = (t: string, isError = false) => ({ isError, content: [{ type: 'text' as const, text: t }] });
    if (!this.#run) return text('No datasheet import is running in the app.', true);
    this.submissions++;
    const { card, issues } = draftToCard(input);
    this.issues = issues;
    const list = (sev: IngestIssue['severity']) => issues.filter((i) => i.severity === sev).map((i) => `- ${i.message}`).join('\n');
    if (!card) {
      this.log.push(`Submission ${this.submissions}: ${issues.filter((i) => i.severity === 'error').length} problem(s), asked to fix`);
      return text(`Not accepted. Fix these from the datasheet and submit again:\n${list('error')}${list('warning') ? `\nAlso check:\n${list('warning')}` : ''}`, true);
    }
    this.card = card;
    this.log.push(`Submission ${this.submissions}: ${card.pins.length} pins accepted${issues.length ? `, ${issues.length} warning(s)` : ''}`);
    return text(
      `Accepted ${card.id} (${card.pins.length} pins, ${card.package}) for the user's review.` +
        (issues.length ? `\nWarnings shown to the user (resubmit if you can fix them from the datasheet):\n${list('warning')}` : ''),
    );
  }

  async save(): Promise<PartCard | null> {
    const card = this.card;
    if (!card) return null;
    await saveLibraryPart(card);
    registerUserParts([card]);
    await this.#kernel.registerParts([JSON.parse(JSON.stringify(card)) as PartCard]);
    this.library = listUserParts();
    this.#reset();
    return card;
  }

  discard() {
    this.cancel();
    this.#reset();
  }

  async remove(id: string) {
    await deleteLibraryPart(id);
    unregisterUserPart(id);
    await this.#kernel.unregisterPart(id);
    this.library = listUserParts();
  }

  #reset() {
    this.#run = null;
    this.phase = 'idle';
    this.log = [];
    this.reply = '';
    this.error = null;
    this.card = null;
    this.issues = [];
    this.submissions = 0;
    this.costUsd = null;
    this.request = null;
  }
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
