<script lang="ts">
  import { app } from '../../app.svelte.ts';
  import { bridge } from '../../bridge.svelte.ts';
  import Section from './Section.svelte';

  const diag = $derived.by(() => {
    void app.settings;
    void bridge.status;
    return app.diagnostics();
  });
</script>

<Section id="about" title="About">
  {#snippet status()}<span class="muted mono">{diag.build}</span>{/snippet}
  <dl>
    <dt>Address</dt><dd>{diag.origin}</dd>
    <dt>App build</dt><dd>{diag.build}</dd>
    <dt>Chat provider</dt><dd>{diag.provider}</dd>
    <dt>Storage</dt><dd class:bad={diag.storage !== 'ok'}>{diag.storage}{diag.persistent === true ? ' · persistent' : ' · best-effort'}</dd>
    <dt>Bridge</dt><dd>{bridge.status}{bridge.port ? ` · port ${bridge.port}` : ''}{bridge.error ? ` · ${bridge.error}` : ''}</dd>
    <dt>Claude Code</dt><dd>{bridge.chat ? (bridge.chat.available ? `available (${bridge.chat.version})` : `unavailable: ${bridge.chat.reason}`) : 'unknown (not connected)'}</dd>
    <dt>Browser</dt><dd class="ua">{diag.userAgent}</dd>
  </dl>
  <p class="hint">The bridge logs what each tab reports to <code>~/.tracewise/bridge.log</code>.</p>

  <div class="soon">
    <b>Coming next</b>
    <ul>
      <li><b>M1</b> Datasheet PDF → verified part (Parts view)</li>
      <li><b>M2</b> Board, stack-up and placement (Layout view)</li>
      <li><b>M4</b> Your own MCP servers as tools for the in-app agent</li>
      <li>OpenAI-compatible and local (Ollama) providers</li>
    </ul>
  </div>
</Section>

<style>
  dl { display: grid; grid-template-columns: 110px 1fr; gap: 3px 8px; margin: 0; padding: 8px 10px 4px; font-size: 12px; }
  dt { color: var(--txt-3); }
  dd { margin: 0; font-family: var(--mono); font-size: 11.5px; overflow-wrap: anywhere; }
  dd.bad { color: var(--err); }
  .ua { color: var(--txt-3); }
  .hint { font-size: 11px; color: var(--txt-3); margin: 0; padding: 0 10px 8px; }
  .soon { border-top: 1px solid var(--line); padding: 8px 10px 10px; color: var(--txt-2); font-size: 12.5px; }
  .soon ul { margin: 4px 0 0; padding-left: 18px; }
  .soon li { margin: 3px 0; }
</style>
