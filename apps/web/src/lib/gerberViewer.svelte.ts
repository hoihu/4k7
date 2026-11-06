/**
 * The Gerber viewer's state (Tools): the production files open in it and how they are shown. The
 * viewer and the agent's view_gerbers share it, so the user sees what the agent looks at.
 */
import { boardNetDesign, gerbers, ipcNetDesign, isIpc356, panelBoard, readFabFiles, readIpc356, unzip, type CopperCheck, type CopperFinding, type FabFileRead, type FabSet, type NetDesign } from '@4k7/fab';
import type { BoardView, GerberViewInfo, Rect } from '@4k7/schema';
import { checkFiles } from './netcheckClient.ts';

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

  /**
   * The netlist check of what is open (netcheck.ts): its copper read back from the files and held
   * against this board, or against the netlist that came with the files (IPC-D-356), as the fab
   * house does. Null: not checked (checkNote says why).
   */
  check = $state.raw<CopperCheck | null>(null);
  /** What the files were held against: this board, or the netlist among the files. */
  against = $state<'board' | 'netlist' | null>(null);
  checkNote = $state('');
  checking = $state(false);
  /** The finding shown on the canvas. */
  focused = $state.raw<CopperFinding | null>(null);
  private checkRun = 0;
  private pending: Promise<void> = Promise.resolve();

  /** This board's production files, or its panel's, as Fab files (Layout) writes them. */
  fromBoard(b: BoardView, project: string, panel = false) {
    const source = panel ? 'panel' : 'board';
    if (this.madeFrom === b && this.source === source) return;
    const name = project.replace(/[^\w.-]+/g, '_') || 'board';
    const files = panel && b.panel ? gerbers(panelBoard(b, b.panel), `${name}-panel`, b.panel) : gerbers(b, name);
    this.open(readFabFiles(files), source, `${project} (${panel ? 'its panel' : 'this board'})`);
    this.madeFrom = b;
    this.boardHeight = panel && b.panel ? b.panel.h : b.outline.h;
    this.runCheck(files, boardNetDesign(b, panel && b.panel ? b.panel : undefined), true, 'board');
  }

  /** Files the user dropped or picked: Gerbers, drill files, zips of them; checked against the netlist among them, else against `board`. */
  async fromFiles(list: File[], board?: BoardView | null) {
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
      const set = readFabFiles(files);
      this.open(set, 'files', list.length === 1 ? list[0]!.name : `${list.length} files`);
      const layers = set.files.filter((f) => f.layer.kind === 'copper').map((f) => f.layer.id);
      const netlist = files.find((f) => isIpc356(f.content));
      if (netlist) this.runCheck(files, ipcNetDesign(readIpc356(netlist.content), layers), false, 'netlist');
      else if (board?.parts.length && layers.length) this.runCheck(files, boardNetDesign(board), false, 'board');
      else this.noCheck(layers.length ? 'No netlist (IPC-D-356) among the files and no board to hold them against.' : 'No copper layers to check.');
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.busy = false;
    }
  }

  private open(set: FabSet, source: GerberSource, title: string) {
    // the same files again (made anew after an edit): keep the view and the layers switched off,
    // and the check until the new one is done
    if (source !== this.source || source === 'files') {
      this.hidden = {};
      this.show(null);
      this.noCheck('');
    }
    this.set = set;
    this.source = source;
    this.title = title;
    this.madeFrom = null;
    this.boardHeight = null;
  }

  private noCheck(note: string) {
    this.checkRun++;
    [this.check, this.against, this.checkNote, this.checking, this.focused] = [null, null, note, false, null];
  }

  /** Check the files in the worker; a check started later wins. `fresh`: just made from the design. */
  private runCheck(files: { name: string; content: string }[], design: NetDesign, fresh: boolean, against: 'board' | 'netlist') {
    const run = ++this.checkRun;
    this.checking = true;
    this.pending = checkFiles(files, design, fresh, 'viewer')
      .then(
        (c) => {
          if (run !== this.checkRun) return;
          this.focused = null;
          // another board's files (or in other coordinates): too few of the pads are where the board has them
          if (c && against === 'board' && !fresh && c.found < Math.max(1, c.total / 2)) {
            [this.check, this.against] = [null, null];
            this.checkNote = `Only ${c.found} of this board's ${c.total} pads are where these files have pads: they are another board's files, or in other coordinates, so they were not held against this board.`;
            return;
          }
          [this.check, this.against, this.checkNote] = [c, c ? against : null, c ? '' : 'No copper layers to check.'];
        },
        (e: Error) => {
          if (run === this.checkRun) [this.check, this.against, this.checkNote] = [null, null, `The netlist check failed: ${e.message}`];
        },
      )
      .finally(() => {
        if (run === this.checkRun) this.checking = false;
      });
  }

  /** The check of what is open, once the latest one is done (null: not checked). */
  async checked(): Promise<CopperCheck | null> {
    let run: number;
    do {
      run = this.checkRun;
      await this.pending;
    } while (run !== this.checkRun);
    return this.check;
  }

  /** Show a finding: its area, its layer with the holes and the outline (the layers' "all" brings back the rest). */
  focus(f: CopperFinding | null) {
    this.focused = f;
    if (!f) return;
    if (f.layer && this.set) this.hidden = Object.fromEntries(this.set.files.filter((x) => x.layer.id !== f.layer && x.layer.kind !== 'drill' && x.layer.kind !== 'outline').map((x) => [x.layer.id, true]));
    this.show({ x: f.area[0], y: f.area[1], w: f.area[2] - f.area[0], h: f.area[3] - f.area[1] });
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
      ...(this.check ? { check: checkLine(this.check, this.against) } : this.checkNote ? { check: this.checkNote } : {}),
      ...(this.focused ? { focused: this.focused.text } : {}),
    };
  }
}

/** The check in a line: what it found, by kind, or that the copper matches. */
export function checkLine(c: CopperCheck, against: 'board' | 'netlist' | null): string {
  const n = (k: CopperFinding['kind']) => c.findings.filter((f) => f.kind === k).length;
  const words = [
    [n('short'), 'short', 'shorts'],
    [n('open'), 'open', 'opens'],
    [n('pad'), 'pad without copper', 'pads without copper'],
    [n('floating'), 'piece of copper joined to nothing', 'pieces of copper joined to nothing'],
  ] as const;
  const found = words.filter(([k]) => k).map(([k, one, many]) => `${k} ${k === 1 ? one : many}`);
  const whom = against === 'netlist' ? 'the netlist in the files' : 'this board';
  return found.length ? `netlist check against ${whom}: ${found.join(', ')}` : `netlist check against ${whom}: every net joined, no two nets touching (${c.found} pads, ${c.nets} nets)`;
}

export const gerberViewer = new GerberViewer();
