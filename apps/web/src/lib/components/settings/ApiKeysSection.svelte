<script lang="ts">
  import { API_SERVICES, apiProblem, apiService } from '@4k7/agent';
  import { app } from '../../app.svelte.ts';
  import { loadApiKey } from '../../persist.ts';
  import type { Settings } from '../../persist.ts';
  import Field from './Field.svelte';
  import Section from './Section.svelte';

  /**
   * Setting up the model APIs (bring your own key). Which agent or API the chat uses, its model and
   * effort are chosen with the model button under the chat box; the agents' programs under Coding agents.
   */
  let svc = $state<Settings['api']>(app.settings.api);
  let key = $state('');
  let reveal = $state(false);
  let saved = $state(false);

  const service = $derived(apiService(svc));
  const inUse = $derived(app.settings.provider === 'api' && app.settings.api === svc);
  const host = $derived.by(() => {
    try {
      return new URL(app.settings.apiUrls[svc] || service.baseURL).host;
    } catch {
      return 'the address above';
    }
  });

  $effect(() => {
    const id = svc;
    void loadApiKey(id).then((k) => {
      if (svc === id) key = k;
    });
  });

  function setApiUrl(u: string) {
    const urls = { ...app.settings.apiUrls };
    const v = u.trim().replace(/\/+$/, '');
    if (!v || v === service.baseURL) delete urls[svc];
    else urls[svc] = v;
    void app.updateSettings({ apiUrls: urls });
  }

  async function saveKey() {
    await app.saveApiKeyFor(svc, key);
    saved = true;
    setTimeout(() => (saved = false), 1500);
  }

  /** Chat through this service now, with its last model (or its first known one). */
  function use() {
    const model = app.settings.apiModels[svc] || service.models[0] || '';
    void app.updateSettings({ provider: 'api', api: svc, apiModels: { ...app.settings.apiModels, [svc]: model } });
  }
</script>

<Section id="apis" title="API keys">
  {#snippet status()}
    {#if app.settings.provider === 'api'}{#if app.noModel}<span class="tag warn">{app.apiProblem}</span>{:else}<span class="tag ok">chat uses {app.providerLabel}</span>{/if}{/if}
  {/snippet}

  <Field label="Service" hint={service.note ?? 'Billed per token by the service. Choose the model with the model button under the chat box.'}>
    <select class="text" bind:value={svc}>
      {#each API_SERVICES as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
    </select>
  </Field>
  <Field label="Address" hint={service.format === 'anthropic' ? 'Anthropic Messages API.' : 'OpenAI Chat Completions API: the address up to /v1.'}>
    {#key svc}
      <input class="text grow mono" value={app.settings.apiUrls[svc] ?? service.baseURL} placeholder="https://…/v1" spellcheck="false" autocomplete="off" onchange={(e) => setApiUrl((e.currentTarget as HTMLInputElement).value)} />
    {/key}
  </Field>
  <Field label="API key">
    {#snippet hint()}
      Encrypted in this browser (WebCrypto) and sent only to {host}. Empty and Save removes it.
      {#if !service.keyHint}Not needed for a local server.{:else if service.keysUrl}<a href={service.keysUrl} target="_blank" rel="noreferrer">Get a key</a>.{/if}
    {/snippet}
    <div class="row">
      <input class="text grow mono" type={reveal ? 'text' : 'password'} bind:value={key} placeholder={service.keyHint || 'none'} autocomplete="off" spellcheck="false" />
      <button class="ib" onclick={() => (reveal = !reveal)}>{reveal ? 'hide' : 'show'}</button>
      <button class="btn" onclick={saveKey}>{saved ? 'Saved' : 'Save'}</button>
    </div>
  </Field>
  <Field label="Chat" hint="A service with a key also shows up in the model button under the chat box.">
    {#if inUse}<span class="muted">The chat uses {service.name}.</span>
    {:else}<button class="btn pri" disabled={!!apiProblem({ service: svc, baseURL: app.settings.apiUrls[svc] ?? '', apiKey: key, model: 'any' })} onclick={use}>Chat with {service.name}</button>{/if}
  </Field>
  <Field label="Session spend" hint="API price of the tokens used, where the model's price is known. A subscription (Claude, Copilot) is not billed per token.">
    <span class="mono">${app.spend.toFixed(3)}</span>{#if app.lastModel}<span class="muted"> · last reply from <span class="mono">{app.lastModel}</span></span>{/if}
  </Field>
</Section>

<style>
  .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  input.text { width: 100%; box-sizing: border-box; }
  .row input.text { width: auto; flex: 1 1 200px; }
  select.text { max-width: 100%; }
</style>
