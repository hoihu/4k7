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
</Section>

<style>
  dl { display: grid; grid-template-columns: 110px 1fr; gap: 3px 8px; margin: 0; padding: 8px 10px 4px; font-size: 12px; }
  dt { color: var(--txt-3); }
  dd { margin: 0; font-family: var(--mono); font-size: 11.5px; overflow-wrap: anywhere; }
  dd.bad { color: var(--err); }
  .ua { color: var(--txt-3); }
  .hint { font-size: 11px; color: var(--txt-3); margin: 0; padding: 0 10px 8px; }
</style>
