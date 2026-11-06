import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { Kernel } from '@4k7/kernel';
import { crc32, fabFiles, fabSetText, panelFabFiles, readExcellon, readFabFiles, readGerber, unzip, zip, type FabObject } from '../src/index.ts';
import { buckTransaction } from '../../kernel/test/fixtures.ts';

function board() {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  return k.board();
}

const centre = (o: FabObject) => [(o.box[0] + o.box[2]) / 2, (o.box[1] + o.box[3]) / 2];
const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) < 1e-6);

describe('reading production files', () => {
  it('reads back the files fabFiles writes: each layer by its attribute, the board, its pads, holes and tracks', () => {
    const b = board();
    const set = readFabFiles(fabFiles(b, 'buck'));
    expect(set.skipped).toEqual(['buck-IPC356.ipc', 'buck-BOM.csv', 'buck-PnP.csv']);
    expect(set.files.map((f) => f.layer.id)).toEqual(['F.Silkscreen', 'F.Paste', 'F.Mask', 'F.Cu', 'B.Cu', 'B.Mask', 'B.Paste', 'Edge.Cuts', 'PTH']);
    expect(set.files.every((f) => f.layer.by === 'attribute' || f.format === 'excellon')).toBe(true);
    expect(set.files.every((f) => !f.notes.length)).toBe(true);
    const s = set.summary;
    expect(s.board).toMatchObject({ x: 0, y: 0, fromOutline: true });
    expect(s.board!.w).toBeCloseTo(b.outline.w, 6);
    expect(s.board!.h).toBeCloseTo(b.outline.h, 6);
    expect(s.copperLayers).toBe(2);
    expect(s.drills.reduce((n, d) => n + d.holes, 0)).toBe(b.vias.length + 2);
    expect(s.drills.every((d) => d.plated === true)).toBe(true);
    // every top pad is a flash on F.Cu where the board has it (y flipped)
    const top = set.files.find((f) => f.layer.id === 'F.Cu')!;
    const flashes = top.objects.filter((o) => o.kind === 'flash').map(centre);
    const pads = b.parts.flatMap((q) => q.pads).filter((q) => q.layers.includes('F.Cu') || q.drill);
    expect(pads.length).toBeGreaterThan(20);
    for (const p of pads) {
      expect(flashes.some((c) => near(c, [p.x, b.outline.h - p.y])), `pad at ${p.x}, ${p.y}`).toBe(true);
    }
    expect(set.files.find((f) => f.layer.id === 'F.Mask')!.negative).toBe(true);
    // the narrowest copper line: a track, or a plane's spoke
    const widths = [...b.tracks.map((t) => t.width), ...b.zones.flatMap((z) => z.shape?.adds.map((a) => a.w) ?? [])];
    if (widths.length) expect(s.smallestTrack).toBeCloseTo(Math.min(...widths), 6);
    expect(fabSetText(set)).toContain(`Board ${b.outline.w} × ${b.outline.h} mm (its outline)`);
  });

  it('reads a panel: its size, every copy\'s holes, the mouse bites and tooling holes', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    k.accept();
    k.transact({ summary: 'panel', ops: [{ op: 'set_board', width_mm: 40, height_mm: 30 }, { op: 'set_panel' }] });
    const b = k.board();
    const p = b.panel!;
    const s = readFabFiles(panelFabFiles(b, 'buck')).summary;
    expect([s.board!.w, s.board!.h]).toEqual([p.w, p.h]);
    const holes = (plated: boolean) => s.drills.filter((d) => d.plated === plated).reduce((n, d) => n + d.holes, 0);
    expect(holes(true)).toBe(4 * (b.vias.length + 2));
    expect(holes(false)).toBe(p.bites.length + p.tooling.length);
  });

  it('reads KiCad\'s Gerbers: a macro pad, a track and an arc, a non-conductor line, a region and clear polarity', () => {
    const src = [
      '%TF.GenerationSoftware,KiCad,Pcbnew,7.0.10*%',
      '%TF.FileFunction,Copper,L1,Top*%',
      '%TF.FilePolarity,Positive*%',
      '%FSLAX46Y46*%',
      'G04 Gerber Fmt 4.6, Leading zero omitted, Abs format (unit mm)*',
      '%MOMM*%',
      '%LPD*%',
      'G01*',
      '%AMRoundRect*',
      '0 Rectangle with rounded corners*',
      '0 $1 Rounding radius*',
      '4,1,4,$2,$3,$4,$5,$6,$7,$8,$9,$2,$3,0*',
      '1,1,$1+$1,$2,$3*',
      '1,1,$1+$1,$4,$5*',
      '1,1,$1+$1,$6,$7*',
      '1,1,$1+$1,$8,$9*',
      '20,1,$1+$1,$2,$3,$4,$5,0*',
      '20,1,$1+$1,$4,$5,$6,$7,0*',
      '20,1,$1+$1,$6,$7,$8,$9,0*',
      '20,1,$1+$1,$8,$9,$2,$3,0*%',
      '%TA.AperFunction,SMDPad,CuDef*%',
      '%ADD10RoundRect,0.250000X-0.450000X-0.350000X0.450000X-0.350000X0.450000X0.350000X-0.450000X0.350000X0*%',
      '%TD*%',
      '%TA.AperFunction,Conductor*%',
      '%ADD11C,0.250000*%',
      '%TD*%',
      '%TA.AperFunction,NonConductor*%',
      '%ADD12C,0.100000*%',
      '%TD*%',
      'D10*',
      'X10000000Y5000000D03*',
      'D11*',
      'X10000000Y5000000D02*',
      'X20000000Y5000000D01*',
      'G75*',
      'G03*',
      'X25000000Y10000000I0J5000000D01*',
      'G01*',
      'D12*',
      'X0Y0D02*',
      'X1000000Y0D01*',
      'G36*',
      'X30000000Y0D02*',
      'X30000000Y10000000D01*',
      'X40000000Y10000000D01*',
      'X40000000Y0D01*',
      'X30000000Y0D01*',
      'G37*',
      '%LPC*%',
      'D10*',
      'X35000000Y5000000D03*',
      'M02*',
    ].join('\n');
    const r = readGerber(src);
    expect(r.notes).toEqual([]);
    expect(r.attributes['FileFunction']).toEqual(['Copper', 'L1', 'Top']);
    expect(r.objects.map((o) => [o.kind, o.dark])).toEqual([['flash', true], ['draw', true], ['draw', true], ['draw', true], ['region', true], ['flash', false]]);
    const [pad, line, arc, mark, area, cleared] = r.objects as [FabObject, FabObject, FabObject, FabObject, FabObject, FabObject];
    // the rounded rectangle: the corners' centres ± the radius
    expect(pad.box.map((v) => +v.toFixed(6))).toEqual([9.3, 4.4, 10.7, 5.6]);
    expect(line.track).toBe(0.25);
    // a quarter circle round 20, 10 from below to the right: its box, the pen's half width round it
    expect(arc.box.map((v) => +v.toFixed(6))).toEqual([19.875, 4.875, 25.125, 10.125]);
    expect(mark.track).toBeUndefined();
    // drawn clockwise, kept counter-clockwise (filled non-zero)
    const contour = (area.parts[0]!.shape as { contours: { segs: { x: number; y: number }[] }[] }).contours[0]!;
    expect(contour.segs[0]).toEqual({ x: 40, y: 0 });
    expect(centre(cleared)).toEqual([35, 5]);
    const set = readFabFiles([{ name: 'x-F_Cu.gbr', content: src }]);
    expect(set.summary.smallestTrack).toBe(0.25);
    expect(set.files[0]!.software).toBe('KiCad Pcbnew 7.0.10');
  });

  it('reads old files: inches, trailing zeros left out, single-quadrant arcs', () => {
    const r = readGerber(['%FSTAX24Y24*%', '%MOIN*%', '%ADD10C,0.010*%', 'G74*', 'D10*', 'X01Y0D02*', 'G03X0Y01I01J0D01*', 'M02*'].join('\n'));
    expect(r.notes).toEqual(['trailing zeros omitted (deprecated)']);
    // a quarter circle round the origin, 25.4 mm across, the pen 0.254 mm wide
    expect(r.objects[0]!.box.map((v) => +v.toFixed(6))).toEqual([-0.127, -0.127, 25.527, 25.527]);
  });

  it('repeats a step and repeat block, and flashes an aperture block with its polarities turned in clear polarity', () => {
    const r = readGerber([
      '%FSLAX26Y26*%', '%MOMM*%', '%ADD10C,1*%',
      '%ABD20*%', 'D10*', 'X0Y0D03*', '%LPC*%', '%ADD11C,0.5*%', 'D11*', 'X0Y0D03*', '%LPD*%', '%AB*%',
      '%SRX2Y3I10J5*%', 'D20*', 'X1000000Y1000000D03*', '%SR*%',
      '%LPC*%', 'D20*', 'X50000000Y0D03*', 'M02*',
    ].join('\n'));
    expect(r.objects).toHaveLength(2 * 6 + 2);
    const at = r.objects.filter((o) => o.dark && o.box[2] - o.box[0] === 1).map(centre);
    expect(at).toHaveLength(6);
    for (const p of [[1, 1], [11, 1], [1, 6], [11, 6], [1, 11], [11, 11]]) expect(at.some((c) => near(c, p))).toBe(true);
    expect(r.objects.slice(-2).map((o) => [o.dark, centre(o)])).toEqual([[false, [50, 0]], [true, [50, 0]]]);
  });

  it('reads Excellon: inches with leading zeros kept, plating per tool, a repeat and a G85 slot', () => {
    const r = readExcellon(['M48', ';FILE_FORMAT=2:4', 'INCH,LZ', ';TYPE=PLATED', 'T1F00S00C0.0300', ';TYPE=NON_PLATED', 'T2C0.1250', '%', 'G90', 'G05', 'T1', 'X01Y01', 'X015Y0', 'R2X01', 'T2', 'X0Y02G85X01Y02', 'M30'].join('\n'));
    expect(r.notes).toEqual([]);
    expect(r.holes.map((h) => [+h.x.toFixed(3), +h.y.toFixed(3), +h.d.toFixed(3), h.plated, !!h.slot])).toEqual([
      [25.4, 25.4, 0.762, true, false],
      [38.1, 0, 0.762, true, false],
      [63.5, 0, 0.762, true, false],
      [88.9, 0, 0.762, true, false],
      [0, 50.8, 3.175, false, true],
    ]);
  });

  it('reads KiCad\'s drill file with plated and non-plated tools in one and a routed slot', () => {
    const src = [
      'M48', '; DRILL file {KiCad 7.0.10} date 2024-01-01', '; FORMAT={-:-/ absolute / metric / decimal}',
      '; #@! TF.GenerationSoftware,Kicad,Pcbnew,7.0.10', '; #@! TF.FileFunction,MixedPlating,1,2', 'FMAT,2', 'METRIC',
      '; #@! TA.AperFunction,Plated,PTH,ViaDrill', 'T1C0.400', '; #@! TA.AperFunction,NonPlated,NPTH,ComponentDrill', 'T2C3.200', '%',
      'G90', 'G05', 'T1', 'X10.0Y-5.0', 'T2', 'X20.0Y-5.0', 'G00X30.0Y-5.0', 'M15', 'G01X32.0Y-5.0', 'M16', 'G05', 'M30',
    ].join('\n');
    const set = readFabFiles([{ name: 'board.drl', content: src }]);
    expect(set.files[0]!.layer).toMatchObject({ id: 'Drill', kind: 'drill' });
    expect(set.summary.drills).toEqual([{ d: 0.4, plated: true, holes: 1, slots: 0 }, { d: 3.2, plated: false, holes: 1, slots: 1 }]);
    const slot = set.files[0]!.objects[2]!;
    expect(slot.box.map((v) => +v.toFixed(6))).toEqual([28.4, -6.6, 33.6, -3.4]);
  });

  it('tells a layer from the names KiCad, Altium, Eagle and EasyEDA give their files', () => {
    const pad = '%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,0.1*%\nD10*\nX0Y0D03*\nM02*\n';
    const id = (name: string) => readFabFiles([{ name, content: pad }]).files[0]!.layer.id;
    const names: Record<string, string> = {
      'board-F_Cu.gbr': 'F.Cu', 'board-In2_Cu.gbr': 'In2.Cu', 'board-B_SilkS.gbr': 'B.Silkscreen', 'board-Edge_Cuts.gbr': 'Edge.Cuts',
      'board.GTL': 'F.Cu', 'board.G1': 'In1.Cu', 'board.GBS': 'B.Mask', 'board.GTP': 'F.Paste', 'board.GKO': 'Edge.Cuts',
      'board.cmp': 'F.Cu', 'board.sol': 'B.Cu', 'board.sts': 'B.Mask', 'board.plc': 'F.Silkscreen',
      'copper_bottom.gbr': 'B.Cu', 'silkscreen_top.gbr': 'F.Silkscreen', 'soldermask_bottom.gbr': 'B.Mask', 'profile.gbr': 'Edge.Cuts',
      'Gerber_TopPasteMaskLayer.GTP': 'F.Paste', 'F_Cu.gbr': 'F.Cu',
    };
    for (const [name, want] of Object.entries(names)) expect(id(name), name).toBe(want);
    expect(readFabFiles([{ name: 'readme.gbr', content: pad }]).files[0]!.layer).toMatchObject({ kind: 'other', by: 'guess' });
    // the stack: inner layers between the outer ones, by their number
    const set = readFabFiles(['b-B_Cu.gbr', 'b-In2_Cu.gbr', 'b-F_Cu.gbr', 'b-In1_Cu.gbr'].map((name) => ({ name, content: pad })));
    expect(set.files.map((f) => [f.layer.id, f.layer.order])).toEqual([['F.Cu', 1], ['In1.Cu', 2], ['In2.Cu', 3], ['B.Cu', 4]]);
    expect(set.summary.notes).toEqual(['no board outline (Edge.Cuts, profile): the size is that of everything drawn', 'no drill file']);
  });

  it('unzips a stored and a deflated zip', async () => {
    const files = [{ name: 'a-F_Cu.gbr', content: '%FSLAX46Y46*%\nM02*\n' }, { name: 'b.drl', content: 'M48\nM30\n' }];
    const stored = await unzip(zip(files));
    expect(stored.map((f) => [f.name, new TextDecoder().decode(f.data)])).toEqual(files.map((f) => [f.name, f.content]));
    expect((await unzip(deflated(files))).map((f) => [f.name, new TextDecoder().decode(f.data)])).toEqual(files.map((f) => [f.name, f.content]));
    await expect(unzip(new Uint8Array(40))).rejects.toThrow('not a zip file');
  });
});

/** A zip with every file deflated (method 8), as fab houses and EDA tools write them. */
function deflated(files: { name: string; content: string }[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const raw = enc.encode(f.content);
    const data = new Uint8Array(deflateRawSync(raw));
    const head = (size: number, sig: number) => {
      const h = new Uint8Array(size + name.length);
      const v = new DataView(h.buffer);
      v.setUint32(0, sig, true);
      const o = sig === 0x04034b50 ? 0 : 2; // the central record has "version made by" first
      v.setUint16(8 + o, 8, true);
      v.setUint32(14 + o, crc32(raw), true);
      v.setUint32(18 + o, data.length, true);
      v.setUint32(22 + o, raw.length, true);
      v.setUint16(26 + o, name.length, true);
      if (o) v.setUint32(42, offset, true);
      h.set(name, size);
      return h;
    };
    const local = head(30, 0x04034b50);
    central.push(head(46, 0x02014b50));
    parts.push(local, data);
    offset += local.length + data.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, files.length, true);
  v.setUint16(10, files.length, true);
  v.setUint32(12, size, true);
  v.setUint32(16, offset, true);
  const out = new Uint8Array(offset + size + 22);
  let p = 0;
  for (const part of [...parts, ...central, end]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}
