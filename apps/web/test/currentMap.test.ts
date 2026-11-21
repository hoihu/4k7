import { describe, expect, it } from 'vitest';
import { BoardImageInput, type BoardView, type Diagnostic } from '@4k7/schema';
import { HEAT, UNKNOWN_COLOUR, currentLayer, currentLegend, currentOverlayOn, heatBucket } from '../src/lib/currentMap.ts';

const diag = (code: string, waived = false): Diagnostic => ({ code, severity: 'warning', message: code, entities: [], ...(waived ? { waivedBy: 'w1' } : {}) });

describe('heat map colour scale', () => {
  it('buckets the estimated heating against the allowed rise: < ¼, ½, 1×, 2×, > 2×', () => {
    expect(heatBucket(1, 10)).toBe(0);
    expect(heatBucket(2.5, 10)).toBe(0);
    expect(heatBucket(4, 10)).toBe(1);
    expect(heatBucket(10, 10)).toBe(2);
    expect(heatBucket(15, 10)).toBe(3);
    expect(heatBucket(20, 10)).toBe(3);
    expect(heatBucket(68, 10)).toBe(4);
    // relative to the board's allowed rise
    expect(heatBucket(15, 30)).toBe(1);
  });
});

describe('heat map styles', () => {
  const board = {
    netNames: { n1: '+5V', n2: 'VBAT', n3: 'SDA' },
    tracks: [
      { netId: 'n1', layer: 'F.Cu', width: 1, pts: [0, 0, 10, 0] },
      { netId: 'n1', layer: 'F.Cu', width: 0.25, pts: [0, 5, 10, 5] },
      { netId: 'n2', layer: 'B.Cu', width: 0.5, pts: [0, 9, 10, 9] },
      { netId: 'n3', layer: 'F.Cu', width: 0.15, pts: [0, 12, 10, 12] },
    ],
    vias: [{ netId: 'n1', x: 5, y: 5, drill: 0.3, pad: 0.6 }],
    current: {
      riseC: 10,
      copperUm: { 'F.Cu': 35, 'B.Cu': 35 },
      nets: [
        { netId: 'n1', name: '+5V', amps: 2, basis: 'bound', status: 'unverified', worst: 2.3 },
        { netId: 'n2', name: 'VBAT', basis: 'unknown', status: 'unknown' },
      ],
      tracks: [
        { netId: 'n1', index: 0, layer: 'F.Cu', width: 1, length: 10, copperUm: 35, amps: 2, basis: 'bound', status: 'ok', capacity: 2.39, ratio: 0.84, rise: 6.7, needs: 0.8, at: { x: 0, y: 0 } },
        { netId: 'n1', index: 1, layer: 'F.Cu', width: 0.25, length: 10, copperUm: 35, amps: 2, basis: 'bound', status: 'unverified', capacity: 0.875, ratio: 2.29, rise: 66, needs: 0.8, at: { x: 0, y: 5 } },
      ],
      vias: [{ netId: 'n1', at: { x: 5, y: 5 }, vias: 1, drill: 0.3, ids: [], layers: ['F.Cu', 'B.Cu'], amps: 2, basis: 'bound', status: 'unverified', capacity: 0.9, ratio: 2.2, needs: 3 }],
    },
  } as unknown as BoardView;

  it('a track that carries the whole current is solid in its colour; one that may not is dashed with a "?"', () => {
    const h = currentLayer(board)!;
    expect(h.tracks.get(0)).toMatchObject({ colour: HEAT[2].colour, dashed: false });
    expect(h.tracks.get(0)!.title).toBe('+5V · 1 mm · 35 µm · 2 A (bound) · needs 0.8 mm · ≈ +7 °C');
    const hot = h.tracks.get(1)!;
    expect(hot).toMatchObject({ colour: HEAT[4].colour, dashed: true });
    expect(hot.title).toContain('2 A (bound?)');
    expect(hot.title).toContain('≈ +66 °C');
    expect(hot.title).toContain('?');
  });

  it('unknown is grey and dashed, never the cool end; signal copper gets no style (dimmed)', () => {
    const h = currentLayer(board)!;
    expect(h.tracks.get(2)).toMatchObject({ colour: UNKNOWN_COLOUR, dashed: true });
    expect(h.tracks.get(2)!.title).toContain('current unknown');
    expect(HEAT.map((x) => x.colour)).not.toContain(UNKNOWN_COLOUR);
    expect(h.tracks.has(3)).toBe(false);
    expect([...h.unknown]).toEqual(['n2']);
  });

  it('a via group gets a ring in the scale with its count, dashed when it may be too few', () => {
    const [v] = currentLayer(board)!.vias;
    expect(v).toMatchObject({ x: 5, y: 5, count: 1, colour: HEAT[4].colour, dashed: true });
    expect(v!.title).toContain('needs 3');
  });

  it('split copper is drawn solid in its colour, over its capacity too; its tooltip says (split) and the drop', () => {
    const split = {
      ...board,
      current: {
        ...board.current!,
        nets: [{ netId: 'n1', name: '+5V', amps: 2, basis: 'split', status: 'over', worst: 2.3, loads: 2, dropMv: 31 }],
        tracks: [
          { netId: 'n1', index: 0, layer: 'F.Cu', width: 1, length: 10, copperUm: 35, amps: 0.01, basis: 'split', status: 'ok', capacity: 2.39, ratio: 0.004, dropMv: 0.05, rise: 0, needs: 0.15, at: { x: 0, y: 0 } },
          { netId: 'n1', index: 1, layer: 'F.Cu', width: 0.25, length: 10, copperUm: 35, amps: 2, basis: 'split', status: 'over', capacity: 0.875, ratio: 2.29, dropMv: 39.3, rise: 66, needs: 0.8, at: { x: 0, y: 5 } },
        ],
        vias: [],
      },
    } as unknown as BoardView;
    const h = currentLayer(split)!;
    expect(h.tracks.get(0)).toMatchObject({ colour: HEAT[0].colour, dashed: false });
    const hot = h.tracks.get(1)!;
    expect(hot).toMatchObject({ colour: HEAT[4].colour, dashed: false });
    expect(hot.title).toContain('2 A (split)');
    expect(hot.title).toContain('drop 39.3 mV');
    expect(hot.title).not.toContain('?');
  });

  it('nothing without the current check (not routed)', () => {
    expect(currentLayer({ ...board, current: undefined })).toBeNull();
    expect(currentLegend(20)).toContain('+20 °C');
  });
});

