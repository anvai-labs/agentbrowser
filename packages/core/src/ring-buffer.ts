/**
 * Fixed-capacity ring buffer (TD-BROWSER-9).
 *
 * O(1) push and O(1) eviction of the oldest entry - the structure this
 * replaces (`Array` + `.shift()`) is O(n) per eviction because `shift`
 * re-indexes the whole array.
 */

export interface RingBufferOptions {
  /** Maximum items retained; oldest evicted on overflow. */
  capacity: number;
}

export class RingBuffer<T> {
  private readonly buf: (T | undefined)[];
  private start = 0;
  private count = 0;
  private readonly capacity: number;

  constructor(options: RingBufferOptions) {
    this.capacity = Math.max(0, options.capacity);
    this.buf = new Array(this.capacity);
  }

  push(item: T): void {
    if (this.capacity === 0) {
      return;
    }
    const index = (this.start + this.count) % this.capacity;
    this.buf[index] = item;
    if (this.count < this.capacity) {
      this.count++;
    } else {
      // Buffer is full: overwrite the oldest slot and advance the start.
      this.start = (this.start + 1) % this.capacity;
    }
  }

  /** Retained items, oldest first. */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i++) {
      out.push(this.buf[(this.start + i) % this.capacity] as T);
    }
    return out;
  }

  get length(): number {
    return this.count;
  }

  clear(): void {
    this.start = 0;
    this.count = 0;
  }
}
