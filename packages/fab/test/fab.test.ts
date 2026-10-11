import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '@4k7/kernel';
import { bom, crc32, drill, fabFiles, panelFabFiles, pickAndPlace, zip } from '../src/index.ts';
import { buckTransaction } from '../../kernel/test/fixtures.ts';

function board() {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  return k.board();
}

describe('fab outputs', () => {
  it('writes a complete Gerber set with valid structure', () => {
    const b = board();
    const files = fabFiles(b, 'buck converter');
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
        expect(Number(m[2]) / 1e6).toBeLessThanOrEqual(b.outline.h + 1e-6);
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
    if (b.vias.length) expect(drl).toContain('C0.300');
    expect(drl).toContain('C1.000'); // header pins
    const rows = bom(b).trim().split('\n');
    expect(rows[0]).toBe('Comment,Designator,Footprint,Quantity,MPN,Manufacturer,LCSC Part #');
    expect(rows).toContain('TPS54331DR,U1,SOIC-8,1,TPS54331DR,Texas Instruments,');
    const pnp = pickAndPlace(b).trim().split('\n');
    expect(pnp).toHaveLength(1 + 11); // SMD parts only (J1 is through-hole)
    const u1 = b.parts.find((p) => p.refdes === 'U1')!;
    expect(pnp.find((l) => l.startsWith('U1,'))).toBe(`U1,TPS54331DR,SOIC-8,${u1.x.toFixed(3)},${(b.outline.h - u1.y).toFixed(3)},${(360 - u1.rot) % 360},Top`);
  });

  it('parts on the bottom side get their own silkscreen, paste and pick-and-place layer', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    k.accept();
    const cap = k.board().parts.find((p) => p.pads.length === 2 && p.pads.every((q) => !q.drill))!;
    k.transact({ summary: 'side', ops: [{ op: 'constrain', kind: 'layer', a: cap.refdes, value: 'bottom' }] });
    const b = k.board();
    const files = fabFiles(b, 'buck');
    const file = (name: string) => files.find((f) => f.name === name)!.content;
    expect(file('buck-B_Silkscreen.gbr')).toContain('FileFunction,Legend,Bot');
    // paste: flashes (D03) on the bottom for this part's pads only
    expect(file('buck-B_Paste.gbr').split('\n').filter((l) => l.endsWith('D03*'))).toHaveLength(2);
    const row = pickAndPlace(b).split('\n').find((l) => l.startsWith(`${cap.refdes},`))!;
    expect(row.endsWith(',Bottom')).toBe(true);
    expect(pickAndPlace(b).split('\n').filter((l) => l.endsWith(',Top')).length).toBeGreaterThan(0);
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

  it('writes a panel: every copy, the milled contours, mouse bites, tooling holes and fiducials', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    k.accept();
    k.transact({ summary: 'panel', ops: [{ op: 'set_board', width_mm: 40, height_mm: 30 }, { op: 'set_panel' }] });
    const b = k.board();
    const p = b.panel!;
    const files = panelFabFiles(b, 'buck');
    const file = (name: string) => files.find((f) => f.name === name)!.content;
    expect(files.map((f) => f.name)).toContain('buck-panel-NPTH.drl');
    // every Gerber coordinate lies on the panel
    for (const f of files.filter((x) => x.name.endsWith('.gbr'))) {
      for (const m of f.content.matchAll(/X(-?\d+)Y(-?\d+)D0[123]/g)) {
        expect(Number(m[1]) / 1e6).toBeGreaterThanOrEqual(0);
        expect(Number(m[1]) / 1e6).toBeLessThanOrEqual(p.w + 1e-6);
        expect(Number(m[2]) / 1e6).toBeGreaterThanOrEqual(0);
        expect(Number(m[2]) / 1e6).toBeLessThanOrEqual(p.h + 1e-6);
      }
    }
    // the outline file draws the panel's contours (each opened with a D02 move)
    expect(file('buck-panel-Edge_Cuts.gbr').split('\n').filter((l) => l.endsWith('D02*'))).toHaveLength(p.edges.length);
    // plated holes four times over; non-plated: the bites and the tooling holes
    const holes = (s: string) => s.split('\n').filter((l) => /^X/.test(l)).length;
    expect(holes(file('buck-panel-PTH.drl'))).toBe(4 * holes(drill(b)));
    expect(holes(file('buck-panel-NPTH.drl'))).toBe(p.bites.length + p.tooling.length);
    expect(file('buck-panel-NPTH.drl')).toContain('C0.500');
    expect(file('buck-panel-NPTH.drl')).toContain('C2.000');
    // fiducials: 1 mm copper, 2 mm mask opening
    expect(file('buck-panel-F_Cu.gbr')).toContain('C,1.000000');
    expect(file('buck-panel-F_Mask.gbr')).toContain('C,2.000000');
    expect(file('buck-panel-F_Paste.gbr')).not.toContain('C,1.000000');
    // one placement per copy, designators numbered by copy; the BOM counts the panel
    const single = pickAndPlace(b).trim().split('\n');
    const pnp = file('buck-panel-PnP.csv').trim().split('\n');
    expect(pnp).toHaveLength(1 + 4 * (single.length - 1));
    expect(pnp.some((l) => l.startsWith('U1_1,'))).toBe(true);
    expect(pnp.some((l) => l.startsWith('U1_4,'))).toBe(true);
    expect(file('buck-panel-BOM.csv')).toContain('TPS54331DR,"U1_1,U1_2,U1_3,U1_4",SOIC-8,4,');
    // the single-board files stay as they were
    expect(fabFiles(b, 'buck').map((f) => f.name)).not.toContain('buck-NPTH.drl');
  });
});
