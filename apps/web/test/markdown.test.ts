import { describe, expect, it } from 'vitest';
import { markdown } from '../src/lib/markdown.ts';

describe('chat markdown', () => {
  it('renders the agent reply: paragraphs, bullet lists, bold, code', () => {
    const reply = 'The board is now a tree.\n\n- **Holes:** moved to the `bottom` tier.\n- **Routing:** out of date.';
    expect(markdown(reply)).toBe('<p>The board is now a tree.</p><ul><li><strong>Holes:</strong> moved to the <code>bottom</code> tier.</li><li><strong>Routing:</strong> out of date.</li></ul>');
  });

  it('numbered lists, headings, italics and line breaks inside a paragraph', () => {
    expect(markdown('### Steps\n1. one *now*\n2. two\n\nline a\nline b')).toBe('<h5>Steps</h5><ol><li>one <em>now</em></li><li>two</li></ol><p>line a<br>line b</p>');
  });

  it('escapes HTML and only links to http(s)', () => {
    expect(markdown('<img src=x onerror=alert(1)> [ok](https://example.com) [bad](javascript:alert(1))')).toBe(
      '<p>&lt;img src=x onerror=alert(1)&gt; <a href="https://example.com" target="_blank" rel="noopener noreferrer">ok</a> [bad](javascript:alert(1))</p>',
    );
  });

  it('keeps code blocks verbatim (no markup inside)', () => {
    expect(markdown('```\na **b** <c>\n```')).toBe('<pre><code>a **b** &lt;c&gt;</code></pre>');
  });

  it('renders tables, with alignment, escaped pipes and a table right after a paragraph', () => {
    const md = 'Level shifter\n| LCSC | Part | Price |\n|---|:---|---:|\n| **C7484** | 74HC `a\\|b` | $0.104 |\n| C8545 | 2N7002 |\n\nafter';
    expect(markdown(md)).toBe(
      '<p>Level shifter</p><table><thead><tr><th>LCSC</th><th style="text-align:left">Part</th><th style="text-align:right">Price</th></tr></thead><tbody>' +
        '<tr><td><strong>C7484</strong></td><td style="text-align:left">74HC <code>a|b</code></td><td style="text-align:right">$0.104</td></tr>' +
        '<tr><td>C8545</td><td style="text-align:left">2N7002</td><td style="text-align:right"></td></tr></tbody></table><p>after</p>',
    );
  });

  it('leaves a lone pipe line without a delimiter row as text', () => {
    expect(markdown('a | b\nc | d')).toBe('<p>a | b<br>c | d</p>');
  });
});
