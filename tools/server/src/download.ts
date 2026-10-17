/** Downloading datasheets, for an import and for reading the datasheet of a part that only has its link. */

export const MAX_PDF_BYTES = 24 * 1024 * 1024;

/** Download a datasheet (manufacturers often refuse requests without a browser-like agent). */
export async function download(url: string): Promise<Uint8Array> {
  if (!/^https?:\/\//i.test(url)) throw new Error('only http(s) links can be downloaded');
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) 4k7', Accept: 'application/pdf,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_PDF_BYTES) throw new Error(`the PDF is larger than ${MAX_PDF_BYTES >> 20} MB`);
  return new Uint8Array(await res.arrayBuffer());
}

export const isPdf = (data: Uint8Array) => Buffer.from(data.subarray(0, 5)).toString('latin1') === '%PDF-';

/** The file name a link points at ("tps54331.pdf"). */
export function pdfName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || 'datasheet.pdf';
  } catch {
    return 'datasheet.pdf';
  }
}
