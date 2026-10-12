import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { loadSettings, saveSettings, type Settings } from '../src/lib/persist.ts';

/** Stores settings as an older version wrote them. */
const saveOld = (old: Record<string, unknown>) => saveSettings(old as unknown as Settings);

describe('settings of versions before the agent and API choices', () => {
  it('turns the Anthropic provider into the Anthropic API, keeping the model', async () => {
    await saveOld({ provider: 'anthropic', model: 'claude-sonnet-5', effort: 'medium', theme: 'light' });
    const s = await loadSettings();
    expect(s).toMatchObject({ provider: 'api', api: 'anthropic', apiModels: { anthropic: 'claude-sonnet-5' }, effort: 'medium', theme: 'light' });
    expect(s).not.toHaveProperty('model');
  });

  it('turns Claude Code into the Claude Code agent, keeping its model and web access', async () => {
    await saveOld({ provider: 'claude-code', model: 'claude-opus-5', claudeModel: 'sonnet', claudeWeb: true });
    const s = await loadSettings();
    expect(s).toMatchObject({ provider: 'agent', harness: 'claude-code', harnessModels: { 'claude-code': 'sonnet' }, agentWeb: true });
    expect(s).not.toHaveProperty('claudeModel');
    expect(s).not.toHaveProperty('claudeWeb');
  });

  it('keeps current settings as they are', async () => {
    await saveOld({ provider: 'agent', harness: 'opencode', harnessModels: { opencode: 'github-copilot/claude-sonnet-5' }, api: 'openrouter', apiModels: { openrouter: 'x/y' }, apiUrls: {} });
    expect(await loadSettings()).toMatchObject({ provider: 'agent', harness: 'opencode', harnessModels: { opencode: 'github-copilot/claude-sonnet-5' }, api: 'openrouter', apiModels: { openrouter: 'x/y' } });
  });

  it('falls back to the default for the offline demo', async () => {
    await saveOld({ provider: 'demo' });
    expect((await loadSettings()).provider).toBe('agent');
  });

  it('saves settings held in proxies (the app keeps them in Svelte state)', async () => {
    const s = await loadSettings();
    await saveSettings({ ...s, harnessModels: new Proxy({ 'claude-code': 'opus' }, {}), project: 'blinker' });
    expect(await loadSettings()).toMatchObject({ harnessModels: { 'claude-code': 'opus' }, project: 'blinker' });
  });
});
