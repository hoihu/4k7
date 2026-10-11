<script lang="ts">
  import { ANTHROPIC_MODELS, API_SERVICES, apiService, listOpenAIModels } from '@4k7/agent';
  import { HARNESSES, type HarnessId } from '@4k7/schema';
  import { app } from '../../app.svelte.ts';
  import { server } from '../../server.svelte.ts';
  import type { Settings } from '../../persist.ts';
  import Field from './Field.svelte';
  import Section from './Section.svelte';

  let key = $state(app.apiKey);
  let reveal = $state(false);
  let saved = $state(false);
  /** Models the chosen API listed (GET /models), and why that failed. */
  let listed = $state<string[]>([]);
  let listing = $state(false);
  let listError = $state('');

  const serverRun = __SERVER_RUN__;
  const where = __PACKAGED__ ? '' : ' (in this repository)';

  const choices: { id: Settings['provider']; name: string; blurb: string }[] = [
    { id: 'agent', name: 'Coding agent', blurb: 'Claude Code, GitHub Copilot or OpenCode on this computer, with your plan or company login. Needs the local server.' },
    { id: 'api', name: 'API key', blurb: 'Anthropic, OpenAI, OpenRouter, Gemini, a local model or a company gateway. Billed per token.' },
  ];

  /** What each agent's web access is made of. */
  const webTools: Record<HarnessId, string> = { 'claude-code': 'WebSearch and WebFetch', copilot: 'web_fetch', opencode: 'webfetch (and websearch where the provider has it)' };
  const modelHint: Record<HarnessId, string> = {
    'claude-code': '',
    copilot: 'default, or e.g. gpt-5.2, claude-sonnet-4.5, auto',
    opencode: 'default, or provider/model',
  };

  function set<K extends keyof Settings>(k: K, v: Settings[K]) {
    void app.updateSettings({ [k]: v } as Partial<Settings>);
  }

  function setHarnessModel(m: string) {
    set('harnessModels', { ...app.settings.harnessModels, [app.settings.harness]: m.trim() });
  }

  async function setService(id: Settings['api']) {
    listed = [];
    listError = '';
    await app.updateSettings({ api: id });
    key = app.apiKey;
  }

  function setApiUrl(u: string) {
    const urls = { ...app.settings.apiUrls };
    const v = u.trim().replace(/\/+$/, '');
    if (!v || v === service.baseURL) delete urls[app.settings.api];
    else urls[app.settings.api] = v;
    set('apiUrls', urls);
  }

  function setApiModel(m: string) {
    set('apiModels', { ...app.settings.apiModels, [app.settings.api]: m.trim() });
  }

  async function saveKey() {
    await app.updateSettings({ provider: 'api' }, key);
    saved = true;
    setTimeout(() => (saved = false), 1500);
  }

  async function listModels() {
    listing = true;
    listError = '';
    try {
      listed = await listOpenAIModels(app.settings.apiUrls[app.settings.api] || service.baseURL, app.apiKey);
      if (!listed.length) listError = 'The API listed no models.';
    } catch (e) {
      listError = (e as Error).message;
    } finally {
      listing = false;
    }
  }

  const provider = $derived(app.settings.provider);
  const harness = $derived(app.harness);
  const service = $derived(apiService(app.settings.api));
  const apiModel = $derived(app.settings.apiModels[app.settings.api] ?? '');
  const modelInfo = $derived(ANTHROPIC_MODELS.find((m) => m.id === apiModel));
  const suggestions = $derived([...new Set([...service.models, ...listed])]);
  const host = $derived.by(() => {
    try {
      return new URL(app.settings.apiUrls[app.settings.api] || service.baseURL).host;
    } catch {
      return 'the address above';
    }
  });
</script>

