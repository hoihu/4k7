/**
 * A small Markdown renderer for the agent's chat replies: paragraphs, bullet and numbered lists,
 * headings, tables, **bold**, *italic*, `code`, fenced code blocks and [links](https://…). Everything is
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

/** The cells of one table row: split on `|` (not `\\|`), outer pipes optional. */
function cells(line: string): string[] {
  const t = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return t.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

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
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1]!.includes('-') && TABLE_RULE.test(lines[i + 1]!)) {
      const head = cells(line);
      const align = cells(lines[i + 1]!).map((c) => (c.startsWith(':') ? (c.endsWith(':') ? 'center' : 'left') : c.endsWith(':') ? 'right' : ''));
      if (head.length === align.length) {
        flushPara();
        flushList();
        const td = (tag: 'th' | 'td', row: string[]) =>
          row.map((c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c)}</${tag}>`).join('');
        const rows: string[] = [];
        for (i += 2; i < lines.length && lines[i]!.trim() && lines[i]!.includes('|'); i++) {
          const row = cells(lines[i]!);
          rows.push(`<tr>${td('td', align.map((_, k) => row[k] ?? ''))}</tr>`);
        }
        i--;
        html.push(`<table><thead><tr>${td('th', head)}</tr></thead><tbody>${rows.join('')}</tbody></table>`);
        continue;
      }
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
