// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Chief of Staff check-in loop over REAL substrate (docs/specs/chief-of-staff-topic.md §2, §4):
 * a real CoherenceJournal + ReplicatedRecordEmitter + ReplicatedPeerStreamReader on two machines,
 * a REAL ChiefOfStaffActionProtocol (holder = owner = m_a), real ed25519 renewals, and faked
 * evidence/judge seams. Proves: a signed owner renewal makes the lease live; a stalled verdict on
 * non-conversation evidence produces a claim → a started run; the check-event, intent and
 * renewal records cross-apply to the second machine and fold to the same project state there;
 * a tick on the non-holder does nothing; a second tick inside the cadence does not restart again.
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
import { CHIEF_OF_STAFF_KIND_REGISTRATION, CHIEF_OF_STAFF_RECORD_KIND, CHIEF_OF_STAFF_STORE_KEY, buildBindingPut, foldIntentState, foldProjectCheckState, type UnionEntry } from '../../src/core/ChiefOfStaffStore.js';
import { ChiefOfStaffActionProtocol, type CosProtocolDeps } from '../../src/core/ChiefOfStaffActionProtocol.js';
import { ChiefOfStaffLoop, CHIEF_OF_STAFF_LOOP_DEFAULTS, clampLoopConfig, boundProjects, type EvidenceBundle } from '../../src/core/ChiefOfStaffLoop.js';

const CK = 'telegram:141014';
const T0 = Date.parse('2026-11-09T12:00:00Z');
const H = 3_600_000;

function keypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return { priv: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, pub: publicKey.export({ type: 'spki', format: 'pem' }) as string };
}

