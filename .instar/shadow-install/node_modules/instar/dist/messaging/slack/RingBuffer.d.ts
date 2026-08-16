/**
 * Generic fixed-capacity ring buffer.
 *
 * When full, the oldest item is silently overwritten.
 * Used for per-channel message history caching (capacity: 50).
 */
export declare class RingBuffer<T> {
    private buffer;
    private head;
    private count;
    readonly capacity: number;
    constructor(capacity: number);
    /** Add an item. Overwrites oldest if at capacity. */
    push(item: T): void;
    /** Return all items in insertion order (oldest first). */
    toArray(): T[];
    /** Number of items currently stored. */
    get size(): number;
    /** Remove all items. */
    clear(): void;
}
//# sourceMappingURL=RingBuffer.d.ts.map