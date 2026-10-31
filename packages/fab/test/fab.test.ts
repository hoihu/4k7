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

  it('routes a slotted hole from one end to the other, and draws its pad oval', () => {
    const b = structuredClone(board()); // (its pad is changed below; the kernel shares what it placed)
    const part = b.parts.find((p) => p.pads.some((q) => q.drill))!;
    const pad = part.pads.find((q) => q.drill)!;
    Object.assign(pad, { x: 10, y: 5, w: 1.1, h: 2.2, shape: 'round', drill: 0.6, slot: { w: 0.6, h: 1.7 } });
    const drl = drill(b);
    const H = b.outline.h;
    // the tool of its width, from one end's centre to the other's (0.55 mm off the middle each way)
    expect(drl).toContain('C0.600');
    expect(drl).toContain(`G00X10.000Y${(H - 4.45).toFixed(3)}\nM15\nG01X10.000Y${(H - 5.55).toFixed(3)}\nM16\nG05`);
    const top = fabFiles(b, 'slot').find((f) => f.name.endsWith('F_Cu.gbr'))!.content;
    expect(top).toMatch(/%ADD\d+O,1\.100000X2\.200000\*%/);
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
    // the BOM each other house's upload reads: Eurocircuits' MPN column, PCBWay's template
    const ec = bom(b, 'eurocircuits').trim().split('\n');
    expect(ec[0]).toBe('Reference Designators,Quantity,MPN,Manufacturer,Description,Value,Package');
    expect(ec).toContain('U1,1,TPS54331DR,Texas Instruments,IC TPS54331DR,TPS54331DR,SOIC-8');
    const pw = bom(b, 'pcbway').trim().split('\n');
    expect(pw[0]).toBe('Item #,Designator,Qty,Manufacturer,Mfg Part #,Description / Value,Package/Footprint,Type');
    expect(pw.find((l) => l.includes(',J1,'))).toMatch(/,Thru-hole$/);
    expect(pw.find((l) => l.includes(',U1,'))).toMatch(/^\d+,U1,1,Texas Instruments,TPS54331DR,IC TPS54331DR,SOIC-8,SMD$/);
    const pnp = pickAndPlace(b).trim().split('\n');
    expect(pnp).toHaveLength(1 + 11); // SMD parts only (J1 is through-hole)
    const u1 = b.parts.find((p) => p.refdes === 'U1')!;
    expect(pnp.find((l) => l.startsWith('U1,'))).toBe(`U1,TPS54331DR,SOIC-8,${u1.x.toFixed(3)},${(b.outline.h - u1.y).toFixed(3)},${(360 - u1.rot) % 360},Top`);
  });

  it('writes a part in the house\'s frame where it is given: the house\'s rotation, its footprint\'s origin', () => {
    const b = board();
    const u1 = b.parts.find((p) => p.refdes === 'U1')!;
    const row = (csv: string, ref: string) => csv.split('\n').find((l) => l.startsWith(`${ref},`))!.split(',');
    const plain = pickAndPlace(b);
    const framed = pickAndPlace(b, { U1: { rotation: 270, at: [0.5, -0.25] } });
    expect(row(framed, 'U1')).toEqual(['U1', 'TPS54331DR', 'SOIC-8', (u1.x + 0.5).toFixed(3), (b.outline.h - (u1.y - 0.25)).toFixed(3), '270', 'Top']);
    // every other part as before
    expect(framed.split('\n').filter((l) => !l.startsWith('U1,'))).toEqual(plain.split('\n').filter((l) => !l.startsWith('U1,')));
    // the files and each copy on a panel take it too
    expect(row(fabFiles(b, 'buck', 'jlcpcb', { U1: { rotation: 270, at: [0, 0] } }).find((f) => f.name === 'buck-PnP.csv')!.content, 'U1')[5]).toBe('270');
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
    // the position is the board's own (not mirrored); the rotation is 180° − the counter-clockwise one
    const r = row.split(',');
    expect([r[3], r[4]]).toEqual([cap.x.toFixed(3), (b.outline.h - cap.y).toFixed(3)]);
    expect(Number(r[5])).toBe(((180 - (360 - cap.rot)) % 360 + 360) % 360);
    // in the house's frame: its footprint mirrored onto the pads, turned by 90°, is 90° the other way for the file
    const framed = pickAndPlace(b, { [cap.refdes]: { rotation: 90, at: [1, 1] } }).split('\n').find((l) => l.startsWith(`${cap.refdes},`))!.split(',');
    expect(framed).toEqual([cap.refdes, r[1], r[2], (cap.x + 1).toFixed(3), (b.outline.h - cap.y - 1).toFixed(3), '90', 'Bottom']);
    expect(pickAndPlace(b, { [cap.refdes]: { rotation: 0, at: [0, 0] } }).split('\n').find((l) => l.startsWith(`${cap.refdes},`))!.split(',')[5]).toBe('180');
    expect(pickAndPlace(b).split('\n').filter((l) => l.endsWith(',Top')).length).toBeGreaterThan(0);
  });

  it('a bottom part\'s pads, mask openings, paste and polarity mark are on the bottom layers only, where the mirrored footprint puts them', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    k.accept();
    const d1 = k.board().parts.find((p) => p.refdes === 'D1')!;
    k.transact({ summary: 'under', ops: [{ op: 'place', ref: 'D1', x_mm: d1.x, y_mm: d1.y, side: 'bottom' }] });
    const b = k.board();
    const under = b.parts.find((p) => p.refdes === 'D1')!;
    const files = fabFiles(b, 'buck');
    const file = (name: string) => files.find((f) => f.name === `buck-${name}.gbr`)!.content;
    // a flash or stroke point as the file writes it: x, then y up from the bottom edge, in 1e-6 mm
    const at = (x: number, y: number) => `X${Math.round(x * 1e6)}Y${Math.round((b.outline.h - y) * 1e6)}D03*`;
    for (const pad of under.pads) {
      for (const layer of ['B_Cu', 'B_Mask', 'B_Paste']) expect(file(layer), `${layer} ${pad.number}`).toContain(at(pad.x, pad.y));
      for (const layer of ['F_Cu', 'F_Mask', 'F_Paste']) expect(file(layer), `${layer} ${pad.number}`).not.toContain(at(pad.x, pad.y));
    }
    // the flashes of the paste layers: the bottom has this part's two pads, the top every other SMD pad
    const flashes = (name: string) => file(name).split('\n').filter((l) => l.endsWith('D03*')).length;
    const smd = b.parts.flatMap((p) => p.pads.filter((q) => !q.drill && !q.npth));
    expect(flashes('B_Paste')).toBe(2);
    expect(flashes('F_Paste')).toBe(smd.length - 2);
    expect(under.pads.every((q) => q.layers.join() === 'B.Cu')).toBe(true);
    // the cathode band is printed on the bottom silkscreen, not the top
    const band = under.mark!.strokes[0]!.pts;
    const stroke = (x: number, y: number) => `X${Math.round(x * 1e6)}Y${Math.round((b.outline.h - y) * 1e6)}D0`;
    expect(file('B_Silkscreen')).toContain(stroke(band[0]!, band[1]!));
    expect(file('F_Silkscreen')).not.toContain(stroke(band[0]!, band[1]!));
    expect(file('B_Silkscreen')).toContain('FileFunction,Legend,Bot');
    // the through-hole header is on both: pads on every copper layer and a mask opening
    const j1 = b.parts.find((p) => p.refdes === 'J1')!;
    for (const layer of ['F_Cu', 'B_Cu', 'F_Mask', 'B_Mask']) expect(file(layer)).toContain(at(j1.pads[0]!.x, j1.pads[0]!.y));
  });

  it('prints the polarity marks: a dot by pin 1, a band at the cathode, the pin-1 corner chamfered', () => {
    const b = board();
    const silk = fabFiles(b, 'buck').find((f) => f.name === 'buck-F_Silkscreen.gbr')!.content;
    const lines = silk.split('\n');
    const apertures = new Map([...silk.matchAll(/%ADD(\d+)C,([\d.]+)\*%/g)].map((m) => [m[1]!, Number(m[2])]));
    // each flash (D03) and stroke (D01) with the width of the aperture it was drawn with
    const marks: { op: string; w: number; x: number; y: number }[] = [];
    let cur = '';
    for (const l of lines) {
      const sel = /^D(\d+)\*$/.exec(l);
      if (sel) cur = sel[1]!;
      const m = /^X(-?\d+)Y(-?\d+)D0([13])\*$/.exec(l);
      if (m) marks.push({ op: m[3]!, w: apertures.get(cur)!, x: Number(m[1]) / 1e6, y: b.outline.h - Number(m[2]) / 1e6 });
    }
    // U1's and J1's dots, flashed where the board view has them
    for (const ref of ['U1', 'J1']) {
      const dot = b.parts.find((p) => p.refdes === ref)!.mark!.dots[0]!;
      expect(marks.some((m) => m.op === '3' && m.w === dot.d && Math.abs(m.x - dot.x) < 1e-3 && Math.abs(m.y - dot.y) < 1e-3), ref).toBe(true);
    }
    // D1's band: a 0.3 mm stroke ending where the board view has it
    const band = b.parts.find((p) => p.refdes === 'D1')!.mark!.strokes[0]!;
    expect(band.w).toBe(0.3);
    expect(marks.some((m) => m.op === '1' && m.w === 0.3 && Math.abs(m.x - band.pts[2]!) < 1e-3 && Math.abs(m.y - band.pts[3]!) < 1e-3)).toBe(true);
    // U1's outline runs diagonally across its chamfered corner (what is left of it beside the pads)
    const u1 = b.parts.find((p) => p.refdes === 'U1')!;
    const draws = lines.map((l, i) => [l, lines[i - 1] ?? ''] as const).filter(([l]) => l.endsWith('D01*'));
    const pt = (l: string) => { const m = /X(-?\d+)Y(-?\d+)D0[12]/.exec(l)!; return [Number(m[1]) / 1e6, b.outline.h - Number(m[2]) / 1e6] as const; };
    const diagonal = draws.some(([l, prev]) => {
      if (!/D0[12]\*$/.test(prev)) return false;
      const [[x0, y0], [x1, y1]] = [pt(prev), pt(l)];
      const inBody = (x: number, y: number) => x >= u1.body.x - 0.01 && x <= u1.body.x + u1.body.w + 0.01 && y >= u1.body.y - 0.01 && y <= u1.body.y + u1.body.h + 0.01;
      return Math.abs(x1 - x0) > 0.05 && Math.abs(Math.abs(x1 - x0) - Math.abs(y1 - y0)) < 1e-3 && inBody(x0, y0) && inBody(x1, y1);
    });
    expect(diagonal).toBe(true);
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
    // each copy of U1 in the house's frame, its origin moved with the copy
    const framed = panelFabFiles(b, 'buck', 'jlcpcb', { U1: { rotation: 270, at: [0.5, 0] } }).find((f) => f.name === 'buck-panel-PnP.csv')!.content.trim().split('\n');
    const u1 = b.parts.find((x) => x.refdes === 'U1')!;
    p.copies.forEach((c, i) => {
      const f = framed.find((l) => l.startsWith(`U1_${i + 1},`))!.split(',');
      expect([f[3], f[5]]).toEqual([(u1.x + c.dx + 0.5).toFixed(3), '270']);
    });
    expect(file('buck-panel-BOM.csv')).toContain('TPS54331DR,"U1_1,U1_2,U1_3,U1_4",SOIC-8,4,');
    // every copy carries its parts' polarity marks, moved with it
    const dot = b.parts.find((x) => x.refdes === 'U1')!.mark!.dots[0]!;
    const silk = file('buck-panel-F_Silkscreen.gbr');
    for (const c of p.copies) expect(silk).toContain(`X${Math.round((dot.x + c.dx) * 1e6)}Y${Math.round((p.h - dot.y - c.dy) * 1e6)}D03*`);
    // the single-board files stay as they were
    expect(fabFiles(b, 'buck').map((f) => f.name)).not.toContain('buck-NPTH.drl');
  });
});
