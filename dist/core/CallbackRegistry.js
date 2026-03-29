/**
 * CallbackRegistry — Server-side context storage for Telegram inline keyboard callbacks.
 *
 * Telegram limits callback_data to 64 bytes. We store full prompt context server-side
 * keyed by short CSPRNG tokens. Only the token goes in callback_data.
 *
 * Tokens are one-time use: resolve() returns context and deletes the entry.
 * Entries are pruned on a 60-second interval and on server startup.
 */
import { randomBytes } from 'node:crypto';
// ── Token generation ───────────────────────────────────────────────
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/**
 * Generate a base62 token of given length using CSPRNG.
 * 12 chars = ~71 bits of entropy.
 */
function generateBase62(length) {
    const bytes = randomBytes(length);
    let token = '';
    for (let i = 0; i < length; i++) {
        token += BASE62[bytes[i] % 62];
    }
    return token;
}
// ── Allowed keys ───────────────────────────────────────────────────
/**
 * Allowlist of keys that can be sent to tmux via button callbacks.
 * Prevents arbitrary input injection through crafted callback data.
 */
const ALLOWED_BUTTON_KEYS = new Set([
    '1', '2', '3', '4', '5', // Numbered options
    'y', 'n', // Yes/No
    'Enter', 'Escape', // Confirmation/cancel
]);
export function isAllowedButtonKey(key) {
    return ALLOWED_BUTTON_KEYS.has(key);
}
// ── CallbackRegistry ───────────────────────────────────────────────
export class CallbackRegistry {
    config;
    registry = new Map();
    pruneTimer = null;
    constructor(config = {
        maxEntries: 500,
        maxAgeMs: 300_000,
        pruneIntervalMs: 60_000,
    }) {
        this.config = config;
    }
    /**
     * Start periodic pruning. Call on server startup.
     */
    start() {
        // Initial prune (clears any stale state)
        this.prune();
        this.pruneTimer = setInterval(() => this.prune(), this.config.pruneIntervalMs);
        // Don't keep the process alive just for pruning
        if (this.pruneTimer.unref)
            this.pruneTimer.unref();
    }
    /**
     * Stop periodic pruning. Call on server shutdown.
     */
    stop() {
        if (this.pruneTimer) {
            clearInterval(this.pruneTimer);
            this.pruneTimer = null;
        }
    }
    /**
     * Register a callback context and return a short token.
     * The token is safe for Telegram's callback_data (well under 64 bytes).
     */
    register(context) {
        // Enforce size cap
        if (this.registry.size >= this.config.maxEntries) {
            this.prune();
            // If still over cap after pruning, remove oldest entries
            if (this.registry.size >= this.config.maxEntries) {
                const entries = [...this.registry.entries()]
                    .sort((a, b) => a[1].createdAt - b[1].createdAt);
                const toRemove = entries.slice(0, Math.ceil(this.config.maxEntries * 0.2));
                for (const [token] of toRemove) {
                    this.registry.delete(token);
                }
            }
        }
        const token = generateBase62(12);
        this.registry.set(token, { ...context, createdAt: Date.now() });
        return token;
    }
    /**
     * Resolve a token to its context. One-time use: the entry is deleted.
     * Returns null for unknown or expired tokens.
     */
    resolve(token) {
        const ctx = this.registry.get(token);
        if (!ctx)
            return null;
        this.registry.delete(token);
        return ctx;
    }
    /**
     * Peek at a token without consuming it.
     * Used for validation checks before resolving.
     */
    peek(token) {
        return this.registry.get(token) ?? null;
    }
    /**
     * Remove all entries older than maxAgeMs.
     */
    prune() {
        const cutoff = Date.now() - this.config.maxAgeMs;
        let pruned = 0;
        for (const [token, ctx] of this.registry) {
            if (ctx.createdAt < cutoff) {
                this.registry.delete(token);
                pruned++;
            }
        }
        return pruned;
    }
    /**
     * Remove all entries for a specific session.
     * Called when a session ends to clean up stale buttons.
     */
    removeForSession(sessionName) {
        let removed = 0;
        for (const [token, ctx] of this.registry) {
            if (ctx.sessionName === sessionName) {
                this.registry.delete(token);
                removed++;
            }
        }
        return removed;
    }
    /**
     * Current number of registered callbacks.
     */
    get size() {
        return this.registry.size;
    }
}
//# sourceMappingURL=CallbackRegistry.js.map