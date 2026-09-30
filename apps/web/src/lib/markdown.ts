/**
 * A small Markdown renderer for the agent's chat replies: paragraphs, bullet and numbered lists,
 * headings, **bold**, *italic*, `code`, fenced code blocks and [links](https://…). Everything is
 * HTML-escaped first; only these tags are added, and links only to http(s) addresses.
 */

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Inline markup on one (escaped) line. */
function inline(s: string): string {
  const codes: string[] = [];
  // code spans first, kept out of the other rules
  let out = s.replace(/`([^`]+)`/g, (_, c: string) => `\u0000${codes.push(c) - 1}\u0000`);
  out = out
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${codes[Number(i)]}</code>`);
}

export function markdown(src: string): string {
  const lines = escape(src.replace(/\r\n?/g, '\n')).split('\n');
  const html: string[] = [];
  let para: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  const flushPara = () => {
    if (para.length) html.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) html.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      flushPara();
      flushList();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) code.push(lines[i]!);
      html.push(`<pre><code>${code.join('\n')}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (heading) {
      flushPara();
      flushList();
      html.push(`<h5>${inline(heading[2]!)}</h5>`);
    } else if (bullet || numbered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push((bullet ?? numbered)![1]!);
    } else if (list && /^\s{2,}\S/.test(line)) {
      // a continuation of the last list item
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return html.join('');
}
