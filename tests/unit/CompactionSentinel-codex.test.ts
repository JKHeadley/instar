// Codex parity: CompactionSentinel recovery-verification must read a CODEX session's
// newest rollout JSONL (account-wide OpenAI signal) instead of the Claude transcript, so
// a codex session's compaction-recovery is confirmed exactly as a Claude one is. Both
// sides: rollout grows → recovered; rollout doesn't grow → failed. Claude path unaffected.
// Mirrors the RateLimitSentinel codex fix (#33).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CompactionSentinel } from '../../src/monitoring/CompactionSentinel.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function makeCodexHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'compaction-codex-'));
  const dayDir = path.join(home, '.codex', 'sessions', '2026', '05', '31');
  fs.mkdirSync(dayDir, { recursive: true });
  const rollout = path.join(dayDir, 'rollout-2026-05-31T09-00-00-aaaa1111-0000-0000-0000-000000000001.jsonl');
  return {
    codexHome: path.join(home, '.codex'),
    write: (bytes: number) => fs.writeFileSync(rollout, 'x'.repeat(bytes)),
    cleanup: () => SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/CompactionSentinel-codex.test.ts:cleanup' }),
  };
}

describe('CompactionSentinel — codex recovery via newest rollout', () => {
  let codex: ReturnType<typeof makeCodexHome>;
  let recoverFn: ReturnType<typeof vi.fn>;
  let sentinel: CompactionSentinel;
  let events: Array<{ type: string; payload: any }>;

  beforeEach(() => {
    vi.useFakeTimers();
    codex = makeCodexHome();
    recoverFn = vi.fn().mockResolvedValue(true);
    sentinel = new CompactionSentinel(
      {
        recoverFn: recoverFn as any,
        projectDir: '/fake/project',
        getSessionFramework: () => 'codex-cli',
        codexHome: codex.codexHome,
      },
      { dedupeWindowMs: 60_000, verifyWindowMs: 25_000, maxInjectAttempts: 3, recoveryGuardMs: 10 * 60_000 },
    );
    events = [];
    for (const e of ['compaction:detected', 'compaction:recovered', 'compaction:failed']) {
      sentinel.on(e as any, (p: any) => events.push({ type: e, payload: p }));
    }
  });
  afterEach(() => {
    sentinel.stop();
    codex.cleanup();
    vi.useRealTimers();
  });

  it('recovers a codex session when its newest ROLLOUT jsonl grows', async () => {
    codex.write(100);
    sentinel.report('codey-1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    expect(recoverFn).toHaveBeenCalledWith('codey-1', 'watchdog-poll');
    codex.write(600); // a codex turn appended to the rollout
    await vi.advanceTimersByTimeAsync(25_500);
    expect(events.some((e) => e.type === 'compaction:recovered')).toBe(true);
  });

  it('fails a codex session when the rollout never grows (no recovery)', async () => {
    codex.write(100);
    sentinel.report('codey-1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    // never grow the rollout → exhaust attempts
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(events.some((e) => e.type === 'compaction:recovered')).toBe(false);
    expect(events.some((e) => e.type === 'compaction:failed')).toBe(true);
  });
});
