/**
 * MessagingEventBus — Typed event emitter for messaging adapters (Phase 1e).
 *
 * Replaces direct callback properties (onTopicMessage, onInterruptSession, etc.)
 * with a typed pub/sub system. Any adapter can emit events, and any consumer
 * (server, triage nurse, monitor) can subscribe.
 *
 * Design:
 * - Strongly typed: event names are string literals, payloads are typed per-event
 * - Multiple listeners per event (unlike callback properties that only hold one)
 * - Error isolation: one listener throwing doesn't affect others
 * - Async-aware: listeners can return promises, emit() awaits all
 * - Platform-agnostic: uses channelId (string), not topicId (number)
 */
// ── EventBus implementation ──────────────────────────────────────────
export class MessagingEventBus {
    listeners = new Map();
    platform;
    constructor(platform) {
        this.platform = platform;
    }
    /** Subscribe to an event. Returns an unsubscribe function. */
    on(event, listener) {
        const entries = this.listeners.get(event) ?? [];
        const entry = { listener, once: false };
        entries.push(entry);
        this.listeners.set(event, entries);
        return () => {
            const current = this.listeners.get(event);
            if (current) {
                const idx = current.indexOf(entry);
                if (idx !== -1)
                    current.splice(idx, 1);
            }
        };
    }
    /** Subscribe to an event, automatically unsubscribing after the first call. */
    once(event, listener) {
        const entries = this.listeners.get(event) ?? [];
        const entry = { listener, once: true };
        entries.push(entry);
        this.listeners.set(event, entries);
        return () => {
            const current = this.listeners.get(event);
            if (current) {
                const idx = current.indexOf(entry);
                if (idx !== -1)
                    current.splice(idx, 1);
            }
        };
    }
    /** Remove all listeners for a specific event, or all events if no event specified. */
    off(event) {
        if (event) {
            this.listeners.delete(event);
        }
        else {
            this.listeners.clear();
        }
    }
    /** Emit an event to all registered listeners. Awaits all async listeners. */
    async emit(event, data) {
        const entries = this.listeners.get(event);
        if (!entries || entries.length === 0)
            return;
        // Snapshot to avoid mutation during iteration
        const snapshot = [...entries];
        const toRemove = [];
        for (const entry of snapshot) {
            try {
                await entry.listener(data);
            }
            catch (err) {
                console.error(`[event-bus:${this.platform}] Listener error on "${event}": ${err}`);
            }
            if (entry.once) {
                toRemove.push(entry);
            }
        }
        // Remove once-listeners
        if (toRemove.length > 0) {
            const current = this.listeners.get(event);
            if (current) {
                for (const entry of toRemove) {
                    const idx = current.indexOf(entry);
                    if (idx !== -1)
                        current.splice(idx, 1);
                }
            }
        }
    }
    /** Get the count of listeners for a specific event. */
    listenerCount(event) {
        return this.listeners.get(event)?.length ?? 0;
    }
    /** Get all event names that have listeners. */
    eventNames() {
        const names = [];
        for (const [key, entries] of this.listeners) {
            if (entries.length > 0) {
                names.push(key);
            }
        }
        return names;
    }
    /** Get the platform this bus belongs to. */
    getPlatform() {
        return this.platform;
    }
}
//# sourceMappingURL=MessagingEventBus.js.map