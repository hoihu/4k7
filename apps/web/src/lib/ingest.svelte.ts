/**
 * Datasheet import: the local Claude Code (through the bridge) reads the datasheet and submits
 * a draft; this tab checks every submission deterministically (draftToCard) and answers with
 * the problems to fix. Optionally a second, independent pass extracts everything again and the
 * two are compared fact by fact; the user decides where they disagree. The datasheet is kept
 * so every pin can be shown on its page. Nothing is saved before the user's review.
 */
import { compareDrafts, draftToCard, listUserParts, mergeDrafts, planUnits, registerUserParts, unregisterUserPart, type Disagreement } from '@tracewise/parts';
import { PartDraft, type BridgeContent, type IngestIssue, type PartCard, type TokenCount } from '@tracewise/schema';
import { bridge } from './bridge.svelte.ts';
import { deleteLibraryPart, loadDatasheet, loadLibrary, saveDatasheet, saveLibraryPart, type StoredDatasheet } from './persist.ts';

export interface IngestRequest {
  mpn: string;
  file?: File;
  url?: string;
  notes?: string;
  model?: string;
  /** Run a second, independent extraction and compare. */
  verify?: boolean;
}

export type IngestPhase = 'idle' | 'running' | 'review' | 'failed';

interface KernelParts {
  registerParts(cards: PartCard[]): Promise<void>;
  unregisterPart(id: string): Promise<void>;
}

export interface Datasheet extends StoredDatasheet {
  hash: string;
}

const MAX_BYTES = 24 * 1024 * 1024;
/** Parts with more pins than this are split into units by default. */
const SPLIT_ABOVE = 100;

export class IngestState {
  phase = $state<IngestPhase>('idle');
  /** Progress lines (downloading, reading page 69, submitting …). */
  log = $state<string[]>([]);
  /** Claude's closing words. */
  reply = $state('');
  error = $state<string | null>(null);
  /** Issues of the latest submission (shown while running). */
  lastIssues = $state<IngestIssue[]>([]);
  submissions = $state(0);
  costUsd = $state<number | null>(null);
  /** Tokens used so far (both passes), live while the import runs. */
  tokens = $state<TokenCount | null>(null);
  /** Imported parts saved in this browser. */
  library = $state<PartCard[]>([]);
  request = $state<{ mpn: string; source: string; url?: string } | null>(null);
  pass = $state(1);
  passes = $state(1);
  /** Accepted draft of each pass. */
  drafts = $state<(PartDraft | null)[]>([null, null]);
  /** Disagreements where the user took pass 2's value. */
  takeB = $state<Record<string, boolean>>({});
  /** Draw as several symbols (units). */
  split = $state(false);
  datasheet = $state.raw<Datasheet | null>(null);
  /** The second pass did not finish; review what the first found. */
  secondPassFailed = $state<string | null>(null);

