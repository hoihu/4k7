/**
 * What the chat's model picker offers: the sources (a coding agent on this computer, or a model API
 * with the user's key) and the models of each, and how a choice maps onto the settings.
 */
import { ANTHROPIC_MODELS, apiService, type ApiServiceId } from '@4k7/agent';
import { HARNESSES, type HarnessCapability, type HarnessId } from '@4k7/schema';
import type { Settings } from './persist.ts';

export type Source = { kind: 'agent'; id: HarnessId } | { kind: 'api'; id: ApiServiceId };

/** A source and one of its models ('' = the agent's own default). */
export interface ModelChoice {
  source: Source;
  model: string;
}

/** Stable id of a choice, for favorites: `agent:claude-code:claude-opus-5`. */
export function choiceKey(c: ModelChoice): string {
  return `${c.source.kind}:${c.source.id}:${c.model}`;
}

export function parseChoiceKey(key: string): ModelChoice | null {
  const m = /^(agent|api):([^:]+):(.*)$/.exec(key);
  if (!m) return null;
  return { source: { kind: m[1] as 'agent', id: m[2] as HarnessId }, model: m[3]! } as ModelChoice;
}

export function sameSource(a: Source, b: Source): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/** What the chat uses now. */
export function currentChoice(s: Settings): ModelChoice {
  if (s.provider === 'agent') return { source: { kind: 'agent', id: s.harness }, model: s.harnessModels[s.harness] ?? '' };
  return { source: { kind: 'api', id: s.api }, model: s.apiModels[s.api] ?? '' };
}

/** The settings change that makes the chat use `c`. */
export function choicePatch(c: ModelChoice, s: Settings): Partial<Settings> {
  if (c.source.kind === 'agent') return { provider: 'agent', harness: c.source.id, harnessModels: { ...s.harnessModels, [c.source.id]: c.model } };
  return { provider: 'api', api: c.source.id, apiModels: { ...s.apiModels, [c.source.id]: c.model } };
}

export function sourceName(src: Source): string {
  return src.kind === 'agent' ? (HARNESSES.find((h) => h.id === src.id)?.name ?? src.id) : apiService(src.id).name;
}

/** A short mark for the source (the picker's rail and button). */
export function sourceMark(src: Source): string {
  const marks: Record<string, string> = {
    'claude-code': '✻',
    copilot: 'GH',
    opencode: 'OC',
    anthropic: '✻',
    'anthropic-compatible': '✻',
    openai: 'AI',
    openrouter: 'OR',
    gemini: 'G',
    local: 'L',
    'openai-compatible': '⇄',
  };
  return marks[src.id] ?? src.id.slice(0, 2).toUpperCase();
}

/** Claude Code's model aliases (they follow the newest model of the family). */
const CLAUDE_ALIASES = ['opus', 'sonnet', 'fable', 'haiku'];

export function modelLabel(c: ModelChoice): string {
  if (!c.model) return c.source.kind === 'agent' ? `${sourceName(c.source)} default` : 'no model';
  const known = ANTHROPIC_MODELS.find((m) => m.id === c.model);
  if (known && (c.source.id === 'claude-code' || apiService(c.source.id).format === 'anthropic')) return known.label;
  if (c.source.id === 'claude-code' && CLAUDE_ALIASES.includes(c.model)) return `${c.model[0]!.toUpperCase()}${c.model.slice(1)} (newest)`;
  return c.model;
}

/**
 * The models a source offers: what the agent's CLI listed (or Claude's), the API's own list (`listed`),
 * and the one chosen now even when no list has it.
 */
export function modelsOf(src: Source, opts: { harnesses: HarnessCapability[]; listed?: string[]; current?: string }): string[] {
  const ids: string[] = [];
  if (src.kind === 'agent') {
    ids.push('');
    if (src.id === 'claude-code') ids.push(...ANTHROPIC_MODELS.map((m) => m.id), ...CLAUDE_ALIASES);
    else ids.push(...(opts.harnesses.find((h) => h.id === src.id)?.models ?? []));
  } else {
    ids.push(...apiService(src.id).models, ...(opts.listed ?? []));
  }
  if (opts.current && !ids.includes(opts.current)) ids.splice(src.kind === 'agent' ? 1 : 0, 0, opts.current);
  return [...new Set(ids)];
}

/** Whether a model has an effort setting (only the Anthropic Messages API takes one for now). */
export function hasEffort(c: ModelChoice): boolean {
  if (c.source.kind !== 'api' || apiService(c.source.id).format !== 'anthropic') return false;
  const info = ANTHROPIC_MODELS.find((m) => c.model.startsWith(m.id));
  return !info || info.effort;
}
