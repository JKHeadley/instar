/**
 * Unit tests for TokenLedgerPoller's Codex wiring + TokenLedger.scanCodexRolloutsAsync.
 *
 * Guards against the "feature built but not wired" failure mode: the poller
 * MUST invoke the Codex scan when codexProjectDir is set, and MUST NOT when it
 * is not (Claude-only hosts). Also exercises the real FS walk + cwd attribution.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TokenLedger } from '../../src/monitoring/TokenLedger.js';
import { TokenLedgerPoller } from '../../src/monitoring/TokenLedgerPoller.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/** Minimal ledger double that records which scans were called. */
function spyLedger() {
  const calls = { claude: 0, codex: 0, codexOptions: [] as Array<{ projectDir?: string; maxFileAgeMs?: number }> };
  const ledger = {
    async scanAllAsync() { calls.claude += 1; return { filesScanned: 0, inserted: 0 }; },
    async scanCodexRolloutsAsync(opts: { projectDir?: string; maxFileAgeMs?: number }) {
      calls.codex += 1;
      calls.codexOptions.push(opts);
      return { filesScanned: 0, ingested: 0 };
    },
    pruneToRetention() { return { deleted: 0, more: false }; },
  } as unknown as TokenLedger;
  return { ledger, calls };
}

const flush = () => new Promise<void>(r => setTimeout(r, 20));

describe('TokenLedgerPoller — Codex wiring', () => {
  it('invokes the Codex scan each tick when codexProjectDir is set', async () => {
    const { ledger, calls } = spyLedger();
    const poller = new TokenLedgerPoller({ ledger, codexProjectDir: '/tmp/agent', intervalMs: 999_999 });
    poller.start(); // immediate first tick via queueMicrotask
    await flush();
    poller.stop();
    expect(calls.claude).toBe(1);
    expect(calls.codex).toBe(1); // wired, not dead code
    expect(calls.codexOptions).toEqual([{
      projectDir: '/tmp/agent', maxFileAgeMs: 30 * 24 * 60 * 60 * 1000,
    }]);
  });

  it('skips the Codex scan entirely when codexProjectDir is not set', async () => {
    const { ledger, calls } = spyLedger();
    const poller = new TokenLedgerPoller({ ledger, intervalMs: 999_999 });
    poller.start();
    await flush();
    poller.stop();
    expect(calls.claude).toBe(1);
    expect(calls.codex).toBe(0);
  });

  it('reports a failed Codex scan and retries on the next tick', async () => {
    const { ledger, calls } = spyLedger();
    const error = new Error('worker exited');
    const errors: unknown[] = [];
    const scan = vi.spyOn(ledger, 'scanCodexRolloutsAsync')
      .mockRejectedValueOnce(error)
      .mockResolvedValue({ filesScanned: 1, ingested: 1 });
    const poller = new TokenLedgerPoller({ ledger, codexProjectDir: '/tmp/agent', intervalMs: 999_999,
      onError: err => errors.push(err) });
    try {
      poller.start();
      await flush();
      expect(errors).toEqual([error]);
      (poller as unknown as { tick: () => void }).tick();
      await flush();
      expect(scan).toHaveBeenCalledTimes(2);
      expect(calls.claude).toBe(2);
    } finally { poller.stop(); }
  });
});

