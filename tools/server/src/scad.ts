/**
 * OpenSCAD on this computer, for the enclosure (docs/design/enclosure.md §5.1): the app sends the
 * board as a library (board.scad), the agent's script and the runs to make (each piece, each
 * check), the server runs the user's OpenSCAD on them in a scratch folder and answers with the
 * meshes and what OpenSCAD said. The GPL program is never shipped with the app; the user installs it.
 *
 * The program is, in this order, FOURK7_OPENSCAD_BIN, the path chosen in the app ("openscadBin" in
 * server.json), `openscad` on the PATH, or where the installers put it.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { cpus, homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { ScadJob, ScadRunResult, ScadStatus } from '@4k7/schema';
import { findBin, isExecutable } from './claude-bin.ts';
import { expandHome, saveConfig } from './config.ts';

export const OPENSCAD_ENV = 'FOURK7_OPENSCAD_BIN';

/** Where the installers put OpenSCAD (the release and the nightly build). */
export function openscadCandidates(home = homedir()): string[] {
  if (process.platform === 'darwin') {
    return ['OpenSCAD.app', 'OpenSCAD-nightly.app', 'OpenSCAD (Nightly).app'].flatMap((app) => [join('/Applications', app, 'Contents/MacOS/OpenSCAD'), join(home, 'Applications', app, 'Contents/MacOS/OpenSCAD')]);
  }
  if (process.platform === 'win32') return ['C:\\Program Files\\OpenSCAD\\openscad.exe', 'C:\\Program Files\\OpenSCAD (Nightly)\\openscad.exe'];
  return ['/usr/bin/openscad', '/usr/local/bin/openscad', '/snap/bin/openscad', join(home, '.local/bin/openscad'), '/usr/bin/openscad-nightly'];
}

/** A file name the app may send: letters, digits, - and _, ending in .scad. */
const FILE = /^[A-Za-z0-9_-]{1,64}\.scad$/;
/** Longest a single run may take. */
const RUN_MS = 60_000;
/** Most runs in one job. */
const MAX_RUNS = 64;
const MAX_SOURCE = 4 * 1024 * 1024;

/** What is wrong with the code OpenSCAD is given (empty: nothing): it may include only the job's own files and read nothing else. */
export function sourceProblems(code: string, files: string[]): string[] {
  const out: string[] = [];
  const bare = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const m of bare.matchAll(/\b(include|use)\s*<\s*([^>]*)>/g)) if (!files.includes(m[2]!.trim())) out.push(`${m[1]} <${m[2]}> is not one of this job's files`);
  if (/\b(import|surface)\s*\(/.test(bare)) out.push('import() and surface() read files');
  return out;
}

export interface OpenScadOptions {
  /** The path chosen in the app (server.json "openscadBin"). */
  bin?: string;
  /** Save the chosen path (default: into server.json). */
  save?: (bin: string | null) => void;
  log?: (msg: string) => void;
  /** Runs at once (default: half the cores, 2 to 6). */
  parallel?: number;
}

export class OpenScad {
  #opts: OpenScadOptions;
  #chosen: string | null;
  #status: ScadStatus | null = null;

  constructor(opts: OpenScadOptions = {}) {
    this.#opts = opts;
    this.#chosen = opts.bin ? expandHome(opts.bin) : null;
  }

  /** The program to run: the variable, the app's choice, the PATH, the usual places. */
  #find(): { path: string | null; from: ScadStatus['from'] } {
    const env = process.env[OPENSCAD_ENV];
    if (env) return { path: isExecutable(env) ? env : null, from: 'env' };
    if (this.#chosen) return { path: isExecutable(this.#chosen) ? this.#chosen : null, from: 'settings' };
    const onPath = findBin('openscad');
    if (onPath) return { path: onPath, from: 'auto' };
    return { path: openscadCandidates().find(isExecutable) ?? null, from: 'auto' };
  }