describe('heat map on or off', () => {
  it('is on by itself while a current finding is open, off when none is', () => {
    expect(currentOverlayOn([diag('DRC.CURRENT_UNVERIFIED')], null)).toBe(true);
    expect(currentOverlayOn([diag('DRC.TRACK_CURRENT')], null)).toBe(true);
    expect(currentOverlayOn([diag('DRC.VIA_CURRENT')], null)).toBe(true);
    expect(currentOverlayOn([diag('DRC.CURRENT_UNKNOWN')], null)).toBe(true);
    expect(currentOverlayOn([diag('DRC.CLEARANCE')], null)).toBe(false);
    expect(currentOverlayOn([], null)).toBe(false);
    // a waived finding is not open
    expect(currentOverlayOn([diag('DRC.VIA_CURRENT', true)], null)).toBe(false);
  });

  it("the user's switch holds (off with a finding open, on with none)", () => {
    expect(currentOverlayOn([diag('DRC.CURRENT_UNVERIFIED')], false)).toBe(false);
    expect(currentOverlayOn([], true)).toBe(true);
  });

  it('a picture can force it either way', () => {
    expect(currentOverlayOn([], false, 'current')).toBe(true);
    expect(currentOverlayOn([diag('DRC.CURRENT_UNVERIFIED')], true, 'none')).toBe(false);
  });
});

describe('get_board_image overlay', () => {
  it('takes current or none, and nothing else', () => {
    expect(BoardImageInput.parse({ overlay: 'current' }).overlay).toBe('current');
    expect(BoardImageInput.parse({ overlay: 'none' }).overlay).toBe('none');
    expect(BoardImageInput.parse({}).overlay).toBeUndefined();
    expect(BoardImageInput.safeParse({ overlay: 'heat' }).success).toBe(false);
  });
});
