<script lang="ts">
  import AboutSection from './settings/AboutSection.svelte';
  import AgentSection from './settings/AgentSection.svelte';
  import AgentsSection from './settings/AgentsSection.svelte';
  import AppearanceSection from './settings/AppearanceSection.svelte';
  import ServerSection from './settings/ServerSection.svelte';
  import ProjectSection from './settings/ProjectSection.svelte';
  import ProviderSection from './settings/ProviderSection.svelte';

  const nav = [
    { id: 'provider', label: 'Chat provider' },
    { id: 'server', label: 'Local server' },
    { id: 'agent', label: 'Agent' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'project', label: 'Project' },
    { id: 'about', label: 'About' },
  ];

  let scroller: HTMLDivElement | undefined = $state();

  function jump(id: string) {
    scroller?.querySelector(`#${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
</script>

<div class="set">
  <nav class="nav" aria-label="Settings sections">
    {#each nav as n (n.id)}<button class="ib" onclick={() => jump(n.id)}>{n.label}</button>{/each}
  </nav>
  <div class="col" bind:this={scroller}>
    <ProviderSection />
    <AgentsSection />
    <ServerSection />
    <AgentSection />
    <AppearanceSection />
    <ProjectSection />
    <AboutSection />
  </div>
</div>

<style>
  .set { display: grid; grid-template-columns: 150px minmax(0, 680px); gap: 10px; padding: 10px; height: 100%; overflow: hidden; }
  .nav { display: flex; flex-direction: column; align-items: stretch; gap: 2px; padding-top: 2px; }
  .nav button { text-align: left; font-size: 12.5px; padding: 4px 8px; }
  .col { overflow: auto; display: flex; flex-direction: column; gap: 10px; min-width: 0; padding-right: 2px; }
  @media (max-width: 720px) {
    .set { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto 1fr; }
    .nav { flex-direction: row; flex-wrap: wrap; }
  }
</style>
