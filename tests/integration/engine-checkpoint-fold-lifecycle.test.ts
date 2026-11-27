// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * context-budget-layered-summaries §9.3 — the engine checkpoint as a carrier of
 * the REAL FoldCoordinator built the way server.ts builds it (defaultFoldCarriers
 * includes the checkpoint carrier):
 *  - commit deletes the checkpoint; rollback keeps it for the grace period;
 *  - a crash past the point of no return keeps it, and it still restores;
 *  - a checkpoint with no record is removed by the boot sweep as an orphan.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFoldCoordinator } from '../../src/monitoring/foldCoordinatorBoot.js';
import type { FoldRecord } from '../../src/monitoring/FoldCoordinator.js';
import { takeEngineCheckpoint, readEngineCheckpoint, restoreEngineCheckpoint } from '../../src/monitoring/engineCheckpoint.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/integration/engine-checkpoint-fold-lifecycle.test.ts';
const TOPIC = '141133';
const SID = '11111111-2222-3333-4444-555555555555';

describe('engine checkpoint × FoldCoordinator', () => {
  let stateDir: string;
  let engineDir: string;
  let transcript: string;
  const deps = () => ({
    stateDir, runningTopicSessions: () => [{ topicKey: TOPIC }], poolPlacementLive: () => false,
    inboundQueueLive: () => true, topicRowsPresent: () => true, sentinelHeartbeatFresh: () => true, layerKindPresent: () => true,
  });
  const step = (c: ReturnType<typeof buildFoldCoordinator>['coordinator'], rec: FoldRecord, to: FoldRecord['state']) => {
    const r = c.transition(rec.topicKey, rec.foldId, { state: rec.state, seq: rec.seq, generation: rec.generation }, to);
    if (!r.ok) throw new Error(r.reason);
    return r.record;
  };
  const begin = (c: ReturnType<typeof buildFoldCoordinator>['coordinator']) => {
    const b = c.begin(TOPIC);
    if (!b.ok) throw new Error(b.reason);
    const cp = takeEngineCheckpoint(stateDir, { topicKey: TOPIC, foldId: b.record.foldId, sessionId: SID, transcriptPath: transcript });
    if (!cp.ok) throw new Error(cp.reason);
    return step(c, b.record, 'snapshotted');
  };

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-cp-int-'));
    engineDir = path.join(stateDir, 'projects');
    fs.mkdirSync(engineDir);
    transcript = path.join(engineDir, `${SID}.jsonl`);
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', uuid: 'u1', sessionId: SID, message: { content: 'hello' } })}\n`);
  });
  afterEach(() => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: OP }));

  it('a committed fold deletes its checkpoint', () => {
    const { coordinator: c } = buildFoldCoordinator(deps());
    const rec = begin(c);
    step(c, step(c, step(c, step(c, rec, 'staged'), 'replacing'), 'probing'), 'committed');
    expect(readEngineCheckpoint(stateDir, TOPIC, rec.foldId)).toBeNull();
  });

  it('a rolled-back fold keeps its checkpoint, marked settled for the grace period', () => {
    const { coordinator: c } = buildFoldCoordinator(deps());
    const rec = begin(c);
    step(c, rec, 'rolled-back');
    expect(readEngineCheckpoint(stateDir, TOPIC, rec.foldId)?.settledAt).toBeTypeOf('number');
  });

  it('a crash past the point of no return keeps the checkpoint, and it still restores', () => {
    const a = buildFoldCoordinator(deps()).coordinator;
    const rec = begin(a);
    step(a, step(a, rec, 'staged'), 'replacing');
    fs.appendFileSync(transcript, `${JSON.stringify({ type: 'user', uuid: 'u9', sessionId: SID, message: { content: 'seeded context' } })}\n`);
    const b = buildFoldCoordinator(deps()).coordinator;
    expect(b.recoverPendingFolds().quarantined).toHaveLength(1);
    const cp = readEngineCheckpoint(stateDir, TOPIC, rec.foldId);
    expect(cp).not.toBeNull();
    const id = crypto.randomUUID();
    expect(restoreEngineCheckpoint(stateDir, cp!, { currentTranscriptPath: transcript, engineTranscriptDir: engineDir, newSessionId: () => id }))
      .toMatchObject({ mode: 'materialised', sessionId: id });
  });

  it('a checkpoint with no fold record is removed by the boot sweep as an orphan', () => {
    const cp = takeEngineCheckpoint(stateDir, { topicKey: TOPIC, foldId: 'fghost', sessionId: SID, transcriptPath: transcript });
    expect(cp.ok).toBe(true);
    const swept = buildFoldCoordinator(deps()).coordinator.recoverPendingFolds();
    expect(swept.orphans.some((o) => o.kind === 'engine-checkpoint' && o.foldId === 'fghost')).toBe(true);
    expect(readEngineCheckpoint(stateDir, TOPIC, 'fghost')).toBeNull();
  });
});
