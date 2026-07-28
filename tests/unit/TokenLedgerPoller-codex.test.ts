/**
 * Unit tests for TokenLedgerPoller's Codex wiring + TokenLedger.scanCodexRolloutsAsync.
 *
 * Guards against the "feature built but not wired" failure mode: the poller
 * MUST invoke the Codex scan when codexProjectDir is set, and MUST NOT when it
 * is not (Claude-only hosts). Also exercises the real FS walk + cwd attribution.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TokenLedger } from '../../src/monitoring/TokenLedger.js';
import { TokenLedgerPoller } from '../../src/monitoring/TokenLedgerPoller.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/** Minimal ledger double that records which scans were called. */
function spyLedger() {
  const calls = { claude: 0, codex: 0 };
  const ledger = {
    async scanAllAsync() { calls.claude += 1; return { filesScanned: 0, inserted: 0 }; },
    async scanCodexRolloutsAsync(opts: { projectDir?: string }) { calls.codex += 1; return { filesScanned: 0, ingested: 0 }; },
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

  it('returns zero counts gracefully when the Codex home does not exist', async () => {
    const result = await ledger.scanCodexRolloutsAsync({ projectDir: AGENT_DIR, codexHome: '/no/such/codex/home' });
    expect(result).toEqual({ filesScanned: 0, ingested: 0 });
  });
});
