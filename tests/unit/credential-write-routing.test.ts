/**
 * Step 4b routing tests — every in-process Claude credential write is serialized through the
 * CredentialWriteFunnel, and a busy per-slot lock degrades SAFELY (a transient "skip/retry",
 * never a corruption or a false needs-reauth).
 *
 * Hermetic: in-memory store + injected fetch + injected funnel → zero keychain, zero network.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  refreshClaudeToken,
  type CredentialStore,
  type RefreshFetch,
} from '../../src/core/OAuthRefresher.js';
import { CredentialWriteFunnel } from '../../src/core/CredentialWriteFunnel.js';
import {
  writeCredentialsSerialized,
  type CredentialProvider,
  type ClaudeCredentials,
} from '../../src/monitoring/CredentialProvider.js';
import { QuotaPoller, type FetchImpl } from '../../src/core/QuotaPoller.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOME = '/h/.claude-a';
const FIXED_NOW = () => 5_000_000;

function credRaw(): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat0-OLD',
      refreshToken: 'sk-ant-ort0-OLD',
      expiresAt: 1000,
      subscriptionType: 'max',
    },
  });
}

function fakeStore(initial: Record<string, string> = {}) {
  const m: Record<string, string> = { ...initial };
  let writes = 0;
  const store: CredentialStore = {
    read: (ch) => (ch in m ? m[ch] : null),
    write: (ch, raw) => {
      m[ch] = raw;
      writes += 1;
      return true;
    },
  };
  return { store, dump: () => ({ ...m }), writeCount: () => writes };
}

function tokenFetch(status: number, body: unknown): RefreshFetch {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

const GOOD_EXCHANGE = {
  access_token: 'sk-ant-oat0-NEW',
  refresh_token: 'sk-ant-ort0-NEW',
  expires_in: 28800,
};

/** Occupy a funnel slot with a never-resolving holder until the returned release() is called. */
function occupySlot(funnel: CredentialWriteFunnel, slot: string): () => void {
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  void funnel.withSlotLock(slot, () => held);
  return release;
}

describe('Step 4b — refreshClaudeToken routes its write through the funnel', () => {
  it('happy path: the write goes through an injected funnel and persists the new token', async () => {
    const store = fakeStore({ [HOME]: credRaw() });
    const funnel = new CredentialWriteFunnel();
    const res = await refreshClaudeToken(HOME, {
      store: store.store,
      now: FIXED_NOW,
      fetchImpl: tokenFetch(200, GOOD_EXCHANGE),
      funnel,
    });
    expect(res.ok).toBe(true);
    expect(store.writeCount()).toBe(1);
    expect(JSON.parse(store.dump()[HOME]).claudeAiOauth.accessToken).toBe('sk-ant-oat0-NEW');
  });

  it('busy slot → write-skipped, and the existing credential is left UNTOUCHED (no corruption)', async () => {
    const store = fakeStore({ [HOME]: credRaw() });
    const funnel = new CredentialWriteFunnel({ slotLockTimeoutMs: 30 });
    const release = occupySlot(funnel, HOME); // hold the slot so the refresh write can't acquire
    try {
      const res = await refreshClaudeToken(HOME, {
        store: store.store,
        now: FIXED_NOW,
        fetchImpl: tokenFetch(200, GOOD_EXCHANGE),
        funnel,
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toBe('write-skipped');
      // The exchange succeeded but the write was skipped — the OLD credential is intact.
      expect(store.writeCount()).toBe(0);
      expect(JSON.parse(store.dump()[HOME]).claudeAiOauth.accessToken).toBe('sk-ant-oat0-OLD');
    } finally {
      release();
    }
  });

  it('a different slot is NOT blocked by a busy slot (per-slot isolation)', async () => {
    const OTHER = '/h/.claude-b';
    const store = fakeStore({ [HOME]: credRaw(), [OTHER]: credRaw() });
    const funnel = new CredentialWriteFunnel({ slotLockTimeoutMs: 30 });
    const release = occupySlot(funnel, HOME);
    try {
      const res = await refreshClaudeToken(OTHER, {
        store: store.store,
        now: FIXED_NOW,
        fetchImpl: tokenFetch(200, GOOD_EXCHANGE),
        funnel,
      });
      expect(res.ok).toBe(true); // OTHER slot is free
      expect(store.writeCount()).toBe(1);
    } finally {
      release();
    }
  });
});

describe('Step 4b — QuotaPoller maps a write-skipped refresh to no-snapshot, NEVER needs-reauth', () => {
  let dir: string;
  let pool: SubscriptionPool;
  const ACCT = {
    id: 'claude-1',
    nickname: 'primary',
    provider: 'anthropic' as const,
    framework: 'claude-code' as const,
    configHome: HOME,
  };
  const auth401: FetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qpoll-4b-'));
    pool = new SubscriptionPool({ stateDir: dir });
  });
  afterEach(() => {
    try {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'credential-write-routing.test.ts:cleanup' });
    } catch {
      /* @silent-fallback-ok: best-effort temp cleanup */
    }
  });

  it('write-skipped → pollAccount returns null and the account is NOT needs-reauth', async () => {
    const p = new QuotaPoller({
      pool,
      fetchImpl: auth401,
      tokenResolver: () => 'sk-ant-oat01-x',
      refresher: async () => ({ ok: false, reason: 'write-skipped' }),
    });
    pool.add({ ...ACCT });
    const snap = await p.pollAccount(pool.get('claude-1')!);
    expect(snap).toBeNull();
    expect(pool.get('claude-1')!.status).not.toBe('needs-reauth');
  });

  it('CONTRAST: a genuine exchange-failed DOES mark needs-reauth', async () => {
    const p = new QuotaPoller({
      pool,
      fetchImpl: auth401,
      tokenResolver: () => 'sk-ant-oat01-x',
      refresher: async () => ({ ok: false, reason: 'exchange-failed' }),
    });
    pool.add({ ...ACCT });
    const snap = await p.pollAccount(pool.get('claude-1')!);
    expect(snap).toBeNull();
    expect(pool.get('claude-1')!.status).toBe('needs-reauth');
  });
});

describe('Step 4b — writeCredentialsSerialized serializes provider.writeCredentials', () => {
  function fakeProvider() {
    const calls: ClaudeCredentials[] = [];
    const provider: Pick<CredentialProvider, 'writeCredentials'> = {
      writeCredentials: async (c) => {
        calls.push(c);
      },
    };
    return { provider, calls };
  }
  const CREDS: ClaudeCredentials = { accessToken: 'sk-ant-oat0-X', expiresAt: 9_000_000, email: 'a@b.co' };

  it('happy path: the provider write runs under the lock (ran:true)', async () => {
    const { provider, calls } = fakeProvider();
    const funnel = new CredentialWriteFunnel();
    const r = await writeCredentialsSerialized(provider, HOME, CREDS, funnel);
    expect(r.ran).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].accessToken).toBe('sk-ant-oat0-X');
  });

  it('busy slot: the write is SKIPPED (ran:false) and the provider is NEVER called', async () => {
    const { provider, calls } = fakeProvider();
    const funnel = new CredentialWriteFunnel({ slotLockTimeoutMs: 30 });
    const release = occupySlot(funnel, HOME);
    try {
      const r = await writeCredentialsSerialized(provider, HOME, CREDS, funnel);
      expect(r.ran).toBe(false);
      expect(calls).toHaveLength(0);
    } finally {
      release();
    }
  });
});
