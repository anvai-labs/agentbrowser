/**
 * T5 J-c: the journal's effective time within one process.
 *
 * `max(startWall + monotonicElapsed, wallNow, previousReading)`: a backward wall-clock step mid-process cannot
 * move journal time backwards (so no horizon is ever extended by it), while a forward step is
 * followed. The persisted high-water is the third term of the design's rule and is applied by the
 * record layer inside each transaction (`max(now, clock_high_water)`), which also refuses a
 * reopen below it. Restart horizons never derive from the monotonic source: each process starts
 * from its own wall sample (design t5-journal-sqlite-audit "Retention, time, keys").
 */
export interface JournalClockSources {
  wall(): number;
  monotonic(): number;
}

export interface JournalClock {
  /** Effective epoch milliseconds: never below any earlier reading of this clock. */
  now(): number;
}

export function createJournalClock(
  sources: JournalClockSources = {
    wall: () => Date.now(),
    monotonic: () => performance.now(),
  }
): JournalClock {
  const startWall = sources.wall();
  const startMonotonic = sources.monotonic();
  // In-process high-water: after a forward wall step followed by a backward one, the projection
  // alone would fall below an earlier reading.
  let last = Number.NEGATIVE_INFINITY;
  return {
    now() {
      const projected = startWall + Math.max(0, sources.monotonic() - startMonotonic);
      last = Math.max(last, Math.floor(Math.max(projected, sources.wall())));
      return last;
    },
  };
}
