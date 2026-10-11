/**
 * Datasheet import: the local Claude Code (through the server) reads the datasheet and submits
 * a draft; this tab checks every submission deterministically (draftToCard) and answers with
 * the problems to fix. Optionally a second, independent pass extracts everything again and the
 * two are compared fact by fact; the user decides where they disagree. The datasheet is kept
 * so every pin can be shown on its page. Nothing is saved before the user's review.
 */
import { compareDrafts, draftToCard, listUserParts, mergeDrafts, planUnits, registerUserParts, unregisterUserPart, type Disagreement } from '@4k7/parts';
import { PartDraft, type ToolContent, type DraftPin, type PackageInfo, type Design, type IngestIssue, type PartCard, type TokenCount } from '@4k7/schema';
import { server } from './server.svelte.ts';
import { deleteDatasheet, deleteLibraryPart, loadDatasheet, loadLibrary, loadPendingImport, saveDatasheet, saveLibraryPart, savePendingImport, type StoredDatasheet } from './persist.ts';

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

interface PendingRecord {
  request: IngestState['request'];
  passes: number;
  drafts: (PartDraft | null)[];
  takeB: Record<string, boolean>;
  split: boolean;
  secondPassFailed: string | null;
  costUsd: number | null;
  tokens: TokenCount | null;
  reply: string;
  datasheet: { hash: string; name: string } | null;
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
  /** Saved parts a newer version of the app wrote; not loaded, left in storage. */
  newer = 0;
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
  /** Set once a saved pending review is restored, so the first (idle) state does not erase it. */
  #restored = false;
  /** The datasheet stored for the pending review (removed again if the import is discarded). */
  #storedSheet: string | null = null;

