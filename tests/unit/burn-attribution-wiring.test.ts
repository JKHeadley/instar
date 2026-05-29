/**
 * Unit tests — attribution wiring fix (the "unknown::pre-attribution = 100%
 * of 24h spend" false-positive closure).
 *
 * Root cause this suite pins: Phase 2's AttributionResolver was written but
 * never wired into the ingest path, so EVERY JSONL-sourced token event was
 * hardcoded to the `unknown::pre-attribution` sentinel. With a single bucket,
 * its share was always 100%, so the BurnDetector's absolute-share trigger
 * (>25%) fired every hour forever — a false alarm, not a real burn.
 *
 * The fix has three observable behaviors, each covered here:
 *   1. AttributionResolver NEVER returns the sentinel — it always resolves to
 *      a real key. The sentinel is purely the column default / "never ran".
 *   2. TokenLedger.ingestLine now resolves a real key at write time, and a
 *      one-shot idempotent backfill converts legacy sentinel rows on boot.
 *   3. BurnDetector exempts the sentinel from the absolute-share trigger (a
 *      coverage gap is not a burn) while a genuinely-residual `unknown::<sid>`
 *      key still triggers normally.
 *
 * Spec: docs/specs/token-burn-detection-and-self-heal.md (Phase 2 wiring +
 * §"Threshold logic" sentinel-is-a-coverage-signal).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  resolveAttribution,
  PRE_ATTRIBUTION_KEY,
} from '../../src/monitoring/AttributionResolver.js';
import { TokenLedger } from '../../src/monitoring/TokenLedger.js';
import type { AttributionKeyRow } from '../../src/monitoring/TokenLedger.js';
import { BurnDetector } from '../../src/monitoring/BurnDetector.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function assistantLine(opts: {
  requestId: string;
  sessionId: string;
  cwd?: string;
  ts?: string;
  model?: string;
  input?: number;
  output?: number;
}): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: opts.sessionId,
    cwd: opts.cwd ?? '/',
    timestamp: opts.ts ?? '2026-05-29T16:00:00.000Z',
    uuid: 'uuid-' + opts.requestId,
    requestId: opts.requestId,
    message: {
      id: 'msg-' + opts.requestId,
      model: opts.model ?? 'claude-opus-4-8',
      usage: {
        input_tokens: opts.input ?? 10,
        output_tokens: opts.output ?? 100,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        service_tier: 'standard',
      },
    },
  });
}

// ── 1. The resolver never returns the sentinel ────────────────────────────

describe('AttributionResolver — never returns the PRE_ATTRIBUTION_KEY sentinel', () => {
  it('exports the sentinel as the documented literal', () => {
    expect(PRE_ATTRIBUTION_KEY).toBe('unknown::pre-attribution');
  });

  it('resolves a real key for every shape — never the sentinel', () => {
    const cases = [
      // The dominant Claude-CLI shape: no prompt on the assistant line, cwd '/'.
      { sessionId: '0418632d-aa11-4440-8110-b26af9335100', projectPath: '/', prompt: null },
      // Manifest prompt match.
      { sessionId: 's', prompt: 'analyzing terminal output' },
      // Scheduled-job cwd.
      { sessionId: 's', projectPath: '/Users/x/.instar/jobs/daily-summary', prompt: null },
      // Hook cwd.
      { sessionId: 's', projectPath: '/Users/x/.instar/hooks/instar/foo.js', prompt: null },
      // Empty session, no signals.
      { sessionId: '', projectPath: null, prompt: null },
      // Everything missing.
      { sessionId: 'abcdefgh8901', projectPath: undefined, prompt: undefined, model: undefined },
    ];
    for (const c of cases) {
      const key = resolveAttribution(c as any);
      expect(key).not.toBe(PRE_ATTRIBUTION_KEY);
      expect(key.length).toBeGreaterThan(0);
    }
  });

  it('falls back to a stable per-session key when only sessionId is known', () => {
    const key = resolveAttribution({ sessionId: '0418632d-aa11-4440', projectPath: '/', prompt: null });
    expect(key).toBe('unknown::0418632d');
    expect(key).not.toBe(PRE_ATTRIBUTION_KEY);
  });
});

// ── 2. ingest resolves + one-shot backfill ────────────────────────────────

describe('TokenLedger — ingest resolves attribution (no more sentinel pile-up)', () => {
  let ledger: TokenLedger;

  beforeEach(() => {
    ledger = new TokenLedger({ dbPath: ':memory:', claudeProjectsDir: '/tmp/nonexistent' });
  });
  afterEach(() => ledger.close());

  it('ingestLine on a normal assistant line stores a resolved per-session key, NOT the sentinel', () => {
    const sessionId = '0418632d-aa11-4440-8110-b26af9335100';
    ledger.ingestLine(assistantLine({ requestId: 'r1', sessionId, cwd: '/' }));
    const rows = ledger.byAttributionKey({ sinceMs: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0].attributionKey).toBe('unknown::' + sessionId.slice(0, 8));
    expect(rows[0].attributionKey).not.toBe(PRE_ATTRIBUTION_KEY);
  });

  it('attributes a scheduled-job cwd to a user-job:<name> key', () => {
    ledger.ingestLine(
      assistantLine({
        requestId: 'r1',
        sessionId: 's',
        cwd: '/Users/x/.instar/jobs/commitment-check',
      }),
    );
    const rows = ledger.byAttributionKey({ sinceMs: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0].attributionKey.startsWith('user-job:commitment-check')).toBe(true);
  });

  it('two different sessions split into two keys (the 100%-one-bucket bug is gone)', () => {
    ledger.ingestLine(assistantLine({ requestId: 'r1', sessionId: 'aaaaaaaa-1', cwd: '/' }));
    ledger.ingestLine(assistantLine({ requestId: 'r2', sessionId: 'bbbbbbbb-2', cwd: '/' }));
    const rows = ledger.byAttributionKey({ sinceMs: 0 });
    expect(rows).toHaveLength(2);
    const keys = rows.map((r) => r.attributionKey).sort();
    expect(keys).toEqual(['unknown::aaaaaaaa', 'unknown::bbbbbbbb']);
  });
});

describe('TokenLedger.backfillAttributionOnce — converts legacy sentinel rows, idempotent', () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attr-backfill-'));
    dbPath = path.join(tmp, 'ledger.db');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmp, {
      recursive: true,
      force: true,
      operation: 'tests/unit/burn-attribution-wiring.test.ts',
    });
  });

  it('is idempotent: a second call on a fresh ledger reports alreadyDone', () => {
    const ledger = new TokenLedger({ dbPath, claudeProjectsDir: tmp, attributionBackfill: 'sync' });
    // The constructor already ran the one-shot backfill (0 rows → marker set).
    const second = ledger.backfillAttributionOnce();
    expect(second.alreadyDone).toBe(true);
    expect(second.backfilled).toBe(0);
    ledger.close();
  });

  it('converts pre-existing sentinel rows on the next boot (the real upgrade path)', () => {
    // Phase 1: open a ledger and seed rows that still carry the sentinel,
    // simulating an agent whose DB pre-dates Phase 2 wiring. recordEvent lets
    // us force the sentinel key explicitly.
    const seed = new TokenLedger({ dbPath, claudeProjectsDir: tmp, attributionBackfill: 'sync' });
    seed.recordEvent({
      requestId: 'legacy-1', sessionId: 'sessA1234567', ts: 1000,
      inputTokens: 100, outputTokens: 50, attributionKey: PRE_ATTRIBUTION_KEY,
    });
    seed.recordEvent({
      requestId: 'legacy-2', sessionId: 'sessA1234567', ts: 2000,
      inputTokens: 10, outputTokens: 5, attributionKey: PRE_ATTRIBUTION_KEY,
    });
    seed.recordEvent({
      requestId: 'legacy-3', sessionId: 'sessB7654321', ts: 3000,
      inputTokens: 10, outputTokens: 5, attributionKey: PRE_ATTRIBUTION_KEY,
    });
    seed.close();

    // Both rows are under the sentinel, and the constructor's backfill already
    // marked the DB done (it found these rows AFTER the marker, since seed's
    // constructor ran on an empty DB). Simulate the genuine pre-wiring DB by
    // removing the marker so the NEXT boot's backfill actually runs.
    const raw = new Database(dbPath);
    raw.prepare(`DELETE FROM ledger_meta WHERE key = 'attribution-backfill-v1'`).run();
    // Sanity: the seeded rows really are on the sentinel before backfill.
    const before = raw
      .prepare(`SELECT COUNT(*) AS c FROM token_events WHERE attribution_key = ?`)
      .get(PRE_ATTRIBUTION_KEY) as { c: number };
    expect(before.c).toBe(3);
    raw.close();

    // Phase 2: re-open. The constructor runs backfillAttributionOnce(), which
    // finds the sentinel rows + no marker → converts them.
    const reopened = new TokenLedger({ dbPath, claudeProjectsDir: tmp, attributionBackfill: 'sync' });
    const rows = reopened.byAttributionKey({ sinceMs: 0 });
    // No row should remain on the sentinel.
    expect(rows.find((r) => r.attributionKey === PRE_ATTRIBUTION_KEY)).toBeUndefined();
    // The two sessions resolve to two stable per-session keys
    // (sessionId.slice(0, 8) — 'sessA123' / 'sessB765').
    const keys = rows.map((r) => r.attributionKey).sort();
    expect(keys).toEqual(['unknown::sessA123', 'unknown::sessB765']);
    // A subsequent explicit call is a no-op (marker now set).
    const again = reopened.backfillAttributionOnce();
    expect(again.alreadyDone).toBe(true);
    expect(again.backfilled).toBe(0);
    reopened.close();
  });

  it('async (default) does NOT convert rows during construction — boot never blocks on the scan', () => {
    // Seed sentinel rows + clear the marker so a real backfill is pending.
    const seed = new TokenLedger({ dbPath, claudeProjectsDir: tmp, attributionBackfill: 'sync' });
    for (let i = 0; i < 5; i++) {
      seed.recordEvent({
        requestId: `leg-${i}`, sessionId: `sessX${i}0000000`, ts: 1000 + i,
        inputTokens: 10, outputTokens: 5, attributionKey: PRE_ATTRIBUTION_KEY,
      });
    }
    seed.close();
    const raw = new Database(dbPath);
    raw.prepare(`DELETE FROM ledger_meta WHERE key = 'attribution-backfill-v1'`).run();
    raw.close();

    // Default strategy is 'async': construction returns WITHOUT having run the
    // scan (the fix — a large ledger can't stall boot). The background timer is
    // scheduled but has not fired in this synchronous test, so rows are still on
    // the sentinel immediately after construction.
    const led = new TokenLedger({ dbPath, claudeProjectsDir: tmp });
    const stillSentinel = led
      .byAttributionKey({ sinceMs: 0 })
      .filter((r) => r.attributionKey === PRE_ATTRIBUTION_KEY);
    expect(stillSentinel.length).toBeGreaterThan(0);

    // Driving chunks (what the background timer does) completes the backfill.
    let guard = 0;
    for (;;) {
      const { done } = led.backfillAttributionChunk(2);
      if (done || ++guard > 50) break;
    }
    const after = led.byAttributionKey({ sinceMs: 0 });
    expect(after.find((r) => r.attributionKey === PRE_ATTRIBUTION_KEY)).toBeUndefined();
    led.close();
  });

  it('backfillAttributionChunk is bounded by limit, resumable, and terminates', () => {
    const seed = new TokenLedger({ dbPath, claudeProjectsDir: tmp, attributionBackfill: 'sync' });
    for (let i = 0; i < 6; i++) {
      seed.recordEvent({
        requestId: `r-${i}`, sessionId: `sessQ${i}0000000`, ts: 1000 + i,
        inputTokens: 1, outputTokens: 1, attributionKey: PRE_ATTRIBUTION_KEY,
      });
    }
    seed.close();
    const raw = new Database(dbPath);
    raw.prepare(`DELETE FROM ledger_meta WHERE key = 'attribution-backfill-v1'`).run();
    raw.close();

    // 'off' → no auto-run; we drive chunks explicitly and assert bounding.
    const led = new TokenLedger({ dbPath, claudeProjectsDir: tmp, attributionBackfill: 'off' });
    const c1 = led.backfillAttributionChunk(2);
    expect(c1.backfilled).toBe(2); // 2 distinct triples × 1 row each
    expect(c1.done).toBe(false);
    led.backfillAttributionChunk(2); // 2 more
    led.backfillAttributionChunk(2); // last 2
    // All 6 converted; next chunk finds no sentinel rows → done + marker set.
    const cFinal = led.backfillAttributionChunk(2);
    expect(cFinal.done).toBe(true);
    expect(
      led.byAttributionKey({ sinceMs: 0 }).find((r) => r.attributionKey === PRE_ATTRIBUTION_KEY)
    ).toBeUndefined();
    // Marker is set → a further explicit full drain is a no-op.
    expect(led.backfillAttributionOnce().alreadyDone).toBe(true);
    led.close();
  });
});

// ── 3. BurnDetector exempts the sentinel from absolute-share ───────────────

function stubLedger(byKey: AttributionKeyRow[]) {
  return {
    byAttributionKey(): AttributionKeyRow[] {
      return byKey;
    },
    summary: () => ({ totalTokens: 0 } as any),
  };
}
function stubReporter() {
  const reports: any[] = [];
  return { reports, report(ev: any) { reports.push(ev); } };
}

describe('BurnDetector — PRE_ATTRIBUTION_KEY is exempt from absolute-share', () => {
  it('does NOT emit absolute-share when the sentinel is 100% of spend (the false-positive regression)', () => {
    const ledger = stubLedger([
      { attributionKey: PRE_ATTRIBUTION_KEY, totalTokens: 2_000_000, eventCount: 40, firstTs: 0, lastTs: 0 },
    ]);
    const reporter = stubReporter();
    const detector = new BurnDetector({
      ledger,
      reporter,
      // Infinite cold-start isolates absolute-share from baseline-divergence.
      config: { coldStartMs: Number.MAX_SAFE_INTEGER },
      now: () => 1_000_000_000_000,
    });
    expect(detector.tick()).toHaveLength(0);
    expect(reporter.reports).toHaveLength(0);
  });

  it('STILL emits absolute-share for a genuinely-residual unknown::<sid> key at 100%', () => {
    const ledger = stubLedger([
      { attributionKey: 'unknown::0418632d', totalTokens: 2_000_000, eventCount: 40, firstTs: 0, lastTs: 0 },
    ]);
    const reporter = stubReporter();
    const detector = new BurnDetector({
      ledger,
      reporter,
      config: { coldStartMs: Number.MAX_SAFE_INTEGER },
      now: () => 1_000_000_000_000,
    });
    const signals = detector.tick();
    expect(signals).toHaveLength(1);
    expect(signals[0].trigger).toBe('absolute-share');
    expect(signals[0].attributionKey).toBe('unknown::0418632d');
  });

  it('does not let the sentinel mask a real burner sharing the window', () => {
    // Sentinel at 60% + a real component at 40%: the sentinel is skipped, the
    // real component still trips the 25% threshold.
    const ledger = stubLedger([
      { attributionKey: PRE_ATTRIBUTION_KEY, totalTokens: 600, eventCount: 10, firstTs: 0, lastTs: 0 },
      { attributionKey: 'InputDetector::abcd1234', totalTokens: 400, eventCount: 10, firstTs: 0, lastTs: 0 },
    ]);
    const reporter = stubReporter();
    const detector = new BurnDetector({
      ledger,
      reporter,
      config: { coldStartMs: Number.MAX_SAFE_INTEGER },
      now: () => 1_000_000_000_000,
    });
    const signals = detector.tick();
    expect(signals).toHaveLength(1);
    expect(signals[0].attributionKey).toBe('InputDetector::abcd1234');
  });
});
