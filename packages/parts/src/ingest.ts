/**
 * From an AI-extracted datasheet draft to a Part Card, with deterministic cross-checks.
 * The checks are what makes extraction trustworthy: a wrong pin count, a duplicate or
 * missing pin number or an impossible ball name is reported back to the AI (and the user)
 * instead of silently becoming a broken symbol.
 */
import { PartDraft, type DatasheetPages, type IngestIssue, type PartCard, type PartRequirement } from '@4k7/schema';
import { bgaRowName, footprintFor } from './footprint.ts';
import { planSymbolLayout } from './symbolgen.ts';

export interface IngestResult {
  card: PartCard | null;
  issues: IngestIssue[];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'part';

export function draftToCard(input: unknown): IngestResult {
  const parsed = PartDraft.safeParse(input);
  if (!parsed.success) {
    return {
      card: null,
      issues: parsed.error.issues.slice(0, 12).map((i) => ({ severity: 'error' as const, message: `${i.path.join('.') || '(draft)'}: ${i.message}` })),
    };
  }
  const draft = parsed.data;
  const issues: IngestIssue[] = [];
  const err = (message: string) => issues.push({ severity: 'error', message });
  const warn = (message: string) => issues.push({ severity: 'warning', message });
  const pkg = draft.package;

  /* ---- pin numbers ---- */
  const seen = new Map<string, number>();
  for (const p of draft.pins) seen.set(p.number.toUpperCase(), (seen.get(p.number.toUpperCase()) ?? 0) + 1);
  const dups = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  if (dups.length) err(`Duplicate pin numbers: ${dups.slice(0, 20).join(', ')}.`);

  const isEp = (n: string) => /^(EP|PAD)$/i.test(n) || (!!pkg.exposed_pad_mm && Number(n) === pkg.pins + 1);
  const counted = draft.pins.filter((p) => !isEp(p.number));
  if (counted.length !== pkg.pins) {
    err(`${pkg.name} has ${pkg.pins} pins but the draft lists ${counted.length}${counted.length < pkg.pins ? ' (some are missing)' : ' (too many)'}.`);
  }

  const grid = pkg.family === 'BGA' || pkg.family === 'CSP';
  if (grid) {
    const valid = new Set<string>();
    if (pkg.grid) for (let r = 0; r < pkg.grid.rows; r++) for (let c = 1; c <= pkg.grid.cols; c++) valid.add(`${bgaRowName(r)}${c}`);
    const bad = counted.map((p) => p.number.toUpperCase()).filter((n) => !/^[A-Z]{1,2}\d{1,2}$/.test(n) || (valid.size > 0 && !valid.has(n)));
    if (bad.length) err(`Ball names not valid for ${pkg.name}${pkg.grid ? ` (${pkg.grid.rows}×${pkg.grid.cols}, rows skip I O Q S X Z)` : ''}: ${bad.slice(0, 15).join(', ')}.`);
  } else {
    const nums = counted.map((p) => Number(p.number));
    if (nums.some((n) => !Number.isInteger(n))) {
      err(`Pin numbers of a ${pkg.family} package must be integers; got ${counted.filter((p) => !Number.isInteger(Number(p.number))).slice(0, 10).map((p) => p.number).join(', ')}.`);
    } else {
      const have = new Set(nums);
      const missing: number[] = [];
      for (let i = 1; i <= pkg.pins; i++) if (!have.has(i)) missing.push(i);
      const extra = nums.filter((n) => n < 1 || n > pkg.pins);
      if (missing.length) err(`Missing pin numbers: ${compress(missing)}.`);
      if (extra.length) err(`Pin numbers outside 1–${pkg.pins}: ${compress(extra)}.`);
    }
  }

  /* ---- names and types ---- */
  const supplies = draft.pins.filter((p) => p.type === 'pwr_in' && !/^(VSS|GND|V-|VREF-)/i.test(p.name));
  const grounds = draft.pins.filter((p) => /^(VSS|GND|EP|PAD)/i.test(p.name));
  if (draft.category === 'ic' && !supplies.length) warn('No supply pins (type pwr_in) found; check VDD/VCC pins.');
  if (draft.category === 'ic' && !grounds.length) warn('No ground pins (VSS/GND) found.');
  const mistyped = grounds.filter((p) => p.type !== 'pwr_in' && p.type !== 'passive');
  if (mistyped.length) warn(`Ground pins should have type pwr_in: ${mistyped.slice(0, 8).map((p) => `${p.number} ${p.name}`).join(', ')}.`);

  const noPage = draft.pins.filter((p) => !p.page).length;
  if (noPage) warn(`${noPage} pin(s) without a datasheet page; give the page of each pin's table row.`);

  /* ---- footprint ---- */
  const fp = footprintFor(pkg, draft.pins.map((p) => p.number));
  if (!fp.ok) warn(`Footprint not generated: ${fp.reason}.`);
  else if (!grid) {
    const padNums = new Set(fp.footprint.pads.map((p) => p.number.toUpperCase()));
    const noPad = draft.pins.filter((p) => !padNums.has(p.number.toUpperCase()));
    if (noPad.length) err(`Pins without a pad in the generated ${pkg.name} footprint: ${noPad.slice(0, 10).map((p) => p.number).join(', ')}.`);
  }

  /* ---- card ---- */
  const requirements: PartRequirement[] = (draft.decoupling ?? []).map((r) => ({
    kind: 'decouple',
    pin: r.pin,
    min: r.min,
    ...(r.note ? { note: r.note } : {}),
    src: { source: 'datasheet', ...(draft.datasheet ? { document: draft.datasheet } : {}) },
  }));
  const pins = draft.pins.map((p) => ({
    number: p.number,
    name: p.name,
    type: p.type,
    ...(p.functions?.length || p.description ? { description: [p.description, p.functions?.length ? `alt: ${p.functions.join(', ')}` : ''].filter(Boolean).join(' · ') } : {}),
    ...(draft.supply_max_v && p.type === 'pwr_in' && !/^(VSS|GND)/i.test(p.name) ? { maxVoltage: draft.supply_max_v } : {}),
    ...(p.page ? { page: p.page } : {}),
  }));
  const card: PartCard = {
    id: `${slug(draft.manufacturer.split(/\s/)[0]!)}:${draft.mpn}`,
    mpn: draft.mpn,
    ...(draft.title ? { title: draft.title } : {}),
    manufacturer: draft.manufacturer,
    description: draft.description,
    category: draft.category,
    refPrefix: draft.category === 'connector' ? 'J' : draft.category === 'transistor' ? 'Q' : draft.category === 'crystal' ? 'Y' : 'U',
    package: pkg.name,
    pins,
    params: {},
    ...(requirements.length ? { requirements } : {}),
    ...(draft.datasheet ? { datasheet: draft.datasheet } : {}),
    provenance: { source: 'datasheet', ...(draft.datasheet ? { document: draft.datasheet } : {}), ...(draft.pages?.pinout?.[0] ? { page: draft.pages.pinout[0] } : {}) },
    ...(draft.notes?.length ? { notes: draft.notes } : {}),
    ...(datasheetPages(draft.pages) ? { datasheetPages: datasheetPages(draft.pages) } : {}),
    packageInfo: pkg,
    // large ICs get the conventional arrangement (supplies top, grounds bottom, ports grouped)
    ...(pins.length >= 12 ? { symbolLayout: planSymbolLayout(pins) } : {}),
  };
  return { card: issues.some((i) => i.severity === 'error') ? null : card, issues };
}

const SECTIONS = ['pinout', 'package', 'application', 'design', 'layout'] as const;

/** The draft's section pages, sorted and without repeats; undefined when there are none. */
function datasheetPages(pages: PartDraft['pages']): DatasheetPages | undefined {
  const out: DatasheetPages = {};
  for (const k of SECTIONS) {
    const list = [...new Set((pages?.[k] ?? []).filter((n) => n > 0))].sort((a, b) => a - b);
    if (list.length) out[k] = list;
  }
  return Object.keys(out).length ? out : undefined;
}

/** 1,2,3,7,9,10 → "1–3, 7, 9–10" */
function compress(nums: number[]): string {
  const s = [...new Set(nums)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j]! + 1) j++;
    out.push(i === j ? String(s[i]) : `${s[i]}–${s[j]}`);
    i = j + 1;
  }
  return out.slice(0, 20).join(', ') + (out.length > 20 ? ' …' : '');
}