  constructor(kernel: KernelParts) {
    this.#kernel = kernel;
    // keep the review across reloads: saved on every change, cleared when saved or discarded
    $effect.root(() => {
      $effect(() => {
        // a snapshot reads every nested value, so picks made in the Parts view are seen too
        const pending = this.phase === 'review' && this.drafts[0] ? ($state.snapshot(this.#pendingRecord()) as PendingRecord) : null;
        if (!this.#restored) return;
        void this.#keep(pending);
      });
    });
  }

  #pendingRecord(): PendingRecord {
    return {
      request: this.request,
      passes: this.passes,
      drafts: this.drafts,
      takeB: this.takeB,
      split: this.split,
      secondPassFailed: this.secondPassFailed,
      costUsd: this.costUsd,
      tokens: this.tokens,
      reply: this.reply,
      datasheet: this.datasheet ? { hash: this.datasheet.hash, name: this.datasheet.name } : null,
    };
  }

  async #keep(pending: PendingRecord | null) {
    if (pending?.datasheet && this.datasheet && this.#storedSheet !== this.datasheet.hash) {
      this.#storedSheet = this.datasheet.hash;
      await saveDatasheet(this.datasheet.hash, { name: this.datasheet.name, data: this.datasheet.data });
    }
    await savePendingImport(pending);
  }

  /** Load saved parts and make them known to the kernel (agent) and the UI; restore a pending review. */
  async init() {
    const { items: cards, newer } = await loadLibrary();
    this.newer = newer;
    registerUserParts(cards);
    await this.#kernel.registerParts(cards);
    this.library = listUserParts();
    try {
      const p = await loadPendingImport<PendingRecord>();
      if (p?.drafts?.[0] && this.phase === 'idle') {
        this.request = p.request;
        this.passes = p.passes;
        this.drafts = p.drafts;
        this.takeB = p.takeB ?? {};
        this.split = p.split;
        this.secondPassFailed = p.secondPassFailed;
        this.costUsd = p.costUsd;
        this.tokens = p.tokens;
        this.reply = p.reply ?? '';
        if (p.datasheet) {
          const s = await loadDatasheet(p.datasheet.hash);
          if (s) {
            this.datasheet = { ...s, hash: p.datasheet.hash };
            this.#storedSheet = p.datasheet.hash;
          }
        }
        this.log = ['Restored the import waiting for review.'];
        this.phase = 'review';
      }
    } finally {
      this.#restored = true;
    }
  }

  get available(): boolean {
    return server.status === 'connected' && !!server.chat?.available;
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
    if (!this.available) return fail('Connect the local server first (Settings → Local server).');
    let pdf: { name: string; base64: string } | undefined;
    if (req.file) {
      if (req.file.size > MAX_BYTES) return fail(`The PDF is larger than ${MAX_BYTES >> 20} MB.`);
      this.log.push(`Uploading ${req.file.name} to the server`);
      const data = await req.file.arrayBuffer();
      this.datasheet = { name: req.file.name, data, hash: await sha256(data) };
      pdf = { name: req.file.name, base64: toBase64(data) };
    } else if (!req.url?.trim()) return fail('Attach the datasheet PDF or paste its link.');

    const id = `ingest-${Date.now().toString(36)}`;
    this.#run = id;
    const sent = server.sendIngest(
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
    if (!sent) fail('The server is not connected.');
  }

  /**
   * The agent's side of the review (pending_import): the same draft the user sees in Parts. Pin
   * and package corrections go into both passes' drafts, so a corrected fact is no longer disputed.
   */
  async agentEdit(
    a:
      | { action: 'get' | 'save' | 'discard' }
      | { action: 'pick'; picks: { key: string; pass: 1 | 2 }[] }
      | { action: 'set_pins'; pins: DraftPin[] }
      | { action: 'remove_pins'; numbers: string[] }
      | { action: 'rename'; mpn?: string; title?: string }
      | { action: 'set_package'; package: Partial<PackageInfo> },
  ): Promise<{ isError: boolean; text: string }> {
    if (this.phase === 'running') return { isError: true, text: `The import of ${this.request?.mpn} is still running; wait for it (import_part again with the same mpn).` };
    if (this.phase !== 'review' || !this.drafts[0]) return { isError: true, text: 'No import is waiting for review.' };
    const keys = new Set(this.disagreements.map((d) => d.key));
    const edit = (f: (d: PartDraft) => void) => {
      this.drafts = this.drafts.map((d) => {
        if (!d) return d;
        const copy = $state.snapshot(d) as PartDraft;
        f(copy);
        return copy;
      });
    };
    const forget = (key: string) => {
      const next = { ...this.takeB };
      delete next[key];
      this.takeB = next;
    };
    switch (a.action) {
      case 'get':
        return { isError: false, text: this.#describe() };
      case 'discard': {
        const mpn = this.request?.mpn;
        this.discard();
        return { isError: false, text: `Discarded the import of ${mpn}.` };
      }
      case 'save': {
        const errors = this.issues.filter((i) => i.severity === 'error');
        if (!this.card || errors.length) return { isError: true, text: `Not saved; fix first:\n${errors.map((i) => `- ${i.message}`).join('\n')}` };
        const open = this.disagreements.filter((d) => this.takeB[d.key] === undefined);
        if (open.length) return { isError: true, text: `Not saved; settle these disagreements first (pick, or correct the pin/package): ${open.map((d) => d.key).join(', ')}` };
        const saved = await this.save();
        return saved ? { isError: false, text: `${saved.mpn ?? saved.id} added to the library as ${saved.id} (${saved.pins.length} pins); place it with add_part.` } : { isError: true, text: 'Saving failed.' };
      }
      case 'pick': {
        const bad = a.picks.filter((p) => !keys.has(p.key));
        if (bad.length) return { isError: true, text: `Not disputed: ${bad.map((p) => p.key).join(', ')}. Disputed: ${[...keys].join(', ') || 'none'}` };
        this.takeB = { ...this.takeB, ...Object.fromEntries(a.picks.map((p) => [p.key, p.pass === 2])) };
        break;
      }
      case 'set_pins':
        edit((d) => {
          for (const p of a.pins) {
            const i = d.pins.findIndex((x) => x.number.toUpperCase() === p.number.toUpperCase());
            if (i >= 0) d.pins[i] = { ...d.pins[i], ...p };
            else d.pins.push(p);
          }
        });
        for (const p of a.pins) forget(`pin:${p.number.toUpperCase()}`);
        break;
      case 'remove_pins': {
        const gone = new Set(a.numbers.map((n) => n.toUpperCase()));
        edit((d) => (d.pins = d.pins.filter((p) => !gone.has(p.number.toUpperCase()))));
        for (const n of gone) forget(`pin:${n}`);
        break;
      }
      case 'rename': {
        const mpn = a.mpn?.trim();
        if (mpn && this.library.some((p) => p.mpn?.toLowerCase() === mpn.toLowerCase())) return { isError: true, text: `${mpn} is already in the library.` };
        edit((d) => {
          if (mpn) d.mpn = mpn;
          if (a.title !== undefined) d.title = a.title.trim() || undefined;
        });
        if (mpn && this.request) this.request = { ...this.request, mpn };
        break;
      }
      case 'set_package':
        edit((d) => Object.assign(d.package, a.package));
        for (const k of Object.keys(a.package)) forget(`package:${k}`);
        break;
    }
    return { isError: false, text: `Updated.\n${this.#describe()}` };
  }

  /** The pending import as the agent reads it. */
  agentSummary(): string {
    return this.phase === 'review' && this.drafts[0] ? this.#describe() : '';
  }

  #describe(): string {
    const d = this.drafts[0]!;
    const card = this.card;
    const pkg = card?.packageInfo ?? d.package;
    const lines = [
      `${this.request?.mpn}${d.title ? ` "${d.title}"` : ''}: ${card ? `${card.id}, ${card.pins.length} pins` : 'not usable yet'}, package ${pkg.name} (${pkg.family}${pkg.pitch_mm ? `, pitch ${pkg.pitch_mm}` : ''}${pkg.body_mm ? `, body ${pkg.body_mm.join('×')}` : ''}${pkg.exposed_pad_mm ? `, exposed pad ${pkg.exposed_pad_mm.join('×')}` : ''}; drawing p.${pkg.page ?? '?'})`,
    ];
    const dis = this.disagreements;
    if (dis.length) {
      lines.push('Disagreements between the passes (key: pass 1 | pass 2 → chosen):');
      for (const x of dis) lines.push(`- ${x.key}: ${x.a} | ${x.b} → ${this.takeB[x.key] === undefined ? 'open' : this.takeB[x.key] ? 'pass 2' : 'pass 1'}`);
    }
    if (this.secondPassFailed) lines.push(`Second pass: ${this.secondPassFailed}`);
    if (this.issues.length) lines.push('Issues:', ...this.issues.map((i) => `- ${i.severity}: ${i.message}`));
    const pins = card?.pins ?? d.pins;
    lines.push(`Pins: ${pins.map((p) => `${p.number} ${p.name} ${p.type}${'page' in p && p.page ? ` p${p.page}` : ''}`).join('; ')}`);
    return lines.join('\n');
  }

  cancel() {
    if (this.#run) server.cancelChat(this.#run);
  }

  /** submit_part from the importer: check the draft, answer with what to fix. */
  submit(input: unknown): { isError: boolean; content: ToolContent[] } {
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

  /**
   * A footprint given to a library part in the design (set_footprint, from its datasheet drawing)
   * goes back to the library part once committed, so the Parts view and later designs have it.
   */
  async adoptFootprints(design: Design): Promise<void> {
    for (const lib of this.library) {
      const pkg = design.parts[lib.id]?.packageInfo;
      if (!pkg?.pads?.length || JSON.stringify(pkg) === JSON.stringify(lib.packageInfo)) continue;
      await this.update({ ...lib, packageInfo: pkg, package: pkg.name });
    }
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
    // the datasheet was kept only for this review (unless a saved part uses it)
    const hash = this.#storedSheet;
    if (hash && !this.library.some((p) => p.provenance.document === `sha256:${hash}`)) void deleteDatasheet(hash);
    this.#storedSheet = null;
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
