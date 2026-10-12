<script lang="ts">
  import { untrack } from 'svelte';
  import { CHECKED_SCH_RULES, SCHEMATIC_RULES, paramNumber, parseSchematicRules, type RuleLevel } from '@4k7/schema';
  import { app } from '../../app.svelte.ts';
  import Field from './Field.svelte';
  import Section from './Section.svelte';

  /** The text in the box; the setting stores '' while it equals the shipped default. */
  let text = $state(untrack(() => app.rulesText));
  let timer: ReturnType<typeof setTimeout> | undefined;

  // another tab (or Reset) changed the setting: show it, unless it is what the box already says
  $effect(() => {
    const t = app.rulesText;
    if (t !== untrack(() => text)) text = t;
  });

  /** Line ends as the default has them, so a pasted CRLF copy of it still counts as the default. */
  const lf = (t: string) => t.replace(/\r\n?/g, '\n').trim();

  function save() {
    clearTimeout(timer);
    timer = undefined;
    const next = lf(text) === lf(SCHEMATIC_RULES) ? '' : text;
    if (next !== app.settings.schematicRules) void app.updateSettings({ schematicRules: next });
  }

  function typed() {
    clearTimeout(timer);
    timer = setTimeout(save, 800);
  }

  function reset() {
    clearTimeout(timer);
    text = SCHEMATIC_RULES;
    void app.updateSettings({ schematicRules: '' });
  }

  const parsed = $derived(parseSchematicRules(text));
  const checked = $derived(CHECKED_SCH_RULES.map((id) => ({ id, level: parsed.rules[id]?.level ?? 'off', max: paramNumber(parsed.rules[id]?.param) })));
  const guidanceOnly = $derived(Object.keys(parsed.rules).filter((id) => !(CHECKED_SCH_RULES as readonly string[]).includes(id)));
  // the box, not the saved setting: the save lands after a pause, and Reset must work right away
  const edited = $derived(lf(text) !== lf(SCHEMATIC_RULES) || app.settings.schematicRules !== '');
  const cls = (l: RuleLevel) => (l === 'error' ? 'err' : l === 'warning' ? 'warn' : l === 'info' ? 'info' : '');
</script>

<Section id="rules" title="Schematic rules">
  {#snippet status()}
    {#if edited}<span class="tag info">edited</span>{:else}<span class="tag">default</span>{/if}
  {/snippet}

  <Field label="Ruleset">
    {#snippet hint()}
      Plain text is guidance the agent reads with every request. A <code>### SCH.ID: title</code> heading with a <code>level:</code> line (error, warning, info or off) is a rule the kernel checks; <code>param:</code> sets its threshold. Saved as you type.
    {/snippet}
    <textarea class="text mono rules" spellcheck="false" aria-label="Schematic rules" bind:value={text} oninput={typed} onblur={save}></textarea>
    <div class="row">
      <button class="btn" onclick={reset} disabled={!edited}>Reset to default</button>
    </div>
  </Field>

  <Field label="Checked">
    <div class="list">
      {#each checked as r (r.id)}<span class="rule"><code>{r.id}</code><span class="tag {cls(r.level)}">{r.level}</span>{#if r.max !== undefined}<span class="muted">max {r.max}</span>{/if}</span>{/each}
    </div>
    {#snippet hint()}
      {#if guidanceOnly.length}Guidance only (no kernel check yet): {guidanceOnly.join(', ')}{:else}Every rule in the text has a kernel check.{/if}
    {/snippet}
  </Field>
</Section>

<style>
  .rules { width: 100%; box-sizing: border-box; min-height: 320px; max-height: 60vh; resize: vertical; line-height: 1.45; tab-size: 2; }
  .row { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
  .list { display: flex; flex-wrap: wrap; gap: 4px 10px; padding-top: 3px; }
  .rule { display: inline-flex; align-items: center; gap: 4px; }
</style>
