import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '@tracewise/kernel';
import { bom, crc32, drill, fabFiles, pickAndPlace, zip } from '../src/index.ts';
import { buckTransaction } from '../../kernel/test/fixtures.ts';

function board() {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  return k.board();
}

describe('fab outputs', () => {
  it('writes a complete Gerber set with valid structure', () => {
    const files = fabFiles(board(), 'buck converter');
    expect(files.map((f) => f.name)).toEqual([
      'buck_converter-F_Cu.gbr', 'buck_converter-B_Cu.gbr',
      'buck_converter-F_Mask.gbr', 'buck_converter-F_Paste.gbr', 'buck_converter-B_Mask.gbr', 'buck_converter-B_Paste.gbr',
      'buck_converter-F_Silkscreen.gbr', 'buck_converter-Edge_Cuts.gbr', 'buck_converter-PTH.drl',
      'buck_converter-BOM.csv', 'buck_converter-PnP.csv',
    ]);
    for (const f of files.filter((x) => x.name.endsWith('.gbr'))) {
      const lines = f.content.trim().split('\n');
      expect(lines).toContain('%FSLAX46Y46*%');
      expect(lines).toContain('%MOMM*%');
      expect(lines.at(-1)).toBe('M02*');
      // every aperture is defined before it is selected
      const defined = new Set<string>();
      for (const l of lines) {
        const def = /^%ADD(\d+)/.exec(l);
        if (def) defined.add(def[1]!);
        const sel = /^D(\d+)\*$/.exec(l);
        if (sel) expect(defined.has(sel[1]!), `${f.name} D${sel[1]}`).toBe(true);
      }
      // coordinates are inside the board (y flipped, 1e-6 mm units)
      for (const m of f.content.matchAll(/X(-?\d+)Y(-?\d+)D0[123]/g)) {
        expect(Number(m[1]) / 1e6).toBeGreaterThanOrEqual(0);
        expect(Number(m[2]) / 1e6).toBeLessThanOrEqual(15.5 + 1e-6);
      }
    }
    const top = files.find((f) => f.name.endsWith('F_Cu.gbr'))!.content;
    expect(top).toContain('%TF.FileFunction,Copper,L1,Top*%');
  });

  it('drills vias and through-hole pads, and lists the BOM and placement', () => {
    const b = board();
    const drl = drill(b);
    const holes = drl.split('\n').filter((l) => /^X/.test(l));
    expect(holes).toHaveLength(b.vias.length + 2); // + the two header pins
    expect(drl).toContain('T1C0.300');
    const rows = bom(b).trim().split('\n');
    expect(rows[0]).toBe('Comment,Designator,Footprint,Quantity,MPN,Manufacturer');
    expect(rows).toContain('TPS54331DR,U1,SOIC-8,1,TPS54331DR,Texas Instruments');
    const pnp = pickAndPlace(b).trim().split('\n');
    expect(pnp).toHaveLength(1 + 11); // SMD parts only (J1 is through-hole)
    const u1 = b.parts.find((p) => p.refdes === 'U1')!;
    expect(pnp.find((l) => l.startsWith('U1,'))).toBe(`U1,TPS54331DR,SOIC-8,${u1.x.toFixed(3)},${(b.outline.h - u1.y).toFixed(3)},${(360 - u1.rot) % 360},Top`);
  });

  it('packs a zip that unzip accepts with intact contents', () => {
    const files = fabFiles(board(), 'buck');
    const dir = mkdtempSync(join(tmpdir(), 'tw-zip-'));
    writeFileSync(join(dir, 'f.zip'), zip(files));
    const out = execFileSync('unzip', ['-t', join(dir, 'f.zip')], { encoding: 'utf8' });
    expect(out).toContain('No errors detected');
    const top = execFileSync('unzip', ['-p', join(dir, 'f.zip'), 'buck-F_Cu.gbr'], { encoding: 'utf8' });
    expect(top).toBe(files[0]!.content);
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});
