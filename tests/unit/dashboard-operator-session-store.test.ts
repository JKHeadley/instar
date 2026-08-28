import { describe, expect, it } from 'vitest';
import { DashboardOperatorSessionStore } from '../../src/server/DashboardOperatorSessionStore.js';

describe('DashboardOperatorSessionStore', () => {
  it('issues opaque, bounded, non-sliding operator proofs', () => {
    let now = 1_000_000;
    const store = new DashboardOperatorSessionStore({ now: () => now, ttlMs: 60_000, maxSessions: 2 });
    const first = store.issue();
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(store.verify(first.token)).toBe(true);
    expect(store.verify('ordinary-api-bearer')).toBe(false);
    now += 60_000;
    expect(store.verify(first.token)).toBe(false);
  });

  it('evicts the oldest proof at its hard capacity', () => {
    const store = new DashboardOperatorSessionStore({ ttlMs: 60_000, maxSessions: 2 });
    const first = store.issue().token;
    const second = store.issue().token;
    const third = store.issue().token;
    expect(store.verify(first)).toBe(false);
    expect(store.verify(second)).toBe(true);
    expect(store.verify(third)).toBe(true);
  });
});
