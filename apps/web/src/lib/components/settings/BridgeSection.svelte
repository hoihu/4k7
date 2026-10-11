<script lang="ts">
  import { app } from '../../app.svelte.ts';
  import { bridge } from '../../bridge.svelte.ts';
  import Field from './Field.svelte';
  import Section from './Section.svelte';

  let copied = $state(false);
  const mcpCommand = `claude mcp add --scope user tracewise -- ${__BRIDGE_MCP__}`;
  const bridgeRun = __BRIDGE_RUN__;
  const where = __PACKAGED__ ? '' : ' (in this repository)';

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(mcpCommand);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      app.flash('Copy failed; select the command and copy it manually.');
    }
  }

  async function reconnect() {
    if (await bridge.connect(app.settings.bridgeToken, { preferPort: app.settings.bridgePort })) app.flash(`Connected to ${bridge.agent ?? 'the bridge'}`);
  }

  /** Forgets the access key too: this tab connects again only when opened with the bridge's link. */
  function disconnect() {
    bridge.disconnect();
    void app.updateSettings({ bridgeToken: '', bridgePort: null });
  }

  const linked = $derived(bridge.status === 'connected' || bridge.status === 'waiting');
</script>

<Section id="bridge" title="Local bridge">
  {#snippet status()}
    {#if bridge.status === 'connected'}<span class="tag ok">connected · {bridge.agent ?? 'MCP client'} · :{bridge.port}</span>
    {:else if bridge.status === 'connecting'}<span class="tag info">connecting…</span>
    {:else if bridge.status === 'waiting'}<span class="tag warn">waiting for bridge</span>
    {:else if bridge.status === 'elsewhere'}<span class="tag warn">connected in another tab</span> <button class="btn" onclick={() => bridge.useThisTab()}>Use this tab</button>
    {:else}<span class="tag">off</span>{/if}
  {/snippet}

  <Field label="Connection">
    {#snippet hint()}
      The app's address (<code>http://localhost:7777/…</code>) carries the bridge's access key. Opening the link the bridge prints connects this tab.
    {/snippet}
    <div class="row">
      {#if linked}<button class="btn" onclick={disconnect}>Disconnect</button>
      {:else if app.settings.bridgeToken && bridge.status === 'off'}<button class="btn pri" onclick={reconnect}>Connect</button>
      {:else if !app.settings.bridgeToken}<span class="muted">Not connected. Open the link the bridge prints.</span>{/if}
    </div>
    {#if bridge.error}<div class="err">{bridge.error}</div>{/if}
  </Field>

  <Field label="Access">
    <span class="muted">127.0.0.1 only, this app's pages only. Changes arrive as changesets for you to review.</span>
  </Field>

  <details class="how">
    <summary>How to connect</summary>
    <div class="ways">
      <div class="way">
        <b>Chat in this app</b>
        <p>Start the bridge in a terminal and open the link it prints. Then choose <a href="#provider">Claude Code</a> as chat provider.</p>
        <div class="cmd"><code>{bridgeRun}</code></div>
        {#if where}<p class="muted">Run it in this repository.</p>{/if}
      </div>
      <div class="way">
        <b>Drive this tab from the Claude Code CLI</b>
        {#if where}
          <p>Start <code>claude</code> in this repository and approve the <b>tracewise</b> MCP server it offers from <code>.mcp.json</code>. To use it from any folder, register it once:</p>
        {:else}
          <p>Register the <b>tracewise</b> MCP server once:</p>
        {/if}
        <div class="cmd"><code>{mcpCommand}</code><button class="ib" onclick={copyCommand}>{copied ? 'copied' : 'copy'}</button></div>
        <p>Then ask Claude to <i>“connect to Tracewise”</i>. It gives you the app's link; opening it connects this tab.</p>
      </div>
    </div>
    <p class="note">The tab reconnects by itself when the bridge or Claude Code restarts.</p>
  </details>
</Section>

<style>
  .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .err { color: var(--err); margin-top: 6px; font-size: 12px; }
  .how { padding: 8px 10px 10px; font-size: 12.5px; border-top: 1px solid var(--line); }
  .how summary { cursor: pointer; color: var(--txt-3); }
  .ways { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: 10px; margin-top: 8px; }
  .way { background: var(--panel-2); border-radius: 6px; padding: 8px 10px; min-width: 0; }
  .way > b { display: block; margin-bottom: 4px; }
  .way p { margin: 4px 0; color: var(--txt-2); }
  .cmd { display: flex; align-items: center; gap: 4px; margin: 6px 0; background: var(--canvas); border: 1px solid var(--line); border-radius: 6px; padding: 4px 4px 4px 8px; }
  .cmd code { flex: 1; min-width: 0; overflow-x: auto; white-space: nowrap; font-size: 11.5px; }
  .note { margin: 8px 0 0; font-size: 11px; color: var(--txt-3); }
</style>