describe('TokenLedger.scanCodexRolloutsAsync — FS walk + cwd attribution', () => {
  let ledger: TokenLedger;
  let codexHome: string;
  const AGENT_DIR = '/Users/justin/Documents/Projects/instar-codey';

  beforeEach(() => {
    ledger = new TokenLedger({ dbPath: ':memory:', claudeProjectsDir: '/nonexistent' });
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  });
  afterEach(() => {
    ledger.close();
    SafeFsExecutor.safeRmSync(codexHome, { recursive: true, force: true, operation: 'tests/unit/TokenLedgerPoller-codex.test.ts cleanup' });
  });

  function writeRollout(dayDir: string, name: string, sessionId: string, cwd: string, total: number) {
    const dir = path.join(codexHome, 'sessions', dayDir);
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'session_meta', payload: { id: sessionId, timestamp: '2026-05-24T01:20:00.514Z', cwd } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.2', cwd } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total } }, rate_limits: { primary: { used_percent: 9 }, secondary: { used_percent: 1 }, plan_type: 'prolite' } } }),
    ];
    fs.writeFileSync(path.join(dir, name), lines.join('\n') + '\n');
  }

  it('ingests only rollouts whose cwd matches the agent project dir', async () => {
    writeRollout('2026/05/23', 'rollout-a.jsonl', 'mine-1', AGENT_DIR, 1000);
    writeRollout('2026/05/23', 'rollout-b.jsonl', 'mine-2', path.join(AGENT_DIR, 'subdir'), 500); // subdir counts
    writeRollout('2026/05/23', 'rollout-c.jsonl', 'other', '/Users/justin/Documents/Projects/some-other-agent', 9999); // excluded

    const result = await ledger.scanCodexRolloutsAsync({ projectDir: AGENT_DIR, codexHome });
    expect(result.ingested).toBe(2);

    const sessions = ledger.codexSessions();
    const ids = sessions.map(s => s.sessionId).sort();
    expect(ids).toEqual(['mine-1', 'mine-2']);
    expect(ledger.codexSummary().totalTokens).toBe(1500); // other-agent's 9999 excluded
  });

  it('ingests all rollouts when no projectDir filter is given', async () => {
    writeRollout('2026/05/23', 'rollout-a.jsonl', 'one', AGENT_DIR, 100);
    writeRollout('2026/05/23', 'rollout-c.jsonl', 'two', '/somewhere/else', 200);
    const result = await ledger.scanCodexRolloutsAsync({ codexHome });
    expect(result.ingested).toBe(2);
    expect(ledger.codexSummary().totalTokens).toBe(300);
  });

  it('is idempotent across rescans (cumulative totals, not summed)', async () => {
    writeRollout('2026/05/23', 'rollout-a.jsonl', 'mine-1', AGENT_DIR, 1000);
    await ledger.scanCodexRolloutsAsync({ projectDir: AGENT_DIR, codexHome });
    await ledger.scanCodexRolloutsAsync({ projectDir: AGENT_DIR, codexHome });
    expect(ledger.codexSummary().sessionCount).toBe(1);
    expect(ledger.codexSummary().totalTokens).toBe(1000);
  });

  it('re-reads and upserts an unchanged valid rollout on every poll', async () => {
    writeRollout('2026/05/23', 'rollout-a.jsonl', 'mine-1', AGENT_DIR, 100);
    expect((await ledger.scanCodexRolloutsAsync({ codexHome })).ingested).toBe(1);
    expect(await ledger.scanCodexRolloutsAsync({ codexHome })).toEqual({ filesScanned: 1, ingested: 1 });
  });

  it('returns zero counts gracefully when the Codex home does not exist', async () => {
    const result = await ledger.scanCodexRolloutsAsync({ projectDir: AGENT_DIR, codexHome: '/no/such/codex/home' });
    expect(result).toEqual({ filesScanned: 0, ingested: 0 });
  });

  it('keeps the legacy default selection limit of 500 on every poll', async () => {
    for (let i = 0; i < 501; i++) {
      writeRollout('2026/05/23', `rollout-${String(i).padStart(4, '0')}.jsonl`, `s-${i}`, AGENT_DIR, 1);
    }
    expect((await ledger.scanCodexRolloutsAsync({ codexHome })).filesScanned).toBe(500);
    expect((await ledger.scanCodexRolloutsAsync({ codexHome })).filesScanned).toBe(500);
    expect(ledger.codexSummary().sessionCount).toBe(500);
  });

  it('preserves the legacy rows and totals for a mixed fixture set', async () => {
    writeRollout('2026/05/23', 'rollout-a.jsonl', 'mine-1', AGENT_DIR, 100);
    writeRollout('2026/05/23', 'rollout-b.jsonl', 'mine-2', path.join(AGENT_DIR, 'sub'), 250);
    writeRollout('2026/05/23', 'rollout-c.jsonl', 'other', '/other', 900);
    const legacy = new TokenLedger({ dbPath: ':memory:', claudeProjectsDir: '/nonexistent' });
    try {
      const base = path.join(codexHome, 'sessions/2026/05/23');
      legacy.ingestCodexRollout(path.join(base, 'rollout-a.jsonl'));
      legacy.ingestCodexRollout(path.join(base, 'rollout-b.jsonl'));
      const result = await ledger.scanCodexRolloutsAsync({ codexHome, projectDir: AGENT_DIR });
      expect(result).toEqual({ filesScanned: 3, ingested: 2 });
      expect(ledger.codexSessions()).toEqual(legacy.codexSessions());
      expect(ledger.codexSummary()).toEqual(legacy.codexSummary());
      writeRollout('2026/05/23', 'rollout-a.jsonl', 'mine-1', AGENT_DIR, 400);
      legacy.ingestCodexRollout(path.join(base, 'rollout-a.jsonl'));
      await ledger.scanCodexRolloutsAsync({ codexHome, projectDir: AGENT_DIR });
      expect(ledger.codexSessions()).toEqual(legacy.codexSessions());
      expect(ledger.codexSummary()).toEqual(legacy.codexSummary());
    } finally { legacy.close(); }
  });

  it('keeps the event loop responsive while parsing a multi-MB rollout', async () => {
    const dir = path.join(codexHome, 'sessions/2026/05/23');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'rollout-large.jsonl');
    const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'large', cwd: AGENT_DIR } });
    const usage = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 77 } } } });
    const noise = JSON.stringify({ type: 'noise', payload: { value: 'x'.repeat(200) } }) + '\n';
    fs.writeFileSync(file, `${meta}\n${noise.repeat(100_000)}${usage}`);
    let ticks = 0;
    let maxGap = 0;
    let lastTick = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - lastTick);
      lastTick = now;
      ticks++;
    }, 5);
    try {
      expect((await ledger.scanCodexRolloutsAsync({ codexHome })).ingested).toBe(1);
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(ticks).toBeGreaterThanOrEqual(2);
      expect(maxGap).toBeLessThan(50);
      expect(ledger.codexSummary().totalTokens).toBe(77);
    } finally { clearInterval(timer); }
  }, 20_000);

  it('picks up a same-size rewrite whose mtime is preserved', async () => {
    writeRollout('2026/05/23', 'rollout-a.jsonl', 'mine', AGENT_DIR, 200);
    const file = path.join(codexHome, 'sessions/2026/05/23/rollout-a.jsonl');
    const preserved = new Date(Date.now() - 10_000);
    fs.utimesSync(file, preserved, preserved);
    expect((await ledger.scanCodexRolloutsAsync({ codexHome })).filesScanned).toBe(1);
    writeRollout('2026/05/23', 'rollout-a.jsonl', 'mine', AGENT_DIR, 100);
    fs.utimesSync(file, preserved, preserved);
    expect((await ledger.scanCodexRolloutsAsync({ codexHome })).filesScanned).toBe(1);
    expect(ledger.codexSummary().totalTokens).toBe(100);
  });

  it('matches legacy descending-mtime upsert order for duplicate session IDs', async () => {
    writeRollout('2026/05/23', 'rollout-a.jsonl', 'shared', AGENT_DIR, 200);
    writeRollout('2026/05/23', 'rollout-b.jsonl', 'shared', AGENT_DIR, 100);
    const base = path.join(codexHome, 'sessions/2026/05/23');
    const newer = new Date(Date.now() - 1000);
    const older = new Date(Date.now() - 2000);
    fs.utimesSync(path.join(base, 'rollout-a.jsonl'), newer, newer);
    fs.utimesSync(path.join(base, 'rollout-b.jsonl'), older, older);
    const legacy = new TokenLedger({ dbPath: ':memory:', claudeProjectsDir: '/nonexistent' });
    try {
      // This is the legacy listAllRollouts order: newest first, oldest last.
      legacy.ingestCodexRollout(path.join(base, 'rollout-a.jsonl'));
      legacy.ingestCodexRollout(path.join(base, 'rollout-b.jsonl'));
      await ledger.scanCodexRolloutsAsync({ codexHome });
      expect(ledger.codexSessions()).toEqual(legacy.codexSessions());
      expect(ledger.codexSummary()).toEqual(legacy.codexSummary());
      expect(ledger.codexSummary().totalTokens).toBe(100);
    } finally { legacy.close(); }
  });

  it('rejects and terminates a worker that exceeds the timeout', async () => {
    ledger.close();
    ledger = new TokenLedger({
      dbPath: ':memory:', claudeProjectsDir: '/nonexistent', codexScanTimeoutMs: 1,
    });
    writeRollout('2026/05/23', 'rollout-a.jsonl', 'mine', AGENT_DIR, 100);
    await expect(ledger.scanCodexRolloutsAsync({ codexHome })).rejects.toThrow(/timed out/);
    expect((ledger as unknown as { codexWorker: unknown }).codexWorker).toBeNull();
  });

  it('does not start a second worker while a Codex scan is in flight', async () => {
    let release!: (value: { filesScanned: number; updates: [] }) => void;
    const pending = new Promise<{ filesScanned: number; updates: [] }>(resolve => { release = resolve; });
    const run = vi.spyOn(ledger as never, 'runCodexScanWorker' as never).mockReturnValue(pending as never);
    const first = ledger.scanCodexRolloutsAsync({ codexHome });
    expect(await ledger.scanCodexRolloutsAsync({ codexHome })).toEqual({ filesScanned: 0, ingested: 0 });
    expect(run).toHaveBeenCalledTimes(1);
    release({ filesScanned: 0, updates: [] });
    await first;
  });

  it('retries after a worker exits during a scan', async () => {
    const dir = path.join(codexHome, 'sessions/2026/05/23');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'rollout-large.jsonl');
    const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'mine', cwd: AGENT_DIR } });
    const usage = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 100 } } } });
    fs.writeFileSync(file, `${meta}\n${'{}\n'.repeat(100_000)}${usage}`);
    const running = ledger.scanCodexRolloutsAsync({ codexHome });
    const worker = (ledger as unknown as { codexWorker: { terminate: () => Promise<number> } }).codexWorker;
    await worker.terminate();
    await expect(running).rejects.toThrow(/exited/);
    expect((await ledger.scanCodexRolloutsAsync({ codexHome })).ingested).toBe(1);
  });

  it('terminates its active worker when the ledger closes', async () => {
    writeRollout('2026/05/23', 'rollout-a.jsonl', 'mine', AGENT_DIR, 100);
    const running = ledger.scanCodexRolloutsAsync({ codexHome });
    ledger.close();
    await expect(running).rejects.toThrow();
  });

  it('applies the 30-day age window', async () => {
    writeRollout('2026/05/23', 'rollout-old.jsonl', 'old', AGENT_DIR, 900);
    writeRollout('2026/05/23', 'rollout-new.jsonl', 'new', AGENT_DIR, 100);
    const old = path.join(codexHome, 'sessions/2026/05/23/rollout-old.jsonl');
    const stale = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old, stale, stale);
    const opts = { codexHome, maxFileAgeMs: 30 * 24 * 60 * 60 * 1000 };
    expect((await ledger.scanCodexRolloutsAsync(opts)).filesScanned).toBe(1);
    expect((await ledger.scanCodexRolloutsAsync(opts)).filesScanned).toBe(1);
    expect(ledger.codexSessions().map(s => s.sessionId)).toEqual(['new']);
  });
});
