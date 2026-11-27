import { describe, expect, it } from 'vitest';
import type { Scorecard } from '@4k7/schema';
import { scorecardHtml } from '../src/lib/scorecarddoc.ts';

const card: Scorecard = {
  findings: { DRC: { errors: 1, warnings: 2, infos: 0 }, SEM: { errors: 0, warnings: 1, infos: 3 } },
  waived: 2,
  unknown: { 'DRC.CURRENT_UNKNOWN': 1 },
  ledger: { hard: 1, soft: 0, violated: 0 },
  parts: { fitted: 12, dnp: 1, cards: 6 },
  power: { rails: 2, over: 0, unknown: 1, hot: { count: 0 } },
  boards: [
    { id: 'b_1', name: 'Main', width_mm: 24.5, height_mm: 22, size_by: 'proposal', layers: 2, parts: { top: 12, bottom: 0 }, routing: 'done', connections: { nets: 8, routed: 7, open: 1 }, track_mm: 120.3, vias: 4 },
    { id: 'b_2', name: 'LED board', width_mm: 10, height_mm: 14, size_by: 'user', layers: 2, parts: { top: 3, bottom: 0 }, routing: 'stale' },
  ],
};

describe('design document: scorecard table', () => {
  it('has the findings, what was not judged and each board with its size, layers and routing', () => {
    const html = scorecardHtml(card);
    expect(html).toContain('1 error, 3 warnings, 3 notes <span class="muted">(DRC, SEM)</span>; 2 waived');
    expect(html).toContain('<span class="mono">DRC.CURRENT_UNKNOWN</span> 1');
    expect(html).toContain('<th>Board Main</th><td>24.5 × 22 mm, 2 layers; routed, 1 connection open</td>');
    expect(html).toContain('<th>Board LED board</th><td>10 × 14 mm, 2 layers; routing out of date</td>');
  });

  it('says nothing was left unjudged, and names a single board just Board', () => {
    const html = scorecardHtml({ ...card, unknown: {}, boards: [{ ...card.boards[0]!, routing: 'none' }] });
    expect(html).toContain('<th>Not judged</th><td>nothing</td>');
    expect(html).toContain('<th>Board</th><td>24.5 × 22 mm, 2 layers; not routed</td>');
  });
});
