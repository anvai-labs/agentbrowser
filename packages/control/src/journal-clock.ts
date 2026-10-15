/**
 * T5 J-c: the journal's effective time within one process.
 *
 * `now()` is `max(startWall + monotonicElapsed, wallNow, previousReading)`: a backward wall-clock
 * step mid-process cannot move it backwards, a forward step is followed. It is used for CHECKS
 * only (fencing, admission and retention horizons), which can therefore only become stricter.
 *
 * `wall()` is the plain wall reading, used for everything that PERSISTS or DELETES: the persisted
 * high-water, namespace retirement and the reopen rollback check. Restart behaviour is therefore
 * exactly what it was before this clock existed; no restart horizon or persisted value derives
 * from the monotonic source (design t5-journal-sqlite-audit "Retention, time, keys").
 */
export interface JournalClockSources {
  wall(): number;
  monotonic(): number;
}

export interface JournalClock {
  /** Effective epoch milliseconds for checks: never below any earlier reading. */
  now(): number;
  /** Integer wall epoch milliseconds for persistence, retirement and rollback detection. */
  wall(): number;
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
      const projected = startWall + (sources.monotonic() - startMonotonic);
      last = Math.max(last, Math.floor(Math.max(projected, sources.wall())));
      return last;
    },
    wall() {
      return Math.floor(sources.wall());
    },
  };
}
