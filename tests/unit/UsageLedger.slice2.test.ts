/**
 * UsageLedger — Slice 2 (docs/specs/unified-usage-ledger.md): Codex rollout deltas,
 * the bounded intelligence-call queue, and cross-source dedupe pairs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageLedger, encodeClaudeProjectDir, normalizeFramework, type InvocationInput } from '../../src/monitoring/UsageLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const T0 = Date.now() + 60_000;

describe('UsageLedger — Slice 2', () => {
  let tmp: string;
  let home: string;
  let claudeDir: string;
  let codexDir: string;
  let now: number;
  let ledger: UsageLedger;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-ledger-s2-'));
    home = path.join(tmp, 'agent');
    claudeDir = path.join(tmp, 'claude');
    codexDir = path.join(tmp, 'codex');
    fs.mkdirSync(home, { recursive: true });
    now = T0 + 60_000;
    ledger = new UsageLedger({
      dbPath: ':memory:', machineId: 'm1', agentId: 'echo', agentHomes: [home],
      now: () => now, settleWindowMs: 120_000,
    });
    ledger.addClaudeRoot(claudeDir, 'test');
    ledger.addCodexRoot(codexDir, 'test');
  });

  afterEach(() => {
    ledger.close();
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/UsageLedger.slice2.test.ts:cleanup' });
  });

  function rollout(name: string, lines: object[]): string {
    const d = path.join(codexDir, 'sessions', '2026', '11', '10');
    fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, `rollout-${name}.jsonl`);
    fs.appendFileSync(f, lines.map(l => JSON.stringify(l) + '\n').join(''));
    return f;
  }

  const tc = (ts: number, input: number, cached: number, output: number, reasoning = 0) => ({
    type: 'event_msg', timestamp: new Date(ts).toISOString(),
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning } } },
  });

  it('maps framework ids to the ledger vocabulary', () => {
    expect(normalizeFramework('claude-code')).toBe('claude-code');
    expect(normalizeFramework('codex-cli')).toBe('codex-cli');
    expect(normalizeFramework('gemini-cli')).toBe('gemini-cli');
    expect(normalizeFramework('grok-build')).toBe('grok-build');
    expect(normalizeFramework('pi')).toBe('pi-cli');
    expect(normalizeFramework(null)).toBe('api');
  });

  it('Codex: per-request rows are deltas of the cumulative total, skipping unchanged totals', () => {
    rollout('a', [
      { type: 'session_meta', payload: { id: 'cx-1', cwd: home } },
      { type: 'turn_context', payload: { model: 'gpt-5.2' } },
      tc(T0, 1000, 800, 100, 20),
      tc(T0 + 1000, 1000, 800, 100, 20), // rate-limit refresh: unchanged
      tc(T0 + 2000, 2500, 2000, 300, 50),
    ]);
    ledger.scanTick();
    const t = ledger.totals(T0);
    expect(t.calls).toBe(2);
    // input excludes cached: (1000-800) + (1500-1200)
    expect(t.input).toBe(200 + 300);
    expect(t.cacheRead).toBe(2000);
    expect(t.output).toBe(300);
    expect(t.reasoning).toBe(50);
    expect(t.missing.cacheWrite).toBe(2); // Codex does not report cache writes
    // Sum of deltas equals the final total.
    expect(t.input + t.cacheRead).toBe(2500);
  });

  it('Codex: a re-read resumes from the checkpoint instead of replaying', () => {
    const f = rollout('b', [
      { type: 'session_meta', payload: { id: 'cx-2', cwd: home } },
      tc(T0, 100, 0, 10),
    ]);
    ledger.scanTick();
    fs.appendFileSync(f, JSON.stringify(tc(T0 + 1000, 250, 50, 30)) + '\n');
    ledger.scanTick();
    ledger.scanTick();
    const t = ledger.totals(T0);
    expect(t.calls).toBe(2);
    expect(t.input + t.cacheRead).toBe(250);
    expect(t.output).toBe(30);
  });

  it('Codex: a resumed rollout stores its inherited total as baseline and never counts it twice', () => {
    rollout('c', [
      { type: 'session_meta', payload: { id: 'cx-3', cwd: home, forked_from_id: 'cx-parent' } },
      tc(T0, 5000, 4000, 500),
      tc(T0 + 1000, 5600, 4500, 600),
    ]);
    ledger.scanTick();
    const t = ledger.totals(T0);
    expect(t.calls).toBe(1);
    expect(t.input + t.cacheRead).toBe(600);
    expect(t.output).toBe(100);
    expect(ledger.coverageCounters().codex_inherited_uncounted).toBe(5500);
  });

  it('Codex: a rollout outside the agent is not counted', () => {
    rollout('d', [
      { type: 'session_meta', payload: { id: 'cx-4', cwd: path.join(tmp, 'elsewhere') } },
      tc(T0, 100, 0, 10),
    ]);
    ledger.scanTick();
    expect(ledger.totals(T0).calls).toBe(0);
  });

  function inv(over: Partial<InvocationInput> = {}): InvocationInput {
    return {
      feature: 'MessagingToneGate', framework: 'claude-code', model: 'claude-haiku-5-5',
      startedAt: T0, endedAt: T0 + 5000, outcome: 'ok', jobSlug: null, runId: null,
      usage: { sessionId: 'oneshot-1', input: 10, cacheRead: 1000, cacheWrite: 100, output: 50, reportedUsd: 0.01, reportedBasis: 'actual' },
      ...over,
    };
  }

  function oneShotTranscript(sessionId: string, cwd: string, parts: { input: number; cacheRead: number; cacheWrite: number; output: number }): string {
    const d = path.join(claudeDir, 'projects', encodeClaudeProjectDir(cwd));
    fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, `${sessionId}.jsonl`);
    fs.appendFileSync(f, JSON.stringify({
      type: 'assistant', requestId: `req-${sessionId}`, sessionId, cwd, timestamp: new Date(T0 + 1000).toISOString(),
      message: { model: 'claude-haiku-5-5', usage: { input_tokens: parts.input, cache_read_input_tokens: parts.cacheRead, cache_creation_input_tokens: parts.cacheWrite, output_tokens: parts.output } },
    }) + '\n');
    return f;
  }

  it('invocation queue: bounded, oldest dropped, drop count in coverage', () => {
    const small = new UsageLedger({ dbPath: ':memory:', machineId: 'm1', agentId: 'echo', agentHomes: [home], invocationQueueMax: 3, now: () => now });
    for (let i = 0; i < 5; i++) small.enqueueInvocation(inv({ usage: null }));
    expect(small.queuedInvocations).toBe(3);
    expect(small.droppedInvocations).toBe(2);
    expect(small.flushInvocations()).toBe(3);
    expect(small.totals(T0).calls).toBe(3);
    expect(small.coverageCounters().invocations_no_counts).toBe(3);
    expect(small.coverageCounters().invocations_uncorrelated).toBe(3);
    small.close();
  });

  it('invocation-only (no transcript): the invocation is counted with its reported dollars and feature', () => {
    ledger.enqueueInvocation(inv());
    ledger.scanTick();
    const t = ledger.totals(T0);
    expect(t.calls).toBe(1);
    expect(t.input + t.cacheRead + t.cacheWrite + t.output).toBe(1160);
    expect(t.reportedActualUsd).toBeCloseTo(0.01);
  });

  for (const order of ['invocation-first', 'file-first'] as const) {
    it(`dedupe (${order}): agreeing totals count once, tokens move to the file side, call and dollars stay`, () => {
      // A one-shot runs in some other cwd; the internal binding makes its transcript a member.
      const cwd = path.join(tmp, 'oneshot-cwd');
      if (order === 'invocation-first') {
        ledger.enqueueInvocation(inv());
        ledger.scanTick();
        oneShotTranscript('oneshot-1', cwd, { input: 10, cacheRead: 1000, cacheWrite: 100, output: 50 });
        ledger.scanTick();
      } else {
        // File first: the binding is not there yet, so the transcript is not a member until the
        // invocation lands; then the rescan picks the transcript up held.
        oneShotTranscript('oneshot-1', cwd, { input: 10, cacheRead: 1000, cacheWrite: 100, output: 50 });
        ledger.scanTick();
        ledger.enqueueInvocation(inv());
        ledger.scanTick();
      }
      // Before settlement: exactly one copy of the tokens counted.
      let t = ledger.totals(T0);
      expect(t.input + t.cacheRead + t.cacheWrite + t.output).toBe(1160);
      now += 10 * 60_000;
      const s = ledger.settlePairs();
      expect(s.settled).toBe(1);
      t = ledger.totals(T0);
      expect(t.input + t.cacheRead + t.cacheWrite + t.output).toBe(1160);
      expect(t.calls).toBe(1);
      expect(t.reportedActualUsd).toBeCloseTo(0.01);
      const ev = ledger.totalsFromEvents(T0);
      expect(ev.input + ev.cacheRead + ev.cacheWrite + ev.output).toBe(1160);
      expect(ev.calls).toBe(1);
      expect(ledger.pairCounts().settled).toBe(1);
    });
  }

  it('dedupe: a member file row already counted flips to held when its invocation arrives', () => {
    // Transcript in the agent home: a member by cwd before any binding exists.
    oneShotTranscript('oneshot-2', home, { input: 5, cacheRead: 0, cacheWrite: 0, output: 5 });
    ledger.scanTick();
    expect(ledger.totals(T0).calls).toBe(1);
    ledger.enqueueInvocation(inv({ usage: { sessionId: 'oneshot-2', input: 5, cacheRead: 0, cacheWrite: 0, output: 5 } }));
    ledger.scanTick();
    const t = ledger.totals(T0);
    expect(t.input + t.output).toBe(10);
    expect(t.calls).toBe(1);
  });

  it('dedupe: disagreeing totals keep the invocation counted and show the excess as disputed', () => {
    const cwd = path.join(tmp, 'oneshot-cwd');
    ledger.enqueueInvocation(inv());
    ledger.scanTick();
    oneShotTranscript('oneshot-1', cwd, { input: 10, cacheRead: 3000, cacheWrite: 100, output: 50 });
    ledger.scanTick();
    now += 10 * 60_000;
    expect(ledger.settlePairs().disagreed).toBe(1);
    const t = ledger.totals(T0);
    expect(t.input + t.cacheRead + t.cacheWrite + t.output).toBe(1160);
    expect(ledger.pairCounts().disagreement).toBe(1);
    expect(ledger.pairCounts().disputedTokens).toBe(2000);
  });

  it('dedupe: a pair does not settle while its file is quiet for less than the settle window', () => {
    const cwd = path.join(tmp, 'oneshot-cwd');
    ledger.enqueueInvocation(inv());
    ledger.scanTick();
    oneShotTranscript('oneshot-1', cwd, { input: 10, cacheRead: 1000, cacheWrite: 100, output: 50 });
    ledger.scanTick();
    now = T0 + 5000 + 30_000;
    expect(ledger.settlePairs().settled).toBe(0);
  });

  it('enqueue never throws, even after close', () => {
    ledger.close();
    expect(() => ledger.enqueueInvocation(inv())).not.toThrow();
  });
});
