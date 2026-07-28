// safe-fs-allow: test file — uses only in-memory stores + tmpdir for the store factory.

/**
 * Tier-1 tests for maturation-followthrough-fix Standard C (C1 + C2) on the
 * GrowthDigestPublisher: the un-droppable-delivery contract and the tone-safe
 * digest content. Both sides of every decision boundary:
 *
 *  C2 — scanFormattedDigestForLeaks: a real formatted digest is clean; a leaky
 *       one is flagged (route path / config key / file path). formatDigest's own
 *       footer + truncation notes are asserted leak-free (the 2026-06-29 fix).
 *  C1 — isRetryableSendReason (retryable vs terminal); genericSendReason never
 *       echoes the raw reason; the publishOnce non-send matrix (retryable+on →
 *       defer, no window consumed, one NORMAL attention; retryable+off → legacy
 *       send-blocked consuming the window; terminal → send-blocked; exhaustion →
 *       send-exhausted + HIGH attention; success clears a prior deferral); the
 *       catchUp drain of a due deferral; the file-backed store round-trip.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  GrowthDigestPublisher,
  formatDigest,
  isRetryableSendReason,
  genericSendReason,
  scanFormattedDigestForLeaks,
  createGrowthDigestDeferralStore,
  type GrowthDigestPublisherDeps,
  type GrowthDigestAuditEntry,
  type GrowthDigestAttention,
  type GrowthDigestDeferral,
  type GrowthDigestDeferralStore,
} from '../../src/monitoring/GrowthDigestPublisher.js';
import type { GrowthDigest, GrowthFinding } from '../../src/monitoring/GrowthMilestoneAnalyst.js';

const COUNTS = {
  incubating: 0,
  promotionReady: 0,
  expiredUnproven: 0,
  stalling: 0,
  specPatterns: 0,
  correctionPatterns: 0,
  devGateDark: 0,
};

function activeDigest(findings?: GrowthFinding[]): GrowthDigest {
  const f: GrowthFinding[] = findings ?? [
    {
      rule: 'R1',
      priority: 'high',
      subjectId: 'feat-a',
      title: 'Feature "quota-planner" is ready to promote',
      detail: 'It cleared its incubation window with proof-of-life. Promote it or extend the window.',
      suggestedAction: 'promote',
    },
    {
      rule: 'R6',
      priority: 'normal',
      subjectId: 'feat-b',
      title: 'Dev-gated feature "mesh-coherence-check" is DARK on this dev agent',
      detail:
        'A periodic mesh coherence check. It follows the developmentAgent dark-feature gate, so it ' +
        'should run LIVE on a development agent — but the live config resolves it DARK on this agent.',
      suggestedAction: 'review',
    },
  ];
  return {
    generatedAt: '2026-06-08T11:00:00.000Z',
    calm: false,
    summary: 'Growth digest: 2 item(s) worth a look this week.',
    findings: f,
    counts: { ...COUNTS, promotionReady: 1, devGateDark: 1 },
  };
}

// ── In-memory deferral store (deterministic, no disk) ─────────────────────────
function memStore(): GrowthDigestDeferralStore & { map: Map<string, GrowthDigestDeferral> } {
  const map = new Map<string, GrowthDigestDeferral>();
  return {
    map,
    get: (w) => map.get(w),
    upsert: (r) => void map.set(r.windowId, { ...r }),
    remove: (w) => void map.delete(w),
    duePending: (now) =>
      [...map.values()].filter(
        (r) => r.state === 'deferred' && new Date(r.nextAttemptAt).getTime() <= now.getTime(),
      ),
    all: () => [...map.values()],
  };
}

interface C1Harness {
  pub: GrowthDigestPublisher;
  audits: GrowthDigestAuditEntry[];
  attention: GrowthDigestAttention[];
  store: ReturnType<typeof memStore>;
}

function makeC1Pub(over: {
  sendResult?: import('../../src/monitoring/GrowthDigestPublisher.js').DeliveryResult;
  escalationOn?: boolean;
  now?: Date;
  maxAttempts?: number;
  recordedWindows?: () => Set<string>;
  wireStore?: boolean;
  wireAttention?: boolean;
} = {}): C1Harness {
  const audits: GrowthDigestAuditEntry[] = [];
  const attention: GrowthDigestAttention[] = [];
  const store = memStore();
  const deps: GrowthDigestPublisherDeps = {
    buildDigest: () => activeDigest(),
    cron: '0 11 * * 1',
    mode: 'live',
    now: () => over.now ?? new Date('2026-06-10T17:30:00.000Z'),
    send: async () => over.sendResult ?? { ok: false, reason: 'tone-gate-blocked' },
    audit: (e) => audits.push(e),
    recordedWindows: over.recordedWindows,
    blockedDigestEscalationEnabled: () => over.escalationOn ?? true,
    deferrals: over.wireStore === false ? undefined : store,
    raiseAttention: over.wireAttention === false ? undefined : (a) => attention.push(a),
    machineId: () => 'mac-1',
    maxAttempts: over.maxAttempts,
  };
  return { pub: new GrowthDigestPublisher(deps), audits, attention, store };
}

afterEach(() => {
  /* no timers/fs to reset in these tests */
});

