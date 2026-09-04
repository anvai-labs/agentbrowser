/**
 * TDD Tests for RingBuffer (TD-BROWSER-9)
 */

import { describe, expect, it } from 'vitest';
import { RingBuffer } from './ring-buffer';

describe('RingBuffer', () => {
  it('should retain items in push order within capacity', () => {
    const buffer = new RingBuffer<number>({ capacity: 3 });
    buffer.push(1);
    buffer.push(2);

    expect(buffer.toArray()).toEqual([1, 2]);
    expect(buffer.length).toBe(2);
  });

  it('should evict the oldest item once over capacity', () => {
    const buffer = new RingBuffer<number>({ capacity: 3 });
    for (const n of [1, 2, 3, 4, 5]) {
      buffer.push(n);
    }

    expect(buffer.toArray()).toEqual([3, 4, 5]);
    expect(buffer.length).toBe(3);
  });

  it('should wrap around the underlying array correctly across many pushes', () => {
    const buffer = new RingBuffer<number>({ capacity: 2 });
    for (let n = 0; n < 7; n++) {
      buffer.push(n);
    }

    expect(buffer.toArray()).toEqual([5, 6]);
  });

  it('should be a no-op sink when capacity is 0', () => {
    const buffer = new RingBuffer<number>({ capacity: 0 });
    buffer.push(1);
    buffer.push(2);

    expect(buffer.toArray()).toEqual([]);
    expect(buffer.length).toBe(0);
  });

  it('should clear all items', () => {
    const buffer = new RingBuffer<number>({ capacity: 3 });
    buffer.push(1);
    buffer.push(2);
    buffer.clear();

    expect(buffer.toArray()).toEqual([]);
    expect(buffer.length).toBe(0);
    // Clearing must release the item references, not just reset the cursors:
    // clearLogs()-style callers clear to reclaim memory.
    expect(
      (buffer as unknown as { buf: (number | undefined)[] }).buf.every((slot) => slot === undefined)
    ).toBe(true);

    // Still usable after a clear.
    buffer.push(9);
    expect(buffer.toArray()).toEqual([9]);
  });
});
