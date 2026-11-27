/**
 * CHECKS (src/checks.ts) lists every code a finding can carry. This reads the code literals out of
 * the sources that report findings and fails when the list and the sources drift apart.
 * See docs/design/spec.md §6.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECKS, UNKNOWN_CODES, checkFamily, isCheckCode } from '../src/checks.ts';

const root = fileURLToPath(new URL('../../..', import.meta.url));
/** Where findings are reported: the packages' sources and the app. */
const dirs = ['packages/schema/src', 'packages/kernel/src', 'packages/parts/src', 'packages/fab/src', 'packages/agent/src', 'apps/web/src', 'tools/server/src'];
/** This file lists the codes; it does not report them. */
const skip = new Set([join(root, 'packages/schema/src/checks.ts')]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : files(path);
    return /\.(ts|svelte)$/.test(name) && !skip.has(path) ? [path] : [];
  });
}

/**
 * A quoted FAMILY.CODE of any family, so a new family is seen too. A literal that ends in "_" is a
 * prefix someone tests with startsWith, not a code.
 */
const literal = /['"`]([A-Z]{2,8}\.[A-Z][A-Z_0-9]*[A-Z0-9])['"`]/g;

const inSources = new Set<string>();
for (const dir of dirs) for (const path of files(join(root, dir))) for (const m of readFileSync(path, 'utf8').matchAll(literal)) inSources.add(m[1]!);

describe('CHECKS lists the codes the sources report', () => {
  it('finds the codes', () => {
    expect(inSources.size).toBeGreaterThan(100);
    expect(checkFamily('DRC.SHORT')).toBe('DRC');
  });

  it('lists every code a source names', () => {
    const missing = [...inSources].filter((code) => !isCheckCode(code)).sort();
    expect(missing, 'codes in the sources that CHECKS does not list').toEqual([]);
  });

  it('lists no code that no source names', () => {
    const stale = Object.keys(CHECKS).filter((code) => !inSources.has(code));
    expect(stale, 'codes in CHECKS that nothing reports').toEqual([]);
  });

  it('names only listed codes as the ones that say "could not judge"', () => {
    const unknown = [...UNKNOWN_CODES].filter((code) => !isCheckCode(code));
    expect(unknown).toEqual([]);
    expect(UNKNOWN_CODES.has('DRC.CURRENT_UNKNOWN')).toBe(true);
  });

  it('is sorted, so two branches that add a code merge without a conflict in most cases', () => {
    const codes = Object.keys(CHECKS);
    expect(codes).toEqual([...codes].sort());
  });
});