// ── C2: content is tone-safe (no route/config/file leak) ──────────────────────

describe('C2 — scanFormattedDigestForLeaks (deterministic tone-safety guard)', () => {
  it('a real formatted active digest is leak-clean (footer + findings)', () => {
    const text = formatDigest(activeDigest(), { timezone: 'UTC' });
    const scan = scanFormattedDigestForLeaks(text);
    expect(scan.clean).toBe(true);
    expect(scan.matches).toEqual([]);
    // The C2 footer is plain English, not a raw route path.
    expect(text).toContain('Full digest in your dashboard');
    expect(text).not.toContain('/growth/digest');
    expect(text).not.toContain('GET /');
  });

  it('a calm digest is leak-clean', () => {
    const calm: GrowthDigest = {
      generatedAt: '2026-06-08T11:00:00.000Z',
      calm: true,
      summary: 'All healthy — 2 feature(s) incubating, nothing past its window.',
      findings: [],
      counts: { ...COUNTS, incubating: 2 },
    };
    expect(scanFormattedDigestForLeaks(formatDigest(calm)).clean).toBe(true);
  });

  it('FLAGS a route path, a config key, and a file path (the regression the guard catches)', () => {
    const route = scanFormattedDigestForLeaks('Read the full digest anytime: GET /growth/digest.');
    expect(route.clean).toBe(false);
    expect(route.matches.some((m) => m.startsWith('route'))).toBe(true);

    const cfg = scanFormattedDigestForLeaks('it resolves DARK at monitoring.growthAnalyst.watcher.enabled today');
    expect(cfg.clean).toBe(false);
    expect(cfg.matches.some((m) => m.startsWith('config-key'))).toBe(true);

    const file = scanFormattedDigestForLeaks('see src/monitoring/GrowthDigestPublisher.ts for detail');
    expect(file.clean).toBe(false);
    expect(file.matches.some((m) => m.startsWith('file-path'))).toBe(true);
  });
});

// ── C1: reason classification ─────────────────────────────────────────────────

describe('C1 — isRetryableSendReason', () => {
  it('RETRYABLE: tone-gate block + provider/send faults', () => {
    for (const r of ['tone-gate-blocked', 'gate-timeout', 'slow-review', 'send-error', 'send-threw', 'ECONNRESET', 'rate-limited', 'HTTP 503']) {
      expect(isRetryableSendReason(r)).toBe(true);
    }
  });
  it('TERMINAL: structural / content non-sends + unknown', () => {
    for (const r of ['no-updates-topic', 'telegram-not-configured', 'no-sender', 'empty-text', 'too-long', undefined, 'wat']) {
      expect(isRetryableSendReason(r)).toBe(false);
    }
  });
});

describe('C1 — genericSendReason never echoes the raw reason (security)', () => {
  it('maps a tone block to a generic phrase, never the offending pattern', () => {
    const raw = 'tone-gate-blocked: raw route path "GET /growth/digest"';
    const generic = genericSendReason(raw);
    expect(generic).toBe('blocked by the outbound safety filter');
    expect(generic).not.toContain('/growth/digest');
    expect(generic).not.toContain('GET /');
  });
  it('maps a provider fault + a fallback', () => {
    expect(genericSendReason('HTTP 503 unavailable')).toBe('the messaging provider was unreachable');
    expect(genericSendReason('mystery')).toBe('delivery was interrupted');
  });
});

// ── C1: publishOnce non-send matrix ───────────────────────────────────────────

