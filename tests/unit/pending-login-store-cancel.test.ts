/**
 * Unit tests for the operator-cancel store changes (matrix-cell-operator-cancel):
 *   1. transition() terminal guard — a completed/abandoned login is NEVER re-transitioned
 *      (a cancel landing a moment after completion must not clobber the enrollment).
 *   2. issue() replaces a same-id TERMINAL/EXPIRED record (so re-enrollment after a cancel
 *      works) but still throws on a genuine live-PENDING duplicate.
 *
 * Hermetic: injected clock, temp-dir state, zero network.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PendingLoginStore, ValidationError } from '../../src/core/PendingLoginStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const T0 = Date.parse('2026-06-19T00:00:00Z');

function login(id = 'fm-1') {
  return {
    id,
    label: 'main',
    provider: 'anthropic' as const,
    framework: 'claude-code' as const,
    kind: 'url-code-paste' as const,
    configHome: `/tmp/.claude-followme-${id}`,
    verificationUrl: 'https://claude.com/oauth',
    expectedEmail: 'approved@x.com',
  };
}

describe('PendingLoginStore — operator-cancel changes', () => {
  let dir: string;
  let clock: number;
  let store: PendingLoginStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plogin-cancel-'));
    clock = T0;
    store = new PendingLoginStore({ stateDir: dir, now: () => clock });
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/pending-login-store-cancel.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  // ---- transition() terminal guard ----

  it('abandon() of a pending login → abandoned', () => {
    store.issue(login());
    const r = store.abandon('fm-1');
    expect(r?.status).toBe('abandoned');
    expect(store.get('fm-1')?.status).toBe('abandoned');
  });

  it('abandon() does NOT clobber a COMPLETED login (terminal guard) — and does not bump version', () => {
    store.issue(login());
    const completed = store.complete('fm-1');
    expect(completed?.status).toBe('completed');
    const vBefore = store.get('fm-1')!.version;
    const r = store.abandon('fm-1');
    expect(r?.status).toBe('completed'); // NOT abandoned — the successful enrollment is preserved
    expect(store.get('fm-1')?.status).toBe('completed');
    expect(store.get('fm-1')!.version).toBe(vBefore); // no-op: version unchanged
  });

  it('abandon() of an already-abandoned login is idempotent (no version bump)', () => {
    store.issue(login());
    store.abandon('fm-1');
    const vBefore = store.get('fm-1')!.version;
    store.abandon('fm-1');
    expect(store.get('fm-1')?.status).toBe('abandoned');
    expect(store.get('fm-1')!.version).toBe(vBefore);
  });

  it('abandon() of a live-EXPIRED (stored-pending) login still transitions to abandoned', () => {
    store.issue({ ...login(), ttlMs: 60_000 });
    clock += 120_000; // past the TTL → live status is 'expired', stored status still 'pending'
    expect(store.get('fm-1')?.status).toBe('expired');
    const r = store.abandon('fm-1');
    expect(r?.status).toBe('abandoned'); // expired is still cancellable
  });

  it('abandon() of an unknown id → null', () => {
    expect(store.abandon('nope')).toBeNull();
  });

  // ---- issue() replace-on-terminal ----

  it('issue() REPLACES a same-id ABANDONED record (re-enrollment after cancel works)', () => {
    store.issue(login());
    store.abandon('fm-1');
    // Re-enroll the SAME account id — must NOT throw "already exists".
    const reissued = store.issue({ ...login(), verificationUrl: 'https://claude.com/oauth2' });
    expect(reissued.status).toBe('pending');
    expect(reissued.verificationUrl).toBe('https://claude.com/oauth2');
    // Exactly one record for the id (the stale abandoned one was spliced out).
    expect(store.list().filter((l) => l.id === 'fm-1').length).toBe(1);
  });

  it('issue() REPLACES a same-id COMPLETED record', () => {
    store.issue(login());
    store.complete('fm-1');
    const reissued = store.issue(login());
    expect(reissued.status).toBe('pending');
    expect(store.list().filter((l) => l.id === 'fm-1').length).toBe(1);
  });

  it('issue() REPLACES a same-id live-EXPIRED record', () => {
    store.issue({ ...login(), ttlMs: 60_000 });
    clock += 120_000; // now live-expired
    const reissued = store.issue(login());
    expect(reissued.status).toBe('pending');
    expect(store.list().filter((l) => l.id === 'fm-1').length).toBe(1);
  });

  it('issue() STILL throws on a genuine live-PENDING duplicate (un-expired)', () => {
    store.issue(login());
    expect(() => store.issue(login())).toThrow(ValidationError);
  });
});
