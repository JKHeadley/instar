/**
 * CallbackRegistry — Unit tests.
 *
 * Tests token generation, one-time resolve, pruning, size cap,
 * session cleanup, and the button key allowlist.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CallbackRegistry,
  isAllowedButtonKey,
  type CallbackContext,
} from '../../src/core/CallbackRegistry.js';

// ── Token Registration & Resolution ─────────────────────────────

describe('CallbackRegistry.register', () => {
  let registry: CallbackRegistry;

  beforeEach(() => {
    registry = new CallbackRegistry({
      maxEntries: 500,
      maxAgeMs: 300_000,
      pruneIntervalMs: 60_000,
    });
  });

  it('generates unique 12-char tokens', () => {
    const token1 = registry.register({ sessionName: 'sess-1', promptId: 'p1', key: '1' });
    const token2 = registry.register({ sessionName: 'sess-1', promptId: 'p2', key: '2' });
    expect(token1).toHaveLength(12);
    expect(token2).toHaveLength(12);
    expect(token1).not.toBe(token2);
  });

  it('tokens fit in Telegram callback_data (< 64 bytes)', () => {
    const token = registry.register({ sessionName: 'sess-1', promptId: 'p1', key: '1' });
    const callbackData = JSON.stringify({ id: token });
    expect(callbackData.length).toBeLessThan(64);
  });

  it('stores context and returns it on resolve', () => {
    const token = registry.register({ sessionName: 'sess-1', promptId: 'p1', key: 'y' });
    const ctx = registry.resolve(token);
    expect(ctx).not.toBeNull();
    expect(ctx!.sessionName).toBe('sess-1');
    expect(ctx!.promptId).toBe('p1');
    expect(ctx!.key).toBe('y');
    expect(ctx!.createdAt).toBeGreaterThan(0);
  });
});

// ── One-Time Use ────────────────────────────────────────────────

describe('CallbackRegistry.resolve', () => {
  it('deletes entry on first resolve (one-time use)', () => {
    const registry = new CallbackRegistry();
    const token = registry.register({ sessionName: 's', promptId: 'p', key: '1' });

    const first = registry.resolve(token);
    expect(first).not.toBeNull();

    const second = registry.resolve(token);
    expect(second).toBeNull();
  });

  it('returns null for unknown tokens', () => {
    const registry = new CallbackRegistry();
    expect(registry.resolve('nonexistent12')).toBeNull();
  });
});

// ── Peek ────────────────────────────────────────────────────────

describe('CallbackRegistry.peek', () => {
  it('returns context without consuming', () => {
    const registry = new CallbackRegistry();
    const token = registry.register({ sessionName: 's', promptId: 'p', key: '1' });

    const peeked = registry.peek(token);
    expect(peeked).not.toBeNull();

    // Should still be resolvable after peek
    const resolved = registry.resolve(token);
    expect(resolved).not.toBeNull();
  });
});

// ── Pruning ─────────────────────────────────────────────────────

describe('CallbackRegistry.prune', () => {
  it('removes entries older than maxAgeMs', () => {
    const registry = new CallbackRegistry({ maxEntries: 500, maxAgeMs: 100, pruneIntervalMs: 60000 });
    const token = registry.register({ sessionName: 's', promptId: 'p', key: '1' });

    // Manually expire the entry
    const ctx = (registry as any).registry.get(token);
    ctx.createdAt = Date.now() - 200; // 200ms ago, maxAge is 100ms

    const pruned = registry.prune();
    expect(pruned).toBe(1);
    expect(registry.resolve(token)).toBeNull();
  });

  it('does not prune fresh entries', () => {
    const registry = new CallbackRegistry({ maxEntries: 500, maxAgeMs: 300000, pruneIntervalMs: 60000 });
    const token = registry.register({ sessionName: 's', promptId: 'p', key: '1' });

    const pruned = registry.prune();
    expect(pruned).toBe(0);
    expect(registry.resolve(token)).not.toBeNull();
  });
});

// ── Size Cap ────────────────────────────────────────────────────

describe('CallbackRegistry.sizeCap', () => {
  it('enforces max entries by removing oldest', () => {
    const registry = new CallbackRegistry({ maxEntries: 5, maxAgeMs: 300000, pruneIntervalMs: 60000 });

    // Register 5 entries
    const tokens: string[] = [];
    for (let i = 0; i < 5; i++) {
      tokens.push(registry.register({ sessionName: `s${i}`, promptId: `p${i}`, key: '1' }));
    }

    expect(registry.size).toBe(5);

    // Register one more — should evict oldest
    registry.register({ sessionName: 's5', promptId: 'p5', key: '1' });

    // Size should be at or below max
    expect(registry.size).toBeLessThanOrEqual(5);
  });
});

// ── Session Cleanup ─────────────────────────────────────────────

describe('CallbackRegistry.removeForSession', () => {
  it('removes all entries for a specific session', () => {
    const registry = new CallbackRegistry();
    registry.register({ sessionName: 'sess-a', promptId: 'p1', key: '1' });
    registry.register({ sessionName: 'sess-a', promptId: 'p2', key: '2' });
    registry.register({ sessionName: 'sess-b', promptId: 'p3', key: 'y' });

    const removed = registry.removeForSession('sess-a');
    expect(removed).toBe(2);
    expect(registry.size).toBe(1); // Only sess-b remains
  });

  it('returns 0 for unknown session', () => {
    const registry = new CallbackRegistry();
    expect(registry.removeForSession('nonexistent')).toBe(0);
  });
});

// ── Button Key Allowlist ────────────────────────────────────────

describe('isAllowedButtonKey', () => {
  it('allows numbered options 1-5', () => {
    for (const key of ['1', '2', '3', '4', '5']) {
      expect(isAllowedButtonKey(key)).toBe(true);
    }
  });

  it('allows y/n', () => {
    expect(isAllowedButtonKey('y')).toBe(true);
    expect(isAllowedButtonKey('n')).toBe(true);
  });

  it('allows Enter and Escape', () => {
    expect(isAllowedButtonKey('Enter')).toBe(true);
    expect(isAllowedButtonKey('Escape')).toBe(true);
  });

  it('rejects arbitrary keys', () => {
    expect(isAllowedButtonKey('rm -rf /')).toBe(false);
    expect(isAllowedButtonKey('6')).toBe(false);
    expect(isAllowedButtonKey('')).toBe(false);
    expect(isAllowedButtonKey('Y')).toBe(false);
  });

  it('rejects control characters', () => {
    expect(isAllowedButtonKey('\x03')).toBe(false); // Ctrl+C
    expect(isAllowedButtonKey('\n')).toBe(false);
  });
});
