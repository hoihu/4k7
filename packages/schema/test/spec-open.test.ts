import { describe, expect, it } from 'vitest';
import { specRefusal, type SpecAnswer, type SpecStatus } from '../src/index.ts';

// The spec_open gate on propose: a violated item is fixed, waived or named in spec_open (docs/design/spec.md §5).

const spec = (...items: [id: string, text: string, status: SpecStatus, assumed?: boolean][]): SpecAnswer => ({
  counts: { verified: 0, violated: 0, unverified: 0, waived: 0, assumed: 0 },
  items: items.map(([id, text, status, assumed]) => ({ id, text, status, assumed: !!assumed, source: { type: 'user', quote: text }, verify: [] })),
});

describe('specRefusal', () => {
  const usb = spec(['S1', 'A USB-C input', 'violated'], ['S2', 'two layers', 'verified']);

  it('refuses a violated item without spec_open, listing it by id and text', () => {
    const r = specRefusal(usb, undefined);
    expect(r).not.toBeNull();
    expect(r!.count).toBe(1);
    expect(r!.text).toMatch(/^Refused: 1 spec item\(s\) violated/);
    expect(r!.text).toContain('- S1 "A USB-C input"');
    expect(r!.text).not.toContain('S2');
    expect(r!.text).toContain('spec_open');
  });

  it('refuses a blank spec_open', () => {
    expect(specRefusal(usb, '  \n')).not.toBeNull();
    expect(specRefusal(usb, '')).not.toBeNull();
  });

  it('allows a violated item named in spec_open', () => {
    expect(specRefusal(usb, 'S1: the USB-C connector comes in the next step of the plan')).toBeNull();
  });

  it('allows a waived item, no spec, and items only unverified or assumed', () => {
    expect(specRefusal(spec(['S1', 'A USB-C input', 'waived']), undefined)).toBeNull();
    expect(specRefusal(null, undefined)).toBeNull();
    expect(specRefusal(undefined, undefined)).toBeNull();
    expect(specRefusal(spec(['S1', 'low ripple', 'unverified'], ['S2', '5 V input', 'verified', true], ['S3', '3.3 V rail', 'unverified', true]), undefined)).toBeNull();
  });
});
