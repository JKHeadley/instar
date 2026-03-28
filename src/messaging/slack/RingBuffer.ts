/**
 * Generic fixed-capacity ring buffer.
 *
 * When full, the oldest item is silently overwritten.
 * Used for per-channel message history caching (capacity: 50).
 */
export class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private head = 0;
  private count = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    if (capacity < 1) throw new Error('RingBuffer capacity must be >= 1');
    this.capacity = capacity;
    this.buffer = new Array(capacity);
  }

  /** Add an item. Overwrites oldest if at capacity. */
  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** Return all items in insertion order (oldest first). */
  toArray(): T[] {
    if (this.count === 0) return [];
    const result: T[] = [];
    const start = this.count < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.capacity;
      result.push(this.buffer[idx] as T);
    }
    return result;
  }

  /** Number of items currently stored. */
  get size(): number {
    return this.count;
  }

  /** Remove all items. */
  clear(): void {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.count = 0;
  }
}
