// Small, bounded jitter cushion. A stall grows it quickly; stable playback
// shrinks it slowly. This does not use spoofable video frame counters or RTT.
export class LiveBuffer {
  target = 0.35;
  waiting = true;
  private lastStall = -Infinity;
  private lastDecay = 0;

  stalled(now: number): void {
    if (!this.waiting && now - this.lastStall > 1000) {
      this.target = Math.min(0.8, this.target + 0.15);
      this.lastStall = now;
    }
    this.waiting = true;
  }

  update(now: number, buffered: number): { play: boolean; seekBehind: number | null } {
    if (now - this.lastStall > 30_000 && now - this.lastDecay > 10_000) {
      this.target = Math.max(0.25, this.target - 0.025);
      this.lastDecay = now;
    }
    if (this.waiting && buffered < this.target) return { play: false, seekBehind: null };
    this.waiting = false;
    return { play: true, seekBehind: buffered > this.target + 1.5 ? this.target : null };
  }
}
