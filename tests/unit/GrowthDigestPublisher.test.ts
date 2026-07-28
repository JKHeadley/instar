// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-1 tests for GrowthDigestPublisher (Slice 2 — the proactive growth-digest
 * voice). Pure logic with injected deps; both sides of every decision boundary:
 *  - the publishOnce matrix (isAwake × mode × calm × sendOnCalmWeeks × ok/blocked)
 *  - lease-gated delivery (standby → zero sends)
 *  - the in-flight (overlap) guard
 *  - missed-run catch-up + its idempotency on the window key
 *  - the cadence sanity-floor refusal
 *  - formatDigest: calm, single/all-rules, priority-never-truncate, scrub, overflow
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  GrowthDigestPublisher,
  formatDigest,
  createGrowthDigestAuditSink,
  type GrowthDigestAuditEntry,
  type DeliveryResult,
} from '../../src/monitoring/GrowthDigestPublisher.js';
import type {
  GrowthDigest,
  GrowthFinding,
  GrowthFindingPriority,
  GrowthRuleId,
} from '../../src/monitoring/GrowthMilestoneAnalyst.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

const COUNTS = {
  incubating: 0,
  promotionReady: 0,
  expiredUnproven: 0,
  stalling: 0,
  specPatterns: 0,
  correctionPatterns: 0,
  devGateDark: 0,
};

function calmDigest(): GrowthDigest {
  return {
    generatedAt: '2026-06-08T11:00:00.000Z',
    calm: true,
    summary: 'All healthy — 2 feature(s) incubating, nothing past its window. Next window closes in 3d.',
    findings: [],
    counts: { ...COUNTS, incubating: 2 },
    nextWindowClosesInDays: 3,
  };
}

function finding(
  rule: GrowthRuleId,
  priority: GrowthFindingPriority,
  i: number,
  detail = 'A short detail.',
): GrowthFinding {
  return {
    rule,
    priority,
    subjectId: `${rule}-${i}`,
    title: `${rule} item ${i}`,
    detail,
    suggestedAction: 'review',
  };
}

function activeDigest(findings: GrowthFinding[] = [finding('R3', 'normal', 1)]): GrowthDigest {
  return {
    generatedAt: '2026-06-08T11:00:00.000Z',
    calm: false,
    summary: `Growth digest: ${findings.length} item(s).`,
    findings,
    counts: { ...COUNTS, stalling: findings.filter((f) => f.rule === 'R3').length },
  };
}

interface Harness {
  pub: GrowthDigestPublisher;
  sends: string[];
  audits: GrowthDigestAuditEntry[];
}

function makePublisher(over: Partial<Parameters<typeof newPub>[0]> = {}): Harness {
  return newPub(over);
}

function newPub(over: {
  digest?: GrowthDigest;
  mode?: 'off' | 'dry-run' | 'live';
  isAwake?: () => boolean;
  sendOnCalmWeeks?: boolean;
  sendResult?: DeliveryResult;
  cron?: string;
  now?: Date;
}): Harness {
  const sends: string[] = [];
  const audits: GrowthDigestAuditEntry[] = [];
  const pub = new GrowthDigestPublisher({
    buildDigest: () => over.digest ?? activeDigest(),
    cron: over.cron ?? '0 11 * * 1',
    mode: over.mode ?? 'live',
    sendOnCalmWeeks: over.sendOnCalmWeeks,
    isAwake: over.isAwake,
    now: () => over.now ?? new Date('2026-06-10T17:30:00.000Z'),
    send: async (t: string) => {
      sends.push(t);
      return over.sendResult ?? { ok: true };
    },
    audit: (e) => audits.push(e),
  });
  return { pub, sends, audits };
}

afterEach(() => {
  vi.useRealTimers();
});

// ── publishOnce decision matrix ──────────────────────────────────────────────

