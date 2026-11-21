/** Downloading datasheets, for an import and for reading the datasheet of a part that only has its link. */

export const MAX_PDF_BYTES = 24 * 1024 * 1024;

/**
 * Download a datasheet (manufacturers often refuse requests without a browser-like agent). Redirects are
 * followed; what comes back must be a PDF by its first bytes (servers send PDFs as octet-stream, and pages as
 * PDFs), else the error says which link it was and what came back instead (an HTML page and its title).
 */
export async function download(url: string): Promise<Uint8Array> {
  if (!/^https?:\/\//i.test(url)) throw new Error('only http(s) links can be downloaded');
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) 4k7', Accept: 'application/pdf,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
  });
  const via = res.url && res.url !== url ? ` (redirected to ${res.url})` : '';
  if (!res.ok) throw new Error(`downloading ${url}${via} failed: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}${res.status === 404 ? '; the link is wrong or out of date, find the current datasheet link' : ''}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_PDF_BYTES) throw new Error(`the PDF is larger than ${MAX_PDF_BYTES >> 20} MB`);
  const data = new Uint8Array(await res.arrayBuffer());
  if (!isPdf(data)) throw Object.assign(new Error(`${url}${via} is not a PDF: the server sent ${whatCame(data, res.headers.get('content-type'))}. Give the direct link to the datasheet PDF.`), { status: 422 });
  return data;
}

/** A PDF by its header, which readers accept within the first 1024 bytes (some servers send a few bytes before it). */
export const isPdf = (data: Uint8Array) => Buffer.from(data.subarray(0, 1024)).toString('latin1').includes('%PDF-');

/** What a download that is not a PDF is, for the error: "an HTML page "Access denied" (text/html)". */
function whatCame(data: Uint8Array, type: string | null): string {
  const head = Buffer.from(data.subarray(0, 4096)).toString('utf8');
  const kind = type?.split(';')[0]?.trim() || 'no content type';
  if (!data.byteLength) return `an empty response (${kind})`;
  if (/<html|<!doctype html/i.test(head)) {
    const title = /<title[^>]*>([^<]*)/i.exec(head)?.[1]?.replace(/\s+/g, ' ').trim().slice(0, 80);
    return `an HTML page${title ? ` "${title}"` : ''} (${kind}), not the file: a page about the part, a login or a bot check`;
  }
  return `${data.byteLength} bytes of ${kind}`;
}

/** The file name a link points at ("tps54331.pdf"). */
export function pdfName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || 'datasheet.pdf';
  } catch {
    return 'datasheet.pdf';
  }
}
