// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * Tier-3 lifecycle for the Chief of Staff store (docs/specs/chief-of-staff-topic.md §1.2,
 * "Multi-machine posture"): the PRODUCTION replication path, in-process. Machine A emits
 * through the real ReplicatedRecordEmitter (store-flag gated, HLC clock, registry) into a real
 * CoherenceJournal; the stream is applied on machine B through JournalSyncApplier and read back
 * through ReplicatedPeerStreamReader; B's folds equal A's. Then both machines write concurrently
 * (A closes, B edits the binding) and the union folds to the same answer on both sides — the
 * immutable-event design the spec relies on, proven on the substrate rather than asserted.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import { ReplicatedPeerStreamReader } from '../../src/core/ReplicatedPeerStreamReader.js';
import { JournalSyncApplier } from '../../src/core/JournalSyncApplier.js';
import { HybridLogicalClock } from '../../src/core/HybridLogicalClock.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  CHIEF_OF_STAFF_KIND_REGISTRATION, CHIEF_OF_STAFF_RECORD_KIND, CHIEF_OF_STAFF_STORE_KEY,
  buildBindingPut, buildLifecycleEvent, buildIntent, buildOutcome, buildRenewal,
  foldBindingState, foldIntentState, deriveLeaseExpiry, type UnionEntry,
} from '../../src/core/ChiefOfStaffStore.js';

const CK = 'telegram:141014';
const T0 = Date.parse('2026-11-09T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

function machine(root: string, id: string, reg: ReplicatedKindRegistry, enabled: boolean) {
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, 'state', 'sessions'), { recursive: true });
  const journal = new CoherenceJournal({ stateDir: dir, machineId: id, flushIntervalMs: 1_000_000 });
  journal.open(); journal.setReplicatedKindRegistry(reg);
  let t = T0;
  const emitter = new ReplicatedRecordEmitter({
    journal, clock: new HybridLogicalClock({ node: id, now: () => (t += 1000) }), registry: reg,
    origin: id, stores: () => ({ [CHIEF_OF_STAFF_STORE_KEY]: { enabled } }), loadWitness: () => undefined,
  });
  return { id, dir, journal, emitter };
}

function ownEntries(j: CoherenceJournal): UnionEntry[] {
  return j.readTail(CHIEF_OF_STAFF_RECORD_KIND, 1000).entries.map((e) => ({ data: e.data as Record<string, unknown>, origin: String((e.data as Record<string, unknown>).origin ?? '') }));
}

async function peerEntries(dir: string, reg: ReplicatedKindRegistry, selfId: string): Promise<UnionEntry[]> {
  const streams = new ReplicatedPeerStreamReader({ stateDir: dir, registry: reg, selfMachineId: selfId, autoRebuild: false });
  await streams.rebuildWitnessIndexAsync();
  const out: UnionEntry[] = [];
  for (const byOrigin of streams.loadAllOriginRecords(CHIEF_OF_STAFF_STORE_KEY).values()) {
    for (const r of byOrigin) out.push({ data: { ...r.data, recordKey: r.envelope.recordKey, hlc: r.envelope.hlc, op: r.envelope.op, origin: r.origin }, origin: r.origin });
  }
  return out;
}

