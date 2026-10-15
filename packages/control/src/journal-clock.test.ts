import { describe, expect, it } from 'vitest';
import { createJournalClock } from './journal-clock.js';

function sources(start = 1_000_000) {
  let wall = start;
  let monotonic = 50;
  return {
    sources: { wall: () => wall, monotonic: () => monotonic },
    advance(ms: number) {
      wall += ms;
      monotonic += ms;
    },
    setWall(value: number) {
      wall = value;
    },
  };
}

describe('journal effective time (T5 J-c)', () => {
  it('follows real elapsed time', () => {
    const s = sources();
    const clock = createJournalClock(s.sources);
    expect(clock.now()).toBe(1_000_000);
    s.advance(250);
    expect(clock.now()).toBe(1_000_250);
  });

  it('a backward wall-clock step mid-process does not move journal time backwards', () => {
    const s = sources();
    const clock = createJournalClock(s.sources);
    s.advance(5_000);
    expect(clock.now()).toBe(1_005_000);
    s.setWall(900_000); // the wall clock jumps back 105 s
    expect(clock.now()).toBe(1_005_000);
    s.advance(1_000);
    // Monotonic progress continues from the projection; the rolled-back wall is ignored.
    expect(clock.now()).toBe(1_006_000);
  });

  it('a forward wall-clock step is followed (horizons may expire early, never late)', () => {
    const s = sources();
    const clock = createJournalClock(s.sources);
    s.setWall(2_000_000);
    expect(clock.now()).toBe(2_000_000);
  });

  it('readings never decrease across any interleaving of steps', () => {
    const s = sources();
    const clock = createJournalClock(s.sources);
    let previous = clock.now();
    for (const step of [10, -500_000, 3, 900_000, -2_000_000, 1, 7]) {
      if (step > 0 && step < 1000) s.advance(step);
      else s.setWall(s.sources.wall() + step);
      const reading = clock.now();
      expect(reading).toBeGreaterThanOrEqual(previous);
      previous = reading;
    }
  });

  it('a monotonic source that goes backwards is clamped, never subtracted', () => {
    let monotonic = 100;
    const clock = createJournalClock({ wall: () => 1_000_000, monotonic: () => monotonic });
    monotonic = 40;
    expect(clock.now()).toBe(1_000_000);
  });
});
