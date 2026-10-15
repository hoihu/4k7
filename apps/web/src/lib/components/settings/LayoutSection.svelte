<script lang="ts">
  import { LAYOUT_NOTES_PLACEHOLDER } from '@4k7/schema';
  import { app } from '../../app.svelte.ts';
  import NotesField from './NotesField.svelte';
  import Section from './Section.svelte';
</script>

<Section id="layout" title="Board layout">
  {#snippet status()}
    {#if app.settings.layoutNotes.trim()}<span class="tag info">your own</span>{:else}<span class="tag">default</span>{/if}
  {/snippet}
  <NotesField setting="layoutNotes" what="how to lay out boards" placeholder={LAYOUT_NOTES_PLACEHOLDER} />
</Section>
