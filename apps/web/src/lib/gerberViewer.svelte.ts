/**
 * The Gerber viewer's state (Tools): the production files open in it and how they are shown. The
 * viewer and the agent's view_gerbers share it, so the user sees what the agent looks at.
 */
import { gerbers, panelBoard, readFabFiles, unzip, type FabFileRead, type FabSet } from '@4k7/fab';
import type { BoardView, GerberViewInfo, Rect } from '@4k7/schema';

/** What is open: this board's production files, its panel's, or files the user opened. */
export type GerberSource = 'board' | 'panel' | 'files';

/** Zip files carry these beside the real ones (macOS's resource forks, folders). */
const junk = (name: string) => name.startsWith('__MACOSX/') || /(^|\/)\._/.test(name) || /(^|\/)\.DS_Store$/.test(name);
const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

class GerberViewer {
  source = $state<GerberSource | null>(null);
  /** What is open, in words: "spiral2 (this board)", "spiral2-fab.zip", "12 files". */
  title = $state('');
  set = $state.raw<FabSet | null>(null);
  /** Layers switched off, by id. */
  hidden = $state<Record<string, boolean>>({});
  /** Seen from below: mirrored, the bottom layers in front. */
  below = $state(false);
  /** The area to show (files' mm; x, y the bottom-left corner), null: all of it; the canvas fits it in each time `fit` counts up. */
  frame: Rect | null = null;
  fit = $state(0);
  /** Files that could not be opened (not a zip it can read). */
  error = $state('');
  busy = $state(false);
  /** The area on screen, said by the canvas (null when the viewer is closed). */
  visible: (() => Rect | null) | null = null;
  /** The height of the board (or panel) the files were made from: their y counts up from its bottom edge. Null: files opened. */
  boardHeight: number | null = null;
  /** The board the files were made from (they are made again when it changes). */
  private madeFrom: BoardView | null = null;

  /** This board's production files, or its panel's, as Fab files (Layout) writes them. */
  fromBoard(b: BoardView, project: string, panel = false) {
    const source = panel ? 'panel' : 'board';
    if (this.madeFrom === b && this.source === source) return;
    const name = project.replace(/[^\w.-]+/g, '_') || 'board';
    const files = panel && b.panel ? gerbers(panelBoard(b, b.panel), `${name}-panel`, b.panel) : gerbers(b, name);
    this.open(readFabFiles(files), source, `${project} (${panel ? 'its panel' : 'this board'})`);
    this.madeFrom = b;
    this.boardHeight = panel && b.panel ? b.panel.h : b.outline.h;
  }

  /** Files the user dropped or picked: Gerbers, drill files, zips of them. */
  async fromFiles(list: File[]) {
    if (!list.length) return;
    this.busy = true;
    this.error = '';
    try {
      const dec = new TextDecoder();
      const files: { name: string; content: string }[] = [];
      for (const f of list) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        if (!isZip(bytes)) files.push({ name: f.name, content: dec.decode(bytes) });
        else for (const z of await unzip(bytes)) if (!junk(z.name)) files.push({ name: z.name.split('/').pop()!, content: dec.decode(z.data) });
      }
      this.open(readFabFiles(files), 'files', list.length === 1 ? list[0]!.name : `${list.length} files`);
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.busy = false;
    }
  }

  private open(set: FabSet, source: GerberSource, title: string) {
    // the same files again (made anew after an edit): keep the view and the layers switched off
    if (source !== this.source || source === 'files') {
      this.hidden = {};
      this.show(null);
    }
    this.set = set;
    this.source = source;
    this.title = title;
    this.madeFrom = null;
    this.boardHeight = null;
  }

  /** Show an area (null: everything). */
  show(frame: Rect | null) {
    this.frame = frame;
    this.fit++;
  }

  /** The layers shown. */
  get shown(): FabFileRead[] {
    return this.set?.files.filter((f) => !this.hidden[f.layer.id]) ?? [];
  }

  /** The area of everything open: the board's, with a margin. */
  whole(): Rect | null {
    const b = this.set?.summary.board;
    if (!b) return null;
    const m = Math.max(b.w, b.h) * 0.04 + 1;
    return { x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m };
  }

  /** What the user has on screen here, for the agent's <view>. */
  viewInfo(): GerberViewInfo | null {
    const rect = this.visible?.();
    const b = this.set?.summary.board;
    if (!this.set || !this.source || !rect) return null;
    const r1 = (v: number) => Math.round(v * 10) / 10;
    return {
      view: 'gerbers',
      source: this.source,
      title: this.title,
      rect: { x: r1(rect.x), y: r1(rect.y), w: r1(rect.w), h: r1(rect.h) },
      whole: !b || (rect.x <= b.x && rect.y <= b.y && rect.x + rect.w >= b.x + b.w && rect.y + rect.h >= b.y + b.h),
      below: this.below,
      layers: this.shown.map((f) => f.layer.id),
      hidden: this.set.files.filter((f) => this.hidden[f.layer.id]).map((f) => f.layer.id),
    };
  }
}

export const gerberViewer = new GerberViewer();
