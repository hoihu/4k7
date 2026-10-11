import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { loadProject, loadSettings, saveProject } from '../src/lib/persist.ts';

function seedOld(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('tracewise', 4);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of ['projects', 'settings', 'keys', 'library', 'datasheets', 'artwork']) db.createObjectStore(s);
    };
    req.onsuccess = () => {
      const db = req.result;
      const t = db.transaction(['projects', 'settings'], 'readwrite');
      t.objectStore('projects').put('{"name":"old board"}', 'current');
      t.objectStore('settings').put({ theme: 'light', version: 2 }, 'settings');
      t.oncomplete = () => {
        db.close();
        resolve();
      };
      t.onerror = () => reject(t.error);
    };
    req.onerror = () => reject(req.error);
  });
}

describe('the database of the old name', () => {
  it('is copied into the new one on its first open and left in place', async () => {
    await seedOld();
    expect(await loadProject()).toBe('{"name":"old board"}');
    expect((await loadSettings()).theme).toBe('light');
    // writes go to the new database only
    await saveProject('{"name":"new board"}');
    expect(await loadProject()).toBe('{"name":"new board"}');
    const names = (await indexedDB.databases()).map((d) => d.name).sort();
    expect(names).toEqual(['4k7', 'tracewise']);
  });
});
