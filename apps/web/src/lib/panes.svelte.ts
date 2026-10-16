/**
 * Widths of the side columns: the chat on the left and the details on the right (inspector,
 * layout and enclosure panels). The user drags them; one width each for every view, kept in this
 * browser so a widened chat stays wide.
 */
export type PaneId = 'chat' | 'side';

const KEY = '4k7.panes';
export const PANE_DEFAULT: Record<PaneId, number> = { chat: 330, side: 290 };
export const PANE_MIN: Record<PaneId, number> = { chat: 240, side: 220 };
/** What the canvas keeps when a column is dragged wide. */
const CANVAS_MIN = 280;

function load(): Record<PaneId, number> {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const w = { ...PANE_DEFAULT };
    for (const id of ['chat', 'side'] as const) if (typeof saved[id] === 'number' && saved[id] >= PANE_MIN[id]) w[id] = saved[id];
    return w;
  } catch {
    return { ...PANE_DEFAULT };
  }
}

export const panes = $state(load());

/** Sets a column's width, keeping it above its minimum and leaving the canvas room beside the other column. */
export function setPane(id: PaneId, px: number) {
  const other = id === 'chat' ? panes.side : panes.chat;
  const max = Math.max(PANE_MIN[id], window.innerWidth - other - CANVAS_MIN);
  panes[id] = Math.round(Math.min(max, Math.max(PANE_MIN[id], px)));
  try {
    localStorage.setItem(KEY, JSON.stringify(panes));
  } catch {
    // private mode: the width lasts until the reload
  }
}
