// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * context-budget-layered-summaries §9.3 "Held inbound", wired the way server.ts
 * wires it: the REAL FoldCoordinator (buildFoldCoordinator, real lock and
 * records) with the REAL inbound queue (PendingInboundStore) registered as a
 * carrier through inboundHoldCarrier.
 *
 *  - a message arriving while the fold holds its topic is invisible to the drain;
 *  - the fold's terminal transition releases it (the carrier), and only then;
 *  - after a restart, a fold the boot sweep aborted has its rows released by
 *    releaseSettledInboundHolds; a quarantined fold keeps them held.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFoldCoordinator } from '../../src/monitoring/foldCoordinatorBoot.js';
import { FoldRecordStore, TERMINAL_STATES, type FoldRecord } from '../../src/monitoring/FoldCoordinator.js';
import { inboundHoldCarrier, releaseSettledInboundHolds } from '../../src/monitoring/foldInboundHold.js';
import { PendingInboundStore, type InboundQueueBounds } from '../../src/core/PendingInboundStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/integration/fold-inbound-hold-wiring.test.ts';
const TOPIC = '141133';
const BOUNDS: InboundQueueBounds = { maxPerSession: 10, maxTotal: 20, hardMaxTotal: 30, maxPayloadBytes: 4096 };

describe('FoldCoordinator × inbound queue hold', () => {
  let stateDir: string;
  let store: PendingInboundStore;
  let n = 0;
  const deps = () => ({
    stateDir, runningTopicSessions: () => [{ topicKey: TOPIC }], poolPlacementLive: () => false,
    inboundQueueLive: () => true, topicRowsPresent: () => true, sentinelHeartbeatFresh: () => true, layerKindPresent: () => true,
  });
  const enqueue = () => {
    n += 1;
    const r = store.enqueue({ sessionKey: TOPIC, messageId: `m${n}`, payload: 'hi', reason: 'r', tenure: 't', nowIso: new Date().toISOString(), monoMs: 1, bootSessionId: 'b' }, BOUNDS);
    if (r.result !== 'queued') throw new Error(r.result);
    return r.seq;
  };
  const heads = () => store.selectEligibleHeads(new Date(Date.now() + 1000).toISOString(), 10).map((r) => r.session_key);
  const step = (c: ReturnType<typeof buildFoldCoordinator>['coordinator'], rec: FoldRecord, to: FoldRecord['state']) => {
    const r = c.transition(rec.topicKey, rec.foldId, { state: rec.state, seq: rec.seq, generation: rec.generation }, to);
    if (!r.ok) throw new Error(r.reason);
    return r.record;
  };
  const recordOpen = () => {
    const recs = new FoldRecordStore(stateDir);
    return (t: string, f: string) => { const r = recs.get(t, f); return r ? !TERMINAL_STATES.has(r.state) : null; };
  };

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-inbound-int-'));
    store = PendingInboundStore.open('echo', stateDir);
    n = 0;
  });
  afterEach(() => {
    store.close();
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: OP });
  });

  it('held while the fold runs; released only by its terminal transition', () => {
    const { coordinator } = buildFoldCoordinator(deps());
    coordinator.registerCarrier(inboundHoldCarrier(() => store));
    const b = coordinator.begin(TOPIC);
    if (!b.ok) throw new Error(b.reason);
    store.holdForFold(TOPIC, b.record.foldId, new Date().toISOString());
    enqueue();
    expect(heads()).toEqual([]);
    const rec = step(coordinator, b.record, 'snapshotted');
    expect(heads()).toEqual([]); // a non-terminal step never releases
    step(coordinator, rec, 'aborted');
    expect(heads()).toEqual([TOPIC]);
  });

  it('after a restart: an aborted fold releases its rows; a quarantined fold keeps them', () => {
    const a = buildFoldCoordinator(deps()).coordinator;
    const b = a.begin(TOPIC);
    if (!b.ok) throw new Error(b.reason);
    store.holdForFold(TOPIC, b.record.foldId, new Date().toISOString());
    enqueue();
    step(a, step(a, step(a, b.record, 'snapshotted'), 'staged'), 'replacing'); // past the point of no return

    // restart: fold boot sweep (quarantines), then the queue opens and settles
    const c = buildFoldCoordinator(deps()).coordinator;
    expect(c.recoverPendingFolds().quarantined).toHaveLength(1);
    expect(releaseSettledInboundHolds(store, recordOpen(), new Date().toISOString())).toEqual([]);
    expect(heads()).toEqual([]); // quarantined: still the fold's
  });

  it('a fold aborted by the boot sweep has its held rows released after the queue opens', () => {
    const a = buildFoldCoordinator(deps()).coordinator;
    const b = a.begin(TOPIC);
    if (!b.ok) throw new Error(b.reason);
    store.holdForFold(TOPIC, b.record.foldId, new Date().toISOString());
    enqueue();
    const c = buildFoldCoordinator(deps()).coordinator; // restart before the point of no return
    expect(c.recoverPendingFolds().aborted).toHaveLength(1);
    expect(releaseSettledInboundHolds(store, recordOpen(), new Date().toISOString())).toEqual([b.record.foldId]);
    expect(heads()).toEqual([TOPIC]);
  });
});
