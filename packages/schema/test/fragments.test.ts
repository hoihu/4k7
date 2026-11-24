/**
 * Shapes the op catalogue repeats (a rectangle in mm, a copper layer, a 90° rotation, a sheet name) are written once
 * in packages/schema/src/ops.ts and shared. This walks every op and fails when a site spells one out again.
 * A shared fragment with its own describe text is a clone that keeps the fragment's def, so sites compare by def.
 * See docs/design/ops-api.md.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EditOp, QueryOp, boardRef, copperLayer, designWideBoardRef, rectMm, rot90, sheetRef } from '../src/ops.ts';

type Site = { path: string; schema: z.ZodType };

const ops = [...EditOp.options, ...QueryOp.options] as z.ZodObject[];

/** Every schema reachable from the ops, with its path (op.field.…); optional, nullable and default wrappers are looked through. */
function walk(schema: z.ZodType, path: string, out: Site[]): Site[] {
  const def = schema.def as unknown as Record<string, unknown>;
  const wrapper = schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault;
  if (!wrapper) out.push({ path, schema });
  if (schema instanceof z.ZodObject) for (const [k, v] of Object.entries(schema.shape)) walk(v as z.ZodType, `${path}.${k}`, out);
  else if (wrapper) walk(def.innerType as z.ZodType, path, out);
  else if (schema instanceof z.ZodArray) walk(def.element as z.ZodType, `${path}[]`, out);
  else if (schema instanceof z.ZodUnion) (def.options as z.ZodType[]).forEach((o, i) => walk(o, `${path}|${i}`, out));
  else if (schema instanceof z.ZodTuple) (def.items as z.ZodType[]).forEach((o, i) => walk(o, `${path}[${i}]`, out));
  return out;
}
const sites = ops.flatMap((o) => walk(o, o.shape.op.value as string, []));

/** The schema without its optional/nullable wrappers. */
function bare(schema: z.ZodType): z.ZodType {
  let s = schema;
  while (s instanceof z.ZodOptional || s instanceof z.ZodNullable) s = (s.def as unknown as { innerType: z.ZodType }).innerType;
  return s;
}
const same = (a: z.ZodType, b: z.ZodType) => a.def === b.def;

const keys = (s: z.ZodType) => (s instanceof z.ZodObject ? Object.keys(s.shape).sort().join(',') : '');
const literals = (s: z.ZodType) =>
  s instanceof z.ZodUnion ? (s.def.options as z.ZodType[]).map((o) => (o instanceof z.ZodLiteral ? String(o.value) : '?')).join(',') : '';

describe('shared schema fragments', () => {
  it('every { x_mm, y_mm, width_mm, height_mm } rectangle is rectMm', () => {
    const rects = sites.filter((s) => keys(s.schema) === 'height_mm,width_mm,x_mm,y_mm');
    expect(rects.length).toBeGreaterThanOrEqual(6);
    expect(rects.filter((s) => !same(s.schema, rectMm)).map((s) => s.path)).toEqual([]);
  });

  it('constrain keeps its own room rectangle', () => {
    const rect = bare(ops.find((o) => o.shape.op.value === 'constrain')!.shape.rect as z.ZodType);
    expect(keys(rect)).toBe('h,w,x,y');
  });

  it('every copper-layer enum is copperLayer', () => {
    const layers = sites.filter((s) => s.schema instanceof z.ZodEnum && [...s.schema.options].sort().join(',') === 'B.Cu,F.Cu,In1.Cu,In2.Cu');
    expect(layers.length).toBeGreaterThanOrEqual(7);
    expect(layers.filter((s) => !same(s.schema, copperLayer)).map((s) => s.path)).toEqual([]);
  });

  it('every 0/90/180/270 rotation is rot90', () => {
    const rots = sites.filter((s) => literals(s.schema) === '0,90,180,270');
    expect(rots.length).toBeGreaterThanOrEqual(2);
    expect(rots.filter((s) => !same(s.schema, rot90)).map((s) => s.path)).toEqual([]);
  });

  it('every sheet field is sheetRef, optional where the op allows it', () => {
    const sheets = sites.filter((s) => /\.sheet$/.test(s.path));
    expect(sheets.length).toBeGreaterThanOrEqual(7);
    expect(sheets.filter((s) => !same(bare(s.schema), sheetRef)).map((s) => s.path)).toEqual([]);
    expect(sheetRef.safeParse('').success).toBe(false);
  });

  it('add_waiver, set_fab_profile and set_net take an optional board that means every board when absent, not boardRef', () => {
    for (const name of ['add_waiver', 'set_fab_profile', 'set_net']) {
      const board = ops.find((o) => o.shape.op.value === name)!.shape.board as z.ZodType;
      expect(board, name).not.toBe(boardRef);
      expect(same(board, boardRef), name).toBe(false);
      expect(same(board, designWideBoardRef), name).toBe(true);
      expect(board.safeParse(undefined).success, name).toBe(true);
      expect(board.safeParse('').success, name).toBe(false);
      expect(board.description, name).toMatch(/every board/);
    }
  });
});