<Section id="provider" title="Chat provider">
  {#snippet status()}
    {#if app.noModel}<span class="tag warn">{app.apiProblem}</span>{:else}<span class="tag ok">{app.providerLabel}</span>{/if}
  {/snippet}

  <div class="choices" role="radiogroup" aria-label="Chat provider">
    {#each choices as c (c.id)}
      <button class="choice" role="radio" aria-checked={provider === c.id} onclick={() => set('provider', c.id)}>
        <b>{c.name}</b>
        <span>{c.blurb}</span>
      </button>
    {/each}
  </div>

  {#if provider === 'agent'}
    <Field label="Agent" hint="Runs headlessly per message with only the 4k7 tools: no shell, no files.">
      <div class="seg">
        {#each HARNESSES as h (h.id)}
          {@const cap = server.harnesses.find((c) => c.id === h.id)}
          <button aria-pressed={app.settings.harness === h.id} onclick={() => set('harness', h.id)} title={cap ? (cap.available ? cap.version : cap.reason) : undefined}>
            {h.name}{#if cap && !cap.available}<span class="off"> · not found</span>{/if}
          </button>
        {/each}
      </div>
    </Field>
    <Field label="Status">
      {#if server.status === 'connected' && harness.available}
        <span class="tag ok">ready</span> <span class="muted">{harness.version} · runs your local {harness.name} with only the 4k7 tools</span>
      {:else if server.status === 'connected'}
        <span class="tag warn">server connected, {harness.name} unavailable</span>
        <div class="hint">
          {#if server.harnesses.length}{harness.reason ?? 'Not found on this computer.'} Install it from <a href={HARNESSES.find((h) => h.id === harness.id)?.install} target="_blank" rel="noreferrer">its site</a>, sign in once in a terminal, then restart the server.
          {:else}This server only knows Claude Code. Update it (restart it).{/if}
        </div>
      {:else}
        <span class="tag warn">not connected</span>
        <div class="hint">{#if __APP_RUN__}Open {serverRun} again{:else}Run <code>{serverRun}</code>{where} and open the link it prints{/if} (see <a href="#server">Local server</a>).</div>
      {/if}
    </Field>
    <Field label="Model">
      {#snippet hint()}
        Uses your {harness.name} login and plan.
        {#if app.lastModel}Last reply came from <span class="mono">{app.lastModel}</span>.{:else}The model shows here after the first reply.{/if}
      {/snippet}
      {#if harness.id === 'claude-code'}
        <div class="seg">
          <button aria-pressed={!app.settings.harnessModels['claude-code']} onclick={() => setHarnessModel('')}>default</button>
          {#each ['opus', 'sonnet', 'fable', 'haiku'] as m (m)}
            <button aria-pressed={app.settings.harnessModels['claude-code'] === m} onclick={() => setHarnessModel(m)}>{m}</button>
          {/each}
        </div>
      {:else}
        {#key harness.id}
          <input class="text grow mono" list="harness-models" value={app.settings.harnessModels[harness.id] ?? ''} placeholder={modelHint[harness.id]} spellcheck="false" autocomplete="off" onchange={(e) => setHarnessModel((e.currentTarget as HTMLInputElement).value)} />
        {/key}
        <datalist id="harness-models">{#each harness.models ?? [] as m (m)}<option value={m}></option>{/each}</datalist>
      {/if}
    </Field>
    <Field label="Web" hint={`Read-only ${webTools[harness.id]}. Still no shell or file access.`}>
      <label class="check">
        <input type="checkbox" checked={app.settings.agentWeb} onchange={(e) => set('agentWeb', (e.currentTarget as HTMLInputElement).checked)} />
        Let {harness.name} read the web (datasheets, application notes)
      </label>
    </Field>
  {:else}
    <Field label="Service" hint={service.note}>
      <select class="text" value={app.settings.api} onchange={(e) => void setService((e.currentTarget as HTMLSelectElement).value as Settings['api'])}>
        {#each API_SERVICES as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
      </select>
    </Field>
    <Field label="Address" hint={service.format === 'anthropic' ? 'Anthropic Messages API.' : 'OpenAI Chat Completions API: the address up to /v1.'}>
      {#key app.settings.api}
        <input class="text grow mono" value={app.settings.apiUrls[app.settings.api] ?? service.baseURL} placeholder="https://…/v1" spellcheck="false" autocomplete="off" onchange={(e) => setApiUrl((e.currentTarget as HTMLInputElement).value)} />
      {/key}
    </Field>
    <Field label="API key">
      {#snippet hint()}
        Encrypted in this browser (WebCrypto) and sent only to {host}.
        {#if !service.keyHint}Not needed for a local server.{:else if service.keysUrl}<a href={service.keysUrl} target="_blank" rel="noreferrer">Get a key</a>.{/if}
      {/snippet}
      <div class="row">
        <input class="text grow mono" type={reveal ? 'text' : 'password'} bind:value={key} placeholder={service.keyHint || 'none'} autocomplete="off" spellcheck="false" />
        <button class="ib" onclick={() => (reveal = !reveal)}>{reveal ? 'hide' : 'show'}</button>
        <button class="btn pri" onclick={saveKey}>{saved ? 'Saved' : 'Save'}</button>
      </div>
    </Field>
    <Field label="Model">
      {#snippet hint()}
        {#if listError}<span class="err">{listError}</span>
        {:else if service.id === 'anthropic'}{modelInfo ? `$${modelInfo.price.input}/$${modelInfo.price.output} per million tokens in/out.` : ''}
        {:else}A model that supports tool calls (function calling).{#if app.lastModel} Last reply came from <span class="mono">{app.lastModel}</span>.{/if}{/if}
      {/snippet}
      {#if service.id === 'anthropic'}
        <select class="text" value={apiModel} onchange={(e) => setApiModel((e.currentTarget as HTMLSelectElement).value)}>
          {#each ANTHROPIC_MODELS as m (m.id)}<option value={m.id}>{m.label} · ${m.price.input}/${m.price.output} per MTok</option>{/each}
        </select>
      {:else}
        <div class="row">
          {#key app.settings.api}
            <input class="text grow mono" list="api-models" value={apiModel} placeholder="model id" spellcheck="false" autocomplete="off" onchange={(e) => setApiModel((e.currentTarget as HTMLInputElement).value)} />
          {/key}
          <datalist id="api-models">{#each suggestions as m (m)}<option value={m}></option>{/each}</datalist>
          {#if service.format === 'openai'}<button class="btn" disabled={listing} onclick={listModels}>{listing ? 'Listing…' : 'List models'}</button>{/if}
        </div>
      {/if}
    </Field>
    {#if service.format === 'anthropic'}
      <Field label="Effort" hint={!modelInfo || modelInfo.effort ? 'Higher is more thorough and uses more tokens.' : 'This model has no effort setting.'}>
        <div class="seg" class:off={!!modelInfo && !modelInfo.effort}>
          {#each ['low', 'medium', 'high', 'xhigh', 'max'] as e (e)}
            <button aria-pressed={app.settings.effort === e} disabled={!!modelInfo && !modelInfo.effort} onclick={() => set('effort', e as Settings['effort'])}>{e}</button>
          {/each}
        </div>
      </Field>
    {/if}
  {/if}

  <Field label="Session spend" hint="API price of the tokens used, where the model's price is known. A subscription (Claude, Copilot) is not billed per token.">
    <span class="mono">${app.spend.toFixed(3)}</span>{#if provider === 'api' && app.lastModel}<span class="muted"> · last reply from <span class="mono">{app.lastModel}</span></span>{/if}
  </Field>
</Section>

<style>
  .choices { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--line); }
  .choice { display: flex; flex-direction: column; gap: 2px; align-items: flex-start; text-align: left; padding: 7px 9px; border: 1px solid var(--line-2); border-radius: 6px; background: var(--panel-2); color: var(--txt-2); font-size: 12px; }
  .choice b { color: var(--txt); font-size: 12.5px; }
  .choice span { font-size: 11px; color: var(--txt-3); }
  .choice:hover { background: var(--hover); }
  .choice[aria-checked="true"] { border-color: var(--accent); background: var(--accent-soft); }
  .choice[aria-checked="true"] b { color: var(--accent-txt); }
  .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .check { display: flex; gap: 6px; align-items: center; }
  .hint { font-size: 11px; color: var(--txt-3); margin-top: 4px; }
  .seg .off { color: var(--txt-3); }
  .err { color: var(--err); }
  input.text { width: 100%; box-sizing: border-box; }
  .row input.text { width: auto; flex: 1 1 200px; }
  select.text { max-width: 100%; }
  .seg.off { opacity: .5; }
  @media (max-width: 560px) { .choices { grid-template-columns: 1fr; } }
</style>
