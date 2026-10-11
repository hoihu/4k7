import { describe, expect, it } from 'vitest';
import { autoTabs, type BoardView } from '@tracewise/schema';
import { Kernel } from '../src/index.ts';
import { buckTransaction } from './fixtures.ts';

function panel(...ops: unknown[]) {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  const r = k.transact({ summary: 'panel', ops: ops as never });
  return { k, r, b: k.board() };
}
const codes = (b: BoardView) => b.diagnostics.map((d) => d.code).filter((c) => c.startsWith('PANEL.'));

/** Even-odd over every milled contour: is the point material? */
function material(b: BoardView, x: number, y: number): boolean {
  let hit = false;
  for (const p of b.panel!.edges) {
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      const [xi, yi, xj, yj] = [p[i]!, p[i + 1]!, p[j]!, p[j + 1]!];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
  }
  return hit;
}

describe('fabrication panel', () => {
  it('lays out a 2 × 2 panel with rails, shared tabs and mouse bites', () => {
    const { r, b } = panel({ op: 'set_board', width_mm: 40, height_mm: 30 }, { op: 'set_panel' });
    expect(r.status).toBe('ok');
    const p = b.panel!;
    // 5 mm rail + 2 mm gap on each side, 2 mm between the copies
    expect([p.w, p.h]).toEqual([96, 76]);
    expect(p.copies).toEqual([{ dx: 7, dy: 7 }, { dx: 49, dy: 7 }, { dx: 7, dy: 39 }, { dx: 49, dy: 39 }]);
    // per board: two tabs on the 40 mm sides, one on the 30 mm sides; the ones between neighbours are shared
    expect(p.settings.tabs).toEqual(autoTabs(['top', 'right', 'bottom', 'left'], 40, 30));
    expect(p.tabs).toHaveLength(18);
    expect(p.tabs.filter((t) => t.joins)).toHaveLength(6);
    // 8 holes across a 5 mm tab (pitch ≤ 0.75), a row at each end: the board edges, or a board and the frame
    expect(p.bites).toHaveLength(18 * 16);
    expect(codes(b)).toEqual([]);
    // material: the boards and the frame; milled: the channel, except at a tab
    expect(material(b, 27, 22)).toBe(true);
    expect(material(b, 2, 2)).toBe(true);
    expect(material(b, 27, 6)).toBe(false); // above the first board, between its tabs
    expect(material(b, 48, 12)).toBe(false); // between the first two boards, beside the shared tab
    const shared = p.tabs.find((t) => t.joins && t.side === 'right')!;
    expect(material(b, shared.x + shared.w / 2, shared.y + shared.h / 2)).toBe(true);
    // a frame tab: holes 0.25 mm inside the board edge (y 7) and inside the frame (the rail ends at y 5)
    const top = p.tabs.find((t) => t.copy === 0 && t.side === 'top')!;
    const row = p.bites.filter((m) => m.x >= top.x - 1e-6 && m.x <= top.x + top.w + 1e-6 && m.y < 10);
    expect(row).toHaveLength(16);
    expect([...new Set(row.map((m) => m.y))].sort()).toEqual([4.75, 7.25]);
    // fiducials (three, asymmetric) and tooling holes on the rails, 3.85 mm from the edge
    expect(p.fiducials).toHaveLength(3);
    expect(p.tooling.map((t) => [t.x, t.y])).toEqual([[3.85, 3.85], [92.15, 3.85], [3.85, 72.15], [92.15, 72.15]]);
  });

  it('keeps the bites inside a round board and joins neighbours', () => {
    const { b } = panel(
      { op: 'set_outline', svg_path: 'M 0 10 A 10 10 0 1 1 20 10 A 10 10 0 1 1 0 10 Z', width_mm: 30 },
      { op: 'set_panel', cols: 3, rows: 1 },
    );
    const p = b.panel!;
    expect(codes(b)).toEqual([]);
    expect(p.tabs.filter((t) => t.joins)).toHaveLength(2);
    // each hole just inside a board, or (frame side) just inside the material past the 2 mm channel
    for (const m of p.bites) {
      const r = Math.min(...p.copies.map((o) => Math.hypot(m.x - (o.dx + 15), m.y - (o.dy + 15))));
      expect(r < 15 || r > 17, `hole at ${r} mm from the centre`).toBe(true);
    }
  });

  it('reports boards held by too few tabs and a panel that falls apart', () => {
    const { b } = panel({ op: 'set_board', width_mm: 40, height_mm: 30 }, { op: 'set_panel', cols: 3, rows: 1, rails_mm: { left: 0, right: 0 }, tab_sides: ['left', 'right'] });
    // no rail on the left and right: the outer sides get no tab; the rails are not held at all
    expect(b.panel!.tabs).toHaveLength(2);
    expect(codes(b)).toEqual(['PANEL.TABS', 'PANEL.LOOSE']);
  });

  it('reports a tab that runs off the board', () => {
    const { b } = panel({ op: 'set_board', width_mm: 40, height_mm: 30 }, { op: 'set_panel', tabs: [{ side: 'left', at: 0.02 }, { side: 'right', at: 0.5 }] });
    expect(codes(b)).toContain('PANEL.TAB');
    const two = panel({ op: 'set_board', width_mm: 40, height_mm: 30 }, { op: 'set_panel', tabs: [{ side: 'top', at: 0.5 }, { side: 'top', at: 0.55 }, { side: 'bottom', at: 0.5 }] });
    expect(two.b.diagnostics.find((d) => d.code === 'PANEL.TAB')?.message).toContain('overlap');
  });

  it('drills only at the board edge when the frame side is off', () => {
    const { b } = panel({ op: 'set_board', width_mm: 40, height_mm: 30 }, { op: 'set_panel', frame_holes: false });
    expect(b.panel!.bites).toHaveLength(12 * 8 + 6 * 16);
  });

  it('warns when mouse bites run into a mark on the rail', () => {
    // a tab on a 30 mm board near the left end of the top side: its frame-side row lands on the fiducial at x 10
    const { b } = panel({ op: 'set_board', width_mm: 30, height_mm: 30 }, { op: 'set_panel', tabs: [{ side: 'top', at: 0.1 }, { side: 'bottom', at: 0.5 }, { side: 'left', at: 0.5 }, { side: 'right', at: 0.5 }] });
    expect(codes(b)).toContain('PANEL.MARKS');
  });

  it('changes only what is given, and goes away with none', () => {
    const { k } = panel({ op: 'set_board', width_mm: 40, height_mm: 30 }, { op: 'set_panel', cols: 3 });
    k.transact({ summary: 'gap', ops: [{ op: 'set_panel', gap_mm: 3, tab_sides: ['top', 'bottom'], tabs_per_side: 1 }] });
    const s = k.board().panel!.settings;
    expect([s.cols, s.rows, s.gap]).toEqual([3, 2, 3]);
    expect(s.tabs).toEqual([{ side: 'top', at: 0.5 }, { side: 'bottom', at: 0.5 }]);
    k.transact({ summary: 'none', ops: [{ op: 'set_panel', none: true }] });
    expect(k.board().panel).toBeUndefined();
  });

  it('checks the panel against the fab profile', () => {
    const { b } = panel({ op: 'set_board', width_mm: 40, height_mm: 30 }, { op: 'set_fab_profile', preset: 'jlcpcb' }, { op: 'set_panel', cols: 20, rows: 2 });
    expect(codes(b)).toEqual(['PANEL.SIZE']);
    const ec = panel({ op: 'set_board', width_mm: 40, height_mm: 30 }, { op: 'set_fab_profile', preset: 'eurocircuits/6C' }, { op: 'set_panel', hole_mm: 0.3 });
    expect(codes(ec.b)).toEqual(['PANEL.HOLE']);
  });
});
