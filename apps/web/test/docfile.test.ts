import { describe, expect, it } from 'vitest';
import { designDocFileName, standaloneHtml } from '../src/lib/docfile.ts';

describe('design document download', () => {
  it('names the file after the project, safe for any file system', () => {
    expect(designDocFileName('LED driver')).toBe('LED_driver-design.html');
    expect(designDocFileName('usb-c/pd: v2')).toBe('usb-c_pd_v2-design.html');
    expect(designDocFileName('untitled')).toBe('untitled-design.html');
    expect(designDocFileName('')).toBe('untitled-design.html');
    expect(designDocFileName('../..')).toBe('untitled-design.html');
  });

  it('puts the pictures in as images and drops placeholders without one', () => {
    const html = '<div class="hero"><canvas data-pic="iso"></canvas></div><figure><canvas data-pic="front"></canvas></figure><canvas id="x"></canvas>';
    expect(standaloneHtml(html, { iso: 'data:image/png;base64,AAA=' })).toBe(
      '<div class="hero"><img data-pic="iso" src="data:image/png;base64,AAA=" alt=""></div><figure></figure><canvas id="x"></canvas>',
    );
  });

  it('leaves a document without pictures as it is', () => {
    const html = '<!doctype html><html><body><svg></svg></body></html>';
    expect(standaloneHtml(html, {})).toBe(html);
  });
});
