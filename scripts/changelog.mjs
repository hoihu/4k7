// CHANGELOG.md is where the releases are written up; this puts them on the site and in the GitHub release.
//   node scripts/changelog.mjs              writes the releases into site/changelog.html (between its markers)
//   node scripts/changelog.mjs --check      fails when site/changelog.html is behind CHANGELOG.md, or when
//                                           CHANGELOG.md has no section for package.json's version (run by CI)
//   node scripts/changelog.mjs notes 0.2.0  prints that release's notes, for `gh release create --notes-file`
// Changes not yet released go under `## Unreleased` at the top; it is left out of the page and the notes.
// A release is `## 0.2.0 — 2026-10-25`, then paragraphs, `### ` headings and `- ` lists with **bold**, *italics*,
// `code` and [links](https://…). The site stays plain HTML: the page is written here and committed.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const PAGE = `${root}site/changelog.html`;
const START = '<!-- releases: written by scripts/changelog.mjs from CHANGELOG.md, do not edit -->';
const END = '<!-- /releases -->';
const RELEASE_URL = 'https://github.com/hoihu/4k7/releases/tag/v';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const fail = (msg) => {
  console.error(`changelog: ${msg}`);
  process.exit(1);
};

/** The releases in CHANGELOG.md, newest first: version, date and the Markdown under the heading. */
function releases(md) {
  const out = [];
  let unreleased = false;
  for (const line of md.split('\n')) {
    if (/^## Unreleased\s*$/.test(line)) {
      if (out.length) fail('"## Unreleased" goes above the releases');
      unreleased = true;
      continue;
    }
    const m = /^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?) [—-] (\d{4}-\d{2}-\d{2})\s*$/.exec(line);
    if (m) {
      out.push({ version: m[1], date: m[2], lines: [] });
      unreleased = false;
    }
    else if (line.startsWith('## ')) fail(`a release heading is "## <version> — <yyyy-mm-dd>", not "${line}"`);
    else if (!unreleased) out.at(-1)?.lines.push(line);
  }
  for (let i = 1; i < out.length; i++) {
    if (compareVersions(out[i - 1].version, out[i].version) <= 0) fail(`${out[i - 1].version} comes before ${out[i].version}: newest first`);
  }
  return out.map(({ lines, ...r }) => ({ ...r, body: lines.join('\n').trim() }));
}

/** Numeric dotted versions; a pre-release (0.2.0-beta.1) is older than its release (as in tools/server/src/update.ts). */
function compareVersions(a, b) {
  const parse = (v) => {
    const [main, pre = null] = v.split(/-(.*)/s, 2);
    return { nums: main.split('.').map(Number), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One line of Markdown as HTML: code spans and link addresses as they are, then curly quotes, links, bold and italics. */
function inline(text) {
  const kept = [];
  const keep = (html) => `\u0000${kept.push(html) - 1}\u0000`;
  let s = text.replace(/`([^`]+)`/g, (_, c) => keep(`<code>${escape(c)}</code>`));
  s = s.replace(/\]\(([^)\s]+)\)/g, (_, href) => `](${keep(escape(href).replace(/"/g, '%22'))})`);
  s = escape(s).replace(/"([^"]*)"/g, '“$1”').replace(/(\w)'/g, '$1’').replace(/'/g, '‘');
  s = s.replace(/\[([^\]]+)\]\((\u0000\d+\u0000)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^\w*])\*(?=\S)(.+?)\*(?![\w*])/g, '$1<i>$2</i>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]);
}

/** A release's Markdown as HTML lines: paragraphs, `### ` headings, `- ` lists (an item goes on over indented lines). */
function blocks(md) {
  const out = [];
  let para = null;
  let list = null;
  const flush = () => {
    if (para) out.push(`<p>${inline(para.join(' '))}</p>`);
    if (list) out.push('<ul>', ...list.map((item) => `  <li>${inline(item)}</li>`), '</ul>');
    para = list = null;
  };
  for (const line of md.split('\n')) {
    if (!line.trim()) flush();
    else if (line.startsWith('### ')) {
      flush();
      out.push(`<h3>${inline(line.slice(4).trim())}</h3>`);
    } else if (/^[-*] /.test(line)) {
      if (para) flush();
      (list ??= []).push(line.slice(2).trim());
    } else if (list && /^\s/.test(line)) list[list.length - 1] += ` ${line.trim()}`;
    else {
      if (list) flush();
      (para ??= []).push(line.trim());
    }
  }
  flush();
  return out;
}

function releaseHtml({ version, date, body }) {
  const [y, m, d] = date.split('-').map(Number);
  const id = `v${version}`;
  return [
    `<article class="release" id="${id}">`,
    '  <header>',
    `    <h2><a href="#${id}">${version}</a></h2>`,
    `    <time datetime="${date}">${d} ${MONTHS[m - 1]} ${y}</time>`,
    `    <a class="gh" href="${RELEASE_URL}${version}">Release on GitHub</a>`,
    '  </header>',
    '  <div class="notes">',
    ...blocks(body).map((l) => `    ${l}`),
    '  </div>',
    '</article>',
  ];
}

/** The page with the releases written between its markers, indented like the start marker. */
function render(page, list) {
  const i = page.indexOf(START);
  const j = page.indexOf(END);
  if (i < 0 || j < i) fail(`site/changelog.html has lost its markers (${START} … ${END})`);
  const indent = page.slice(page.lastIndexOf('\n', i) + 1, i);
  const html = list.flatMap(releaseHtml).map((l) => `${indent}${l}`);
  return `${page.slice(0, i + START.length)}\n${html.join('\n')}\n${indent}${page.slice(j)}`;
}

const list = releases(readFileSync(`${root}CHANGELOG.md`, 'utf8'));
const [cmd, arg] = process.argv.slice(2);
if (cmd === 'notes') {
  const release = list.find((r) => r.version === arg?.replace(/^v/, ''));
  if (!release?.body) fail(`CHANGELOG.md has no notes for ${arg ?? '(no version given)'}`);
  process.stdout.write(`${release.body}\n`);
} else if (cmd === '--check') {
  const { version } = JSON.parse(readFileSync(`${root}package.json`, 'utf8'));
  if (!version.includes('-') && !list.some((r) => r.version === version)) fail(`CHANGELOG.md has no section for ${version}, the version in package.json`);
  const page = readFileSync(PAGE, 'utf8');
  if (render(page, list) !== page) fail('site/changelog.html is behind CHANGELOG.md: run node scripts/changelog.mjs');
  console.log(`changelog: ${list.length} releases, site/changelog.html up to date`);
} else if (cmd === undefined) {
  writeFileSync(PAGE, render(readFileSync(PAGE, 'utf8'), list));
  console.log(`changelog: ${list.length} releases written to site/changelog.html`);
} else fail(`unknown command ${cmd} (none, --check or notes <version>)`);
