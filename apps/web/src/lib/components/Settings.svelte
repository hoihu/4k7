<script lang="ts">
  import AboutSection from './settings/AboutSection.svelte';
  import AgentSection from './settings/AgentSection.svelte';
  import AgentsSection from './settings/AgentsSection.svelte';
  import AppearanceSection from './settings/AppearanceSection.svelte';
  import ServerSection from './settings/ServerSection.svelte';
  import ProjectSection from './settings/ProjectSection.svelte';
  import ApiKeysSection from './settings/ApiKeysSection.svelte';

  const nav = [
    { id: 'project', label: 'General', section: ProjectSection },
    { id: 'appearance', label: 'Appearance', section: AppearanceSection },
    { id: 'agents', label: 'Coding agents', section: AgentsSection },
    { id: 'apis', label: 'API keys', section: ApiKeysSection },
    { id: 'server', label: 'Local server', section: ServerSection },
    { id: 'agent', label: 'Layout and Schematic', section: AgentSection },
    { id: 'about', label: 'About', section: AboutSection },
  ];

  let current = $state('project');
  const Current = $derived(nav.find((n) => n.id === current)!.section);
</script>

<div class="set">
  <nav class="nav" aria-label="Settings sections">
    {#each nav as n (n.id)}<button class="ib" aria-current={current === n.id} onclick={() => (current = n.id)}>{n.label}</button>{/each}
  </nav>
  <div class="col">
    <Current />
  </div>
</div>

<style>
  .set { display: grid; grid-template-columns: 170px minmax(0, 680px); gap: 10px; padding: 10px; height: 100%; overflow: hidden; }
  .nav { display: flex; flex-direction: column; align-items: stretch; gap: 2px; padding-top: 2px; }
  .nav button { text-align: left; font-size: 12.5px; padding: 4px 8px; }
  .nav button[aria-current="true"] { background: var(--panel-2); color: var(--txt); font-weight: 600; }
  .col { overflow: auto; display: flex; flex-direction: column; gap: 10px; min-width: 0; padding-right: 2px; }
  @media (max-width: 720px) {
    .set { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto 1fr; }
    .nav { flex-direction: row; flex-wrap: wrap; }
  }
</style>
