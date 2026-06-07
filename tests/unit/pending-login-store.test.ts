/**
 * Unit tests for PendingLoginStore (P2.1). Hermetic: injected clock (no real
 * time), temp-dir state, zero network. Covers issue + TTL→expired (live status)
 * + auto-reissue + complete/abandon + the never-store-credentials guard, both
 * sides of each boundary.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PendingLoginStore, ValidationError } from '../../src/core/PendingLoginStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const T0 = Date.parse('2026-06-07T00:00:00Z');

function deviceCode(id = 'codex-1') {
  return {
    id,
    label: 'codex',
    provider: 'openai' as const,
    framework: 'codex-cli' as const,
    kind: 'device-code' as const,
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: '7DAU-W4XJA',
  };
}

describe('PendingLoginStore', () => {
  let dir: string;
  let clock: number;
  let store: PendingLoginStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plogin-'));
    clock = T0;
    store = new PendingLoginStore({ stateDir: dir, now: () => clock });
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/pending-login-store.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  it('issues a device-code login (default 15-min TTL) and persists it', () => {
    const l = store.issue(deviceCode());
    expect(l.status).toBe('pending');
    expect(l.userCode).toBe('7DAU-W4XJA');
    expect(Date.parse(l.ttlExpiresAt) - T0).toBe(15 * 60_000);
    expect(new PendingLoginStore({ stateDir: dir, now: () => clock }).get('codex-1')?.label).toBe('codex');
  });

  it('reports expired (live) once the TTL elapses — the auto-reissue work-list', () => {
    store.issue(deviceCode());
    expect(store.active().map(l => l.id)).toEqual(['codex-1']);
    expect(store.expired()).toEqual([]);
    clock = T0 + 15 * 60_000 + 1; // past TTL
    expect(store.active()).toEqual([]);
    expect(store.expired().map(l => l.id)).toEqual(['codex-1']);
    expect(store.get('codex-1')?.status).toBe('expired');
  });

  it('auto-reissues an expired login with a fresh code + TTL (bumps reissueCount)', () => {
    store.issue(deviceCode());
    clock = T0 + 16 * 60_000; // expired
    const r = store.reissue('codex-1', { verificationUrl: 'https://auth.openai.com/codex/device', userCode: '7EHB-L23HC' });
    expect(r?.status).toBe('pending');
    expect(r?.userCode).toBe('7EHB-L23HC');
    expect(r?.reissueCount).toBe(1);
    expect(Date.parse(r!.ttlExpiresAt)).toBe(clock + 15 * 60_000);
  });

  it('complete / abandon are terminal; reissue refuses them', () => {
    store.issue(deviceCode());
    expect(store.complete('codex-1')?.status).toBe('completed');
    expect(() => store.reissue('codex-1', { verificationUrl: 'x' })).toThrow(/cannot reissue a completed/);
    store.issue(deviceCode('codex-2'));
    expect(store.abandon('codex-2')?.status).toBe('abandoned');
  });

  it('url-code-paste flow needs no userCode; device-code requires one', () => {
    expect(store.issue({ id: 'claude-1', label: 'claude', provider: 'anthropic', framework: 'claude-code', kind: 'url-code-paste', verificationUrl: 'https://claude.ai/oauth/...' }).kind).toBe('url-code-paste');
    expect(() => store.issue({ id: 'bad', label: 'x', provider: 'openai', framework: 'codex-cli', kind: 'device-code', verificationUrl: 'u' })).toThrow(/requires a userCode/);
  });

  it('validates id charset + rejects duplicates + missing fields', () => {
    expect(() => store.issue({ ...deviceCode(), id: 'Bad Id' })).toThrow(/\^\[a-z0-9-\]/);
    store.issue(deviceCode());
    expect(() => store.issue(deviceCode())).toThrow(/already exists/);
    expect(() => store.issue({ ...deviceCode(), id: 'x', verificationUrl: '' })).toThrow(/verificationUrl is required/);
  });

  it('rejects credential-bearing fields (stores public codes/URLs only)', () => {
    for (const bad of ['accessToken', 'token', 'secret', 'password', 'apiKey']) {
      expect(() => store.issue(deviceCode('c'), { ...deviceCode('c'), [bad]: 'sk-leak' })).toThrow(/never credentials/);
    }
    expect(store.size()).toBe(0);
  });

  it('starts fresh on a corrupt store (no credentials lost)', () => {
    fs.writeFileSync(path.join(dir, 'pending-logins.json'), '{ broken');
    const fresh = new PendingLoginStore({ stateDir: dir, now: () => clock });
    expect(fresh.size()).toBe(0);
    expect(fresh.issue(deviceCode()).id).toBe('codex-1');
  });
});
