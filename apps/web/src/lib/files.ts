/**
 * Imported parts, artwork and datasheets, kept on this computer by the local server
 * (~/.4k7/library, ~/.4k7/artwork, ~/.4k7/datasheets) for every project.
 */
import type { Artwork, PartCard } from '@4k7/schema';
import { disk } from './disk.svelte.ts';
import { ARTWORK_FORMAT_VERSION, LIBRARY_FORMAT_VERSION, readStored, stamp, type Stamped, type Stored, type StoredDatasheet } from './persist.ts';

/** Whether the record stored under this key was written by a newer version (saving would destroy it). */
async function newerStored(store: 'library' | 'artwork', key: string, current: number): Promise<boolean> {
  const existing = await disk.record<{ format?: number }>(store, key);
  return (existing?.format ?? 1) > current;
}

/* ------------------------------ part library ------------------------------ */

/** Parts imported from datasheets, kept on this computer for every project. */
export async function loadLibrary(): Promise<Stored<PartCard>> {
  return readStored(await disk.records<Stamped<PartCard>>('library'), LIBRARY_FORMAT_VERSION);
}

export async function saveLibraryPart(card: PartCard): Promise<void> {
  if (await newerStored('library', card.id, LIBRARY_FORMAT_VERSION)) throw new Error(`${card.id} was saved by a newer version of the app; update the app to change it`);
  await disk.putRecord('library', card.id, stamp(card, LIBRARY_FORMAT_VERSION));
}

export async function deleteLibraryPart(id: string): Promise<void> {
  await disk.deleteRecord('library', id);
}

/* -------------------------------- artwork -------------------------------- */

/** Saved silkscreen artwork (logos, clipart), kept on this computer for every project. */
export async function loadArtwork(): Promise<Stored<Artwork>> {
  return readStored(await disk.records<Stamped<Artwork>>('artwork'), ARTWORK_FORMAT_VERSION);
}

export async function saveArtwork(a: Artwork): Promise<void> {
  if (await newerStored('artwork', a.id, ARTWORK_FORMAT_VERSION)) throw new Error(`"${a.name}" was saved by a newer version of the app; update the app to change it`);
  await disk.putRecord('artwork', a.id, stamp(a, ARTWORK_FORMAT_VERSION));
}

export async function deleteArtwork(id: string): Promise<void> {
  await disk.deleteRecord('artwork', id);
}

export async function saveDatasheet(hash: string, sheet: StoredDatasheet): Promise<void> {
  await disk.putDatasheet(hash, sheet);
}

export async function deleteDatasheet(hash: string): Promise<void> {
  await disk.deleteDatasheet(hash);
}

export async function loadDatasheet(hash: string): Promise<StoredDatasheet | undefined> {
  try {
    return await disk.datasheet(hash);
  } catch {
    return undefined;
  }
}

/** The datasheet behind a link, downloaded by the server and kept like an imported one. Throws when it cannot be had. */
export async function fetchDatasheet(url: string): Promise<{ hash: string; sheet: StoredDatasheet }> {
  const got = await disk.fetchDatasheet(url);
  if (!got) throw new Error('this 4k7 server cannot download datasheets yet: update it (restart the app)');
  const sheet = await disk.datasheet(got.hash);
  if (!sheet) throw new Error('the downloaded datasheet went missing');
  return { hash: got.hash, sheet };
}
