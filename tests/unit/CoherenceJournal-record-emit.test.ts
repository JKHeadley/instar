// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * Unit — CoherenceJournal.emitReplicatedRecord (WS2 send-side, the §3.1 journal gap).
 *
 * Proves the journal can APPEND + VALIDATE a registered `*-record` kind (it could
 * not before — `validate()` fell through to `return null` for any non-lifecycle
 * kind), that the op-key is `recordKey:hlcKey` (a same-key+same-hlc retry dedupes;
 * a new hlc is a new event), that the per-entry cap is RAISED for record kinds (a
 * 20 KB-description learning is appended, not dropped as oversize at 8 KB), and that
 * a malformed envelope is a counted schema-reject. Without the registry injected, the
 * emit is a strict no-op (the unchanged pre-WS2 behavior).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { CoherenceJournal, sanitizeMachineId } from '../../src/core/CoherenceJournal.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import {
  LEARNING_KIND_REGISTRATION,
  LEARNING_RECORD_KIND,
  buildLearningRecordData,
} from '../../src/core/LearningsReplicatedStore.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import type { LearningEntry } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MACHINE = 'm_journal_test';

function hlc(physical: number, logical = 0): HlcTimestamp {
  return { physical, logical, node: MACHINE };
}

function learning(over: Partial<LearningEntry> = {}): LearningEntry {
  return {
    id: 'LRN-001',
    title: 'tmux trailing colon',
    category: 'ops',
    description: 'use a trailing colon for pane-level commands',
    source: { discoveredAt: '2026-06-15T00:00:00.000Z' },
    tags: ['tmux'],
    applied: false,
    ...over,
  };
}

describe('CoherenceJournal.emitReplicatedRecord', () => {
  let dir: string;
  let journal: CoherenceJournal;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-rec-'));
    journal = new CoherenceJournal({ stateDir: dir, machineId: MACHINE, flushIntervalMs: 1_000_000 });
    journal.open();
  });
  afterEach(() => {
    try { journal.close(); } catch { /* best-effort */ }
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/CoherenceJournal-record-emit.test.ts' });
  });

  function ownStreamLines(kind: string): Record<string, unknown>[] {
    const file = path.join(dir, 'state', 'coherence-journal', `${sanitizeMachineId(MACHINE)}.${kind}.jsonl`);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  it('is a NO-OP for a record kind when no registry is injected (unchanged pre-WS2 behavior)', () => {
    const data = buildLearningRecordData({ record: learning(), hlc: hlc(1000), origin: MACHINE })!;
    journal.emitReplicatedRecord(LEARNING_RECORD_KIND, data);
    journal.flush();
    expect(ownStreamLines(LEARNING_RECORD_KIND)).toHaveLength(0);
  });

  it('appends a registered learning-record to the own stream when the registry is injected', () => {
    const registry = new ReplicatedKindRegistry();
    registry.register(LEARNING_KIND_REGISTRATION);
    journal.setReplicatedKindRegistry(registry);

    const data = buildLearningRecordData({ record: learning(), hlc: hlc(1000), origin: MACHINE })!;
    journal.emitReplicatedRecord(LEARNING_RECORD_KIND, data);
    journal.flush();

    const lines = ownStreamLines(LEARNING_RECORD_KIND);
    expect(lines).toHaveLength(1);
    expect(lines[0].kind).toBe(LEARNING_RECORD_KIND);
    expect((lines[0].data as Record<string, unknown>).recordKey).toBe(data.recordKey);
    expect((lines[0].data as Record<string, unknown>).title).toBe('tmux trailing colon');
    expect((lines[0].data as Record<string, unknown>).op).toBe('put');
  });

  it('op-key dedupes a same-(recordKey,hlc) retry; a new hlc is a distinct event', () => {
    const registry = new ReplicatedKindRegistry();
    registry.register(LEARNING_KIND_REGISTRATION);
    journal.setReplicatedKindRegistry(registry);

    const d1 = buildLearningRecordData({ record: learning(), hlc: hlc(1000), origin: MACHINE })!;
    journal.emitReplicatedRecord(LEARNING_RECORD_KIND, d1);
    journal.emitReplicatedRecord(LEARNING_RECORD_KIND, d1); // exact retry — deduped
    journal.flush();
    expect(ownStreamLines(LEARNING_RECORD_KIND)).toHaveLength(1);

    // Same record, NEW hlc (e.g. a markApplied re-emit) — a distinct event.
    const d2 = buildLearningRecordData({ record: learning({ applied: true }), hlc: hlc(2000), origin: MACHINE })!;
    journal.emitReplicatedRecord(LEARNING_RECORD_KIND, d2);
    journal.flush();
    expect(ownStreamLines(LEARNING_RECORD_KIND)).toHaveLength(2);
  });

  it('appends a FAT (20KB-description) learning — the raised 80KB record cap, not the 8KB lifecycle cap', () => {
    const registry = new ReplicatedKindRegistry();
    registry.register(LEARNING_KIND_REGISTRATION);
    journal.setReplicatedKindRegistry(registry);

    const big = learning({ description: 'x'.repeat(20_000) });
    const data = buildLearningRecordData({ record: big, hlc: hlc(1000), origin: MACHINE })!;
    expect(Buffer.byteLength(JSON.stringify(data), 'utf-8')).toBeGreaterThan(8 * 1024); // would be dropped at 8KB
    journal.emitReplicatedRecord(LEARNING_RECORD_KIND, data);
    journal.flush();
    const lines = ownStreamLines(LEARNING_RECORD_KIND);
    expect(lines).toHaveLength(1);
    expect(((lines[0].data as Record<string, unknown>).description as string).length).toBe(20_000);
  });

  it('rejects a malformed envelope (missing recordKey) — counted schema-reject, nothing written', () => {
    const registry = new ReplicatedKindRegistry();
    registry.register(LEARNING_KIND_REGISTRATION);
    journal.setReplicatedKindRegistry(registry);

    const before = journal.getDegradation().schemaRejects;
    journal.emitReplicatedRecord(LEARNING_RECORD_KIND, { title: 'no key', op: 'put', origin: MACHINE, hlc: hlc(1) } as Record<string, unknown>);
    journal.flush();
    expect(ownStreamLines(LEARNING_RECORD_KIND)).toHaveLength(0);
    expect(journal.getDegradation().schemaRejects).toBe(before + 1);
  });
});
