<script lang="ts">
  import { app } from '../../app.svelte.ts';
  import type { Settings } from '../../persist.ts';
  import { SCHEMATIC_THEMES, schematicTheme, schematicThemeStyle, type SchematicThemeId } from '../../schematicThemes.ts';
  import Field from './Field.svelte';
  import Section from './Section.svelte';

  const current = $derived(schematicTheme(app.settings.schematicTheme).id);
</script>

<Section id="appearance" title="Appearance">
  <Field label="Theme">
    <div class="seg">
      {#each ['system', 'light', 'dark'] as t (t)}
        <button aria-pressed={app.settings.theme === t} onclick={() => void app.updateSettings({ theme: t as Settings['theme'] })}>{t}</button>
      {/each}
    </div>
  </Field>
  <Field label="Schematic colours" hint="The schematic canvas only. Printing and the design document stay black on white.">
    <div class="themes" role="radiogroup" aria-label="Schematic colours">
      {#each SCHEMATIC_THEMES as t (t.id)}
        <button
          class="th"
          role="radio"
          aria-checked={current === t.id}
          title={t.hint}
          onclick={() => void app.updateSettings({ schematicTheme: t.id as SchematicThemeId })}
        >
          <!-- a resistor between a net label and ground, in the theme's colours -->
          <svg viewBox="0 0 120 56" style={schematicThemeStyle(t.id) || undefined} aria-hidden="true">
            <rect class="cv" width="120" height="56" />
            <rect class="pp" x="6" y="5" width="108" height="46" rx="1" />
            <polygon class="fl" points="12,19 26,19 30,23 26,27 12,27" />
            <text class="nt" x="14" y="25.5">IN</text>
            <polyline class="w" points="30,23 44,23" />
            <circle class="j" cx="44" cy="23" r="1.8" />
            <polyline class="w" points="44,23 44,38" />
            <line class="g" x1="38" y1="38" x2="50" y2="38" /><line class="g" x1="40.5" y1="41" x2="47.5" y2="41" /><line class="g" x1="42.5" y1="44" x2="45.5" y2="44" />
            <line class="s" x1="44" y1="23" x2="54" y2="23" />
            <rect class="s b" x="54" y="19" width="22" height="8" />
            <line class="s" x1="76" y1="23" x2="86" y2="23" />
            <polyline class="w" points="86,23 106,23" />
            <text class="rf" x="57" y="15">R1</text>
            <text class="vl" x="58" y="35">4k7</text>
          </svg>
          <span class="nm">{t.label}</span>
        </button>
      {/each}
    </div>
  </Field>
</Section>

<style>
  .themes { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: 8px; }
  .th { display: flex; flex-direction: column; gap: 4px; padding: 4px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel-2); cursor: pointer; text-align: left; }
  .th:hover { border-color: var(--line-2); }
  .th[aria-checked="true"] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .th svg { display: block; width: 100%; height: auto; border-radius: 4px; }
  .nm { font-size: 12px; padding: 0 2px 1px; }
  .th[aria-checked="true"] .nm { font-weight: 600; }
  .cv { fill: var(--canvas); }
  .pp { fill: var(--paper); stroke: var(--frame, var(--grid)); stroke-width: .6; }
  .w { stroke: var(--wire); stroke-width: 1.2; fill: none; stroke-linecap: round; stroke-linejoin: round; }
  .j { fill: var(--wire); }
  .g { stroke: var(--supply, var(--wire)); stroke-width: 1.2; stroke-linecap: round; }
  .s { stroke: var(--sym); stroke-width: 1.1; fill: none; }
  .s.b { fill: var(--sym-fill); }
  .fl { fill: var(--flag, var(--canvas)); stroke: var(--label, var(--wire)); stroke-width: .8; }
  text { font-family: var(--mono); }
  .nt { fill: var(--label, var(--wire)); font-size: 6px; font-weight: 600; }
  .rf { fill: var(--ref, var(--sym)); font-size: 6.5px; font-weight: 700; }
  .vl { fill: var(--sch-txt); font-size: 6px; }
</style>
