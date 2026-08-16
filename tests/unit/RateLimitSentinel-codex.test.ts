// #33: RateLimitSentinel codex parity — the recovery-verification (jsonl-growth) must
// resolve a CODEX session's rollout JSONL (not the Claude transcript) so a throttled
// codex session recovers exactly as a Claude one does. Both sides: codex framework →
// reads the codex rollout; absent framework → unchanged Claude path. Plus the dark
// default of the detection flag.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RateLimitSentinel } from '../../src/monitoring/RateLimitSentinel.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const FIRST_BACKOFF = 30_000;
const VERIFY = 25_000;
const THREAD_ID = '019e7b19-6e6b-7193-a633-b17c2b307dc6';

function makeCodexHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rls-codex-'));
  // Mirror the real layout: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
  const dayDir = path.join(root, 'sessions', '2026', '05', '31');
  fs.mkdirSync(dayDir, { recursive: true });
  const rollout = path.join(dayDir, `rollout-2026-05-31T00-00-00-${THREAD_ID}.jsonl`);
  return {
    root,
    rollout,
    write: (bytes: number) => fs.writeFileSync(rollout, 'x'.repeat(bytes)),
    cleanup: () => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/RateLimitSentinel-codex.test.ts' }),
  };
}

describe('RateLimitSentinel — codex recovery (#33)', () => {
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
        getCodexThreadId: () => THREAD_ID,
        codexHome: codex.root,
      },
      { dedupeWindowMs: 60_000, verifyWindowMs: VERIFY, maxAttempts: 6, maxWindowMs: 30 * 60_000, checkInEveryMs: 120_000 },
    );
    events = [];
    for (const e of ['rate-limit:recovered', 'rate-limit:escalated']) {
      sentinel.on(e as any, (p: any) => events.push({ type: e, payload: p }));
    }
  }

  it('recovers a codex session when its ROLLOUT jsonl grows (codex-aware baseline)', async () => {
    codex.write(100);
    buildCodex();
    sentinel.report('codey-1', 'codex-usage-poll', { errorClass: 'throttle' });
    await vi.advanceTimersByTimeAsync(FIRST_BACKOFF + 100); // resume fires
    codex.write(900);                                       // codex turn appended to the rollout
    await vi.advanceTimersByTimeAsync(VERIFY + 500);
    const rec = events.find((e) => e.type === 'rate-limit:recovered');
    expect(rec).toBeDefined();
    expect(rec!.payload.jsonlDelta).toBeGreaterThan(0);
    expect(sentinel.isRecoveryActive('codey-1')).toBe(false);
  });

  it('does NOT recover when the codex rollout does NOT grow (escalates instead)', async () => {
    codex.write(100);
    buildCodex();
    sentinel.report('codey-1', 'codex-usage-poll', { errorClass: 'throttle' });
    // never grow the rollout → no jsonlDelta → keeps retrying then escalates
    await vi.advanceTimersByTimeAsync(40 * 60_000);
    expect(events.some((e) => e.type === 'rate-limit:recovered')).toBe(false);
    expect(events.some((e) => e.type === 'rate-limit:escalated')).toBe(true);
  });

  it('codexUsageDetection defaults OFF (ships dark) — recovery deps work regardless', () => {
    // The detection poll (server.ts) is gated on this flag; the recovery half is always
    // available. A fresh config leaves detection dark.
    const s = new RateLimitSentinel({ resumeFn: resumeFn as any, notifyFn: notifyFn as any, projectDir: '/p' });
    expect((s as unknown as { cfg: { codexUsageDetection: boolean } }).cfg.codexUsageDetection).toBe(false);
    s.stop();
  });
});
