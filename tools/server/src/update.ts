/**
 * Update check for the downloaded app (the DMG and the other archives do not update themselves the
 * way `npx` re-resolved the latest version on every run). Asks GitHub for the latest release at most
 * once a day, remembers the answer in ~/.4k7/update.json, and tells the tab when it is newer.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { UpdateInfo } from '@4k7/schema';

/** Where the latest release is published. */
export const RELEASES_API = 'https://api.github.com/repos/hoihu/4k7/releases/latest';
/** Where the banner sends people: the download section of the site. */
export const DOWNLOAD_URL = 'https://4k7.dev/#download';

const DAY_MS = 24 * 60 * 60 * 1000;

interface Cache {
  checkedAt: number;
  latest: string;
}

/**
 * The newer release if there is one. Never throws: a network failure means "no update" (and is
 * retried the next day). `fetchLatest` and `now` are for tests.
 */
export async function checkForUpdate(
  current: string,
  cacheFile: string,
  opts: { fetchLatest?: () => Promise<string | null>; now?: () => number; log?: (msg: string) => void } = {},
): Promise<UpdateInfo | null> {
  const now = opts.now ?? Date.now;
  let cache: Cache | null = null;
  try {
    cache = JSON.parse(readFileSync(cacheFile, 'utf8')) as Cache;
  } catch {
    // first check
  }
  let latest = cache && now() - cache.checkedAt < DAY_MS ? cache.latest : null;
  if (!latest) {
    latest = await (opts.fetchLatest ?? latestRelease)().catch(() => null);
    if (!latest) return null;
    try {
      writeFileSync(cacheFile, JSON.stringify({ checkedAt: now(), latest } satisfies Cache) + '\n', { mode: 0o600 });
    } catch {
      // not being able to remember the check is no reason to fail it
    }
  }
  if (compareVersions(latest, current) <= 0) return null;
  opts.log?.(`update: version ${latest} is available (this is ${current}); ${DOWNLOAD_URL}`);
  return { version: latest, url: DOWNLOAD_URL };
}

/** The version of the latest GitHub release (its tag without the leading v), or null when there is none. */
async function latestRelease(): Promise<string | null> {
  const r = await fetch(RELEASES_API, { headers: { accept: 'application/vnd.github+json', 'user-agent': '4k7-update-check' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const tag = ((await r.json()) as { tag_name?: string }).tag_name;
  return typeof tag === 'string' ? tag.replace(/^v/, '') : null;
}

/** Numeric dotted versions; a pre-release (0.2.0-beta.1) is older than its release. Returns -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main = '', pre] = v.split('-', 2);
    return { nums: main.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}
