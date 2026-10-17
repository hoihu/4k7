/**
 * The design sections of a datasheet, found by their headings: the typical application circuits,
 * the design procedure (component selection, formulas) and the layout guidelines. The importer
 * notes these pages on the card (datasheetPages); this finds them in parts imported before it did,
 * and next to its notes as a second look.
 */
import type { DatasheetPages } from '@4k7/schema';

export type DesignSection = 'application' | 'design' | 'layout';

export interface SectionHeading {
  page: number;
  section: DesignSection;
  heading: string;
}

/** "(continued)", a symbol such as "(LO)", a colon. */
const TAIL = String.raw`(?: \([^)]{1,24}\))?:?`;
const HEADINGS: [DesignSection, RegExp][] = [
  [
    'application',
    new RegExp(
      String.raw`^(?:typical applications?(?: circuits?| schematics?| diagrams?)?|applications? and implementation|applications? (?:information|circuits?(?: schematics?| diagrams?)?|diagrams?|examples?|schematics?|hints)|reference (?:designs?|circuits?|schematics?)|example (?:circuits?|schematics?)|typical (?:circuits?|connections?|application circuits?))${TAIL}$`,
      'i',
    ),
  ],
  [
    'design',
    new RegExp(
      String.raw`^(?:(?:detailed )?design (?:procedure|requirements|examples?|guide)|component selection|(?:(?:input|output|bootstrap|bulk|external) )?(?:inductor|capacitor|diode|resistor|crystal|mosfet|fet|component)s? selection|selecting (?:the|an?) .{3,40}|setting the output voltage|output voltage (?:setting|selection|programming))${TAIL}$`,
      'i',
    ),
  ],
  [
    'layout',
    new RegExp(
      String.raw`^(?:(?:pcb |board |printed circuit board )?layout(?: guidelines?| examples?| recommendations?| considerations| guide)?|(?:pcb|board) (?:design|layout) (?:guidelines?|recommendations?|considerations)|thermal (?:considerations|design))${TAIL}$`,
      'i',
    ),
  ],
];

/** "8.2.2 Detailed Design Procedure" → "Detailed Design Procedure"; table cell gaps (" | ") become spaces. */
function headingText(line: string): string {
  return line
    .replace(/\s*\|\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:\d+(?:\.\d+)*\.?|[A-Z]\.\d+(?:\.\d+)*\.?)\s+/, '');
}

/** Headings of the design sections in `pages` (the text of each page, page 1 first), in page order. */
export function findDesignSections(pages: string[], max = 30): SectionHeading[] {
  const out: SectionHeading[] = [];
  pages.forEach((text, i) => {
    for (const raw of text.split('\n')) {
      // contents pages list every heading with dot leaders: those are not the sections
      if (/(?:\.\s?){4,}/.test(raw)) continue;
      const h = headingText(raw);
      if (h.length < 6 || h.length > 60 || !/^[A-Z]/.test(h)) continue;
      const hit = HEADINGS.find(([, re]) => re.test(h));
      if (!hit) continue;
      const prev = out.at(-1);
      if (prev && prev.section === hit[0] && prev.heading.toLowerCase() === h.replace(/ \(continued\)$/i, '').toLowerCase()) continue;
      out.push({ page: i + 1, section: hit[0], heading: h });
    }
  });
  return out.slice(0, max);
}

/** 24, 25, 26, 30 → "24–26, 30" */
export function pageList(pages: number[]): string {
  const s = [...new Set(pages)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j]! + 1) j++;
    out.push(i === j ? String(s[i]) : `${s[i]}–${s[j]}`);
    i = j + 1;
  }
  return out.join(', ');
}

const LABELS: Record<keyof DatasheetPages, string> = {
  pinout: 'pinout',
  package: 'package drawing',
  application: 'typical application',
  design: 'design procedure',
  layout: 'layout guidelines',
};

/** "pinout p.4, typical application p.24–25, layout guidelines p.39–40" */
export function describeDatasheetPages(pages: DatasheetPages): string {
  return (Object.keys(LABELS) as (keyof DatasheetPages)[])
    .filter((k) => pages[k]?.length)
    .map((k) => `${LABELS[k]} p.${pageList(pages[k]!)}`)
    .join(', ');
}