/* ------------------------- two-pass reconciliation ------------------------- */

/** One fact the two extraction passes disagree on. */
export interface Disagreement {
  /** "pin:15" or "package:pitch_mm". */
  key: string;
  label: string;
  a: string;
  b: string;
}

const PKG_FIELDS = ['family', 'pins', 'pitch_mm', 'body_mm', 'span_mm', 'lead_length_mm', 'lead_width_mm', 'exposed_pad_mm', 'grid', 'ball_mm'] as const;

const normName = (s: string) => s.toUpperCase().replace(/[\s_]/g, '');
/** Main name without the suffixes datasheets add for extra functions: "PH0-OSC_IN" → "PH0", "PA13(JTMS)" → "PA13". */
const pinBase = (s: string) => normName(s.split(/[-/( ]/)[0]!);
const show = (v: unknown) => (v === undefined ? '—' : Array.isArray(v) ? v.join(' × ') : typeof v === 'object' && v ? Object.values(v).join(' × ') : String(v));
const sameValue = (x: unknown, y: unknown): boolean => {
  if (typeof x === 'number' && typeof y === 'number') return Math.abs(x - y) <= 0.02 + 0.005 * Math.max(x, y);
  if (Array.isArray(x) && Array.isArray(y)) return x.length === y.length && x.every((v, i) => sameValue(v, y[i]));
  if (x && y && typeof x === 'object' && typeof y === 'object') return JSON.stringify(x) === JSON.stringify(y);
  return x === y;
};

/**
 * Compare two independent extractions of the same part: pin by pin (name and type) and the
 * package dimensions that shape the footprint. Alternate-function lists are not compared.
 */
export function compareDrafts(a: PartDraft, b: PartDraft): Disagreement[] {
  const out: Disagreement[] = [];
  const pinStr = (p?: PartDraft['pins'][number]) => (p ? `${p.name} (${p.type})` : 'missing');
  const pa = new Map(a.pins.map((p) => [p.number.toUpperCase(), p]));
  const pb = new Map(b.pins.map((p) => [p.number.toUpperCase(), p]));
  const numbers = [...new Set([...pa.keys(), ...pb.keys()])].sort((x, y) => x.localeCompare(y, 'en', { numeric: true }));
  for (const n of numbers) {
    const x = pa.get(n);
    const y = pb.get(n);
    // "PC14-OSC32_IN" and "PC14" name the same pin; only a different base name or type is a real disagreement
    if (x && y && x.type === y.type && (normName(x.name) === normName(y.name) || pinBase(x.name) === pinBase(y.name))) continue;
    out.push({ key: `pin:${n}`, label: `Pin ${n}`, a: pinStr(x), b: pinStr(y) });
  }
  for (const f of PKG_FIELDS) {
    const x = a.package[f];
    const y = b.package[f];
    if (x === undefined && y === undefined) continue;
    if (!sameValue(x, y)) out.push({ key: `package:${f}`, label: `Package ${f.replace(/_mm$/, ' (mm)').replace(/_/g, ' ')}`, a: show(x), b: show(y) });
  }
  return out;
}

/**
 * A copy of draft data. Not structuredClone: the app hands in its reactive state (Svelte proxies),
 * which the browser refuses to clone ("The object can not be cloned"); drafts are plain JSON.
 */
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Pass A with the facts the user took from pass B. */
export function mergeDrafts(a: PartDraft, b: PartDraft, takeB: Set<string>): PartDraft {
  const out: PartDraft = copy(a);
  const pb = new Map(b.pins.map((p) => [p.number.toUpperCase(), p]));
  for (const key of takeB) {
    const [kind, field] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    if (kind === 'pin') {
      const i = out.pins.findIndex((p) => p.number.toUpperCase() === field);
      const repl = pb.get(field);
      if (repl && i >= 0) out.pins[i] = copy(repl);
      else if (repl) out.pins.push(copy(repl));
      else if (i >= 0) out.pins.splice(i, 1);
    } else if (kind === 'package') {
      const f = field as (typeof PKG_FIELDS)[number];
      const v = b.package[f];
      if (v === undefined) delete (out.package as Record<string, unknown>)[f];
      else (out.package as Record<string, unknown>)[f] = copy(v);
    }
  }
  // section pages only say where to read: what either pass found is kept
  if (b.pages) {
    const pages: NonNullable<PartDraft['pages']> = { ...out.pages };
    for (const k of SECTIONS) if (pages[k] || b.pages[k]) pages[k] = [...new Set([...(pages[k] ?? []), ...(b.pages[k] ?? [])])];
    out.pages = pages;
  }
  return out;
}
