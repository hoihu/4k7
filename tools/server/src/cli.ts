#!/usr/bin/env node
/**
 * `tracewise`, the packaged entry (bundled to dist/tracewise.js; see scripts/package.mjs):
 *   tracewise              serve the app on http://localhost:7777, chat via the local Claude Code, open the browser
 *   tracewise --no-open    the same without opening the browser
 *   tracewise app          what the downloaded app does when opened: open the app, starting the server in the
 *                          background if none runs; it stops when the tab is closed (see launch.ts)
 *   tracewise mcp          MCP server over stdio, for: claude mcp add --scope user tracewise -- tracewise mcp
 */
import { VERSION } from './mcp.ts';

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h') || args.some((a) => !['mcp', 'app', '--no-open', '--idle-exit'].includes(a))) {
  process.stdout.write(
    'Usage:\n' +
      '  tracewise              run the app at http://localhost:7777 (chat answered by your Claude Code) and open it\n' +
      '  tracewise --no-open    the same, without opening the browser\n' +
      '  tracewise --idle-exit  stop by itself once no tab has been connected for a while\n' +
      '  tracewise app          open the app, starting the server in the background when none runs (the downloaded app)\n' +
      '  tracewise mcp          MCP server for the Claude Code CLI:\n' +
      '                           claude mcp add --scope user tracewise -- tracewise mcp\n',
  );
  process.exit(args.includes('--help') || args.includes('-h') ? 0 : 1);
}
if (args.includes('app')) {
  const { launchApp } = await import('./launch.ts');
  await launchApp();
} else {
  process.argv = [process.argv[0]!, process.argv[1]!, ...(args.includes('mcp') ? [] : ['--serve', ...(args.includes('--no-open') ? [] : ['--open']), ...(args.includes('--idle-exit') ? ['--idle-exit'] : [])])];
  await import('./main.ts');
}
