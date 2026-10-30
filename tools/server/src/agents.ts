/**
 * The coding agents' CLIs on this computer (Claude Code, Copilot, OpenCode): which program each one
 * runs, whether it works, and the models it offers. The program is, in this order, the
 * FOURK7_…_BIN environment variable, the path chosen in the app (kept in server.json), or the name
 * looked up on the PATH. The app can set a path and ask for a new look (after installing an agent).
 */
import { isAbsolute } from 'node:path';
import type { HarnessCapability, HarnessId } from '@4k7/schema';
import { extendPathFor, findBin, isExecutable } from './claude-bin.ts';
import { expandHome, saveConfig } from './config.ts';
import type { Harness } from './harness/types.ts';

/** Each agent's program name on the PATH, and the variable that overrides it. */
export const AGENT_BINS: Record<HarnessId, { name: string; env: string }> = {
  'claude-code': { name: 'claude', env: 'FOURK7_CLAUDE_BIN' },
  copilot: { name: 'copilot', env: 'FOURK7_COPILOT_BIN' },
  opencode: { name: 'opencode', env: 'FOURK7_OPENCODE_BIN' },
};

export interface AgentsOptions {
  /** Every agent, with `bin` as it should start (see `binFor`). */
  harnesses: Harness[];
  /** The paths chosen in the app (server.json "bins"). */
  bins: Partial<Record<HarnessId, string>>;
  /** Save the chosen paths (default: into server.json). */
  save?: (bins: Partial<Record<HarnessId, string>>) => void;
  /** Look for missing CLIs where installers put them and on the login shell's PATH (off in tests). */
  extendPath?: boolean;
  /** The details changed (detected again, a model list arrived). */
  onChange?: (caps: HarnessCapability[]) => void;
  log?: (msg: string) => void;
}

/** The program an agent starts with: the variable, else the app's path, else its name on the PATH. */
export function binFor(id: HarnessId, bins: Partial<Record<HarnessId, string>>, env = process.env): string {
  return env[AGENT_BINS[id].env] || bins[id] || AGENT_BINS[id].name;
}

export class Agents {
  #opts: AgentsOptions;
  #bins: Partial<Record<HarnessId, string>>;
  #caps: HarnessCapability[] = [];
  /** Bumped on every detection, so a model list of an older one is dropped. */
  #round = 0;

  constructor(opts: AgentsOptions) {
    this.#opts = opts;
    this.#bins = { ...opts.bins };
  }

  get caps(): HarnessCapability[] {
    return this.#caps;
  }

  #from(id: HarnessId): HarnessCapability['binFrom'] {
    return process.env[AGENT_BINS[id].env] ? 'env' : this.#bins[id] ? 'settings' : 'auto';
  }

  #detectAll(): HarnessCapability[] {
    return this.#opts.harnesses.map((h) => {
      const path = findBin(h.bin);
      return { ...h.detect(), bin: h.bin, ...(path ? { path } : {}), binFrom: this.#from(h.id), binEnv: AGENT_BINS[h.id].env };
    });
  }

  /** Check every agent's CLI (blocks while each prints its version), then fetch the model lists in the background. */
  detect(): HarnessCapability[] {
    let caps = this.#detectAll();
    const missing = caps.filter((c) => !c.available && c.binFrom === 'auto').map((c) => c.id);
    if (missing.length && this.#opts.extendPath !== false) {
      // started from the Finder or a launcher: look where installers put them, then where the user's shell does
      const added = extendPathFor(() => this.#opts.harnesses.some((h) => missing.includes(h.id) && h.detect().available));
      if (added) {
        caps = this.#detectAll();
        this.#opts.log?.(`agent CLIs found after adding to PATH: ${added.join(', ')}`);
      }
    }
    this.#caps = caps;
    void this.#models(++this.#round);
    return caps;
  }

  /** Model lists can take a while (OpenCode asks its providers): they are passed on when they are in. */
  async #models(round: number) {
    await Promise.all(
      this.#opts.harnesses.map(async (h) => {
        if (!h.models || !this.#caps.find((c) => c.id === h.id)?.available) return;
        const models = await h.models();
        if (round !== this.#round || !models.length) return;
        this.#caps = this.#caps.map((c) => (c.id === h.id ? { ...c, models } : c));
        this.#opts.onChange?.(this.#caps);
      }),
    );
  }

  /**
   * Run `bin` (an absolute path) for an agent from now on, or its name on the PATH again (null). The
   * program must exist and print its version; only then is it saved. Returns why not otherwise.
   */
  setBin(id: HarnessId, bin: string | null): { ok: true } | { ok: false; error: string } {
    const h = this.#opts.harnesses.find((x) => x.id === id);
    if (!h) return { ok: false, error: `Unknown agent "${id}".` };
    const env = AGENT_BINS[id].env;
    if (process.env[env]) return { ok: false, error: `${env} is set when the server starts; it decides the program. Remove it to choose here.` };
    const path = bin === null ? '' : expandHome(bin.trim());
    if (path) {
      if (!isAbsolute(path)) {
        const example = process.platform === 'win32' ? `C:\\Users\\you\\AppData\\Roaming\\npm\\${AGENT_BINS[id].name}.cmd` : `/opt/homebrew/bin/${AGENT_BINS[id].name}`;
        return { ok: false, error: `Give the full path, e.g. ${example}.` };
      }
      if (!isExecutable(path)) return { ok: false, error: `${path} is not a program this user can run.` };
      const before = h.bin;
      h.bin = path;
      const cap = h.detect();
      if (!cap.available) {
        h.bin = before;
        return { ok: false, error: `${path} did not answer --version like ${h.name}.` };
      }
    }
    const bins = { ...this.#bins };
    if (path) bins[id] = path;
    else delete bins[id];
    this.#bins = bins;
    h.bin = binFor(id, bins);
    (this.#opts.save ?? ((b) => saveConfig({ bins: b })))(bins);
    this.#opts.log?.(`${h.name}: ${path ? `runs ${path}` : `looks for "${h.bin}" on the PATH`} (set in the app)`);
    this.detect();
    this.#opts.onChange?.(this.#caps);
    return { ok: true };
  }
}
