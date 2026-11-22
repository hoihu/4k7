import { describe, expect, it } from 'vitest';
import { RECENT_MAX, addRecent, recentEntries, renameRecent } from '../src/lib/recentProjects.ts';

describe('recent projects', () => {
  it('puts the project opened at the front', () => {
    expect(addRecent([], 'lamp')).toEqual(['lamp']);
    expect(addRecent(['lamp', 'charger'], 'usb-hub')).toEqual(['usb-hub', 'lamp', 'charger']);
  });

  it('moves a project opened again to the front, once', () => {
    expect(addRecent(['lamp', 'charger', 'usb-hub'], 'usb-hub')).toEqual(['usb-hub', 'lamp', 'charger']);
    expect(addRecent(['lamp'], 'lamp')).toEqual(['lamp']);
  });

  it('keeps the last eight', () => {
    let list: string[] = [];
    for (let i = 0; i < 12; i++) list = addRecent(list, `p${i}`);
    expect(list).toHaveLength(RECENT_MAX);
    expect(list[0]).toBe('p11');
    expect(list.at(-1)).toBe('p4');
  });

  it('ignores an empty id', () => {
    expect(addRecent(['lamp'], '')).toEqual(['lamp']);
  });

  it('follows a renamed file, keeping its place and no duplicate', () => {
    expect(renameRecent(['lamp', 'charger'], 'charger', 'charger-rev2')).toEqual(['lamp', 'charger-rev2']);
    expect(renameRecent(['lamp', 'lamp-2'], 'lamp-2', 'lamp')).toEqual(['lamp']);
  });

  it('offers the others than the open one, marking those whose file is gone', () => {
    expect(recentEntries(['lamp', 'charger', 'old'], 'lamp', ['lamp', 'charger'])).toEqual([
      { id: 'charger', missing: false },
      { id: 'old', missing: true },
    ]);
  });

  it('copes with settings that hold no list or a broken one', () => {
    expect(recentEntries(undefined, null, [])).toEqual([]);
    expect(recentEntries('lamp', null, ['lamp'])).toEqual([]);
    expect(addRecent(null, 'lamp')).toEqual(['lamp']);
    expect(recentEntries(['lamp', 3, '', 'lamp'], null, ['lamp'])).toEqual([{ id: 'lamp', missing: false }]);
  });
});
