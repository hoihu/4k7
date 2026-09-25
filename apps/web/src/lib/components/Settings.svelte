<script lang="ts">
  import { ANTHROPIC_MODELS } from '@tracewise/agent';
  import type { Design } from '@tracewise/schema';
  import { app } from '../app.svelte.ts';
  import type { Settings } from '../persist.ts';

  let key = $state(app.apiKey);
  let reveal = $state(false);
  let saved = $state(false);
  let fileInput: HTMLInputElement | undefined = $state();

  async function saveKey() {
    await app.updateSettings({ provider: key.trim() ? 'anthropic' : 'demo' }, key);
    saved = true;
    setTimeout(() => (saved = false), 1500);
  }

  function set<K extends keyof Settings>(k: K, v: Settings[K]) {
    void app.updateSettings({ [k]: v } as Partial<Settings>);
  }

  async function exportFile() {
    const json = await app.exportJson();
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${app.k?.summary.name ?? 'design'}.twd.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function importFile(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      await app.importDesign(JSON.parse(await f.text()) as Design);
      app.flash(`Loaded ${f.name}`);
      app.view = 'sch';
    } catch (err) {
      app.flash(`Import failed: ${(err as Error).message}`);
    }
  }

  const modelInfo = $derived(ANTHROPIC_MODELS.find((m) => m.id === app.settings.model));
</script>

<div class="set">
  <section class="card">
    <div class="ph"><b>AI provider</b><span class="grow"></span>{#if app.isDemo}<span class="tag warn">offline demo</span>{:else}<span class="tag ok">{app.providerLabel}</span>{/if}</div>
    <table class="tbl">
      <tbody>
        <tr>
          <td>Provider</td>
          <td>
            <select class="text" value={app.settings.provider} onchange={(e) => set('provider', (e.currentTarget as HTMLSelectElement).value as Settings['provider'])}>
              <option value="anthropic">Anthropic (your API key)</option>
              <option value="demo">Offline demo (scripted, no key)</option>
            </select>
          </td>
        </tr>
        <tr>
          <td>API key</td>
          <td>
            <div class="row">
              <input class="text grow mono" type={reveal ? 'text' : 'password'} bind:value={key} placeholder="sk-ant-…" autocomplete="off" spellcheck="false" />
              <button class="ib" onclick={() => (reveal = !reveal)}>{reveal ? 'hide' : 'show'}</button>
              <button class="btn pri" onclick={saveKey}>{saved ? 'Saved' : 'Save'}</button>
            </div>
            <div class="hint">Encrypted in this browser (WebCrypto, non-extractable key) and sent only to api.anthropic.com. Calls are billed to your account.</div>
          </td>
        </tr>
        <tr>
          <td>Model</td>
          <td>
            <select class="text" value={app.settings.model} onchange={(e) => set('model', (e.currentTarget as HTMLSelectElement).value)}>
              {#each ANTHROPIC_MODELS as m (m.id)}<option value={m.id}>{m.label} · ${m.price.input}/${m.price.output} per MTok</option>{/each}
            </select>
          </td>
        </tr>
        <tr>
          <td>Effort</td>
          <td>
            <select class="text" value={app.settings.effort} disabled={!modelInfo?.effort} onchange={(e) => set('effort', (e.currentTarget as HTMLSelectElement).value as Settings['effort'])}>
              {#each ['low', 'medium', 'high', 'xhigh', 'max'] as e (e)}<option value={e}>{e}</option>{/each}
            </select>
            <span class="hint inline">higher = more thorough, more tokens</span>
          </td>
        </tr>
        <tr><td>Session spend</td><td class="mono">${app.spend.toFixed(3)} <span class="muted">(estimate from token usage)</span></td></tr>
      </tbody>
    </table>
  </section>

  <section class="card">
    <div class="ph"><b>Agent behaviour</b></div>
    <table class="tbl">
      <tbody>
        <tr>
          <td>Autonomy</td>
          <td>
            <div class="seg">
              <button aria-pressed={app.settings.mode === 'review'} onclick={() => set('mode', 'review')}>Review each changeset</button>
              <button aria-pressed={app.settings.mode === 'auto'} onclick={() => set('mode', 'auto')}>Auto-commit when clean</button>
            </div>
          </td>
        </tr>
        <tr>
          <td>Fix budget</td>
          <td>
            <select class="text" value={String(app.settings.fixBudget)} onchange={(e) => set('fixBudget', Number((e.currentTarget as HTMLSelectElement).value))}>
              {#each [2, 3, 5, 8] as n (n)}<option value={String(n)}>{n} verification rounds</option>{/each}
            </select>
            <span class="hint inline">applies to new conversations</span>
          </td>
        </tr>
        <tr>
          <td>Theme</td>
          <td>
            <div class="seg">
              {#each ['system', 'light', 'dark'] as t (t)}
                <button aria-pressed={app.settings.theme === t} onclick={() => set('theme', t as Settings['theme'])}>{t}</button>
              {/each}
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </section>

  <section class="card">
    <div class="ph"><b>Project</b><span class="grow"></span><span class="muted">stored locally in IndexedDB</span></div>
    <table class="tbl">
      <tbody>
        <tr>
          <td>Name</td>
          <td><input class="text" value={app.k?.summary.name ?? ''} onchange={(e) => app.renameProject((e.currentTarget as HTMLInputElement).value)} /></td>
        </tr>
        <tr>
          <td>Native file</td>
          <td class="row">
            <button class="btn" onclick={exportFile}>Export .twd.json</button>
            <button class="btn" onclick={() => fileInput?.click()}>Import…</button>
            <input type="file" accept=".json,application/json" hidden bind:this={fileInput} onchange={importFile} />
          </td>
        </tr>
        <tr>
          <td>Reset</td>
          <td><button class="btn" onclick={() => { if (app.k?.summary.components.length === 0 || window.confirm('Start a new, empty project? The current one is replaced.')) void app.newProject(); }}>New empty project</button></td>
        </tr>
      </tbody>
    </table>
  </section>

  <section class="card">
    <div class="ph"><b>Coming next</b></div>
    <ul class="soon">
      <li><b>M1</b> Datasheet PDF → verified part (Parts view)</li>
      <li><b>M2</b> Board, stack-up and placement (Layout view)</li>
      <li><b>M4</b> MCP servers and the local relay for external agents</li>
      <li>OpenAI-compatible and local (Ollama) providers</li>
    </ul>
  </section>
</div>

<style>
  .set { overflow: auto; display: grid; align-content: start; align-items: start; grid-template-columns: repeat(auto-fit, minmax(min(100%, 440px), 1fr)); gap: 10px; padding: 10px; height: 100%; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; min-width: 0; }
  .tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  .tbl td { padding: 6px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .tbl tr:last-child td { border-bottom: 0; }
  .tbl td:first-child { color: var(--txt-3); width: 110px; padding-top: 9px; }
  .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .hint { font-size: 11px; color: var(--txt-3); margin-top: 4px; }
  .hint.inline { margin-left: 6px; }
  select.text { max-width: 100%; }
  .soon { margin: 0; padding: 8px 10px 10px 28px; color: var(--txt-2); font-size: 12.5px; }
  .soon li { margin: 3px 0; }
</style>