  /** Facts the two passes read differently. */
  disagreements = $derived.by((): Disagreement[] => (this.drafts[0] && this.drafts[1] ? compareDrafts(this.drafts[0], this.drafts[1]) : []));
  /** The part as it would be saved: pass 1 plus the user's picks from pass 2. */
  result = $derived.by((): { card: PartCard | null; issues: IngestIssue[] } => {
    const [a, b] = this.drafts;
    if (!a) return { card: null, issues: this.lastIssues };
    const picks = new Set(Object.keys(this.takeB).filter((k) => this.takeB[k]));
    const { card, issues } = draftToCard(b && picks.size ? mergeDrafts(a, b, picks) : a);
    if (!card) return { card, issues };
    const withUnits = this.split ? { ...card, units: planUnits(card.pins) } : card;
    return {
      card: {
        ...withUnits,
        ...(this.request?.url ? { datasheet: this.request.url } : {}),
        provenance: { ...withUnits.provenance, ...(this.datasheet ? { document: `sha256:${this.datasheet.hash}` } : {}) },
      },
      issues,
    };
  });
  card = $derived(this.result.card);
  issues = $derived(this.result.issues);

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
    this.request = { mpn, source: req.file?.name ?? req.url ?? '', ...(req.url && !req.file ? { url: req.url.trim() } : {}) };
    this.phase = 'running';
    this.passes = req.verify ? 2 : 1;
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
      const data = await req.file.arrayBuffer();
      this.datasheet = { name: req.file.name, data, hash: await sha256(data) };
      pdf = { name: req.file.name, base64: toBase64(data) };
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
        ...(req.verify ? { passes: 2 } : {}),
      },
      (e) => {
        if (this.#run !== id) return;
        switch (e.kind) {
          case 'status':
            this.log.push(e.text);
            break;
          case 'pass':
            this.pass = e.n;
            this.log.push(e.n === 1 ? `Pass 1 of ${e.of}` : `Pass ${e.n} of ${e.of}: independent extraction to cross-check`);
            this.reply = '';
            break;
          case 'datasheet': {
            const data = fromBase64(e.base64);
            void sha256(data).then((hash) => (this.datasheet = { name: e.name, data, hash }));
            break;
          }
          case 'text':
            this.reply += e.text;
            break;
          case 'tokens':
            this.tokens = e.tokens;
            break;
          case 'done':
            this.#run = null;
            if (typeof e.costUsd === 'number') this.costUsd = e.costUsd;
            if (e.tokens) this.tokens = e.tokens;
            if (this.drafts[0]) {
              if (this.passes > 1 && !this.drafts[1]) this.secondPassFailed = e.ok ? 'The second pass finished without an accepted part.' : (e.error ?? 'failed');
              this.split = this.drafts[0].pins.length > SPLIT_ABOVE;
              this.phase = 'review';
            } else fail(e.ok ? 'Claude Code finished without an accepted part.' : (e.error ?? 'The import failed.'));
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
    this.lastIssues = issues;
    const list = (sev: IngestIssue['severity']) => issues.filter((i) => i.severity === sev).map((i) => `- ${i.message}`).join('\n');
    const label = this.passes > 1 ? `Pass ${this.pass}, submission` : 'Submission';
    if (!card) {
      this.log.push(`${label} ${this.submissions}: ${issues.filter((i) => i.severity === 'error').length} problem(s), asked to fix`);
      return text(`Not accepted. Fix these from the datasheet and submit again:\n${list('error')}${list('warning') ? `\nAlso check:\n${list('warning')}` : ''}`, true);
    }
    this.drafts[this.pass - 1] = PartDraft.parse(input);
    this.log.push(`${label} ${this.submissions}: ${card.pins.length} pins accepted${issues.length ? `, ${issues.length} warning(s)` : ''}`);
    return text(
      `Accepted ${card.id} (${card.pins.length} pins, ${card.package}) for the user's review.` +
        (issues.length ? `\nWarnings shown to the user (resubmit if you can fix them from the datasheet):\n${list('warning')}` : ''),
    );
  }

  async save(): Promise<PartCard | null> {
    const card = this.card;
    if (!card) return null;
    const plain = JSON.parse(JSON.stringify(card)) as PartCard;
    if (this.datasheet) await saveDatasheet(this.datasheet.hash, { name: this.datasheet.name, data: this.datasheet.data });
    await this.#store(plain);
    this.#reset();
    return plain;
  }

  /** Change a saved part (e.g. split its symbol into units). */
  async update(card: PartCard): Promise<void> {
    await this.#store(JSON.parse(JSON.stringify(card)) as PartCard);
  }

  async #store(card: PartCard) {
    await saveLibraryPart(card);
    registerUserParts([card]);
    await this.#kernel.registerParts([card]);
    this.library = listUserParts();
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

  /** The datasheet behind a part: the one being reviewed, or a stored one. */
  async datasheetFor(card: PartCard): Promise<Datasheet | null> {
    const doc = card.provenance.document;
    if (this.datasheet && doc === `sha256:${this.datasheet.hash}`) return this.datasheet;
    if (!doc?.startsWith('sha256:')) return null;
    const hash = doc.slice(7);
    const s = await loadDatasheet(hash);
    return s ? { ...s, hash } : null;
  }

  #reset() {
    this.#run = null;
    this.phase = 'idle';
    this.log = [];
    this.reply = '';
    this.error = null;
    this.lastIssues = [];
    this.submissions = 0;
    this.costUsd = null;
    this.tokens = null;
    this.request = null;
    this.pass = 1;
    this.passes = 1;
    this.drafts = [null, null];
    this.takeB = {};
    this.split = false;
    this.datasheet = null;
    this.secondPassFailed = null;
  }
}

function toBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): ArrayBuffer {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

async function sha256(data: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
