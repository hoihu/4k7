/**
 * `4k7pcb app`: what the downloaded app runs when it is opened. Opens the app in the browser,
 * starting the server first when none is running, and returns at once: the server keeps going on
 * its own (detached, logging to ~/.4k7/server.log) and stops when the tab is closed
 * (--idle-exit). Opening the app again while it runs just opens the tab again, so it can be
 * launched any number of times.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { SERVER_PORTS } from '@4k7/schema';
import { serves4k7 } from './app.ts';
import { configDir, loadConfig } from './config.ts';

export interface LaunchOptions {
  log?: (msg: string) => void;
  /** The CLI to start the server with (default: this one). */
  script?: string;
  /** Ports to look for a running server on (default: all of them). */
  ports?: readonly number[];
}

export async function launchApp(opts: LaunchOptions = {}): Promise<void> {
  const log = opts.log ?? ((m: string) => process.stderr.write(`[4k7] ${m}\n`));
  const cfg = loadConfig();
  for (const port of opts.ports ?? SERVER_PORTS) {
    if (await serves4k7(port)) {
      const url = `http://localhost:${port}/${cfg.accessKey}`;
      log(`server already running; opening ${url}`);
      openBrowser(url, log);
      return;
    }
  }
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const logFile = openSync(join(configDir(), 'server.log'), 'a', 0o600);
  // the CLI's default command (serve and open the app), stopping by itself; its output goes to the log
  const child = spawn(process.execPath, [opts.script ?? process.argv[1]!, '--idle-exit'], { detached: true, stdio: ['ignore', 'ignore', logFile], env: process.env });
  child.on('error', (e) => log(`could not start the server: ${e.message}`));
  child.unref();
  log(`server started (pid ${child.pid}); it opens the app and stops when the tab is closed`);
}

export function openBrowser(url: string, log: (msg: string) => void) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => log(`could not open a browser; open ${url}`)).unref();
  } catch {
    log(`could not open a browser; open ${url}`);
  }
}
