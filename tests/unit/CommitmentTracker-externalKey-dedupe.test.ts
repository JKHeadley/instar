// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * FD3 (action-claim-followthrough) — record() is idempotent on externalKey: an
 * OPEN commitment with the same key is returned instead of minting a duplicate,
 * so a restated future-action claim updates one commitment rather than spawning N.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmt-dedupe-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function tracker(): CommitmentTracker {
  return new CommitmentTracker({ stateDir: tmpDir, liveConfig: new LiveConfig(tmpDir), originMachineId: 'm_owner' });
}
type RecordInput = Parameters<CommitmentTracker['record']>[0];
const base = (over: Partial<RecordInput>): RecordInput =>
  ({ userRequest: 'u', agentResponse: 'a', type: 'one-time-action', source: 'agent', ...over } as RecordInput);

describe('record() externalKey idempotency (FD3)', () => {
  it('returns the SAME commitment for a repeated open externalKey (no duplicate)', () => {
    const t = tracker();
    const key = 'sha256:topic42|restart';
    const first = t.record(base({ topicId: 42, externalKey: key }));
    const second = t.record(base({ topicId: 42, externalKey: key }));
    expect(second.id).toBe(first.id);
    expect(t.getActive().filter((c) => c.externalKey === key)).toHaveLength(1);
  });

  it('mints distinct commitments for distinct externalKeys', () => {
    const t = tracker();
    const a = t.record(base({ topicId: 42, externalKey: 'k|restart' }));
    const b = t.record(base({ topicId: 42, externalKey: 'k|push' }));
    expect(b.id).not.toBe(a.id);
  });

  it('still mints a fresh commitment when no externalKey is given (unchanged behavior)', () => {
    const t = tracker();
    const a = t.record(base({ topicId: 1 }));
    const b = t.record(base({ topicId: 1 }));
    expect(b.id).not.toBe(a.id);
  });
});
