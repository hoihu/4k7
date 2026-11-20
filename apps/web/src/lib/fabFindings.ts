/**
 * The production files' netlist check of the board on screen, run by itself once its routing is
 * done: a moment after the routed board comes (edits in a row run it once), in the netlist check's
 * worker. Its findings (FAB.*, fabDiagnostics) are held under the fingerprint of the copper they
 * were found on, and shown only while the board has that copper. See docs/design/fab-check.md.
 */
import { boardFingerprint, fabDiagnostics, type CopperCheck } from '@4k7/fab';
import type { BoardView, Diagnostic } from '@4k7/schema';

const HELD = 8;

export class FabWatch {
  /** The findings of the last few boards checked, by their copper (an undo brings one back at once). */
  private held = new Map<string, Diagnostic[]>();
  /** The copper of the board on screen, once routed (null: not routed, or no board). */
  private key: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The copper a check is waiting for or running on. */
  private due: string | null = null;
  private waiters: (() => void)[] = [];

  /** `check`: the files of a board made and checked (in a worker); `changed`: what current() gives may have changed. */
  constructor(
    private check: (b: BoardView) => Promise<CopperCheck | null>,
    private changed: () => void,
    private wait = 800,
  ) {}

  /** The board on screen: `routed` once its copper has settled. A board not routed has no findings until it is. */
  update(b: BoardView | null, routed: boolean) {
    const key = b && routed && b.routing === 'done' && b.parts.length ? boardFingerprint(b) : null;
    if (key === this.key) return;
    this.key = key;
    // (a check already running finishes; what it finds is held under its own copper)
    clearTimeout(this.timer);
    this.due = key && !this.held.has(key) ? key : null;
    if (this.due) this.timer = setTimeout(() => this.start(b!, key!), this.wait);
    this.changed();
    this.wake();
  }

  private start(b: BoardView, key: string) {
    this.check(b)
      .then(
        (c) => {
          this.held.set(key, fabDiagnostics(c, b));
          if (this.held.size > HELD) this.held.delete(this.held.keys().next().value!);
        },
        () => {}, // (replaced by a newer check, or failed: nothing to show)
      )
      .finally(() => {
        if (this.due === key) this.due = null;
        this.changed();
        this.wake();
      });
  }

  /** The findings of the board on screen (none while it is not routed, or not checked yet). */
  current(): Diagnostic[] {
    return (this.key !== null && this.held.get(this.key)) || [];
  }

  /** The findings of the board on screen once its check (if one is due) is done. */
  async settled(): Promise<Diagnostic[]> {
    while (this.key !== null && this.due === this.key && !this.held.has(this.key)) await new Promise<void>((r) => this.waiters.push(r));
    return this.current();
  }

  private wake() {
    for (const w of this.waiters.splice(0)) w();
  }
}
