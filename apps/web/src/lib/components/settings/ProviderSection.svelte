<script lang="ts">
  import { ANTHROPIC_MODELS } from '@tracewise/agent';
  import { app } from '../../app.svelte.ts';
  import { bridge } from '../../bridge.svelte.ts';
  import type { Settings } from '../../persist.ts';
  import Field from './Field.svelte';
  import Section from './Section.svelte';

  let key = $state(app.apiKey);
  let reveal = $state(false);
  let saved = $state(false);

  const bridgeRun = __BRIDGE_RUN__;
  const where = __HOSTED__ ? '' : ' (in this repository)';

  const choices: { id: Settings['provider']; name: string; blurb: string }[] = [
    { id: 'claude-code', name: 'Claude Code', blurb: 'On this computer, with your plan. Needs the local bridge.' },
    { id: 'anthropic', name: 'Anthropic API', blurb: 'Your own API key, billed per token.' },
    { id: 'demo', name: 'Offline demo', blurb: 'Scripted answers, no key, nothing leaves the browser.' },
  ];

  function set<K extends keyof Settings>(k: K, v: Settings[K]) {
    void app.updateSettings({ [k]: v } as Partial<Settings>);
  }

  async function saveKey() {
    await app.updateSettings({ provider: key.trim() ? 'anthropic' : 'demo' }, key);
    saved = true;
    setTimeout(() => (saved = false), 1500);
  }

  const modelInfo = $derived(ANTHROPIC_MODELS.find((m) => m.id === app.settings.model));
  const provider = $derived(app.settings.provider);
</script>

<Section id="provider" title="Chat provider">
  {#snippet status()}
    {#if app.isDemo}<span class="tag warn">offline demo</span>{:else}<span class="tag ok">{app.providerLabel}</span>{/if}
  {/snippet}

  <div class="choices" role="radiogroup" aria-label="Chat provider">
    {#each choices as c (c.id)}
      <button class="choice" role="radio" aria-checked={provider === c.id} onclick={() => set('provider', c.id)}>
        <b>{c.name}</b>
        <span>{c.blurb}</span>
      </button>
    {/each}
  </div>

  {#if provider === 'claude-code'}
    <Field label="Status">
      {#if bridge.status === 'connected' && bridge.chat?.available}
        <span class="tag ok">ready</span> <span class="muted">{bridge.chat.version} · runs your local Claude Code with only the Tracewise tools</span>
      {:else if bridge.status === 'connected'}
        <span class="tag warn">bridge connected, chat unavailable</span>
        <div class="hint">{bridge.chat?.reason ?? 'This bridge is too old for the app chat. Restart it.'}</div>
      {:else}
        <span class="tag warn">not connected</span>
        <div class="hint">Run <code>{bridgeRun}</code>{where} and open the pairing link it prints, or pair under <a href="#bridge">Local bridge</a>.</div>
      {/if}
    </Field>
    <Field label="Model">
      {#snippet hint()}
        Uses your Claude Code login and plan.
        {#if app.lastModel}Last reply came from <span class="mono">{app.lastModel}</span>.{:else}The model shows here after the first reply.{/if}
      {/snippet}
      <div class="seg">
        <button aria-pressed={app.settings.claudeModel === ''} onclick={() => set('claudeModel', '')}>default</button>
        {#each ['opus', 'sonnet', 'fable', 'haiku'] as m (m)}
          <button aria-pressed={app.settings.claudeModel === m} onclick={() => set('claudeModel', m)}>{m}</button>
        {/each}
      </div>
    </Field>
    <Field label="Web" hint="Read-only WebSearch and WebFetch. Still no shell or file access.">
      <label class="check">
        <input type="checkbox" checked={app.settings.claudeWeb} onchange={(e) => set('claudeWeb', (e.currentTarget as HTMLInputElement).checked)} />
        Let Claude Code read the web (datasheets, application notes)
      </label>
    </Field>
  {:else if provider === 'anthropic'}
    <Field label="API key" hint="Encrypted in this browser (WebCrypto) and sent only to api.anthropic.com.">
      <div class="row">
        <input class="text grow mono" type={reveal ? 'text' : 'password'} bind:value={key} placeholder="sk-ant-…" autocomplete="off" spellcheck="false" />
        <button class="ib" onclick={() => (reveal = !reveal)}>{reveal ? 'hide' : 'show'}</button>
        <button class="btn pri" onclick={saveKey}>{saved ? 'Saved' : 'Save'}</button>
      </div>
    </Field>
    <Field label="Model">
      <select class="text" value={app.settings.model} onchange={(e) => set('model', (e.currentTarget as HTMLSelectElement).value)}>
        {#each ANTHROPIC_MODELS as m (m.id)}<option value={m.id}>{m.label} · ${m.price.input}/${m.price.output} per MTok</option>{/each}
      </select>
    </Field>
    <Field label="Effort" hint={modelInfo?.effort ? 'Higher is more thorough and uses more tokens.' : 'This model has no effort setting.'}>
      <div class="seg" class:off={!modelInfo?.effort}>
        {#each ['low', 'medium', 'high', 'xhigh', 'max'] as e (e)}
          <button aria-pressed={app.settings.effort === e} disabled={!modelInfo?.effort} onclick={() => set('effort', e as Settings['effort'])}>{e}</button>
        {/each}
      </div>
    </Field>
  {:else}
    <Field label="Demo">
      <span class="muted">Scripted conversations for trying the app. Pick another provider for real design work.</span>
    </Field>
  {/if}

  {#if provider !== 'demo'}
    <Field label="Session spend" hint="API price of the tokens used. A Claude Code subscription is not billed per token.">
      <span class="mono">${app.spend.toFixed(3)}</span>{#if provider === 'anthropic' && app.lastModel}<span class="muted"> · last reply from <span class="mono">{app.lastModel}</span></span>{/if}
    </Field>
  {/if}
</Section>

<style>
  .choices { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--line); }
  .choice { display: flex; flex-direction: column; gap: 2px; align-items: flex-start; text-align: left; padding: 7px 9px; border: 1px solid var(--line-2); border-radius: 6px; background: var(--panel-2); color: var(--txt-2); font-size: 12px; }
  .choice b { color: var(--txt); font-size: 12.5px; }
  .choice span { font-size: 11px; color: var(--txt-3); }
  .choice:hover { background: var(--hover); }
  .choice[aria-checked="true"] { border-color: var(--accent); background: var(--accent-soft); }
  .choice[aria-checked="true"] b { color: var(--accent-txt); }
  .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .check { display: flex; gap: 6px; align-items: center; }
  .hint { font-size: 11px; color: var(--txt-3); margin-top: 4px; }
  select.text { max-width: 100%; }
  .seg.off { opacity: .5; }
  @media (max-width: 560px) { .choices { grid-template-columns: 1fr; } }
</style>
