<script lang="ts">
  import { ENCLOSURE_NOTES_PLACEHOLDER } from '@4k7/schema';
  import { app } from '../../app.svelte.ts';
  import NotesField from './NotesField.svelte';
  import Section from './Section.svelte';
</script>

<Section id="enclosure" title="Enclosure">
  {#snippet status()}
    {#if app.settings.enclosureNotes.trim()}<span class="tag info">your own</span>{:else}<span class="tag">default</span>{/if}
  {/snippet}
  <NotesField setting="enclosureNotes" what="how to design enclosures (printer, material, fasteners, fits)" placeholder={ENCLOSURE_NOTES_PLACEHOLDER} />
</Section>
