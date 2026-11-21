import type { LandPad } from '@4k7/schema';

/**
 * The ESP32-C3-MINI-1 land (datasheet p.38) as the bike lamp's rev 2 got it in the end, mm from the
 * module's body centre (13.2 × 16.6 mm, the antenna at the top): the pad ring sits 2.2 mm below the
 * body centre, its top and bottom rows 9.8 mm apart, the side columns and the 3 × 3 EPAD centred
 * between them.
 */
export function esp32(o: { top: number; bottom: number; side: number; epad: number }): LandPad[] {
  const pads: LandPad[] = [];
  const side = (i: number) => o.side + (i - 5) * 0.8;
  for (let i = 0; i < 11; i++) pads.push({ number: String(1 + i), x: -5.5, y: side(i), w: 0.8, h: 0.4, shape: 'rect' });
  for (let i = 0; i < 13; i++) pads.push({ number: String(12 + i), x: -4.8 + i * 0.8, y: o.bottom, w: 0.4, h: 0.8, shape: 'rect' });
  for (let i = 0; i < 11; i++) pads.push({ number: String(25 + i), x: 5.5, y: side(10 - i), w: 0.8, h: 0.4, shape: 'rect' });
  for (let i = 0; i < 13; i++) pads.push({ number: String(36 + i), x: 4.8 - i * 0.8, y: o.top, w: 0.4, h: 0.8, shape: 'rect' });
  for (const [n, x, y] of [['50', 5.6, o.top - 0.05], ['51', 5.6, o.bottom + 0.05], ['52', -5.6, o.bottom + 0.05], ['53', -5.6, o.top - 0.05]] as const) {
    pads.push({ number: n, x, y, w: 0.7, h: 0.7, shape: 'rect' });
  }
  for (const dy of [-2.05, 0, 2.05]) for (const dx of [-2.05, 0, 2.05]) pads.push({ number: '49', x: dx, y: o.epad + dy, w: 1.45, h: 1.45, shape: 'rect' });
  return pads;
}
export const corrected = esp32({ top: -2.7, bottom: 7.1, side: 2.2, epad: 2.2 });
/**
 * Before the fix (reconstructed: the design kept only the corrected land): the rows 11.2 mm apart
 * instead of 9.8, the side columns and the EPAD left about the body centre. JLCPCB's footprint check
 * stopped the order; nothing in 4k7 had said so.
 */
export const wrong = esp32({ top: -4.9, bottom: 6.3, side: 0, epad: 0 });