  /** Look for OpenSCAD (again) and ask it for its version. */
  detect(): ScadStatus {
    const { path, from } = this.#find();
    if (!path) {
      this.#status = { available: false, from, env: OPENSCAD_ENV, reason: from === 'auto' ? 'OpenSCAD is not installed (or not where it is usually put).' : `${from === 'env' ? OPENSCAD_ENV : 'The chosen path'} is not a program this user can run.` };
      return this.#status;
    }
    const r = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 15_000 });
    const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const version = /OpenSCAD version\s+(\S+)/i.exec(text)?.[1];
    if (r.error || !version) {
      this.#status = { available: false, path, from, env: OPENSCAD_ENV, reason: `${path} did not answer --version like OpenSCAD.` };
      return this.#status;
    }
    // the Manifold geometry engine (seconds instead of minutes) came with the 2024/2025 snapshots
    const year = Number(version.slice(0, 4));
    const manifold = year >= 2025 || (year === 2024 && /--backend/.test(spawnSync(path, ['--help'], { encoding: 'utf8', timeout: 15_000 }).stderr ?? ''));
    this.#status = { available: true, path, from, env: OPENSCAD_ENV, version, manifold, ...(manifold ? {} : { reason: `OpenSCAD ${version} renders slowly (no Manifold engine): 2025 or later is much faster.` }) };
    this.#opts.log?.(`OpenSCAD ${version} at ${path}${manifold ? '' : ' (without Manifold: slow)'}`);
    return this.#status;
  }

  get status(): ScadStatus {
    return this.#status ?? this.detect();
  }

  /** Run `bin` (an absolute path) from now on, or look for it again (null). Saved only when it works. */
  setBin(bin: string | null): { ok: true; status: ScadStatus } | { ok: false; error: string } {
    if (process.env[OPENSCAD_ENV]) return { ok: false, error: `${OPENSCAD_ENV} is set when the server starts; it decides the program.` };
    const path = bin === null ? null : expandHome(bin.trim()) || null;
    if (path && !isAbsolute(path)) return { ok: false, error: 'Give the full path, e.g. /Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD.' };
    const before = this.#chosen;
    this.#chosen = path;
    const status = this.detect();
    if (path && !status.available) {
      this.#chosen = before;
      this.detect();
      return { ok: false, error: status.reason ?? `${path} is not OpenSCAD.` };
    }
    (this.#opts.save ?? ((b) => saveConfig({ openscadBin: b ?? undefined })))(path);
    return { ok: true, status };
  }

  /** Run a job: write its files to a scratch folder, run OpenSCAD once per run (a few at a time), answer what each made. */
  async render(job: ScadJob): Promise<ScadRunResult[]> {
    const st = this.status;
    if (!st.available || !st.path) throw Object.assign(new Error(st.reason ?? 'OpenSCAD is not available.'), { status: 409 });
    const names = Object.keys(job.files);
    for (const n of names) if (!FILE.test(n)) throw Object.assign(new Error(`bad file name ${n}`), { status: 400 });
    if (!Array.isArray(job.runs) || !job.runs.length || job.runs.length > MAX_RUNS) throw Object.assign(new Error(`1 to ${MAX_RUNS} runs`), { status: 400 });
    const size = [...Object.values(job.files), ...job.runs.map((r) => r.code)].reduce((s, c) => s + String(c).length, 0);
    if (size > MAX_SOURCE) throw Object.assign(new Error('too large'), { status: 413 });
    for (const [n, code] of [...Object.entries(job.files), ...job.runs.map((r) => [r.id, r.code] as const)]) {
      const p = sourceProblems(String(code), names);
      if (p.length) throw Object.assign(new Error(`${n}: ${p.join('; ')}`), { status: 400 });
    }
    const dir = mkdtempSync(join(tmpdir(), '4k7-scad-'));
    try {
      for (const [n, code] of Object.entries(job.files)) writeFileSync(join(dir, n), String(code));
      const parallel = this.#opts.parallel ?? Math.min(6, Math.max(2, Math.floor(cpus().length / 2)));
      const results: ScadRunResult[] = new Array(job.runs.length);
      let next = 0;
      const worker = async () => {
        while (next < job.runs.length) {
          const i = next++;
          results[i] = await this.#run(st.path!, !!st.manifold, dir, i, job.runs[i]!);
        }
      };
      await Promise.all(Array.from({ length: Math.min(parallel, job.runs.length) }, worker));
      return results;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  #run(bin: string, manifold: boolean, dir: string, i: number, run: ScadJob['runs'][number]): Promise<ScadRunResult> {
    const file = join(dir, `run-${i}.scad`);
    const stl = join(dir, `run-${i}.stl`);
    const summary = join(dir, `run-${i}.json`);
    writeFileSync(file, run.code);
    const args = [...(manifold ? ['--backend=manifold'] : []), '-o', stl, '--export-format', 'binstl', '--summary', 'all', '--summary-file', summary, file];
    const t0 = Date.now();
    return new Promise((resolve) => {
      const child = spawn(bin, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (out += c.toString('utf8')));
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, RUN_MS);
      const done = (code: number | null, err?: Error) => {
        clearTimeout(timer);
        const ms = Date.now() - t0;
        const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
        const empty = lines.some((l) => /top level object is empty/i.test(l));
        const errors = lines.filter((l) => /^(ERROR|TRACE):/.test(l)).map((l) => l.replaceAll(dir + '/', '').replaceAll(dir, '.'));
        const warnings = lines.filter((l) => /^WARNING:/.test(l) && !/top level object is empty/i.test(l)).map((l) => l.replaceAll(dir + '/', ''));
        let bbox: ScadRunResult['bbox'];
        try {
          const s = JSON.parse(readFileSync(summary, 'utf8')) as { geometry?: { bounding_box?: { min: number[]; max: number[] } } };
          const b = s.geometry?.bounding_box;
          if (b) bbox = { min: b.min as [number, number, number], max: b.max as [number, number, number] };
        } catch {
          // no geometry (empty or failed)
        }
        const ok = !timedOut && !err && (code === 0 || (empty && !errors.length));
        resolve({
          id: run.id,
          ok,
          empty,
          ms,
          ...(bbox ? { bbox } : {}),
          ...(run.mesh && code === 0 && existsSync(stl) ? { stl: readFileSync(stl).toString('base64') } : {}),
          ...(errors.length ? { errors } : {}),
          ...(warnings.length ? { warnings: warnings.slice(0, 20) } : {}),
          ...(timedOut ? { errors: [`stopped after ${RUN_MS / 1000} s`] } : err ? { errors: [err.message] } : !ok && !errors.length ? { errors: lines.slice(-5) } : {}),
        });
      };
      child.on('error', (e) => done(null, e));
      child.on('close', (code) => done(code));
    });
  }
}
