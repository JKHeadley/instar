/**
 * McpApprovalNonceStore — the single-use, change-bound, TTL approval nonce (C4).
 * Verifies mint/consume, single-use, binding (a nonce can't be replayed against a
 * different change), expiry, and re-mint-replaces-prior.
 */
import { describe, it, expect } from 'vitest';
import { McpApprovalNonceStore } from '../../src/core/McpApprovalNonceStore.js';

describe('McpApprovalNonceStore', () => {
  it('a minted nonce consumes once for the exact change', () => {
    const s = new McpApprovalNonceStore();
    const n = s.mint(42, 'load', 'playwright');
    expect(s.consume(42, 'load', 'playwright', n)).toBe(true);
  });

  it('is single-use — a second consume of the same nonce fails', () => {
    const s = new McpApprovalNonceStore();
    const n = s.mint(42, 'load', 'playwright');
    expect(s.consume(42, 'load', 'playwright', n)).toBe(true);
    expect(s.consume(42, 'load', 'playwright', n)).toBe(false);
  });

  it('a wrong nonce value fails (and does not burn the real one)', () => {
    const s = new McpApprovalNonceStore();
    const n = s.mint(42, 'load', 'playwright');
    expect(s.consume(42, 'load', 'playwright', 'WRONG')).toBe(false);
    expect(s.consume(42, 'load', 'playwright', n)).toBe(true); // real one still valid
  });

  it('is BOUND to the change — same nonce cannot be replayed against a different server/kind/topic', () => {
    const s = new McpApprovalNonceStore();
    const n = s.mint(42, 'load', 'playwright');
    expect(s.consume(42, 'load', 'other-server', n)).toBe(false);
    expect(s.consume(42, 'offload', 'playwright', n)).toBe(false);
    expect(s.consume(99, 'load', 'playwright', n)).toBe(false);
    expect(s.consume(42, 'load', 'playwright', n)).toBe(true); // only the exact binding works
  });

  it('consuming a never-minted change fails', () => {
    const s = new McpApprovalNonceStore();
    expect(s.consume(1, 'load', 'x', 'anything')).toBe(false);
  });

  it('expires after the TTL', () => {
    let t = 1000;
    const s = new McpApprovalNonceStore(5000, () => t);
    const n = s.mint(42, 'load', 'playwright');
    t = 6001; // past 1000 + 5000
    expect(s.consume(42, 'load', 'playwright', n)).toBe(false);
  });

  it('a fresh mint for the same change replaces the prior nonce', () => {
    const s = new McpApprovalNonceStore();
    const n1 = s.mint(42, 'load', 'playwright');
    const n2 = s.mint(42, 'load', 'playwright');
    expect(n1).not.toBe(n2);
    expect(s.consume(42, 'load', 'playwright', n1)).toBe(false); // stale
    expect(s.consume(42, 'load', 'playwright', n2)).toBe(true);
  });

  it('size() reflects outstanding nonces and prunes expired ones', () => {
    let t = 0;
    const s = new McpApprovalNonceStore(1000, () => t);
    s.mint(1, 'load', 'a');
    s.mint(2, 'load', 'b');
    expect(s.size()).toBe(2);
    t = 2000;
    expect(s.size()).toBe(0);
  });
});
