/**
 * JLCPCB sourcing in the app: the jlc_search tool (the in-app agent and the bridge share it) and
 * the catalogue the Inspector's "Find on JLCPCB" uses. The browser calls the catalogue directly;
 * answers are kept for a few minutes so the Inspector and the agent do not ask twice.
 */
import type { ToolOutcome } from '@tracewise/agent';
import { JlcSearchInput } from '@tracewise/schema';
import { describeJlcPart, tscircuitSource, type JlcPart, type JlcQuery, type JlcSource } from '@tracewise/parts';

let source: JlcSource = tscircuitSource();
/** Tests swap the catalogue for a fake. */
export function setJlcSource(s: JlcSource) {
  source = s;
  cache.clear();
}
const cache = new Map<string, { at: number; value: Promise<unknown> }>();
const KEEP_MS = 10 * 60_000;

function memo<T>(key: string, make: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.value as Promise<T>;
  const value = make();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key)); // a failure is not worth remembering
  return value;
}

/** The catalogue, memoised. */
export const jlc: JlcSource = {
  search: (q: JlcQuery) => memo(`s:${JSON.stringify(q)}`, () => source.search(q)),
  lookup: (lcsc: string) => memo(`l:${lcsc.trim().toUpperCase()}`, () => source.lookup(lcsc)),
};

/** The jlc_search tool: text or parametric search, or one part by LCSC number. */
export async function jlcTool(input: unknown): Promise<ToolOutcome> {
  const parsed = JlcSearchInput.safeParse(input);
  if (!parsed.success) return { content: `Invalid jlc_search input: ${parsed.error.message}`, isError: true, label: 'jlc_search', detail: 'invalid input' };
  const a = parsed.data;
  try {
    if (a.lcsc) {
      const p = await jlc.lookup(a.lcsc);
      if (!p) return { content: `${a.lcsc.trim()} is not in JLCPCB's catalogue (or the number is wrong).`, isError: true, label: `jlc · ${a.lcsc.trim()}`, detail: 'not found' };
      const lines = [
        describeJlcPart(p),
        p.manufacturer ? `manufacturer: ${p.manufacturer}` : '',
        p.datasheet ? `datasheet: ${p.datasheet}` : `datasheet: not in the catalogue record; the part page links it: ${p.url}`,
        `part page: ${p.url}`,
        'Record it on a component with design_edit set_param lcsc.',
      ];
      return { content: lines.filter(Boolean).join('\n'), isError: false, label: `jlc · ${p.lcsc}`, detail: `${p.mpn} · ${p.package}` };
    }
    const q: JlcQuery = {
      ...(a.text ? { text: a.text } : {}),
      ...(a.kind ? { kind: a.kind } : {}),
      ...(a.value ? { value: a.value } : {}),
      ...(a.package ? { package: a.package } : {}),
      ...(a.basic_only ? { basicOnly: true } : {}),
      limit: a.limit,
    };
    const what = a.kind ? `${a.kind} ${a.value ?? ''}${a.package ? ` ${a.package}` : ''}`.trim() : (a.text ?? '').trim();
    const parts = await jlc.search(q);
    if (!parts.length) {
      return {
        content: `No JLCPCB parts for "${what}"${a.basic_only ? ' among Basic/Preferred parts' : ''}. Try other words from a catalogue description, or drop the package filter.`,
        isError: false,
        label: `jlc · ${what}`,
        detail: 'no results',
      };
    }
    const content = [
      `${parts.length} JLCPCB part(s) for ${what} (Basic/Preferred first, then by stock; USD per piece at the quantity given):`,
      ...parts.map((p) => `- ${describeJlcPart(p)}`),
      'jlc_search lcsc: "C…" gives a part\'s datasheet link; design_edit set_param lcsc records the choice on a component.',
    ].join('\n');
    return { content, isError: false, label: `jlc · ${what}`, detail: `${parts.length} result(s)` };
  } catch (e) {
    const msg = (e as Error).message;
    return { content: `JLCPCB search failed: ${msg}`, isError: true, label: 'jlc_search', detail: msg };
  }
}

export type { JlcPart };
