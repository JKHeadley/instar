import { describe, expect, it } from 'vitest';
import { DesktopDelegatedSessionStore } from '../../src/core/DesktopDelegatedSessionStore.js';

describe('DesktopDelegatedSessionStore', () => {
  it('binds a delegated session to the browser key and original deadline', () => {
    let now = 100_000;
    const store = new DesktopDelegatedSessionStore(() => now);
    const { token, expiresAtMs } = store.issue('front-1', 'browser-A');
    expect(expiresAtMs).toBe(700_000);
    expect(store.verify(token, 'browser-A')).toBe(true);
    expect(store.verify(token, 'browser-B')).toBe(false);
    now += 15_000;
    expect(store.keepAlive(token, 'front-2')).toBe(false);
    expect(store.keepAlive(token, 'front-1')).toBe(true);
    now = 700_000;
    expect(store.keepAlive(token, 'front-1')).toBe(false);
    expect(store.verify(token, 'browser-A')).toBe(false);
  });

  it('drops control when the front stops refreshing or revokes', () => {
    let now = 100_000;
    const store = new DesktopDelegatedSessionStore(() => now);
    const first = store.issue('front-1', 'browser-A');
    now += 20_000;
    expect(store.verify(first.token, 'browser-A')).toBe(false);
    expect(store.keepAlive(first.token, 'front-1')).toBe(false);
    const second = store.issue('front-1', 'browser-A');
    store.revoke(second.token);
    expect(store.verify(second.token, 'browser-A')).toBe(false);
  });
});
