import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SubscriptionReloginStore } from '../../src/core/SubscriptionReloginStore.js';

// Spec docs/specs/agent-held-google-passkey.md §3.4 — the `loginMethod` column on
// repair_episodes (PRAGMA-guarded ALTER on an EXISTING database), the insert, and the
// method-scoped graduation evidence: successes/oldestSuccessAt per method; mismatches and
// unexpected origins across ALL methods; legacy (NULL) rows count for a legacy method only.

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'subscription-relogin-store-login-method.test cleanup' }); });

const ACCOUNT = ['acct-1', 'machine-1', 'anthropic', 'claude-code'] as const;

function fixture(now = Date.parse('2026-08-28T07:00:00.000Z')) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-login-method-')); dirs.push(stateDir);
  let id = 0; let source = 100;
  const store = new SubscriptionReloginStore({ stateDir, now: () => now, idFactory: () => `repair-${++id}` });
  const finish = (loginMethod: string | null | undefined, state: 'succeeded' | 'failed' | 'refused', failureClass?: string, at?: string) => {
    const ep = store.suggest({ sourceEpisodeId: ++source, accountId: 'acct-1', machineId: 'machine-1', mode: 'approval',
      inputDigest: `sha256:${'a'.repeat(64)}`, profileId: 'justin-google', framework: 'claude-code', provider: 'anthropic', loginMethod, at });
    let cur = store.approve(ep.id, { inputDigest: ep.inputDigest, at });
    const chain: Array<'cli-starting' | 'artifact-ready' | 'browser-driving' | 'identity-verifying' | 'auth-verifying'> =
      state === 'succeeded' ? ['cli-starting', 'artifact-ready', 'browser-driving', 'identity-verifying', 'auth-verifying'] : [];
    for (const to of chain) cur = store.transition(cur.id, { expectedVersion: cur.version, to, eventClass: to, at });
    return store.transition(cur.id, { expectedVersion: cur.version, to: state, eventClass: state, at,
      ...(failureClass ? { failureClass: failureClass as never } : {}) });
  };
  return { stateDir, store, finish };
}

describe('SubscriptionReloginStore — loginMethod column + method-scoped evidence', () => {
  it('adds the loginMethod column to an EXISTING database created before it existed (PRAGMA-guarded ALTER), idempotently', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-legacy-db-')); dirs.push(stateDir);
    const dir = path.join(stateDir, 'state', 'subscription-relogin'); fs.mkdirSync(dir, { recursive: true });
    const legacy = new Database(path.join(dir, 'repairs.db'));
    legacy.exec(`CREATE TABLE repair_episodes (
      id TEXT PRIMARY KEY, sourceEpisodeId INTEGER NOT NULL, accountId TEXT NOT NULL,
      machineId TEXT NOT NULL, mode TEXT NOT NULL, state TEXT NOT NULL, inputDigest TEXT NOT NULL,
      profileId TEXT NOT NULL, framework TEXT NOT NULL, provider TEXT NOT NULL,
      attemptCount INTEGER NOT NULL DEFAULT 0, reissueCount INTEGER NOT NULL DEFAULT 0,
      approvedAt TEXT, approvalExpiresAt TEXT, startedAt TEXT, finishedAt TEXT, nextAttemptAt TEXT,
      failureClass TEXT, version INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
      UNIQUE(sourceEpisodeId,accountId,machineId))`);
    legacy.prepare(`INSERT INTO repair_episodes(id,sourceEpisodeId,accountId,machineId,mode,state,inputDigest,profileId,framework,provider,
      finishedAt,version,createdAt,updatedAt) VALUES('old-1',1,'acct-1','machine-1','approval','succeeded','sha256:${'a'.repeat(64)}','justin-google',
      'claude-code','anthropic','2026-09-01T00:00:00.000Z',1,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')`).run();
    legacy.close();

    const store = new SubscriptionReloginStore({ stateDir });
    const columns = new Set((new Database(path.join(dir, 'repairs.db'), { readonly: true }).prepare('PRAGMA table_info(repair_episodes)').all() as Array<{ name: string }>).map((r) => r.name));
    expect(columns.has('loginMethod')).toBe(true);
    expect(store.get('old-1')).toMatchObject({ state: 'succeeded', loginMethod: null });
    store.close();
    // Re-open: the guard sees the column and does not ALTER again.
    const again = new SubscriptionReloginStore({ stateDir });
    expect(again.get('old-1')?.loginMethod).toBeNull();
    again.close();
  });

  it('records the admitted loginMethod on suggest (null when absent) and returns it on reads', () => {
    const { store, finish } = fixture();
    expect(finish('password', 'succeeded').loginMethod).toBe('password');
    expect(finish(undefined, 'succeeded').loginMethod).toBeNull();
    expect(store.list({ accountId: 'acct-1' }).map((e) => e.loginMethod).sort()).toEqual([null, 'password'].sort());
    store.close();
  });

  it('scopes successes + oldestSuccessAt by method; legacy NULL rows count for a legacy method but NEVER for google-passkey', () => {
    const { store, finish } = fixture();
    finish(null, 'succeeded', undefined, '2026-01-01T00:00:00.000Z');          // legacy row (pre-column)
    finish('password', 'succeeded', undefined, '2026-02-01T00:00:00.000Z');
    finish('password', 'succeeded', undefined, '2026-03-01T00:00:00.000Z');
    finish('google-passkey', 'succeeded', undefined, '2026-04-01T00:00:00.000Z');

    expect(store.getUnattendedEvidence(...ACCOUNT)).toMatchObject({ successfulRepairs: 4, oldestSuccessAt: '2026-01-01T00:00:00.000Z' });
    expect(store.getUnattendedEvidence(...ACCOUNT, 'password')).toMatchObject({ successfulRepairs: 3, oldestSuccessAt: '2026-01-01T00:00:00.000Z' });
    expect(store.getUnattendedEvidence(...ACCOUNT, 'google-passkey')).toMatchObject({ successfulRepairs: 1, oldestSuccessAt: '2026-04-01T00:00:00.000Z' });
    // A method the account has never used: evidence starts from zero (a method change resets it).
    expect(store.getUnattendedEvidence(...ACCOUNT, 'session-cookie')).toMatchObject({ successfulRepairs: 1, oldestSuccessAt: '2026-01-01T00:00:00.000Z' }); // the legacy row only
    store.close();
  });

  it('identityMismatches and unexpectedOrigins are counted across ALL methods — switching method never erases bad history (both directions)', () => {
    const { store, finish } = fixture();
    finish('password', 'refused', 'wrong-identity');
    finish('password', 'failed', 'unexpected-origin');
    finish('google-passkey', 'refused', 'wrong-identity');
    finish('google-passkey', 'failed', 'permission-expansion');
    for (const method of ['password', 'google-passkey', 'session-cookie', undefined] as const) {
      expect(store.getUnattendedEvidence(...ACCOUNT, method)).toMatchObject({ identityMismatches: 2, unexpectedOrigins: 2 });
    }
    expect(store.getUnattendedEvidence(...ACCOUNT, 'google-passkey').successfulRepairs).toBe(0);
    store.close();
  });

  it('a passkey-refused drive outcome lands as a REFUSED terminal, not a failed attempt', () => {
    const { store, finish } = fixture();
    const ep = finish('google-passkey', 'refused', 'passkey-refused');
    expect(ep).toMatchObject({ state: 'refused', failureClass: 'passkey-refused', loginMethod: 'google-passkey' });
    store.close();
  });
});
