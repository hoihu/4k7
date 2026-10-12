import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../src/lib/persist.ts';
import { choiceKey, choicePatch, currentChoice, currentEffort, effortLevels, effortPatch, modelLabel, modelsOf, parseChoiceKey, type ModelChoice } from '../src/lib/models.ts';

const settings = (s: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...s });

describe('the chat model picker', () => {
  it('reads the choice from the settings and writes it back', () => {
    const s = settings({ provider: 'agent', harness: 'opencode', harnessModels: { opencode: 'a/b', copilot: 'gpt-5.2' } });
    expect(currentChoice(s)).toEqual({ source: { kind: 'agent', id: 'opencode' }, model: 'a/b' });
    const patch = choicePatch({ source: { kind: 'api', id: 'openrouter' }, model: 'x/y' }, s);
    expect(patch).toMatchObject({ provider: 'api', api: 'openrouter', apiModels: { openrouter: 'x/y' } });
    // switching agents keeps the model chosen for each
    expect(choicePatch({ source: { kind: 'agent', id: 'claude-code' }, model: 'sonnet' }, s).harnessModels).toEqual({ opencode: 'a/b', copilot: 'gpt-5.2', 'claude-code': 'sonnet' });
  });

  it('round-trips favorites keys, model ids with colons included', () => {
    const c: ModelChoice = { source: { kind: 'api', id: 'local' }, model: 'qwen3:32b' };
    expect(parseChoiceKey(choiceKey(c))).toEqual(c);
    expect(parseChoiceKey('nonsense')).toBeNull();
  });

  it('lists the default, the known models and the current one', () => {
    const cc = modelsOf({ kind: 'agent', id: 'claude-code' }, { harnesses: [], current: 'claude-x' });
    expect(cc.slice(0, 2)).toEqual(['', 'claude-x']);
    expect(cc).toContain('claude-opus-5');
    const oc = modelsOf({ kind: 'agent', id: 'opencode' }, { harnesses: [{ id: 'opencode', name: 'OpenCode', available: true, models: ['p/m'] }] });
    expect(oc).toEqual(['', 'p/m']);
    expect(modelsOf({ kind: 'api', id: 'openai' }, { harnesses: [], listed: ['gpt-5'], current: '' })).toEqual(['gpt-5']);
  });

  it('labels models', () => {
    expect(modelLabel({ source: { kind: 'agent', id: 'claude-code' }, model: '' })).toBe('Claude Code default');
    expect(modelLabel({ source: { kind: 'agent', id: 'claude-code' }, model: 'opus' })).toBe('Opus (newest)');
    expect(modelLabel({ source: { kind: 'api', id: 'anthropic' }, model: 'claude-opus-5-5' })).toBe('Claude Opus 5.5');
    expect(modelLabel({ source: { kind: 'api', id: 'openai' }, model: 'gpt-5' })).toBe('gpt-5');
  });

  it('offers effort where the agent or API takes it', () => {
    expect(effortLevels({ source: { kind: 'api', id: 'anthropic' }, model: 'claude-opus-5' })).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortLevels({ source: { kind: 'api', id: 'anthropic' }, model: 'claude-haiku-4-5' })).toBeNull();
    expect(effortLevels({ source: { kind: 'api', id: 'openai' }, model: 'gpt-5' })).toBeNull();
    expect(effortLevels({ source: { kind: 'agent', id: 'claude-code' }, model: 'opus' })?.[0]).toBe(''); // the agent's own default first
    expect(effortLevels({ source: { kind: 'agent', id: 'claude-code' }, model: 'haiku' })).toBeNull();
    expect(effortLevels({ source: { kind: 'agent', id: 'copilot' }, model: '' })).not.toBeNull();
    expect(effortLevels({ source: { kind: 'agent', id: 'opencode' }, model: 'a/b' })).toBeNull();
  });

  it('keeps an effort per agent, apart from the API one', () => {
    const s = settings({ provider: 'agent', harness: 'copilot', effort: 'high' });
    expect(currentEffort(s)).toBe('');
    const set = settings({ ...s, ...effortPatch(s, 'max') });
    expect(set.harnessEfforts).toEqual({ copilot: 'max' });
    expect(set.effort).toBe('high');
    expect(settings({ ...set, ...effortPatch(set, '') }).harnessEfforts).toEqual({});
    expect(currentEffort(settings({ provider: 'api', effort: 'low' }))).toBe('low');
  });
});
