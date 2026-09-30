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
});
