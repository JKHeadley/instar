/**
 * A dated promise must be storable, not merely readable.
 *
 * `Commitment.checkInAt` has existed since ACT-724 with four readers — the
 * beacon's trigger resolution, the dated-backlog filter, and both arms of
 * `GET /commitments/check-in-reminder`. `record()` never declared it, so a caller
 * passing it got a stored record WITHOUT the field, and the backlog honestly
 * reported `datedCount: 0` across every commitment ever made. These tests pin the
 * writer so the readers can stop describing an empty set.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commitment-checkinat-'));
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(stateDir, {
    recursive: true, force: true,
    operation: 'tests/unit/CommitmentTracker-checkinat-writer.test.ts',
  });
});

const make = () => new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) });

const base = {
  type: 'one-time-action' as const,
  userRequest: 'tell me when the release is out',
  agentResponse: 'I will report once it publishes',
  topicId: 61449,
  followThroughOptOutReason: 'covered by the dated check-in under test',
};

describe('CommitmentTracker.record — checkInAt', () => {
  it('stores checkInAt on the record, so a dated promise survives the write', () => {
    const t = make();
    const c = t.record({ ...base, checkInAt: '2026-10-24T17:00:00.000Z' });
    expect(c.checkInAt).toBe('2026-10-24T17:00:00.000Z');
  });

  it('is readable back from the store, not just from the returned object', () => {
    const t = make();
    const { id } = t.record({ ...base, checkInAt: '2026-10-24T17:00:00.000Z' });
    // A fresh tracker over the same state dir — proves the field was PERSISTED,
    // which is the half that was missing: the in-memory object was never the problem.
    const reread = make().getAll().find((c) => c.id === id);
    expect(reread?.checkInAt).toBe('2026-10-24T17:00:00.000Z');
  });

  it('appears in the dated set that the reminder reconciler filters on', () => {
    const t = make();
    t.record({ ...base, checkInAt: '2026-10-24T17:00:00.000Z' });
    t.record({ ...base, userRequest: 'no date on this one' });
    // The same predicate `GET /commitments/check-in-reminder` applies.
    const dated = t.getAll().filter((c) => !!c.checkInAt);
    expect(dated).toHaveLength(1);
    expect(dated[0].checkInAt).toBe('2026-10-24T17:00:00.000Z');
  });

  it('omits the field entirely when no date was promised', () => {
    const t = make();
    const c = make().record({ ...base });
    expect(c.checkInAt).toBeUndefined();
    void t;
  });

  it('does not set checkInReminderSentAt at creation — a stored date is not a delivery', () => {
    const t = make();
    const c = t.record({ ...base, checkInAt: '2026-10-24T17:00:00.000Z' });
    expect(c.checkInReminderSentAt).toBeUndefined();
  });
});
