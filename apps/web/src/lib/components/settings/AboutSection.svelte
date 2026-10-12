<script lang="ts">
  import { app } from '../../app.svelte.ts';
  import { server } from '../../server.svelte.ts';
  import Logo from '../Logo.svelte';
  import Section from './Section.svelte';

  const diag = $derived.by(() => {
    void app.settings;
    void server.status;
    return app.diagnostics();
  });
</script>

<Section id="about" title="About">
  <p class="intro">
    <Logo size={28} />
    <span><b>4k7</b>: AI-first PCB schematic and layout, in your browser. <a href="https://4k7.dev" target="_blank" rel="noreferrer">4k7.dev</a> · <a href="https://github.com/hoihu/4k7" target="_blank" rel="noreferrer">GitHub</a></span>
  </p>
  <dl>
    <dt>App build</dt><dd>{diag.build}</dd>
    <dt>Address</dt><dd>{diag.origin}</dd>
    <dt>Local server</dt><dd>{server.status}{server.port ? ` · port ${server.port}` : ''}{server.error ? ` · ${server.error}` : ''}</dd>
    <dt>Log file</dt><dd>~/.4k7/server.log</dd>
    <dt>Browser</dt><dd class="ua">{diag.userAgent}</dd>
  </dl>
</Section>

<style>
  .intro { display: flex; align-items: center; gap: 10px; margin: 0; padding: 10px; border-bottom: 1px solid var(--line); font-size: 12.5px; }
  dl { display: grid; grid-template-columns: 110px 1fr; gap: 3px 8px; margin: 0; padding: 8px 10px; font-size: 12px; }
  dt { color: var(--txt-3); }
  dd { margin: 0; font-family: var(--mono); font-size: 11.5px; overflow-wrap: anywhere; }
  .ua { color: var(--txt-3); }
</style>