describe('GrowthDigestPublisher.publishOnce — decision matrix', () => {
  it('live + non-calm + awake → sends exactly once, audits "sent"', async () => {
    const h = makePublisher({ mode: 'live' });
    await h.pub.publishOnce(new Date('2026-06-10T17:30:00Z'), 'manual');
    expect(h.sends.length).toBe(1);
    const sent = h.audits.find((a) => a.action === 'sent');
    expect(sent).toBeDefined();
    expect(sent!.counts).toBeDefined();
  });

  it('standby (isAwake:false) → ZERO sends, audits "skipped-standby", no window consumed', async () => {
    const h = makePublisher({ mode: 'live', isAwake: () => false });
    await h.pub.publishOnce(new Date('2026-06-10T17:30:00Z'), 'cron');
    expect(h.sends.length).toBe(0);
    expect(h.audits.length).toBe(1);
    expect(h.audits[0].action).toBe('skipped-standby');
    // Pre-lease check never records a window — the awake machine still owns it.
    expect(h.audits[0].window).toBeUndefined();
  });

  it('mode "off" → ZERO sends, audits "skipped-off"', async () => {
    const h = makePublisher({ mode: 'off' });
    await h.pub.publishOnce(new Date('2026-06-10T17:30:00Z'), 'cron');
    expect(h.sends.length).toBe(0);
    expect(h.audits[0].action).toBe('skipped-off');
  });

  it('dry-run → ZERO sends, audits "dry-run" carrying the would-send text', async () => {
    const h = makePublisher({ mode: 'dry-run' });
    await h.pub.publishOnce(new Date('2026-06-10T17:30:00Z'), 'cron');
    expect(h.sends.length).toBe(0);
    const dry = h.audits.find((a) => a.action === 'dry-run');
    expect(dry).toBeDefined();
    expect(dry!.wouldSend).toContain('Growth check-in');
  });

  it('calm + sendOnCalmWeeks:false (default) → ZERO sends, audits "skipped-calm"', async () => {
    const h = makePublisher({ mode: 'live', digest: calmDigest() });
    await h.pub.publishOnce(new Date('2026-06-10T17:30:00Z'), 'cron');
    expect(h.sends.length).toBe(0);
    expect(h.audits.find((a) => a.action === 'skipped-calm')).toBeDefined();
  });

  it('calm + sendOnCalmWeeks:true → SENDS the calm heartbeat', async () => {
    const h = makePublisher({ mode: 'live', digest: calmDigest(), sendOnCalmWeeks: true });
    await h.pub.publishOnce(new Date('2026-06-10T17:30:00Z'), 'cron');
    expect(h.sends.length).toBe(1);
    expect(h.audits.find((a) => a.action === 'sent')).toBeDefined();
  });

  it('live but guard blocks (send → {ok:false}) → audits "send-blocked" with reason, not an error', async () => {
    const h = makePublisher({ mode: 'live', sendResult: { ok: false, reason: 'guard-blocked' } });
    await h.pub.publishOnce(new Date('2026-06-10T17:30:00Z'), 'cron');
    expect(h.sends.length).toBe(1); // send WAS attempted
    const blocked = h.audits.find((a) => a.action === 'send-blocked');
    expect(blocked).toBeDefined();
    expect(blocked!.reason).toBe('guard-blocked');
  });

  it('in-flight (overlap) guard → a re-entrant publishOnce audits "skipped-overlap"', async () => {
    const audits: GrowthDigestAuditEntry[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const pub = new GrowthDigestPublisher({
      buildDigest: () => activeDigest(),
      cron: '0 11 * * 1',
      mode: 'live',
      now: () => new Date('2026-06-10T17:30:00Z'),
      send: async () => {
        await gate; // hold the first cycle open
        return { ok: true };
      },
      audit: (e) => audits.push(e),
    });
    const first = pub.publishOnce(new Date('2026-06-10T17:30:00Z'), 'cron');
    const second = pub.publishOnce(new Date('2026-06-10T17:30:00Z'), 'cron'); // re-enters while first is mid-send
    await second;
    expect(audits.find((a) => a.action === 'skipped-overlap')).toBeDefined();
    release();
    await first;
  });
});

// ── sanity-floor + start ─────────────────────────────────────────────────────

describe('GrowthDigestPublisher.start — cadence sanity-floor', () => {
  it('refuses to start a sub-hourly cadence', () => {
    const onError = vi.fn();
    const pub = new GrowthDigestPublisher({
      buildDigest: () => activeDigest(),
      cron: '*/30 * * * *', // 30-minute cadence — under the 1h floor
      mode: 'live',
      now: () => new Date('2026-06-10T17:30:00Z'),
      onError,
    });
    pub.start();
    expect(pub.isStarted()).toBe(false);
    expect(onError).toHaveBeenCalledWith('start', expect.any(Error));
    pub.stop();
  });

  it('starts a weekly cadence', () => {
    const pub = new GrowthDigestPublisher({
      buildDigest: () => activeDigest(),
      cron: '0 11 * * 1',
      mode: 'live',
      now: () => new Date('2026-06-10T17:30:00Z'),
      settleMs: 60_000,
    });
    pub.start();
    expect(pub.isStarted()).toBe(true);
    pub.stop();
    expect(pub.isStarted()).toBe(false);
  });
});

// ── missed-run catch-up ──────────────────────────────────────────────────────

describe('GrowthDigestPublisher — missed-run catch-up', () => {
  it('replays the most-recent missed window once on start, then is idempotent across restarts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T17:30:00.000Z')); // Wed — last Mon 11:00 fire elapsed

    const recorded = new Set<string>();
    const audits: GrowthDigestAuditEntry[] = [];
    const sends: string[] = [];
    const mk = () =>
      new GrowthDigestPublisher({
        buildDigest: () => activeDigest(),
        cron: '0 11 * * 1',
        mode: 'live',
        now: () => new Date('2026-06-10T17:30:00.000Z'),
        send: async (t: string) => {
          sends.push(t);
          return { ok: true };
        },
        audit: (e) => {
          audits.push(e);
          if (e.window) recorded.add(e.window); // emulate the durable window record
        },
        recordedWindows: () => recorded,
        settleMs: 1_000,
      });

    const pub1 = mk();
    pub1.start();
    await vi.advanceTimersByTimeAsync(1_200);
    const catchup = audits.find((a) => a.trigger === 'catchup');
    expect(catchup).toBeDefined();
    expect(catchup!.action).toBe('sent');
    expect(catchup!.window).toBeDefined();
    expect(sends.length).toBe(1);
    pub1.stop();

    // Restart: the window is now in `recorded` → catch-up must NOT re-fire it.
    const pub2 = mk();
    pub2.start();
    await vi.advanceTimersByTimeAsync(1_200);
    expect(sends.length).toBe(1); // unchanged — no double-send across the restart
    pub2.stop();
  });
});

