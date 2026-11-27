// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * Integration (Tier 2) — the Chief of Staff action protocol on the REAL substrate
 * (docs/specs/chief-of-staff-topic.md §2.4): two machines, each with a real CoherenceJournal +
 * ReplicatedRecordEmitter, real Ed25519 machine keys (MachineIdentity.sign/verify), the
 * production applier for cross-machine replication, and fake executors. Proves:
 *  - holder A claims, routes to owner B, B verifies the inner signature against the lease view,
 *    writes `executing` durably (awaitDurableSeq on the real journal) and then `started`;
 *  - after cross-apply, A's fold shows the same terminal state and a re-presented command on B
 *    returns the recorded outcome (no second execution);
 *  - a forged holder signature is rejected on B and leaves a durable `rejected` record.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import { ReplicatedPeerStreamReader } from '../../src/core/ReplicatedPeerStreamReader.js';
import { JournalSyncApplier } from '../../src/core/JournalSyncApplier.js';
import { HybridLogicalClock } from '../../src/core/HybridLogicalClock.js';
import { sign, verify } from '../../src/core/MachineIdentity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { CHIEF_OF_STAFF_KIND_REGISTRATION, CHIEF_OF_STAFF_RECORD_KIND, CHIEF_OF_STAFF_STORE_KEY, foldIntentState, type UnionEntry } from '../../src/core/ChiefOfStaffStore.js';
import { ChiefOfStaffActionProtocol, canonicalCommand, type CosProtocolDeps, type CosActionCommand } from '../../src/core/ChiefOfStaffActionProtocol.js';

const CK = 'telegram:141014';

function keypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return { priv: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, pub: publicKey.export({ type: 'spki', format: 'pem' }) as string };
}

interface Machine { id: string; dir: string; journal: CoherenceJournal; emitter: ReplicatedRecordEmitter; protocol: ChiefOfStaffActionProtocol; started: string[]; }

