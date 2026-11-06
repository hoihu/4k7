<script lang="ts">
  import { app } from '../app.svelte.ts';
  import Chat from './Chat.svelte';
  import GerberViewer from './GerberViewer.svelte';
  import Splitter from './Splitter.svelte';

  /** Tools: the Gerber viewer for the production files. The chat stays beside it, so the agent can be asked about what is on screen. */
</script>

<section class="tools" class:nochat={!app.chatOpen}>
  <div class="col chatcol">{#if app.chatOpen}<Chat /><Splitter pane="chat" />{/if}</div>
  <GerberViewer />
</section>

<style>
  .tools { display: grid; grid-template-columns: var(--chat-col) minmax(0, 1fr) var(--side-col); gap: 1px; background: var(--line); height: 100%; min-height: 0; }
  .tools.nochat { grid-template-columns: 0 minmax(0, 1fr) var(--side-col); }
  .col { position: relative; background: var(--panel); min-height: 0; min-width: 0; display: flex; flex-direction: column; }
  @media (max-width: 900px) {
    .tools, .tools.nochat { grid-template-columns: minmax(0, 1fr); grid-template-rows: 60% 40%; }
    .chatcol { display: none; }
  }
</style>
