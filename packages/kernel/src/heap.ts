/** The queue of the path searches (the board's router, a schematic wire's path). */
/** Binary min-heap of (state, priority), in typed arrays that grow as needed. */
export class Heap {
  private s = new Int32Array(1024);
  private p = new Float64Array(1024);
  size = 0;
  push(state: number, prio: number) {
    if (this.size === this.s.length) {
      const s = new Int32Array(this.s.length * 2);
      s.set(this.s);
      this.s = s;
      const p = new Float64Array(this.p.length * 2);
      p.set(this.p);
      this.p = p;
    }
    const s = this.s;
    const p = this.p;
    // move the hole up rather than swapping entries
    let i = this.size++;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (p[up]! <= prio) break;
      s[i] = s[up]!;
      p[i] = p[up]!;
      i = up;
    }
    s[i] = state;
    p[i] = prio;
  }
  /** Priority of the entry returned by the last pop(). */
  lastPrio = 0;
  pop(): number {
    const s = this.s;
    const p = this.p;
    const top = s[0]!;
    this.lastPrio = p[0]!;
    const n = --this.size;
    if (n > 0) {
      // the last entry sinks from the top, the hole moving down
      const ls = s[n]!;
      const lp = p[n]!;
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && p[c + 1]! < p[c]!) c++;
        if (p[c]! >= lp) break;
        s[i] = s[c]!;
        p[i] = p[c]!;
        i = c;
      }
      s[i] = ls;
      p[i] = lp;
    }
    return top;
  }
}
