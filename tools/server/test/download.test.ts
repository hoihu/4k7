import { afterEach, describe, expect, it, vi } from 'vitest';
import { download, isPdf } from '../src/download.ts';

/** fetch answers with `body`; `finalUrl` is where the redirects ended. */
function serve(body: string | Uint8Array<ArrayBuffer>, init: { status?: number; statusText?: string; type?: string; finalUrl?: string } = {}) {
  vi.stubGlobal('fetch', async (url: string) => {
    const res = new Response(body, { status: init.status ?? 200, statusText: init.statusText ?? '', headers: init.type ? { 'content-type': init.type } : {} });
    Object.defineProperty(res, 'url', { value: init.finalUrl ?? url });
    return res;
  });
}

afterEach(() => vi.unstubAllGlobals());

const URL1 = 'https://cree-led.com/media/documents/XLampXPE2.pdf';

describe('datasheet download', () => {
  it('takes a PDF by its first bytes, whatever the content type says', async () => {
    serve(new TextEncoder().encode('%PDF-1.7\n...'), { type: 'application/octet-stream' });
    expect(isPdf(await download(URL1))).toBe(true);
  });

  it('accepts a few bytes before the PDF header', async () => {
    serve(new TextEncoder().encode('\r\n\r\n%PDF-1.4\n...'), { type: 'application/pdf' });
    expect((await download(URL1)).byteLength).toBeGreaterThan(0);
  });

  it('names the link, where it was redirected and the HTML page that came back instead of the PDF', async () => {
    serve('<!DOCTYPE html><html><head><title>XLamp XP-E2 LEDs | Cree LED</title></head><body>…</body></html>', {
      type: 'text/html; charset=utf-8',
      finalUrl: 'https://cree-led.com/products/xlamp-leds-discrete/xlamp-xp-e2',
    });
    const err = await download(URL1).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(URL1);
    expect((err as Error).message).toContain('redirected to https://cree-led.com/products/xlamp-leds-discrete/xlamp-xp-e2');
    expect((err as Error).message).toContain('an HTML page "XLamp XP-E2 LEDs | Cree LED" (text/html)');
    expect((err as Error).message).toContain('direct link');
  });

  it('names the link and the status of a failed download', async () => {
    serve('gone', { status: 404, statusText: 'Not Found' });
    const err = (await download(URL1).catch((e: Error) => e)) as Error;
    expect(err.message).toContain(`downloading ${URL1} failed: HTTP 404 Not Found`);
    expect(err.message).toContain('find the current datasheet link');
  });

  it('says what else came back', async () => {
    serve(new Uint8Array([1, 2, 3]), { type: 'image/png' });
    expect(((await download(URL1).catch((e: Error) => e)) as Error).message).toContain('3 bytes of image/png');
    serve('');
    expect(((await download(URL1).catch((e: Error) => e)) as Error).message).toContain('an empty response');
  });
});
