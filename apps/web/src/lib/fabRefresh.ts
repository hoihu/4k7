import type { FabProfile } from '@4k7/schema';

/**
 * The message that asks the agent to re-read the page a fab profile's limits came from and
 * import them again. The stored profile is a snapshot; this is how the user updates it.
 */
export function fabRefreshPrompt(fab: FabProfile, today: string): string {
  const was = fab.source.checked ? `checked ${fab.source.checked}` : 'checked on an unknown date';
  return (
    `Refresh the manufacturer limits for this board: ${fab.house}, ${fab.tier}. ` +
    `Read ${fab.source.url} now (the stored limits were ${was}) and compare each limit with the stored ones (design_query get_fab_profiles). ` +
    `Then import what the page says with set_fab_profile: house "${fab.house}", tier "${fab.tier}", layers [${fab.layers.join(', ')}], source_url ${fab.source.url}, checked ${today}, limits in mm, keeping the notes that still apply. ` +
    `Say which limits changed (old → new). If nothing changed, say so and import the same limits so the date is current. ` +
    `If you cannot read the page, say so and change nothing. Never fill in a number the page does not state.`
  );
}
