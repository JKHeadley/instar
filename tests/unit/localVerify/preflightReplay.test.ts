// safe-fs-allow: test fixture cleanup inside a fresh OS temp directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PreflightReplayStore, replayKey, REPLAY_ADMISSION_MAX, REPLAY_EXECUTION_MAX } from '../../../src/localVerify/preflightReplay.js';
import type { LocalVerifyRecord } from '../../../src/localVerify/record.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const H = 'a'.repeat(40);
const B = 'b'.repeat(40);
const record = (): LocalVerifyRecord => ({
  repo: 'owner/repo', pr: 7, headSha: H, baseSha: B, baseRefName: 'main', mergeTree: 'c'.repeat(40),
  lanes: [], nodeVersion: '22', machineId: 'studio', startedAt: '2026-10-31T00:00:00Z', finishedAt: '2026-10-31T00:00:01Z',
  outcome: 'failure', harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false,
  verifierVersion: 'v', policyHash: 'policy', preflight: { mode: 'enforce', outcome: 'red', reason: 'preflight-red', elapsedMs: 100,
    changedFiles: 1, selectedFiles: ['tests/a.test.ts'], selectedCases: 1, repeatedFailedFile: 'tests/a.test.ts', headSha: H, baseSha: B },
});

describe('durable preflight replay obligation', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-replay-test-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'preflightReplay.test:cleanup' }); });

  it('persists exactly one same-head/target marker and retains it after a full verdict', () => {
    const store = new PreflightReplayStore(dir);
    const red = record();
    const first = store.ensureRed(red, 1000);
    expect(store.ensureRed(red, 2000)).toEqual(first);
    const restored = new PreflightReplayStore(dir);
    const key = replayKey(red);
    expect(restored.get(key)?.state).toBe('pending');
    restored.admitted(key, 3000);
    expect(restored.finished(key, 4000, 'success').state).toBe('completed');
    expect(new PreflightReplayStore(dir).get(key)?.state).toBe('completed');
    expect(replayKey({ ...red, baseSha: 'd'.repeat(40) })).toBe(key);
    expect(replayKey({ ...red, baseRefName: 'release' })).not.toBe(key);
  });

  it('bounds admission backoff, execution errors and the one lifetime rearm', () => {
    const store = new PreflightReplayStore(dir);
    const key = store.ensureRed(record(), 0).key;
    for (let n = 0; n < REPLAY_ADMISSION_MAX; n++) {
      const next = store.admissionFailed(key, (n + 1) * 1000, 'queue-full');
      expect(next.admissionAttempts).toBe(n + 1);
    }
    expect(store.get(key)?.state).toBe('blocked');
    expect(store.rearmOnce(key, 100_000)?.state).toBe('pending');
    for (let n = 0; n < REPLAY_EXECUTION_MAX; n++) {
      store.admitted(key, 100_001 + n * 1000);
      store.finished(key, 100_002 + n * 1000, 'error');
    }
    expect(store.get(key)?.state).toBe('blocked');
    expect(store.rearmOnce(key, 200_000)).toBeNull();
  });

  it('recovers an interrupted running attempt and rejects corrupt state', () => {
    const store = new PreflightReplayStore(dir);
    const key = store.ensureRed(record(), 0).key;
    store.admitted(key, 1);
    expect(new PreflightReplayStore(dir).recoverInterrupted(key, 2)?.state).toBe('retryable-error');
    const file = path.join(dir, 'local-verify', 'preflight-replays.json');
    fs.writeFileSync(file, '{bad');
    expect(() => new PreflightReplayStore(dir)).toThrow();
  });
});
