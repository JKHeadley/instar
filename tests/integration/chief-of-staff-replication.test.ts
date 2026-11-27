// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * Integration (Tier 2 — replication path) — Chief of Staff store (docs/specs/chief-of-staff-topic.md
 * §1.2 / §2.4 step 3): every record type round-trips through the REAL CoherenceJournal pipeline
 * (emit → schema-validate → append → read → fold), the dual-registry wiring holds (the kind in
 * JOURNAL_KINDS + the registry schema), a malformed record never lands, the op-key dedupes a
 * retry, and `emitReplicatedRecordWithSeq` + `awaitDurableSeq` close the "accepted ≠ on disk" gap.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { CoherenceJournal, sanitizeMachineId } from '../../src/core/CoherenceJournal.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import {
  CHIEF_OF_STAFF_KIND_REGISTRATION, CHIEF_OF_STAFF_RECORD_KIND,
  buildBindingPut, buildLifecycleEvent, buildIntent, buildOutcome, buildRenewal, buildCheckEvent,
  foldBindingState, foldIntentState, foldProjectCheckState, deriveLeaseExpiry,
  type UnionEntry,
} from '../../src/core/ChiefOfStaffStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MACHINE = 'm_cos_test';
const hlc = (physical: number, logical = 0, node = MACHINE) => ({ physical, logical, node });
const CK = 'telegram:141014';
const T0 = Date.parse('2026-11-09T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const SHA = 'b'.repeat(64);

describe('chief-of-staff replication — journal round-trip', () => {
  let dir: string;
  let journal: CoherenceJournal;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-repl-'));
    journal = new CoherenceJournal({ stateDir: dir, machineId: MACHINE, flushIntervalMs: 1_000_000 });
    journal.open();
    const registry = new ReplicatedKindRegistry();
    registry.register(CHIEF_OF_STAFF_KIND_REGISTRATION);
    journal.setReplicatedKindRegistry(registry);
  });
  afterEach(() => {
    try { journal.close(); } catch { /* best-effort */ }
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/chief-of-staff-replication.test.ts' });
  });

  function streamFile(): string {
    return path.join(dir, 'state', 'coherence-journal', `${sanitizeMachineId(MACHINE)}.${CHIEF_OF_STAFF_RECORD_KIND}.jsonl`);
  }
  function streamLines(): Record<string, unknown>[] {
    const file = streamFile();
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  function union(): UnionEntry[] {
    return streamLines().map((l) => ({ data: l.data as Record<string, unknown>, origin: String((l.data as Record<string, unknown>).origin ?? '') }));
  }
  const binding = buildBindingPut({
    conversationKey: CK, goal: 'Ship it', checkCadenceHours: 24,
    doneDefinition: [{ id: 'pr', kind: 'deterministic', text: 'PR merged' }],
    linked: { repos: ['JKHeadley/instar'] }, confirmedBy: 'owner', confirmedAt: iso(T0),
  });

  it('a binding, a lifecycle event, an intent, its outcomes and a renewal all land and fold from the stream', () => {
    expect(journal.emitReplicatedRecord(CHIEF_OF_STAFF_RECORD_KIND, binding(hlc(100), MACHINE)!)).toBe('accepted');
    expect(journal.emitReplicatedRecord(CHIEF_OF_STAFF_RECORD_KIND, buildLifecycleEvent(CK, 'closed', hlc(100), 'chief-of-staff', iso(T0))(hlc(200), MACHINE)!)).toBe('accepted');
    expect(journal.emitReplicatedRecord(CHIEF_OF_STAFF_RECORD_KIND, buildIntent({ conversationKey: CK, action: 'restart-run', leaseEpoch: 1, sequence: 1, claimedAt: iso(T0), machine: MACHINE, holderSignature: 's' })(hlc(300), MACHINE)!)).toBe('accepted');
    expect(journal.emitReplicatedRecord(CHIEF_OF_STAFF_RECORD_KIND, buildOutcome({ intentKey: `${CK}:1:1`, transition: 'executing', writer: 'ownership-machine', machine: MACHINE, at: iso(T0) })(hlc(310), MACHINE)!)).toBe('accepted');
    expect(journal.emitReplicatedRecord(CHIEF_OF_STAFF_RECORD_KIND, buildOutcome({ intentKey: `${CK}:1:1`, transition: 'started', writer: 'ownership-machine', machine: MACHINE, at: iso(T0), runId: 'run-1' })(hlc(320), MACHINE)!)).toBe('accepted');
    expect(journal.emitReplicatedRecord(CHIEF_OF_STAFF_RECORD_KIND, buildRenewal({ renewedAt: iso(T0), renewedVia: 'telegram', principal: 'owner:1', machine: MACHINE, machineSignature: 'good' })(hlc(400), MACHINE)!)).toBe('accepted');
    expect(journal.emitReplicatedRecord(CHIEF_OF_STAFF_RECORD_KIND, buildCheckEvent({ conversationKey: CK, verdict: 'moving', evidenceHash: SHA, evidenceIds: ['pr#1'], progressSeen: true, netDiffHighWater: 40, machine: MACHINE, at: iso(T0 + 3_600_000) })(hlc(500), MACHINE)!)).toBe('accepted');
    journal.flush();
    expect(streamLines()).toHaveLength(7);

    const u = union();
    const bs = foldBindingState(u).get(CK)!;
    expect(bs.confirmed).toBe(true); expect(bs.closed).toBe(true);
    const is = foldIntentState(u).get(`${CK}:1:1`)!;
    expect(is.state).toBe('started'); expect(is.runId).toBe('run-1'); expect(is.open).toBe(false);
    const lease = deriveLeaseExpiry(u, (r) => r.machineSignature === 'good', 72, new Date(T0 + 3_600_000));
    expect(lease.live).toBe(true);
    const cs = foldProjectCheckState(u, CK, { checkCadenceHours: 24, maxRestartsWithoutProgress: 3, breakerRestartsPerWeek: 5 }, new Date(T0 + 2 * 3_600_000), bs);
    expect(cs.lastProgressAt).toBe(iso(T0 + 3_600_000)); expect(cs.netDiffHighWater).toBe(40); expect(cs.restartsWithoutProgress).toBe(0);
  });

  it('a malformed record is schema-rejected and never appended', () => {
    const bad = { ...binding(hlc(100), MACHINE)!, checkCadenceHours: 0 };
    expect(journal.emitReplicatedRecord(CHIEF_OF_STAFF_RECORD_KIND, bad)).toBe('schema-rejected');
    journal.flush();
    expect(streamLines()).toHaveLength(0);
  });

  it('the op-key dedupes a retry of the same (recordKey, hlc); a new HLC is a new event', () => {
    const data = binding(hlc(100), MACHINE)!;
    expect(journal.emitReplicatedRecord(CHIEF_OF_STAFF_RECORD_KIND, data)).toBe('accepted');
    expect(journal.emitReplicatedRecord(CHIEF_OF_STAFF_RECORD_KIND, data)).toBe('deduped');
    expect(journal.emitReplicatedRecord(CHIEF_OF_STAFF_RECORD_KIND, binding(hlc(101), MACHINE)!)).toBe('accepted');
    journal.flush();
    expect(streamLines()).toHaveLength(2);
  });

  it('emitReplicatedRecordWithSeq returns the assigned seq, and awaitDurableSeq resolves only once it is fsynced', async () => {
    const r1 = journal.emitReplicatedRecordWithSeq(CHIEF_OF_STAFF_RECORD_KIND, binding(hlc(100), MACHINE)!);
    expect(r1.outcome).toBe('accepted'); expect(r1.seq).toBe(1);
    // Not durable yet: the advert (highWaterSeq) is still 0 before any flush.
    expect(journal.getOwnAdvert()[CHIEF_OF_STAFF_RECORD_KIND].lastSeq).toBe(0);
    await expect(journal.awaitDurableSeq(CHIEF_OF_STAFF_RECORD_KIND, r1.seq!, 2_000)).resolves.toBeUndefined();
    expect(journal.getOwnAdvert()[CHIEF_OF_STAFF_RECORD_KIND].lastSeq).toBe(1);
    const r2 = journal.emitReplicatedRecordWithSeq(CHIEF_OF_STAFF_RECORD_KIND, binding(hlc(101), MACHINE)!);
    expect(r2.seq).toBe(2);
    await journal.awaitDurableSeq(CHIEF_OF_STAFF_RECORD_KIND, 2, 2_000);
    expect(streamLines()).toHaveLength(2);
  });

  it('emitReplicatedRecordWithSeq carries no seq on a non-accepted outcome', () => {
    const r = journal.emitReplicatedRecordWithSeq(CHIEF_OF_STAFF_RECORD_KIND, { recordType: 'bogus', recordKey: 'x', hlc: hlc(1), op: 'put', origin: MACHINE });
    expect(r.outcome).toBe('schema-rejected'); expect(r.seq).toBeUndefined();
  });

  it('awaitDurableSeq rejects on an invalid seq, on a closed journal, and on timeout when the seq never lands', async () => {
    await expect(journal.awaitDurableSeq(CHIEF_OF_STAFF_RECORD_KIND, 0, 100)).rejects.toThrow(/invalid seq/);
    // seq 99 was never assigned: flush() has nothing to advance; the wait must time out, not hang.
    await expect(journal.awaitDurableSeq(CHIEF_OF_STAFF_RECORD_KIND, 99, 150, 10)).rejects.toThrow(/timeout/);
    journal.close();
    await expect(journal.awaitDurableSeq(CHIEF_OF_STAFF_RECORD_KIND, 1, 100)).rejects.toThrow(/not active/);
  });
});
