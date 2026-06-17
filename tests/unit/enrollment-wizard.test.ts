/**
 * Unit tests for EnrollmentWizard (P2.1). Hermetic: injected login-driver +
 * injected clock + temp-dir store. No spawning, no network, no OAuth. Covers
 * start (drive→store), the auto-reissue-expired sweep (the pi-live-test gap),
 * driver-failure resilience, default flow kind per provider, and complete.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  it('flowNotice: url-code-paste (Claude) warns about the two-code sequence; device-code does not', () => {
    const claude = EnrollmentWizard.flowNotice('url-code-paste');
    expect(claude).toBeTruthy();
    expect(claude).toMatch(/two codes/i);
    expect(claude).toMatch(/email/i);
    expect(EnrollmentWizard.flowNotice('device-code')).toBeUndefined();
  });

  it('start attaches the two-code notice on a Claude (url-code-paste) enrollment', async () => {
    const w = wizard([{ verificationUrl: 'https://claude.com/oauth/authorize?code=abc', ttlMs: 15 * 60_000 }]);
    const l = await w.start({ id: 'sagemind-1', label: 'SageMind - Justin', provider: 'anthropic', framework: 'claude-code' });
    expect(l.kind).toBe('url-code-paste');
    expect(l.notice).toMatch(/two codes/i);
    // it survives the store round-trip onto the phone surface
    expect(w.pending()[0].notice).toMatch(/two codes/i);
  });

  it('start attaches NO notice on a device-code (Codex) enrollment', async () => {
    const w = wizard([{ verificationUrl: 'https://auth.openai.com/codex/device', userCode: '7DAU-W4XJA', ttlMs: 15 * 60_000 }]);
    const l = await w.start({ id: 'codex-1', label: 'codex', provider: 'openai', framework: 'codex-cli' });
    expect(l.kind).toBe('device-code');
    expect(l.notice).toBeUndefined();
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

  // ── Onboarding-safe enrollment (2026-06-09 incident) ──────────────
  // `claude auth login` is headless-only: it stores tokens but never sets the
  // interactive first-launch flags, so a freshly-enrolled home wedges the
  // first interactive session pinned/swapped onto it. complete() must seed
  // the flags for claude-code enrollments with a config home.

  function wizardWithReadySpy(artifacts: LoginArtifact[], ready?: (h: string) => { patched: boolean; reason: string }) {
    const readyCalls: string[] = [];
    const queue = [...artifacts];
    const w = new EnrollmentWizard({
      store,
      driveLogin: async () => queue.shift() ?? { verificationUrl: 'https://u', ttlMs: 15 * 60_000 },
      now: () => clock,
      ensureReady: (h: string) => {
        readyCalls.push(h);
        return ready ? ready(h) : { patched: true, reason: 'seeded' };
      },
    });
    return { w, readyCalls };
  }

  it('complete seeds interactive-readiness for a claude-code login with a configHome', async () => {
    const { w, readyCalls } = wizardWithReadySpy([{ verificationUrl: 'https://claude.com/oauth', ttlMs: 15 * 60_000 }]);
    await w.start({ id: 'sm-1', label: 'SageMind - Justin', provider: 'anthropic', framework: 'claude-code', configHome: '/Users/x/.claude-sm' });
    expect(w.complete('sm-1')?.status).toBe('completed');
    expect(readyCalls).toEqual(['/Users/x/.claude-sm']);
  });

  it('complete does NOT seed for a codex login or a login without a configHome', async () => {
    const { w, readyCalls } = wizardWithReadySpy([
      { verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'AAAA-BBBB', ttlMs: 15 * 60_000 },
      { verificationUrl: 'https://claude.com/oauth', ttlMs: 15 * 60_000 },
    ]);
    await w.start({ id: 'codex-1', label: 'codex', provider: 'openai', framework: 'codex-cli', configHome: '/Users/x/.codex-2' });
    await w.start({ id: 'claude-default', label: 'claude', provider: 'anthropic', framework: 'claude-code' });
    w.complete('codex-1');
    w.complete('claude-default');
    expect(readyCalls).toEqual([]);
  });

  it('a seeding failure never blocks completion (fail-safe — launch paths re-ensure)', async () => {
    const { w } = wizardWithReadySpy(
      [{ verificationUrl: 'https://claude.com/oauth', ttlMs: 15 * 60_000 }],
      () => ({ patched: false, reason: 'unreadable' }),
    );
    await w.start({ id: 'sm-1', label: 'SageMind', provider: 'anthropic', framework: 'claude-code', configHome: '/Users/x/.claude-sm' });
    expect(w.complete('sm-1')?.status).toBe('completed');
  });

  it('default ensureReady is the REAL util: complete() lands the flags on disk', async () => {
    const configHome = path.join(dir, '.claude-enrolled');
    fs.mkdirSync(configHome);
    fs.writeFileSync(path.join(configHome, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'u-1' } }));
    const w = new EnrollmentWizard({
      store,
      driveLogin: async () => ({ verificationUrl: 'https://claude.com/oauth', ttlMs: 15 * 60_000 }),
      now: () => clock,
    });
    await w.start({ id: 'sm-1', label: 'SageMind', provider: 'anthropic', framework: 'claude-code', configHome });
    w.complete('sm-1');
    const cfg = JSON.parse(fs.readFileSync(path.join(configHome, '.claude.json'), 'utf-8'));
    expect(cfg.hasCompletedOnboarding).toBe(true);
    expect(cfg.bypassPermissionsModeAccepted).toBe(true);
    expect(cfg.hasTrustDialogAccepted).toBe(true);
    expect(cfg.oauthAccount).toEqual({ accountUuid: 'u-1' }); // untouched
  });

  // ── WS5.2 §5.3 step 3 / S7 — completeFollowMe (email-validation gate) ───────────────
  describe('completeFollowMe (email-validation-before-selectable)', () => {
    // Pre-issue a follow-me pending login carrying the operator-expected email.
    function issueFollowMe(expectedEmail: string | undefined, configHome = '/x/.claude-fm') {
      store.issue({
        id: 'fm-1',
        label: 'main',
        provider: 'anthropic',
        framework: 'claude-code',
        kind: 'url-code-paste',
        configHome,
        verificationUrl: 'https://claude.com/oauth',
        ...(expectedEmail !== undefined ? { expectedEmail } : {}),
      });
    }
    function build(opts: {
      oracle?: { resolveSlotTenant: (slot: string) => Promise<{ email?: string; unavailable?: boolean; reason?: string }> };
      emitAttention?: (item: { id: string; title: string; body: string; priority: 'high'; source: 'agent' }) => void;
    }) {
      return new EnrollmentWizard({
        store,
        driveLogin: async () => ({ verificationUrl: 'https://claude.com/oauth', ttlMs: 15 * 60_000 }),
        now: () => clock,
        oracle: opts.oracle,
        emitAttention: opts.emitAttention,
      });
    }

    it('(a) matching email → validated, returns the email, no attention', async () => {
      issueFollowMe('j@x.com');
      const emit = vi.fn();
      const w = build({ oracle: { resolveSlotTenant: async () => ({ email: 'j@x.com' }) }, emitAttention: emit });
      const r = await w.completeFollowMe('fm-1', 'the Mini');
      expect(r.outcome).toBe('validated');
      if (r.outcome === 'validated') expect(r.email).toBe('j@x.com');
      expect(emit).not.toHaveBeenCalled();
      // the login was still completed (sync complete() ran)
      expect(store.get('fm-1')?.status).toBe('completed');
    });

    it('(b) mismatched email → held + HIGH attention emitted + not validated', async () => {
      issueFollowMe('approved@x.com');
      const emit = vi.fn();
      const w = build({ oracle: { resolveSlotTenant: async () => ({ email: 'attacker@evil.com' }) }, emitAttention: emit });
      const r = await w.completeFollowMe('fm-1', 'the Mini');
      expect(r.outcome).toBe('held');
      if (r.outcome === 'held') expect(r.reason).toBe('email-mismatch');
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit.mock.calls[0][0]).toMatchObject({ priority: 'high', source: 'agent' });
    });

    it('(c) oracle unavailable → held (fail-closed)', async () => {
      issueFollowMe('j@x.com');
      const emit = vi.fn();
      const w = build({ oracle: { resolveSlotTenant: async () => ({ unavailable: true, reason: '401' }) }, emitAttention: emit });
      const r = await w.completeFollowMe('fm-1', 'the Mini');
      expect(r.outcome).toBe('held');
      if (r.outcome === 'held') expect(r.reason).toBe('missing-completed-email');
      expect(emit).toHaveBeenCalledTimes(1);
    });

    it('(c2) no oracle configured → held (fail-closed)', async () => {
      issueFollowMe('j@x.com');
      const w = build({});
      const r = await w.completeFollowMe('fm-1', 'the Mini');
      expect(r.outcome).toBe('held');
    });

    it('(c3) oracle throws → held (fail-closed, never crashes)', async () => {
      issueFollowMe('j@x.com');
      const w = build({ oracle: { resolveSlotTenant: async () => { throw new Error('boom'); } } });
      const r = await w.completeFollowMe('fm-1', 'the Mini');
      expect(r.outcome).toBe('held');
    });

    it('(c4) missing operator-expected email → held (fail-closed even on a real probe)', async () => {
      issueFollowMe(undefined);
      const w = build({ oracle: { resolveSlotTenant: async () => ({ email: 'j@x.com' }) } });
      const r = await w.completeFollowMe('fm-1', 'the Mini');
      expect(r.outcome).toBe('held');
      if (r.outcome === 'held') expect(r.reason).toBe('missing-expected-email');
    });

    it('(d) unknown id → not-found', async () => {
      const w = build({ oracle: { resolveSlotTenant: async () => ({ email: 'j@x.com' }) } });
      const r = await w.completeFollowMe('nope', 'the Mini');
      expect(r.outcome).toBe('not-found');
    });
  });
});
