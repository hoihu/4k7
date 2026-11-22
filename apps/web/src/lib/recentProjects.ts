/**
 * The projects opened last, most recent first, kept in the settings (`recentProjects`). An entry is a
 * project's id: its file's name in the projects folder without .twd.json (see projectFile.ts).
 */
export const RECENT_MAX = 8;

/** The saved list as it can be trusted: ids only, each once (settings from an older version have none). */
export function cleanRecent(list: unknown): string[] {
  const ids = (Array.isArray(list) ? list : []).filter((x): x is string => typeof x === 'string' && !!x);
  return [...new Set(ids)];
}

/** The list with `id` at the front, once, and no more than `max` entries. */
export function addRecent(list: unknown, id: string, max = RECENT_MAX): string[] {
  const ids = cleanRecent(list);
  return (id ? [id, ...ids.filter((x) => x !== id)] : ids).slice(0, max);
}

/** The list after a project's file was renamed: the entry keeps its place under the new name. */
export function renameRecent(list: unknown, from: string, to: string): string[] {
  return cleanRecent(cleanRecent(list).map((x) => (x === from ? to : x)));
}

export interface RecentEntry {
  id: string;
  /** Its file is no longer in the projects folder (moved, renamed or deleted outside the app). */
  missing: boolean;
}

/** What the menu offers: the recent projects other than the open one, each marked whether its file is still there. */
export function recentEntries(list: unknown, open: string | null, inFolder: readonly string[]): RecentEntry[] {
  const there = new Set(inFolder);
  return cleanRecent(list).filter((id) => id !== open).map((id) => ({ id, missing: !there.has(id) }));
}