describe('Chief of Staff loop — real journals, real protocol, two machines', () => {
  it('renewal → lease live; stalled → claim → started; records cross-apply and fold identically; non-holder idle; cadence respected', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-loop-int-'));
    const reg = new ReplicatedKindRegistry(); reg.register(CHIEF_OF_STAFF_KIND_REGISTRATION);
    const keys: Record<string, { priv: string; pub: string }> = { m_a: keypair(), m_b: keypair() };
    const world = { now: T0, holder: 'm_a', stalled: true, started: [] as string[], notes: [] as string[] };

    function make(id: string) {
      const dir = path.join(root, id); fs.mkdirSync(path.join(dir, 'state', 'sessions'), { recursive: true });
      const journal = new CoherenceJournal({ stateDir: dir, machineId: id, flushIntervalMs: 1_000_000 }); journal.open(); journal.setReplicatedKindRegistry(reg);
      let t = T0;
      const emitter = new ReplicatedRecordEmitter({ journal, clock: new HybridLogicalClock({ node: id, now: () => (t += 1000) }), registry: reg, origin: id, stores: () => ({ [CHIEF_OF_STAFF_STORE_KEY]: { enabled: true } }), loadWitness: () => undefined });
      const streams = new ReplicatedPeerStreamReader({ stateDir: dir, registry: reg, selfMachineId: id, autoRebuild: true });
      const emit = (recordKey: string, build: Parameters<ReplicatedRecordEmitter['emit']>[2]) => { const r = emitter.emit(CHIEF_OF_STAFF_STORE_KEY, recordKey, build); return { outcome: r.outcome, ...(r.seq !== undefined ? { seq: r.seq } : {}) }; };
      const loadUnion = (): UnionEntry[] => {
        const own = journal.readTail(CHIEF_OF_STAFF_RECORD_KIND, 10_000).entries.map((e) => ({ data: e.data as Record<string, unknown>, origin: id }));
        const peers: UnionEntry[] = [];
        for (const byOrigin of streams.loadAllOriginRecords(CHIEF_OF_STAFF_STORE_KEY).values()) for (const r of byOrigin) peers.push({ data: { ...r.data, recordKey: r.envelope.recordKey, hlc: r.envelope.hlc, op: r.envelope.op, origin: r.origin }, origin: r.origin });
        return [...own, ...peers];
      };
      const loopRef: { loop: ChiefOfStaffLoop | null } = { loop: null };
      const pdeps: CosProtocolDeps = {
        enabled: () => true, now: () => world.now, machineId: id,
        journal: { emit, awaitDurable: (seq) => journal.awaitDurableSeq(CHIEF_OF_STAFF_RECORD_KIND, seq, 3_000), flush: () => journal.flush(), loadUnion },
        lease: { currentHolder: () => world.holder, freshRenewalWithin: () => true, ttlMs: 30_000, currentEpoch: () => 3, holdsLease: () => world.holder === id },
        ownerOf: () => 'm_a',
        sign: (c) => sign(c, keys[id].priv), verify: (c, sig, m) => (keys[m] ? verify(c, sig, keys[m].pub) : false),
        runRegistry: { stateFor: () => 'none', findByIdempotencyKey: () => null },
        reconcilerCondition: () => null, resumeQueueHolds: () => false, moveInProgress: () => false, operatorStoppedSince: () => false,
        operatorLeaseLive: () => loopRef.loop?.lease().live ?? false,
        actionGate: (ck) => loopRef.loop?.actionGate(ck) ?? { nextActionAllowedAt: null, newestCheckAgeMs: Number.POSITIVE_INFINITY }, laggingFoldMs: 30 * 60_000,
        withConversationLock: async (_k, fn) => fn(),
        executors: {
          startRun: async ({ idempotencyKey }) => { world.started.push(`${id}:${idempotencyKey}`); return { runId: `run-${world.started.length}` }; },
          inject: async () => { throw new Error('not used'); }, abortRun: async () => { throw new Error('not used'); },
        } as never,
        send: async () => undefined,
        log: () => {},
      } as unknown as CosProtocolDeps;
      const protocol = new ChiefOfStaffActionProtocol(pdeps);
      const bundle = (): EvidenceBundle => ({ conversationKey: CK, items: [{ id: 'run', source: 'run', ageMs: 1000, value: 'none', unknown: false }, { id: 'agent-last', source: 'agent-message', ageMs: 30 * H, value: new Date(T0 - 30 * H).toISOString(), unknown: false }], netDiffLines: 0, mergedPrsSinceLastCheck: 0, doneItems: { pr: 'fail' }, liveSession: false, conversationTail: [], lastOwnerMessageAt: null, lastAgentMessageAt: new Date(T0 - 30 * H).toISOString(), overdueCommitments: 0 });
      const loop = new ChiefOfStaffLoop({
        now: () => world.now, machineId: id, enabled: () => true, holdsLease: () => world.holder === id, config: () => clampLoopConfig({ ...CHIEF_OF_STAFF_LOOP_DEFAULTS }),
        journal: { emit, loadUnion, awaitDurable: (seq) => journal.awaitDurableSeq(CHIEF_OF_STAFF_RECORD_KIND, seq, 3_000) },
        verifyRenewal: (r) => { const m = String(r.machine); const canonical = `cos-renewal:${r.renewedAt}:${r.renewedVia}:${r.principal}:${m}`; return keys[m] ? verify(canonical, String(r.machineSignature), keys[m].pub) : false; },
        gather: async () => bundle(),
        judge: async () => (world.stalled ? { verdict: 'stalled', citedIds: ['run', 'agent-last'], reason: 'no session, no diff, nothing for 30h' } : { verdict: 'moving', citedIds: ['run'], reason: 'moving' }),
        protocol,
        mirrorInitiativeStatus: () => {}, sendNote: async (t) => { world.notes.push(`${id}:${t}`); }, sendImmediate: async () => {}, statusUrl: () => 'http://localhost/chief-of-staff', localHour: () => 12,
        log: () => {},
      });
      loopRef.loop = loop;
      return { id, dir, journal, emitter, streams, loop, protocol, loadUnion };
    }
    const A = make('m_a'); const B = make('m_b');
    const cross = (from: typeof A, to: typeof B) => {
      from.journal.flush();
      const entries = from.journal.readTail(CHIEF_OF_STAFF_RECORD_KIND, 10_000).entries.sort((x, y) => x.seq - y.seq);
      new JournalSyncApplier({ stateDir: to.dir, replicatedRegistry: reg }).apply(from.id, [{ kind: CHIEF_OF_STAFF_RECORD_KIND, incarnation: `${from.id}-1`, entries }]);
    };
    try {
      // Bind one project on A (an hour ago, so it is due).
      A.emitter.emit(CHIEF_OF_STAFF_STORE_KEY, `binding:${CK}`, buildBindingPut({ conversationKey: CK, goal: 'Ship it', checkCadenceHours: 24, doneDefinition: [{ id: 'pr', kind: 'deterministic', text: 'PR merged' }], linked: { repos: [], branches: [], domains: [] }, confirmedBy: 'owner', confirmedAt: new Date(T0 - 2 * H).toISOString() } as never));
      A.journal.flush();
      expect(boundProjects(A.loadUnion()).map((p) => p.conversationKey)).toEqual([CK]);

      // No renewal yet ⇒ lease paused ⇒ a stalled project gets a needs-you line, no claim.
      await A.loop.tick(); A.journal.flush(); // the journal flushes on its own interval in production; the test folds right away
      expect(A.loop.status().lastError).toBeNull();
      expect(A.loop.lease().live).toBe(false);
      expect(world.started).toEqual([]);
      const afterFirst = foldProjectCheckState(A.loadUnion(), CK, { checkCadenceHours: 24, maxRestartsWithoutProgress: 3, breakerRestartsPerWeek: 5 }, new Date(world.now));
      expect(afterFirst.lastVerdict).toBe('stalled');

      // The owner speaks in the CoS topic on A: a real signed renewal ⇒ lease live.
      expect(A.loop.recordRenewal({ renewedVia: 'telegram', principal: 'telegram:1', eventRef: 'telegram:999:1', sign: (c) => sign(c, keys.m_a.priv) })).toBe(true);
      A.journal.flush();
      expect(A.loop.lease().live).toBe(true);

      // The project is still due (the paused tick recorded a check, so move past the cadence) and still stalled ⇒ claim ⇒ started.
      world.now = T0 + 25 * H;
      A.loop.markDirty(CK);
      await A.loop.tick(); A.journal.flush();
      expect(A.loop.status().lastError).toBeNull();
      expect(world.started).toHaveLength(1);
      expect(world.started[0].startsWith('m_a:')).toBe(true);
      const intents = [...foldIntentState(A.loadUnion()).values()].filter((s) => s.conversationKey === CK);
      expect(intents).toHaveLength(1); expect(intents[0].state).toBe('started');

      // Cross-apply A → B: B folds the same binding, renewal, check events and intent.
      cross(A, B);
      const stateA = foldProjectCheckState(A.loadUnion(), CK, { checkCadenceHours: 24, maxRestartsWithoutProgress: 3, breakerRestartsPerWeek: 5 }, new Date(world.now));
      const stateB = foldProjectCheckState(B.loadUnion(), CK, { checkCadenceHours: 24, maxRestartsWithoutProgress: 3, breakerRestartsPerWeek: 5 }, new Date(world.now));
      expect(stateB).toEqual(stateA);
      expect(stateB.lastVerdict).toBe('stalled'); expect(stateB.restartsWithoutProgress).toBe(1);
      expect([...foldIntentState(B.loadUnion()).values()].filter((s) => s.conversationKey === CK)[0]?.state).toBe('started');
      expect(B.loop.lease().live).toBe(true); // the renewal record verifies on B with A's public key

      // A tick on the non-holder writes nothing and starts nothing.
      const beforeB = B.loadUnion().length;
      await B.loop.tick(); B.journal.flush();
      expect(B.loadUnion().length).toBe(beforeB); expect(world.started).toHaveLength(1);

      // Inside the cadence on the holder: not due ⇒ no second restart.
      world.now += H;
      await A.loop.tick(); A.journal.flush();
      expect(world.started).toHaveLength(1);

      // The status views on the holder reflect the folded state.
      const rows = A.loop.projectsSummary();
      expect(rows).toHaveLength(1); expect(rows[0].lastVerdict).toBe('stalled'); expect(rows[0].restartsWithoutProgress).toBe(1);
      const detail = A.loop.projectDetail(CK)!;
      expect(detail.intents).toHaveLength(1); expect((detail.checks as unknown[]).length).toBeGreaterThanOrEqual(2);
    } finally {
      A.journal.close(); B.journal.close();
      SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/integration/chief-of-staff-loop.test.ts' });
    }
  });
});