// ── formatDigest ─────────────────────────────────────────────────────────────

describe('formatDigest — deterministic render', () => {
  it('calm digest renders header + summary only', () => {
    const text = formatDigest(calmDigest());
    expect(text).toContain('📊 Growth check-in');
    expect(text).toContain('All healthy');
    expect(text).not.toContain('🔸');
  });

  it('single-rule digest renders the rule section + footer', () => {
    const text = formatDigest(activeDigest([finding('R3', 'normal', 1)]));
    expect(text).toContain('🔸 Stalling');
    expect(text).toContain('R3 item 1');
    expect(text).toContain('GET /growth/digest');
  });

  it('renders all six rules', () => {
    const all: GrowthFinding[] = [
      finding('R1', 'normal', 1),
      finding('R2', 'normal', 1),
      finding('R3', 'normal', 1),
      finding('R4', 'low', 1),
      finding('R5', 'low', 1),
      finding('R6', 'normal', 1),
    ];
    const text = formatDigest(activeDigest(all));
    for (const rule of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6']) {
      expect(text).toContain(`${rule} item 1`);
    }
  });

  it('priority-never-truncate: a high-priority finding survives among 500 low ones, ≤4096 chars', () => {
    const bulk = Array.from({ length: 500 }, (_, i) => finding('R3', 'low', i));
    const high = finding('R3', 'high', 9999, 'CRITICAL — decide now.');
    high.title = 'HIGH-PRIORITY SENTINEL';
    const text = formatDigest(activeDigest([...bulk, high]));
    expect(text).toContain('HIGH-PRIORITY SENTINEL'); // never dropped
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain('more (see full digest)'); // bulk overflowed
  });

  it('R1 (promote) and R6 (dev-gate-dark) are always rendered in full even amid bulk', () => {
    const bulk = Array.from({ length: 50 }, (_, i) => finding('R3', 'low', i));
    const promote = finding('R1', 'normal', 1);
    promote.title = 'PROMOTE-ME';
    const dark = finding('R6', 'normal', 1);
    dark.title = 'DARK-GATE-ME';
    const text = formatDigest(activeDigest([...bulk, promote, dark]));
    expect(text).toContain('PROMOTE-ME');
    expect(text).toContain('DARK-GATE-ME');
  });

  it('scrubs secret shapes from titles and details at the render boundary', () => {
    const f = finding('R3', 'normal', 1, 'token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 here');
    const text = formatDigest(activeDigest([f]));
    expect(text).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
    expect(text).toContain('REDACTED');
  });

  it('caps the low/normal bulk at K per rule with a "+N more" overflow line', () => {
    const six = Array.from({ length: 6 }, (_, i) => finding('R3', 'normal', i));
    const text = formatDigest(activeDigest(six), { perRuleCap: 5 });
    expect(text).toContain('+1 more (see full digest)');
    // exactly 5 bullet rows for R3
    const bulletCount = text.split('\n').filter((l) => l.startsWith('• R3 item')).length;
    expect(bulletCount).toBe(5);
  });

  it('renders the header date in the injected timezone', () => {
    // 2026-06-09T02:00:00Z is Jun 8 18:00 in Los Angeles.
    const d: GrowthDigest = { ...activeDigest(), generatedAt: '2026-06-09T02:00:00.000Z' };
    expect(formatDigest(d, { timezone: 'UTC' })).toContain('Jun 9');
    expect(formatDigest(d, { timezone: 'America/Los_Angeles' })).toContain('Jun 8');
  });

  it('caps each detail at the detailCap with an ellipsis', () => {
    const long = 'x'.repeat(500);
    const text = formatDigest(activeDigest([finding('R3', 'normal', 1, long)]), { detailCap: 50 });
    expect(text).toContain('…');
    expect(text).not.toContain('x'.repeat(60));
  });
});

// ── default audit sink ───────────────────────────────────────────────────────

describe('createGrowthDigestAuditSink', () => {
  it('writes JSONL and reads back only window-bearing entries', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdp-audit-'));
    const sink = createGrowthDigestAuditSink(dir);
    sink.write({ ts: 't1', action: 'skipped-standby' }); // no window
    sink.write({ ts: 't2', action: 'sent', window: '2026-06-08T11:00:00.000Z' });
    sink.write({ ts: 't3', action: 'skipped-calm', window: '2026-06-15T11:00:00.000Z' });
    const wins = sink.recordedWindows();
    expect(wins.has('2026-06-08T11:00:00.000Z')).toBe(true);
    expect(wins.has('2026-06-15T11:00:00.000Z')).toBe(true);
    expect(wins.size).toBe(2); // the windowless entry is not counted
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/GrowthDigestPublisher.test.ts' });
  });
});