describe('C1 — publishOnce non-send matrix', () => {
  it('retryable block + C1 ON → send-deferred (NO window consumed) + ONE NORMAL attention + a stored deferral', async () => {
    const h = makeC1Pub({ sendResult: { ok: false, reason: 'tone-gate-blocked' }, escalationOn: true });
    await h.pub.publishOnce(new Date('2026-06-10T17:30:00Z'), 'cron', '2026-06-08T11:00:00.000Z');

    const deferred = h.audits.find((a) => a.action === 'send-deferred');
    expect(deferred).toBeDefined();
    // The window is NOT consumed — no window field, so recordedWindows() ignores it.
    expect(deferred!.window).toBeUndefined();
    expect(h.audits.some((a) => a.action === 'send-blocked')).toBe(false);
    // Exactly ONE attention item, NORMAL, generic reason.
    expect(h.attention.length).toBe(1);
    expect(h.attention[0].priority).toBe('NORMAL');
    expect(h.attention[0].reason).toBe('blocked by the outbound safety filter');
    expect(h.attention[0].id).toBe('mac-1:growth-digest-defer:2026-06-08T11:00:00.000Z');
    // A durable deferral record with attemptCount 1, state deferred.
    const rec = h.store.get('2026-06-08T11:00:00.000Z');
    expect(rec?.attemptCount).toBe(1);
    expect(rec?.state).toBe('deferred');
  });

  it('retryable block + C1 OFF → legacy send-blocked WITH window (consume-and-drop preserved)', async () => {
    const h = makeC1Pub({ sendResult: { ok: false, reason: 'tone-gate-blocked' }, escalationOn: false });
    await h.pub.publishOnce(new Date('2026-06-10T17:30:00Z'), 'cron', '2026-06-08T11:00:00.000Z');
    const blocked = h.audits.find((a) => a.action === 'send-blocked');
    expect(blocked).toBeDefined();
    expect(blocked!.window).toBe('2026-06-08T11:00:00.000Z');
    expect(h.attention.length).toBe(0);
    expect(h.store.all().length).toBe(0);
  });

  it('TERMINAL reason + C1 ON → send-blocked WITH window (never deferred)', async () => {
    const h = makeC1Pub({ sendResult: { ok: false, reason: 'no-updates-topic' }, escalationOn: true });
    await h.pub.publishOnce(new Date('2026-06-10T17:30:00Z'), 'cron', '2026-06-08T11:00:00.000Z');
    const blocked = h.audits.find((a) => a.action === 'send-blocked');
    expect(blocked?.window).toBe('2026-06-08T11:00:00.000Z');
    expect(h.attention.length).toBe(0);
  });

  it('exhaustion (attemptCount ≥ maxAttempts) → send-exhausted WITH window + ONE HIGH attention', async () => {
    const h = makeC1Pub({ sendResult: { ok: false, reason: 'tone-gate-blocked' }, escalationOn: true, maxAttempts: 2 });
    const win = '2026-06-08T11:00:00.000Z';
    // Attempt 1 → deferred.
    await h.pub.publishOnce(new Date('2026-06-10T17:30:00Z'), 'cron', win);
    expect(h.store.get(win)?.state).toBe('deferred');
    // Attempt 2 → hits maxAttempts=2 → terminal-failed.
    await h.pub.publishOnce(new Date('2026-06-10T17:31:00Z'), 'cron', win);
    const exhausted = h.audits.find((a) => a.action === 'send-exhausted');
    expect(exhausted).toBeDefined();
    expect(exhausted!.window).toBe(win); // consumed — stops retrying forever
    expect(h.store.get(win)?.state).toBe('terminal-failed');
    const high = h.attention.find((a) => a.priority === 'HIGH');
    expect(high).toBeDefined();
    expect(high!.reason).toBe('blocked by the outbound safety filter');
  });

  it('successful send clears a prior deferral (idempotency — a delivered window never retries)', async () => {
    const h = makeC1Pub({ sendResult: { ok: false, reason: 'tone-gate-blocked' }, escalationOn: true });
    const win = '2026-06-08T11:00:00.000Z';
    await h.pub.publishOnce(new Date('2026-06-10T17:30:00Z'), 'cron', win);
    expect(h.store.get(win)?.state).toBe('deferred');
    // Now the send succeeds on retry — a fresh publisher sharing the same store.
    const okPub = new GrowthDigestPublisher({
      buildDigest: () => activeDigest(),
      cron: '0 11 * * 1',
      mode: 'live',
      now: () => new Date('2026-06-10T17:35:00Z'),
      send: async () => ({ ok: true }),
      audit: (e) => h.audits.push(e),
      blockedDigestEscalationEnabled: () => true,
      deferrals: h.store,
      raiseAttention: (a) => h.attention.push(a),
      machineId: () => 'mac-1',
    });
    await okPub.publishOnce(new Date('2026-06-10T17:35:00Z'), 'cron', win);
    expect(h.audits.some((a) => a.action === 'sent')).toBe(true);
    expect(h.store.get(win)).toBeUndefined(); // cleared
  });

  it('a store fault falls back to legacy send-blocked (never a silent drop)', async () => {
    const audits: GrowthDigestAuditEntry[] = [];
    const throwingStore: GrowthDigestDeferralStore = {
      get: () => { throw new Error('disk fault'); },
      upsert: () => {},
      remove: () => {},
      duePending: () => [],
      all: () => [],
    };
    const pub = new GrowthDigestPublisher({
      buildDigest: () => activeDigest(),
      cron: '0 11 * * 1',
      mode: 'live',
      now: () => new Date('2026-06-10T17:30:00Z'),
      send: async () => ({ ok: false, reason: 'tone-gate-blocked' }),
      audit: (e) => audits.push(e),
      blockedDigestEscalationEnabled: () => true,
      deferrals: throwingStore,
      machineId: () => 'mac-1',
    });
    await pub.publishOnce(new Date('2026-06-10T17:30:00Z'), 'cron', '2026-06-08T11:00:00.000Z');
    expect(audits.some((a) => a.action === 'send-blocked' && a.window === '2026-06-08T11:00:00.000Z')).toBe(true);
  });
});

