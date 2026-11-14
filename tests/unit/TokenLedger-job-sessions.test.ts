/**
 * TokenLedger job_sessions side table (docs/specs/job-cost-reduction.md §9.1):
 * idempotent record, transcript binding, the per-job join, unbound counting, and
 * pruning on the token_events schedule.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TokenLedger } from '../../src/monitoring/TokenLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let ledger: TokenLedger | null = null;
afterEach(() => { ledger?.close(); ledger = null; });

function make(opts: { retention?: boolean } = {}): TokenLedger {
  ledger = new TokenLedger({
    dbPath: ':memory:',
    claudeProjectsDir: '/nonexistent',
    attributionBackfill: 'off',
    retention: opts.retention ? { enabled: true, maxAgeMs: 1000 } : undefined,
  });
  return ledger;
}

const T0 = 1_800_000_000_000;

function event(l: TokenLedger, id: string, sessionId: string, ts: number, model = 'claude-opus-5-5', inT = 100, outT = 10) {
  l.recordEvent({ requestId: id, sessionId, ts, model, inputTokens: inT, outputTokens: outT, cacheReadTokens: 1000, cacheCreationTokens: 50 });
}

describe('TokenLedger job_sessions', () => {
  it('recordJobSession is idempotent (first record wins)', () => {
    const l = make();
    expect(l.recordJobSession('tmux-a', 'health-check', 'm1', T0)).toBe(true);
    expect(l.recordJobSession('tmux-a', 'other-slug', 'm1', T0)).toBe(false);
    expect(l.recordJobSession('', 'x', 'm1', T0)).toBe(false);
    const counts = l.jobSessionCounts({ sinceMs: 0 });
    expect(counts).toEqual([{ jobSlug: 'health-check', origin: 'job', recorded: 1, unbound: 1 }]);
  });

  it('joins token_events only through a bound transcript id', () => {
    const l = make();
    l.recordJobSession('tmux-a', 'health-check', 'm1', new Date(T0).toISOString());
    event(l, 'r1', 'claude-uuid-1', T0 + 1);
    event(l, 'r2', 'claude-uuid-1', T0 + 2);
    event(l, 'r3', 'unrelated-session', T0 + 3);
    // Not bound yet → nothing attributed.
    expect(l.jobTokenTotals({ sinceMs: 0 })).toEqual([]);
    expect(l.bindJobSessionTranscript('tmux-a', 'claude-uuid-1')).toBe(true);
    expect(l.bindJobSessionTranscript('tmux-a', 'claude-uuid-1')).toBe(false); // idempotent
    expect(l.bindJobSessionTranscript('not-a-job', 'claude-uuid-9')).toBe(false);
    const rows = l.jobTokenTotals({ sinceMs: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      jobSlug: 'health-check', origin: 'job', framework: 'claude-code', model: 'claude-opus-5-5',
      sessions: 1, modelCalls: 2, tokensIn: 200, tokensOut: 20, cacheRead: 2000, cacheWrite: 100,
    });
    // Bound → no longer unbound.
    expect(l.jobSessionCounts({ sinceMs: 0 })[0].unbound).toBe(0);
  });

  it('a rotated transcript id (respawn) joins too, and origin triage is kept', () => {
    const l = make();
    l.recordJobSession('tmux-t', 'feedback-factory-triage', 'm1', T0, 'triage');
    l.bindJobSessionTranscript('tmux-t', 'uuid-a');
    l.bindJobSessionTranscript('tmux-t', 'uuid-b');
    event(l, 'r1', 'uuid-a', T0 + 1);
    event(l, 'r2', 'uuid-b', T0 + 2);
    const rows = l.jobTokenTotals({ sinceMs: 0 });
    expect(rows[0]).toMatchObject({ origin: 'triage', sessions: 2, modelCalls: 2 });
  });

  it('respects the window and the machine filter', () => {
    const l = make();
    l.recordJobSession('uuid-m1', 'j', 'm1', T0);
    l.recordJobSession('uuid-m2', 'j', 'm2', T0);
    event(l, 'r1', 'uuid-m1', T0 + 10);
    event(l, 'r2', 'uuid-m2', T0 + 10);
    event(l, 'r3', 'uuid-m1', T0 + 10_000);
    expect(l.jobTokenTotals({ sinceMs: 0, machineId: 'm1' })[0].modelCalls).toBe(2);
    expect(l.jobTokenTotals({ sinceMs: 0, untilMs: T0 + 100, machineId: 'm1' })[0].modelCalls).toBe(1);
    expect(l.jobTokenTotals({ sinceMs: 0 })[0].modelCalls).toBe(3);
  });

  it('joins codex sessions with cached input moved out of tokensIn', () => {
    const l = make();
    l.recordJobSession('codex-rollout-1', 'j', 'm1', T0);
    l.ingestCodexSession({
      sessionId: 'codex-rollout-1', cwd: null, model: 'gpt-6-astra', planType: null,
      inputTokens: 1000, cachedInputTokens: 600, outputTokens: 50, reasoningOutputTokens: 0, totalTokens: 1050,
      primaryUsedPercent: null, secondaryUsedPercent: null, tokenCountEvents: 3, firstTs: T0, lastTs: T0 + 5,
    } as any, T0 + 5);
    const rows = l.jobTokenTotals({ sinceMs: 0 });
    expect(rows).toEqual([expect.objectContaining({ framework: 'codex-cli', tokensIn: 400, cacheRead: 600, tokensOut: 50, modelCalls: 3 })]);
  });

  it('prunes job_sessions with token_events, keeping rows that still have in-retention events', () => {
    const l = make({ retention: true });
    l.recordJobSession('tmux-old', 'j', 'm1', T0);            // spawn-time row, no events → pruned
    l.recordJobSession('uuid-old', 'j', 'm1', T0);            // events only old → pruned with them
    l.recordJobSession('uuid-long', 'j', 'm1', T0);           // started old but has a recent event → kept
    l.recordJobSession('uuid-new', 'j', 'm1', T0 + 10_000);   // recent → kept
    event(l, 'r1', 'uuid-old', T0 + 1);
    event(l, 'r2', 'uuid-long', T0 + 9_900);
    event(l, 'r3', 'uuid-new', T0 + 10_000);
    l.pruneToRetention(T0 + 10_000);
    const ids = l.jobSessionCounts({ sinceMs: 0 }).reduce((n, r) => n + r.recorded, 0);
    expect(ids).toBe(2);
    expect(l.jobTokenTotals({ sinceMs: 0 })[0].modelCalls).toBe(2);
  });

  it('sessionUsageInWindow maps sessions to transcript paths via file_offsets', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-js-'));
    try {
      const proj = path.join(dir, 'proj');
      fs.mkdirSync(proj);
      const file = path.join(proj, 'sess-1.jsonl');
      const line = JSON.stringify({ type: 'assistant', sessionId: 'sess-1', requestId: 'q1', timestamp: new Date().toISOString(),
        message: { id: 'm', model: 'claude-opus-5-5', usage: { input_tokens: 5, output_tokens: 2 } } });
      fs.writeFileSync(file, line + '\n');
      ledger = new TokenLedger({ dbPath: ':memory:', claudeProjectsDir: dir, attributionBackfill: 'off' });
      ledger.ingestFile(file);
      const rows = ledger.sessionUsageInWindow({ sinceMs: 0 });
      expect(rows).toEqual([expect.objectContaining({ sessionId: 'sess-1', filePath: file, modelCalls: 1, tokensIn: 5 })]);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/TokenLedger-job-sessions.test.ts' });
    }
  });
});
