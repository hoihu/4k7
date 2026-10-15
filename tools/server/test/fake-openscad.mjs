#!/usr/bin/env node
// Stand-in for OpenSCAD in tests: --version, and a render that writes an STL and a summary. A file
// containing "EMPTY" renders nothing, "SYNTAX" fails with a parser error, "SLEEP" never finishes.
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stderr.write('OpenSCAD version 2025.11.24\n');
  process.exit(0);
}
const out = args[args.indexOf('-o') + 1];
const summary = args[args.indexOf('--summary-file') + 1];
const file = args[args.length - 1];
const code = readFileSync(file, 'utf8');
if (code.includes('SLEEP')) setInterval(() => {}, 1000);
else if (code.includes('SYNTAX')) {
  process.stderr.write(`ERROR: Parser error in file "${file}", line 2: syntax error\n`);
  process.exit(1);
} else if (code.includes('EMPTY')) {
  process.stderr.write('WARNING: Object may not be a valid 2-manifold\nCurrent top level object is empty.\n');
  process.exit(1);
} else {
  // a binary STL with one triangle
  const buf = Buffer.alloc(84 + 50);
  buf.writeUInt32LE(1, 80);
  [0, 0, 1, 0, 0, 0, 10, 0, 0, 0, 10, 0].forEach((v, i) => buf.writeFloatLE(v, 84 + i * 4));
  writeFileSync(out, buf);
  writeFileSync(summary, JSON.stringify({ geometry: { bounding_box: { min: [0, 0, 0], max: [10, 10, 0] } }, args }));
  process.stderr.write(`ECHO: ${args.includes('--backend=manifold') ? 'manifold' : 'cgal'}\n`);
}
