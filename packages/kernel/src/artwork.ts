/**
 * Saved silkscreen artwork (logos, clipart) the app keeps in the browser and registers here, so
 * add_graphic can place it by name. Placing copies the figures into the design: a later change
 * to the artwork does not touch boards that use it.
 */
import type { Artwork } from '@tracewise/schema';

const saved = new Map<string, Artwork>();

export function registerArtwork(list: Artwork[]): void {
  for (const a of list) saved.set(a.id, a);
}

export function unregisterArtwork(id: string): void {
  saved.delete(id);
}

export function listArtwork(): Artwork[] {
  return [...saved.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** By id or name, ignoring case. */
export function findArtwork(nameOrId: string): Artwork | undefined {
  const k = nameOrId.trim().toLowerCase();
  return saved.get(nameOrId) ?? [...saved.values()].find((a) => a.id.toLowerCase() === k || a.name.toLowerCase() === k);
}