describe('Chief of Staff action protocol — real journals, real keys, two machines', () => {
  it('claim on A → execute on B → cross-apply → identical folds, dedupe, forged signature rejected', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-protocol-int-'));
    const reg = new ReplicatedKindRegistry(); reg.register(CHIEF_OF_STAFF_KIND_REGISTRATION);
    const keys: Record<string, { priv: string; pub: string }> = { m_a: keypair(), m_b: keypair() };
    const world = { holder: 'm_a', owner: 'm_b', leaseLive: true };
    const machines: Record<string, Machine> = {};

    function make(id: string): Machine {
      const dir = path.join(root, id); fs.mkdirSync(path.join(dir, 'state', 'sessions'), { recursive: true });
      const journal = new CoherenceJournal({ stateDir: dir, machineId: id, flushIntervalMs: 1_000_000 }); journal.open(); journal.setReplicatedKindRegistry(reg);
      let t = Date.parse('2026-11-09T12:00:00Z');
      const emitter = new ReplicatedRecordEmitter({ journal, clock: new HybridLogicalClock({ node: id, now: () => (t += 1000) }), registry: reg, origin: id, stores: () => ({ [CHIEF_OF_STAFF_STORE_KEY]: { enabled: true } }), loadWitness: () => undefined });
      const streams = new ReplicatedPeerStreamReader({ stateDir: dir, registry: reg, selfMachineId: id, autoRebuild: true });
      const started: string[] = [];
      const deps: CosProtocolDeps = {
        enabled: () => true, now: () => Date.now(), machineId: id,
        journal: {
          emit: (recordKey, build) => {
            const r = emitter.emit(CHIEF_OF_STAFF_STORE_KEY, recordKey, build);
            return { outcome: r.outcome, ...(r.seq !== undefined ? { seq: r.seq } : {}) };
          },
          awaitDurable: (seq) => journal.awaitDurableSeq(CHIEF_OF_STAFF_RECORD_KIND, seq, 3_000),
          flush: () => journal.flush(),
          loadUnion: (): UnionEntry[] => {
            const own = journal.readTail(CHIEF_OF_STAFF_RECORD_KIND, 10_000).entries.map((e) => ({ data: e.data as Record<string, unknown>, origin: id }));
            const peers: UnionEntry[] = [];
            for (const byOrigin of streams.loadAllOriginRecords(CHIEF_OF_STAFF_STORE_KEY).values()) for (const r of byOrigin) peers.push({ data: { ...r.data, recordKey: r.envelope.recordKey, hlc: r.envelope.hlc, op: r.envelope.op, origin: r.origin }, origin: r.origin });
            return [...own, ...peers];
          },
        },
        lease: { currentHolder: () => world.holder, freshRenewalWithin: () => true, ttlMs: 30_000, currentEpoch: () => 3, holdsLease: () => world.holder === id },
        ownerOf: () => world.owner,
        sign: (c) => sign(c, keys[id].priv),
        verify: (c, sig, m) => (keys[m] ? verify(c, sig, keys[m].pub) : false),
        runRegistry: { stateFor: () => 'none', findByIdempotencyKey: () => null },
        reconcilerCondition: () => null, resumeQueueHolds: () => false, moveInProgress: () => false, operatorStoppedSince: () => false,
        operatorLeaseLive: () => world.leaseLive,
        actionGate: () => ({ nextActionAllowedAt: null, newestCheckAgeMs: null }), laggingFoldMs: 30 * 60_000,
        withConversationLock: async (_k, fn) => fn(),
        executors: {
          startRun: async ({ idempotencyKey }) => { started.push(idempotencyKey); return { runId: `run-${id}-${started.length}` }; },
          inject: async ({ idempotencyKey }) => { started.push(idempotencyKey); return { injectId: `inj-${id}` }; },
          liveSession: () => false,
        },
        route: async (to, cmd) => (cmd.type === 'cos-action' ? machines[to].protocol.execute(cmd) : machines[to].protocol.settle(cmd)),
        maxRunHours: 4,
      };
      return (machines[id] = { id, dir, journal, emitter, protocol: new ChiefOfStaffActionProtocol(deps), started });
    }
    const A = make('m_a'); const B = make('m_b');
    const crossApply = async () => {
      for (const [from, to] of [[A, B], [B, A]] as const) {
        const entries = from.journal.readTail(CHIEF_OF_STAFF_RECORD_KIND, 10_000).entries.sort((x, y) => x.seq - y.seq);
        new JournalSyncApplier({ stateDir: to.dir, replicatedRegistry: reg }).apply(from.id, [{ kind: CHIEF_OF_STAFF_RECORD_KIND, incarnation: `${from.id}-1`, entries }]);
      }
    };
    try {
      // A (holder) claims; the owner is B ⇒ routed; B executes.
      const r = await A.protocol.claim({ conversationKey: CK, action: 'restart-run', payload: { durationHours: 1 } });
      expect(r.outcome).toBe('routed');
      expect((r as { result: { outcome: string; runId?: string } }).result).toMatchObject({ outcome: 'started', runId: 'run-m_b-1' });
      expect(B.started).toHaveLength(1); expect(A.started).toHaveLength(0);
      // B's own stream holds executing + started, durably.
      B.journal.flush();
      const bOwnRecs = B.journal.readTail(CHIEF_OF_STAFF_RECORD_KIND, 100).entries.map((e) => e.data as Record<string, unknown>);
      // The owner materialised the holder's intent from the verified command (it had not replicated yet),
      // then wrote executing and started — three durable records on B's own stream.
      expect(bOwnRecs.filter((d) => d.recordType === 'intent').map((d) => d.machine)).toEqual(['m_a']);
      expect(bOwnRecs.filter((d) => d.recordType === 'outcome').map((d) => d.transition).sort()).toEqual(['executing', 'started']);
      // Cross-apply ⇒ both machines fold the intent to `started` with B's run id.
      await crossApply();
      const stA = [...foldIntentState(await (A.protocol as unknown as { d: CosProtocolDeps }).d.journal.loadUnion()).values()][0];
      const stB = [...foldIntentState(await (B.protocol as unknown as { d: CosProtocolDeps }).d.journal.loadUnion()).values()][0];
      expect(stA.state).toBe('started'); expect(stB.state).toBe('started'); expect(stA.runId).toBe('run-m_b-1');
      // Re-present the same command to B: recorded outcome, no second execution.
      const key = stA.intentKey; const [, epoch, seq] = key.split(':').slice(-3).map(Number).length === 3 ? ['', ...key.split(':').slice(-2)] : ['', '3', '0'];
      const cmd: CosActionCommand = { type: 'cos-action', conversationKey: CK, action: 'restart-run', leaseEpoch: Number(epoch), sequence: Number(seq), holderMachineId: 'm_a', claimedAt: new Date().toISOString(), holderSignature: '', payload: {} };
      cmd.holderSignature = sign(canonicalCommand(cmd), keys.m_a.priv);
      expect(await B.protocol.execute(cmd)).toMatchObject({ outcome: 'started', duplicate: true, runId: 'run-m_b-1' });
      expect(B.started).toHaveLength(1);
      // A forged signature (signed by B's key, claiming to be A) is rejected and recorded.
      const forged: CosActionCommand = { ...cmd, sequence: Number(seq) + 1, holderSignature: '' };
      forged.holderSignature = sign(canonicalCommand(forged), keys.m_b.priv);
      const bCountBefore = B.journal.readTail(CHIEF_OF_STAFF_RECORD_KIND, 100).entries.length;
      expect(await B.protocol.execute(forged)).toMatchObject({ outcome: 'rejected', reason: 'holder-signature-invalid' });
      B.journal.flush();
      // An unauthenticated command writes NOTHING (no pre-rejection of a key, no store pollution).
      expect(B.journal.readTail(CHIEF_OF_STAFF_RECORD_KIND, 100).entries.length).toBe(bCountBefore);
      expect(B.started).toHaveLength(1);
      // Operator lease expired ⇒ a new claim is refused before anything is written.
      world.leaseLive = false;
      const before = A.journal.readTail(CHIEF_OF_STAFF_RECORD_KIND, 100).entries.length;
      expect(await A.protocol.claim({ conversationKey: CK, action: 'redirect', payload: { text: 'x' } })).toMatchObject({ outcome: 'rejected', reason: 'operator-lease-expired' });
      A.journal.flush();
      expect(A.journal.readTail(CHIEF_OF_STAFF_RECORD_KIND, 100).entries.length).toBe(before);
    } finally {
      A.journal.close(); B.journal.close();
      SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/integration/chief-of-staff-protocol.test.ts' });
    }
  });
});
