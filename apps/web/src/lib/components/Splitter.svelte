<script lang="ts">
  import { panes, setPane, PANE_DEFAULT, PANE_MIN, type PaneId } from '../panes.svelte.ts';

  /** The column this handle sizes; it sits on the column's inner edge (right of the chat, left of the details). */
  let { pane }: { pane: PaneId } = $props();

  // dragging right widens the chat and narrows the details
  const dir = $derived(pane === 'chat' ? 1 : -1);
  let drag = $state<{ x: number; w: number } | null>(null);

  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag = { x: e.clientX, w: panes[pane] };
    document.body.classList.add('col-resizing');
  }
  function move(e: PointerEvent) {
    if (drag) setPane(pane, drag.w + dir * (e.clientX - drag.x));
  }
  function up() {
    drag = null;
    document.body.classList.remove('col-resizing');
  }
  function key(e: KeyboardEvent) {
    const step = e.shiftKey ? 50 : 10;
    if (e.key === 'ArrowLeft') setPane(pane, panes[pane] - dir * step);
    else if (e.key === 'ArrowRight') setPane(pane, panes[pane] + dir * step);
    else if (e.key === 'Home') setPane(pane, PANE_DEFAULT[pane]);
    else return;
    e.preventDefault();
  }
</script>

<!-- a focusable separator is a widget (WAI-ARIA window splitter); svelte counts every separator as static -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="split {pane}"
  class:on={drag}
  role="separator"
  aria-orientation="vertical"
  aria-label={pane === 'chat' ? 'Resize the chat' : 'Resize the side panel'}
  aria-valuenow={panes[pane]}
  aria-valuemin={PANE_MIN[pane]}
  tabindex="0"
  title="Drag to resize · double-click to reset"
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  ondblclick={() => setPane(pane, PANE_DEFAULT[pane])}
  onkeydown={key}
></div>

<style>
  /* a wide grab area over the 1px gap between the columns; the line lights up on hover and drag */
  .split { position: absolute; top: 0; bottom: 0; width: 9px; z-index: 6; cursor: col-resize; touch-action: none; }
  .split.chat { right: -5px; }
  .split.side { left: -5px; }
  .split::after { content: ''; position: absolute; top: 0; bottom: 0; left: 3px; width: 3px; background: transparent; transition: background .12s; }
  .split:hover::after, .split.on::after, .split:focus-visible::after { background: var(--accent); }
  .split:focus-visible { outline: none; }
  /* narrow screens stack the panes or show one at a time */
  @media (max-width: 900px) { .split { display: none; } }
  :global(body.col-resizing) { cursor: col-resize; user-select: none; }
  :global(body.col-resizing iframe), :global(body.col-resizing canvas) { pointer-events: none; }
</style>
