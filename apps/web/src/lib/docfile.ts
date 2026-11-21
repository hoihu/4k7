/**
 * The design document as a file to download: the same HTML that is printed, made to stand on its
 * own. The printed document draws its 3D pictures into canvases once it is loaded; a file has no
 * one to draw them, so they go in as images.
 */

/** The file name for the downloaded design document: `<project>-design.html`, safe on every system. */
export function designDocFileName(name: string): string {
  const base = name
    .trim()
    .replace(/[^\w.-]+/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '');
  return `${base || 'untitled'}-design.html`;
}

/** The document with each `<canvas data-pic="v">` placeholder replaced by an image of picture `v` (a data URL); placeholders without a picture are left out. */
export function standaloneHtml(html: string, pictures: Record<string, string>): string {
  return html.replace(/<canvas data-pic="([\w-]+)"><\/canvas>/g, (_, v: string) => {
    const src = pictures[v];
    return src ? `<img data-pic="${v}" src="${src.replace(/"/g, '&quot;')}" alt="">` : '';
  });
}
