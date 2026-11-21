import { describe, expect, it } from 'vitest';
import { projectIdOf } from '../src/lib/projectFile.ts';

describe('a project opened from a file', () => {
  it('is named after the file, not the design it holds', () => {
    // a copy of bike-lamp.twd.json: the design inside is still called "bike-lamp"
    expect(projectIdOf('bike-lamp-rev2.twd.json')).toBe('bike-lamp-rev2');
    expect(projectIdOf('bike-lamp.twd.json')).toBe('bike-lamp');
    expect(projectIdOf('Lamp copy.json')).toBe('Lamp copy');
    expect(projectIdOf('Lamp.TWD.JSON')).toBe('Lamp');
  });
});
