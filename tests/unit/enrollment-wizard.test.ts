/**
 * Unit tests for EnrollmentWizard (P2.1). Hermetic: injected login-driver +
 * injected clock + temp-dir store. No spawning, no network, no OAuth. Covers
 * start (drive→store), the auto-reissue-expired sweep (the pi-live-test gap),
 * driver-failure resilience, default flow kind per provider, and complete.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PendingLoginStore } from '../../src/core/PendingLoginStore.js';
import { EnrollmentWizard, type LoginArtifact } from '../../src/core/EnrollmentWizard.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const T0 = Date.parse('2026-06-07T00:00:00Z');

describe('EnrollmentWizard', () => {
  let dir: string;
  let clock: number;
  let store: PendingLoginStore;
  let driveCalls: number;

  function wizard(artifacts: LoginArtifact[] | (() => Promise<LoginArtifact>)) {
    driveCalls = 0;
    const queue = Array.isArray(artifacts) ? [...artifacts] : null;
    const driveLogin = async () => {
      driveCalls++;
      if (typeof artifacts === 'function') return artifacts();
      return queue!.shift() ?? { verificationUrl: 'https://example/fallback', userCode: 'FALL-BACK', ttlMs: 15 * 60_000 };
    };
    return new EnrollmentWizard({ store, driveLogin, now: () => clock });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enroll-'));
    clock = T0;
    store = new PendingLoginStore({ stateDir: dir, now: () => clock });
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/enrollment-wizard.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  it('default flow kind: Codex=device-code, others=url-code-paste', () => {
    expect(EnrollmentWizard.defaultKind('openai')).toBe('device-code');
    expect(EnrollmentWizard.defaultKind('anthropic')).toBe('url-code-paste');
    expect(EnrollmentWizard.defaultKind('github-copilot')).toBe('url-code-paste');
  });

  it('start drives the login + stores the public code/URL with TTL', async () => {
    const w = wizard([{ verificationUrl: 'https://auth.openai.com/codex/device', userCode: '7DAU-W4XJA', ttlMs: 15 * 60_000 }]);
    const l = await w.start({ id: 'codex-1', label: 'codex', provider: 'openai', framework: 'codex-cli' });
    expect(l.kind).toBe('device-code');
    expect(l.userCode).toBe('7DAU-W4XJA');
    expect(l.status).toBe('pending');
    expect(driveCalls).toBe(1);
    expect(w.pending().map(x => x.id)).toEqual(['codex-1']);
  });

  it('auto-reissues an EXPIRED login (the pi-live-test gap) with a fresh code', async () => {
    const w = wizard([
      { verificationUrl: 'https://auth.openai.com/codex/device', userCode: '7DAU-W4XJA', ttlMs: 15 * 60_000 },
      { verificationUrl: 'https://auth.openai.com/codex/device', userCode: '7EHB-L23HC', ttlMs: 15 * 60_000 }, // the re-issue
    ]);
    await w.start({ id: 'codex-1', label: 'codex', provider: 'openai', framework: 'codex-cli' });
    // Nothing to reissue while valid.
    clock = T0 + 5 * 60_000;
    expect(await w.reissueExpired()).toEqual([]);
    // Past TTL → auto-reissue.
    clock = T0 + 16 * 60_000;
    const reissued = await w.reissueExpired();
    expect(reissued).toHaveLength(1);
    expect(reissued[0].userCode).toBe('7EHB-L23HC');
    expect(reissued[0].reissueCount).toBe(1);
    expect(driveCalls).toBe(2); // start + one reissue
    // Now valid again → pending surface shows the fresh code.
    expect(w.pending()[0].userCode).toBe('7EHB-L23HC');
  });

  it('a driver failure during reissue is skipped (sweep continues, login stays expired)', async () => {
    let n = 0;
    const w = wizard(async () => {
      n++;
      if (n === 1) return { verificationUrl: 'https://u', userCode: 'AAAA-BBBB', ttlMs: 15 * 60_000 };
      throw new Error('login flow timed out');
    });
    await w.start({ id: 'codex-1', label: 'codex', provider: 'openai', framework: 'codex-cli' });
    clock = T0 + 16 * 60_000;
    const reissued = await w.reissueExpired();
    expect(reissued).toEqual([]);              // driver threw → nothing reissued
    expect(store.get('codex-1')?.status).toBe('expired'); // left expired for next sweep
  });

  it('complete marks the login done (and it leaves the pending surface)', async () => {
    const w = wizard([{ verificationUrl: 'https://u', userCode: 'AAAA-BBBB' }]);
    await w.start({ id: 'codex-1', label: 'codex', provider: 'openai', framework: 'codex-cli' });
    expect(w.complete('codex-1')?.status).toBe('completed');
    expect(w.pending()).toEqual([]);
  });
});
