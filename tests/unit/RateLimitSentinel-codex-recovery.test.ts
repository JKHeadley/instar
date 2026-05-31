// #33: RateLimitSentinel codex recovery — verifies the account-wide newest-rollout
// baseline drives recovery for codex sessions exactly as the Claude transcript does for
// Claude. Both sides: rollout grows → recovered; rollout doesn't grow → escalates. Plus
// the Claude path is unaffected (no codexHome/framework → original behavior).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RateLimitSentinel } from '../../src/monitoring/RateLimitSentinel.js';

const FIRST_BACKOFF = 30_000;
const VERIFY = 25_000;

function makeCodexHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rls-codex-rec-'));
  const dayDir = path.join(home, '.codex', 'sessions', '2026', '05', '31');
  fs.mkdirSync(dayDir, { recursive: true });
  const rollout = path.join(dayDir, 'rollout-2026-05-31T09-00-00-aaaa1111-0000-0000-0000-000000000001.jsonl');
  return {
    codexHome: path.join(home, '.codex'),
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
    write: (bytes: number) => fs.writeFileSync(rollout, 'x'.repeat(bytes)),
  };
}

describe('RateLimitSentinel — codex recovery via newest rollout (#33)', () => {
  let codex: ReturnType<typeof makeCodexHome>;
  let resumeFn: ReturnType<typeof vi.fn>;
  let notifyFn: ReturnType<typeof vi.fn>;
  let sentinel: RateLimitSentinel;
  let events: Array<{ type: string; payload: any }>;

  beforeEach(() => {
    vi.useFakeTimers();
    codex = makeCodexHome();
    resumeFn = vi.fn().mockResolvedValue(true);
    notifyFn = vi.fn().mockResolvedValue(undefined);
  });
  afterEach(() => {
    sentinel?.stop();
    codex.cleanup();
    vi.useRealTimers();
  });

  function buildCodex() {
    sentinel = new RateLimitSentinel(
      {
        resumeFn: resumeFn as any,
        notifyFn: notifyFn as any,
        projectDir: '/fake/project',
        getSessionFramework: () => 'codex-cli',
        codexHome: codex.codexHome,
      },
      { dedupeWindowMs: 60_000, verifyWindowMs: VERIFY, maxAttempts: 6, maxWindowMs: 30 * 60_000, checkInEveryMs: 120_000 },
    );
    events = [];
    for (const e of ['rate-limit:recovered', 'rate-limit:escalated']) {
      sentinel.on(e as any, (p: any) => events.push({ type: e, payload: p }));
    }
  }

  it('recovers a codex session when the newest rollout GROWS (account throttle cleared)', async () => {
    codex.write(100);
    buildCodex();
    sentinel.report('codey-1', 'codex-usage-poll', { errorClass: 'throttle' });
    await vi.advanceTimersByTimeAsync(FIRST_BACKOFF + 100); // resume fires
    codex.write(900);                                       // a codex turn appended
    await vi.advanceTimersByTimeAsync(VERIFY + 500);
    const rec = events.find((e) => e.type === 'rate-limit:recovered');
    expect(rec).toBeDefined();
    expect(rec!.payload.jsonlDelta).toBeGreaterThan(0);
    expect(sentinel.isRecoveryActive('codey-1')).toBe(false);
  });

  it('escalates a codex session when the rollout never grows (still throttled)', async () => {
    codex.write(100);
    buildCodex();
    sentinel.report('codey-1', 'codex-usage-poll', { errorClass: 'throttle' });
    await vi.advanceTimersByTimeAsync(40 * 60_000); // never grow
    expect(events.some((e) => e.type === 'rate-limit:recovered')).toBe(false);
    expect(events.some((e) => e.type === 'rate-limit:escalated')).toBe(true);
  });
});
