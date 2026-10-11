import { describe, expect, it } from 'vitest';
import { findFabPreset } from '@4k7/schema';
import { fabRefreshPrompt } from '../src/lib/fabRefresh.ts';

describe('fab refresh message', () => {
  const r = findFabPreset('jlcpcb/4l-1oz');
  if (!r.ok) throw new Error('preset');
  const fab = r.profile;

  it('names the profile, its source and the old date, and asks for an import with today\'s date', () => {
    const t = fabRefreshPrompt(fab, '2027-03-01');
    expect(t).toContain('JLCPCB, 4-layer, 1 oz copper');
    expect(t).toContain(fab.source.url);
    expect(t).toContain(`checked ${fab.source.checked}`);
    expect(t).toContain('checked 2027-03-01');
    expect(t).toContain('layers [4]');
    expect(t).toContain('change nothing');
  });

  it('copes with a profile whose date is unknown', () => {
    expect(fabRefreshPrompt({ ...fab, source: { url: fab.source.url } }, '2027-03-01')).toContain('checked on an unknown date');
  });
});
