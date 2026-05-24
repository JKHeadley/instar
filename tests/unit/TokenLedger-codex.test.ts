/**
 * Unit tests for TokenLedger's Codex session surface.
 *
 * Codex usage lives in a SEPARATE codex_token_sessions table so that the
 * BurnDetector (which reads token_events via summary()/byAttributionKey())
 * is provably unaffected. These tests lock that isolation in, plus the
 * cumulative-replace upsert semantics and the aggregate queries.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TokenLedger } from '../../src/monitoring/TokenLedger.js';
import type { ParsedCodexSession } from '../../src/monitoring/CodexRolloutParser.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function parsed(over: Partial<ParsedCodexSession> & { sessionId: string; totalTokens: number }): ParsedCodexSession {
  return {
    sessionId: over.sessionId,
    cwd: over.cwd ?? '/Users/justin/Documents/Projects/instar-codey',
    model: over.model ?? 'gpt-5.2',
    planType: over.planType ?? 'prolite',
    inputTokens: over.inputTokens ?? over.totalTokens,
    cachedInputTokens: over.cachedInputTokens ?? 0,
    outputTokens: over.outputTokens ?? 0,
    reasoningOutputTokens: over.reasoningOutputTokens ?? 0,
    totalTokens: over.totalTokens,
    primaryUsedPercent: over.primaryUsedPercent ?? 10,
    secondaryUsedPercent: over.secondaryUsedPercent ?? 2,
    firstTs: over.firstTs ?? Date.parse('2026-05-24T01:20:00.514Z'),
    tokenCountEvents: over.tokenCountEvents ?? 1,
  };
}

describe('TokenLedger — Codex sessions', () => {
  let ledger: TokenLedger;
  beforeEach(() => {
    ledger = new TokenLedger({ dbPath: ':memory:', claudeProjectsDir: '/nonexistent' });
  });
  afterEach(() => ledger.close());

  it('ingests a Codex session and surfaces it in codexSummary / codexSessions', () => {
    const r = ledger.ingestCodexSession(parsed({ sessionId: 's1', totalTokens: 199006, inputTokens: 196779, cachedInputTokens: 191232, outputTokens: 2227, reasoningOutputTokens: 1128 }), Date.now());
    expect(r.ingested).toBe(true);

    const sum = ledger.codexSummary();
    expect(sum.totalTokens).toBe(199006);
    expect(sum.totalInput).toBe(196779);
    expect(sum.totalCachedInput).toBe(191232);
    expect(sum.sessionCount).toBe(1);
    expect(sum.maxPrimaryUsedPercent).toBe(10);

    const sessions = ledger.codexSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('s1');
    expect(sessions[0].model).toBe('gpt-5.2');
    expect(sessions[0].totalTokens).toBe(199006);
  });

  it('upsert REPLACES totals on re-ingest (cumulative latest-wins, never sums)', () => {
    ledger.ingestCodexSession(parsed({ sessionId: 's1', totalTokens: 100 }), 1000);
    ledger.ingestCodexSession(parsed({ sessionId: 's1', totalTokens: 250 }), 2000); // session grew
    const sum = ledger.codexSummary();
    expect(sum.sessionCount).toBe(1);   // still one session, not two
    expect(sum.totalTokens).toBe(250);  // latest cumulative, NOT 100+250
  });

  it('preserves the earliest first_ts across re-ingests but advances last_ts', () => {
    ledger.ingestCodexSession(parsed({ sessionId: 's1', totalTokens: 100, firstTs: 5000 }), 6000);
    ledger.ingestCodexSession(parsed({ sessionId: 's1', totalTokens: 200, firstTs: 9999 }), 8000);
    const s = ledger.codexSessions()[0];
    expect(s.firstTs).toBe(5000); // earliest kept
    expect(s.lastTs).toBe(8000);  // newest activity
  });

  it('falls back to lastTs when the rollout had no session_meta timestamp (first_ts never 0)', () => {
    ledger.ingestCodexSession(parsed({ sessionId: 's1', totalTokens: 10, firstTs: 0 }), 7777);
    expect(ledger.codexSessions()[0].firstTs).toBe(7777);
  });

  it('aggregates multiple sessions and orders codexSessions by size desc', () => {
    ledger.ingestCodexSession(parsed({ sessionId: 'small', totalTokens: 50 }), Date.now());
    ledger.ingestCodexSession(parsed({ sessionId: 'big', totalTokens: 5000 }), Date.now());
    const sum = ledger.codexSummary();
    expect(sum.sessionCount).toBe(2);
    expect(sum.totalTokens).toBe(5050);
    const sessions = ledger.codexSessions();
    expect(sessions[0].sessionId).toBe('big');
    expect(sessions[1].sessionId).toBe('small');
  });

  it('codexSummary respects the sinceMs recency filter', () => {
    ledger.ingestCodexSession(parsed({ sessionId: 'old', totalTokens: 10 }), 1000);
    ledger.ingestCodexSession(parsed({ sessionId: 'new', totalTokens: 20 }), 9_000_000);
    expect(ledger.codexSummary().sessionCount).toBe(2);
    expect(ledger.codexSummary({ sinceMs: 5000 }).sessionCount).toBe(1);
    expect(ledger.codexSummary({ sinceMs: 5000 }).totalTokens).toBe(20);
  });

  it('ingestCodexRollout reads a real rollout file from disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rollout-'));
    const file = path.join(dir, 'rollout-2026-05-24T01-20-00-019e5791.jsonl');
    const lines = [
      JSON.stringify({ type: 'session_meta', payload: { id: 'disk-1', timestamp: '2026-05-24T01:20:00.514Z', cwd: '/tmp/p' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.4-mini', cwd: '/tmp/p' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, cached_input_tokens: 400, output_tokens: 100, reasoning_output_tokens: 20, total_tokens: 600 } }, rate_limits: { primary: { used_percent: 7 }, secondary: { used_percent: 1 }, plan_type: 'prolite' } } }),
    ];
    fs.writeFileSync(file, lines.join('\n') + '\n');
    try {
      const r = ledger.ingestCodexRollout(file);
      expect(r.ingested).toBe(true);
      expect(r.sessionId).toBe('disk-1');
      const s = ledger.codexSessions()[0];
      expect(s.totalTokens).toBe(600);
      expect(s.model).toBe('gpt-5.4-mini');
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/TokenLedger-codex.test.ts cleanup' });
    }
  });

  it('ingestCodexRollout returns a reason (never throws) for a missing or usage-less file', () => {
    expect(ledger.ingestCodexRollout('/no/such/file.jsonl').ingested).toBe(false);
  });

  // ── Isolation: BurnDetector-facing surfaces must NOT see Codex usage ──
  it('Codex ingest does NOT leak into token_events summary() (BurnDetector isolation)', () => {
    ledger.ingestCodexSession(parsed({ sessionId: 's1', totalTokens: 999999 }), Date.now());
    const claudeSummary = ledger.summary();
    expect(claudeSummary.totalTokens).toBe(0);    // token_events untouched
    expect(claudeSummary.eventCount).toBe(0);
    expect(claudeSummary.sessionsActive).toBe(0);
  });

  it('Codex ingest does NOT create any attribution-key rows (BurnDetector isolation)', () => {
    ledger.ingestCodexSession(parsed({ sessionId: 's1', totalTokens: 999999 }), Date.now());
    expect(ledger.byAttributionKey()).toHaveLength(0);
    expect(ledger.topSessions()).toHaveLength(0);
  });
});
