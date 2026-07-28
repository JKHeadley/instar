// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * Integration (Tier 2 — replication path) — Fix #2 of the cross-machine reconciler
 * convergence: the topic PIN (move-intent) round-trips through the REAL CoherenceJournal
 * replicated-record pipeline (emit → schema-validate → append → read → HLC-merge), so the
 * OWNING machine can see "you are pinned away". Proves the dual-registry wiring (the kind
 * registered in JOURNAL_KINDS + the ReplicatedKindRegistry schema), the op-key dedupe, the
 * tombstone-on-clear, and HLC-highest-wins through the actual journal, not a mock.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { CoherenceJournal, sanitizeMachineId } from '../../src/core/CoherenceJournal.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import {
  TOPIC_PIN_KIND_REGISTRATION, TOPIC_PIN_RECORD_KIND,
  buildTopicPinPut, buildTopicPinTombstone, mergeUnionToPins, compareHlc,
} from '../../src/core/TopicPinReplicatedStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MACHINE = 'm_pin_test';
const hlc = (physical: number, logical = 0, node = MACHINE) => ({ physical, logical, node });

describe('topic-pin replication — journal round-trip (Fix #2)', () => {
  let dir: string;
  let journal: CoherenceJournal;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-repl-'));
    journal = new CoherenceJournal({ stateDir: dir, machineId: MACHINE, flushIntervalMs: 1_000_000 });
    journal.open();
    const registry = new ReplicatedKindRegistry();
    registry.register(TOPIC_PIN_KIND_REGISTRATION);
    journal.setReplicatedKindRegistry(registry);
  });
  afterEach(() => {
    try { journal.close(); } catch { /* best-effort */ }
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/topic-pin-replication.test.ts' });
  });

  function streamLines(): Record<string, unknown>[] {
    const file = path.join(dir, 'state', 'coherence-journal', `${sanitizeMachineId(MACHINE)}.${TOPIC_PIN_RECORD_KIND}.jsonl`);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  function mergedFromStream() {
    const entries = streamLines().map((l) => ({ data: l.data as Record<string, unknown>, origin: String((l.data as Record<string, unknown>).origin ?? '') }));
    return mergeUnionToPins(entries, compareHlc);
  }

  it('a pin PUT round-trips through the journal and merges to an advisory pin', () => {
    journal.emitReplicatedRecord(TOPIC_PIN_RECORD_KIND, buildTopicPinPut(700, 'm_b', true)(hlc(1000), MACHINE)!);
    journal.flush();
    const lines = streamLines();
    expect(lines).toHaveLength(1);
    expect((lines[0].data as Record<string, unknown>).op).toBe('put');
    const merged = mergedFromStream();
    expect(merged.get(700)?.preferredMachine).toBe('m_b');
  });

  it('a TOMBSTONE (clear) with a higher HLC supersedes the set → no advisory pin', () => {
    journal.emitReplicatedRecord(TOPIC_PIN_RECORD_KIND, buildTopicPinPut(700, 'm_b', true)(hlc(1000), MACHINE)!);
    journal.emitReplicatedRecord(TOPIC_PIN_RECORD_KIND, buildTopicPinTombstone(700, '2026-06-30T00:00:00Z')(hlc(2000), MACHINE)!);
    journal.flush();
    expect(mergedFromStream().has(700)).toBe(false);
  });

  it('a re-pin with a NEWER HLC after a clear resurrects the pin (HLC-highest-wins)', () => {
    journal.emitReplicatedRecord(TOPIC_PIN_RECORD_KIND, buildTopicPinTombstone(700, '2026-06-30T00:00:00Z')(hlc(1000), MACHINE)!);
    journal.emitReplicatedRecord(TOPIC_PIN_RECORD_KIND, buildTopicPinPut(700, 'm_a', true)(hlc(2000), MACHINE)!);
    journal.flush();
    expect(mergedFromStream().get(700)?.preferredMachine).toBe('m_a');
  });

  it('a malformed pin (path-shaped preferredMachine) is schema-REJECTED, never appended', () => {
    // buildTopicPinPut refuses a path-shaped id (returns null), and even a hand-forged
    // record is rejected by the registry schema's path-jail → the stream stays empty.
    const forged = { topic: 700, preferredMachine: '../etc/passwd', pinned: true, recordKey: '700', hlc: hlc(1000), op: 'put', origin: MACHINE };
    journal.emitReplicatedRecord(TOPIC_PIN_RECORD_KIND, forged as unknown as Record<string, unknown>);
    journal.flush();
    expect(streamLines()).toHaveLength(0);
  });

  it('op-key dedupes a same-(recordKey,hlc) retry; a new hlc is a distinct event', () => {
    const d = buildTopicPinPut(700, 'm_b', true)(hlc(1000), MACHINE)!;
    journal.emitReplicatedRecord(TOPIC_PIN_RECORD_KIND, d);
    journal.emitReplicatedRecord(TOPIC_PIN_RECORD_KIND, d); // exact retry → deduped
    journal.flush();
    expect(streamLines()).toHaveLength(1);
    journal.emitReplicatedRecord(TOPIC_PIN_RECORD_KIND, buildTopicPinPut(700, 'm_a', true)(hlc(2000), MACHINE)!);
    journal.flush();
    expect(streamLines()).toHaveLength(2); // new hlc → distinct event
  });
});
