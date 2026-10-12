import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { browserData, loadBrowserProject, loadSettings, markMovedToDisk, movedToDisk, saveSettings } from '../src/lib/persist.ts';

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
    expect(await loadBrowserProject()).toBe('{"name":"old board"}');
    expect((await loadSettings()).theme).toBe('light');
    // writes go to the new database only
    await saveSettings({ ...(await loadSettings()), theme: 'dark' });
    expect((await loadSettings()).theme).toBe('dark');
    const names = (await indexedDB.databases()).map((d) => d.name).sort();
    expect(names).toEqual(['4k7', 'tracewise']);
  });
});

describe('what the browser kept before the files', () => {
  it('is read once, to move it to the server', async () => {
    const data = await browserData();
    expect(data.project).toBe('{"name":"old board"}');
    expect(data).toMatchObject({ kept: [], library: [], artwork: [], datasheets: [] });
    expect(await movedToDisk()).toBe(false);
    await markMovedToDisk();
    expect(await movedToDisk()).toBe(true);
  });
});