describe('E2E: Chief of Staff store — production replication path + concurrent-write convergence', () => {
  it('A emits → B applies → both fold identically; then concurrent writes on A and B converge', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-lifecycle-e2e-'));
    const reg = new ReplicatedKindRegistry(); reg.register(CHIEF_OF_STAFF_KIND_REGISTRATION);
    const A = machine(root, 'm_a', reg, true);
    const B = machine(root, 'm_b', reg, true);
    try {
      // ── A: binding + intent + outcomes + renewal, through the REAL emitter (flag-gated).
      const binding = { conversationKey: CK, goal: 'Ship it', checkCadenceHours: 24, doneDefinition: [{ id: 'pr', kind: 'deterministic' as const, text: 'PR merged' }], linked: { repos: ['JKHeadley/instar'] }, confirmedBy: 'owner' as const, confirmedAt: iso(T0) };
      expect(A.emitter.emit(CHIEF_OF_STAFF_STORE_KEY, `binding:${CK}`, buildBindingPut(binding)).outcome).toBe('emitted');
      expect(A.emitter.emit(CHIEF_OF_STAFF_STORE_KEY, `${CK}:1:1`, buildIntent({ conversationKey: CK, action: 'restart-run', leaseEpoch: 1, sequence: 1, claimedAt: iso(T0), machine: 'm_a', holderSignature: 's' })).outcome).toBe('emitted');
      expect(A.emitter.emit(CHIEF_OF_STAFF_STORE_KEY, `${CK}:1:1:outcome:executing`, buildOutcome({ intentKey: `${CK}:1:1`, transition: 'executing', writer: 'ownership-machine', machine: 'm_a', at: iso(T0) })).outcome).toBe('emitted');
      expect(A.emitter.emit(CHIEF_OF_STAFF_STORE_KEY, `${CK}:1:1:outcome:started`, buildOutcome({ intentKey: `${CK}:1:1`, transition: 'started', writer: 'ownership-machine', machine: 'm_a', at: iso(T0), runId: 'run-1' })).outcome).toBe('emitted');
      expect(A.emitter.emit(CHIEF_OF_STAFF_STORE_KEY, 'renewal', buildRenewal({ renewedAt: iso(T0), renewedVia: 'telegram', principal: 'owner:1', machine: 'm_a', machineSignature: 'good' })).outcome).toBe('emitted');
      A.journal.flush();
      const aEntries = ownEntries(A.journal);
      expect(aEntries).toHaveLength(5);

      // ── The flag OFF path emits nothing (dark on the fleet until PR 3 forces it on).
      const dark = machine(root, 'm_dark', reg, false);
      expect(dark.emitter.emit(CHIEF_OF_STAFF_STORE_KEY, `binding:${CK}`, buildBindingPut(binding)).outcome).toBe('disabled');
      dark.journal.flush();
      expect(ownEntries(dark.journal)).toHaveLength(0);
      dark.journal.close();

      // ── B applies A's stream through the production applier and reads it back.
      const applier = new JournalSyncApplier({ stateDir: B.dir, replicatedRegistry: reg });
      const entries = A.journal.readTail(CHIEF_OF_STAFF_RECORD_KIND, 1000).entries.sort((x, y) => x.seq - y.seq);
      const applied = applier.apply('m_a', [{ kind: CHIEF_OF_STAFF_RECORD_KIND, incarnation: 'a-1', entries }]);
      expect(applied.applied).toBe(5);
      const bView = await peerEntries(B.dir, reg, 'm_b');
      expect(bView).toHaveLength(5);

      const bsA = foldBindingState(aEntries).get(CK)!; const bsB = foldBindingState(bView).get(CK)!;
      expect(bsB.confirmed).toBe(true); expect(bsB.closed).toBe(false); expect(bsB.bindingHlc).toEqual(bsA.bindingHlc);
      expect(foldIntentState(bView).get(`${CK}:1:1`)!.state).toBe('started');
      expect(deriveLeaseExpiry(bView, (r) => r.machineSignature === 'good', 72, new Date(T0 + 3_600_000)).live).toBe(true);

      // ── Concurrent writes: A closes against the binding it saw; B (the owner's tap) edits
      // the binding at the same moment. Whichever order the union is read in, the closure is
      // INVALID (its bindingHlc no longer matches the winning binding) — an older verification
      // can never override a concurrent owner edit (§1.2).
      expect(A.emitter.emit(CHIEF_OF_STAFF_STORE_KEY, `lifecycle:${CK}:close`, buildLifecycleEvent(CK, 'closed', bsA.bindingHlc!, 'chief-of-staff', iso(T0 + 60_000))).outcome).toBe('emitted');
      expect(B.emitter.emit(CHIEF_OF_STAFF_STORE_KEY, `binding:${CK}`, buildBindingPut({ ...binding, goal: 'Ship the better thing' })).outcome).toBe('emitted');
      A.journal.flush(); B.journal.flush();
      const aNew = A.journal.readTail(CHIEF_OF_STAFF_RECORD_KIND, 1000).entries.sort((x, y) => x.seq - y.seq);
      const bNew = B.journal.readTail(CHIEF_OF_STAFF_RECORD_KIND, 1000).entries.sort((x, y) => x.seq - y.seq);
      // Cross-apply so each side holds the full union.
      new JournalSyncApplier({ stateDir: B.dir, replicatedRegistry: reg }).apply('m_a', [{ kind: CHIEF_OF_STAFF_RECORD_KIND, incarnation: 'a-1', entries: aNew }]);
      new JournalSyncApplier({ stateDir: A.dir, replicatedRegistry: reg }).apply('m_b', [{ kind: CHIEF_OF_STAFF_RECORD_KIND, incarnation: 'b-1', entries: bNew }]);
      const unionOnA = [...ownEntries(A.journal), ...(await peerEntries(A.dir, reg, 'm_a'))];
      const unionOnB = [...ownEntries(B.journal), ...(await peerEntries(B.dir, reg, 'm_b'))];
      const viewA = foldBindingState(unionOnA).get(CK)!; const viewB = foldBindingState(unionOnB).get(CK)!;
      expect(viewA.closed).toBe(false); expect(viewB.closed).toBe(false);
      expect((viewA.binding as Record<string, unknown>).goal).toBe('Ship the better thing');
      expect(viewA.bindingHlc).toEqual(viewB.bindingHlc);
      expect(foldIntentState(unionOnA).get(`${CK}:1:1`)!.state).toBe(foldIntentState(unionOnB).get(`${CK}:1:1`)!.state);
    } finally {
      A.journal.close(); B.journal.close();
      SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/e2e/chief-of-staff-store-lifecycle.test.ts' });
    }
  });
});