// ── C1: the file-backed store round-trips ─────────────────────────────────────

describe('C1 — createGrowthDigestDeferralStore (file-backed)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'growth-defer-'));
  afterEach(() => {
    try {
      SafeFsExecutor.safeRmSync(tmp, {
        recursive: true,
        force: true,
        operation: 'tests/unit/growth-digest-delivery-c1c2.test.ts',
      });
    } catch {
      /* best-effort */
    }
  });

  it('upsert → get → duePending → remove round-trips and persists to disk', () => {
    const store = createGrowthDigestDeferralStore(tmp);
    const now = new Date('2026-06-10T18:00:00Z');
    store.upsert({
      windowId: 'w1',
      attemptCount: 1,
      firstDeferredAt: '2026-06-10T17:00:00Z',
      nextAttemptAt: '2026-06-10T17:30:00Z', // due (< now)
      lastReason: 'tone-gate-blocked',
      attentionDedupeKey: 'mac-1:growth-digest-defer:w1',
      state: 'deferred',
    });
    store.upsert({
      windowId: 'w2',
      attemptCount: 1,
      firstDeferredAt: '2026-06-10T17:00:00Z',
      nextAttemptAt: '2026-06-10T23:00:00Z', // NOT due yet
      lastReason: 'send-error',
      attentionDedupeKey: 'mac-1:growth-digest-defer:w2',
      state: 'deferred',
    });
    expect(store.get('w1')?.attemptCount).toBe(1);
    const due = store.duePending(now);
    expect(due.map((d) => d.windowId)).toEqual(['w1']); // only w1 is due
    // Durable: a fresh store instance over the same dir sees the records.
    expect(createGrowthDigestDeferralStore(tmp).all().length).toBe(2);
    store.remove('w1');
    expect(store.get('w1')).toBeUndefined();
    expect(createGrowthDigestDeferralStore(tmp).all().length).toBe(1);
  });

  it('corrupt store file → empty (SAFE: never retry off garbage)', () => {
    const store = createGrowthDigestDeferralStore(tmp);
    fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'state', 'growth-digest-deferrals.json'), '{ not json');
    expect(store.all()).toEqual([]);
  });
});

// ── C1: catchUp drains a due deferral ─────────────────────────────────────────

describe('C1 — catchUp drains due deferrals', () => {
  it('a due deferred window is retried on catchUp; a successful retry clears it', async () => {
    const store = memStore();
    const win = '2026-06-08T11:00:00.000Z';
    store.upsert({
      windowId: win,
      attemptCount: 1,
      firstDeferredAt: '2026-06-09T00:00:00Z',
      nextAttemptAt: '2026-06-09T00:01:00Z', // due
      lastReason: 'tone-gate-blocked',
      attentionDedupeKey: `mac-1:growth-digest-defer:${win}`,
      state: 'deferred',
    });
    const audits: GrowthDigestAuditEntry[] = [];
    let sends = 0;
    const pub = new GrowthDigestPublisher({
      buildDigest: () => activeDigest(),
      cron: '0 11 * * 1',
      mode: 'live',
      settleMs: 0,
      now: () => new Date('2026-06-10T17:30:00Z'),
      send: async () => {
        sends++;
        return { ok: true };
      },
      audit: (e) => audits.push(e),
      recordedWindows: () => new Set<string>(),
      blockedDigestEscalationEnabled: () => true,
      deferrals: store,
      machineId: () => 'mac-1',
    });
    // Drive the catch-up path directly (start()'s settle timer calls it).
    await (pub as unknown as { catchUp: () => Promise<void> }).catchUp();
    expect(sends).toBeGreaterThanOrEqual(1);
    expect(audits.some((a) => a.action === 'sent')).toBe(true);
    expect(store.get(win)).toBeUndefined(); // delivered → cleared
  });
});
