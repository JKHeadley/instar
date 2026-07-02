// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * Integration (Tier 2) — U4.1 §2C: the ANSWER-COMPLETE pin fold against the
 * REAL CoherenceJournal + CoherenceJournalReader (docs/specs/u4-1-pin-persistence.md).
 *
 * Spec-named tests:
 *  - topic-pin-record-stream-is-answer-complete (R-r2-3, replica coverage
 *    R-r3-3): >500 pin events across many topics PLUS rotation, own AND
 *    peer-replica streams — the FOLD (not the clamped tail read) returns the
 *    winning record for a topic untouched since the earliest events. The
 *    contrast half proves the OLD read (query, READER_MAX_LIMIT-clamped to the
 *    newest 500) actually MISSES that record — the defect this fold fixes.
 *  - incremental-tail-is-offset-idempotent (R-r2-3): a re-fold of unchanged
 *    bytes scans nothing and returns nothing; appended bytes fold
 *    incrementally; a full re-fold (offset reset) is idempotent by the HLC
 *    winner-map semantics (same records → same winners).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { CoherenceJournal, sanitizeMachineId } from '../../src/core/CoherenceJournal.js';
import { CoherenceJournalReader } from '../../src/core/CoherenceJournalReader.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import {
  TOPIC_PIN_KIND_REGISTRATION, TOPIC_PIN_RECORD_KIND,
  buildTopicPinPut, buildTopicPinTombstone,
} from '../../src/core/TopicPinReplicatedStore.js';
import { TopicPinFoldView } from '../../src/core/TopicPinFoldView.js';
import { TopicPinSkewQuarantine } from '../../src/core/TopicPinSkewQuarantine.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MACHINE = 'm_fold_own';
const PEER = 'm_fold_peer';
// Past-anchored physicals: the fold's skew gate only rejects FUTURE-skewed
// stamps, so honest history folds cleanly regardless of the wall clock.
const BASE = Date.now() - 6 * 3600_000;
const hlc = (offsetMs: number, logical = 0, node = MACHINE): HlcTimestamp => ({ physical: BASE + offsetMs, logical, node });

describe('U4.1 §2C — answer-complete pin fold over the real journal', () => {
  let dir: string;
  let journal: CoherenceJournal;
  let reader: CoherenceJournalReader;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u41-fold-'));
    journal = new CoherenceJournal({
      stateDir: dir,
      machineId: MACHINE,
      flushIntervalMs: 1_000_000,
      // Tiny rotation threshold so a few hundred pin events produce REAL archives
      // (rotateKeep 0 = rotate but never delete — the U4.1 storage half).
      retention: { 'topic-pin-record': { maxFileBytes: 8 * 1024, rotateKeep: 0 } },
      rateCap: { capacity: 1_000_000, refillPerSec: 1_000_000 },
    });
    journal.open();
    const registry = new ReplicatedKindRegistry();
    registry.register(TOPIC_PIN_KIND_REGISTRATION);
    journal.setReplicatedKindRegistry(registry);
    reader = new CoherenceJournalReader({ stateDir: dir });
  });
  afterEach(() => {
    try { journal.close(); } catch { /* best-effort */ }
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/u41-pin-fold-answer-complete.test.ts' });
  });

  function mkView() {
    const quarantine = new TopicPinSkewQuarantine({ filePath: path.join(dir, 'quarantine.json') });
    return new TopicPinFoldView({ reader, quarantine, selfNode: () => 'm_reader' });
  }

  it('topic-pin-record-stream-is-answer-complete: >500 events + rotation + a peer replica — the fold returns the long-untouched winner the clamped tail read MISSES', () => {
    // The LONG-UNTOUCHED topic: pinned once at the very beginning, never again.
    journal.emitReplicatedRecord(TOPIC_PIN_RECORD_KIND, buildTopicPinPut(42, 'm_old_target', true)(hlc(0), MACHINE)!);
    // 600 later pin events across OTHER topics — churn that rotates the stream
    // several times (8KB files) and floods any newest-N window.
    for (let i = 0; i < 600; i++) {
      const topic = 100 + (i % 200);
      journal.emitReplicatedRecord(TOPIC_PIN_RECORD_KIND, buildTopicPinPut(topic, `m_t${i % 3}`, true)(hlc(1000 + i * 1000, i), MACHINE)!);
      if (i % 30 === 29) journal.flush(); // rotation is checked per flush — batch like the live 30s cadence
    }
    journal.flush();

    // Real archives exist (rotation happened) and nothing was deleted (rotateKeep 0).
    const jdir = path.join(dir, 'state', 'coherence-journal');
    const archives = fs.readdirSync(jdir).filter((f) => new RegExp(`^${sanitizeMachineId(MACHINE)}\\.${TOPIC_PIN_RECORD_KIND}\\.\\d+\\.jsonl$`).test(f));
    expect(archives.length).toBeGreaterThan(2);

    // A PEER REPLICA stream (as JournalSyncApplier materializes it) — the fold
    // MUST cover replica streams or the effective map is blind to peers' pins.
    const peersDir = path.join(jdir, 'peers');
    fs.mkdirSync(peersDir, { recursive: true });
    const peerPut = buildTopicPinPut(77, 'm_peer_target', true)({ physical: BASE + 500, logical: 0, node: PEER }, PEER)!;
    fs.writeFileSync(
      path.join(peersDir, `${PEER}.${TOPIC_PIN_RECORD_KIND}.jsonl`),
      JSON.stringify({ seq: 1, ts: new Date(BASE + 500).toISOString(), machine: PEER, kind: TOPIC_PIN_RECORD_KIND, data: peerPut }) + '\n',
    );

    // CONTRAST (the defect being fixed): the old tail read — query() with the
    // silently-clamped limit — misses topic 42's record entirely.
    const tail = reader.query({ kind: TOPIC_PIN_RECORD_KIND, limit: 2000 });
    expect(tail.entries.length).toBeLessThanOrEqual(500); // READER_MAX_LIMIT hard clamp
    expect(tail.entries.some((e) => (e.data as Record<string, unknown>).recordKey === '42')).toBe(false);

    // THE FIX: the fold is answer-complete — the earliest record still wins for
    // its untouched topic, and the peer-replica pin is visible.
    const view = mkView();
    view.refresh(); // boot-time full-stream fold
    const pins = view.pins();
    expect(pins.get(42)?.preferredMachine).toBe('m_old_target');
    expect(pins.get(77)?.preferredMachine).toBe('m_peer_target');
    expect(pins.get(77)?.origin).toBe(PEER);
    expect(pins.size).toBeGreaterThan(200); // every churned topic's winner is present too
  });

  it('incremental-tail-is-offset-idempotent: unchanged bytes re-scan to nothing; appends fold incrementally; tombstones land through the tail', () => {
    journal.emitReplicatedRecord(TOPIC_PIN_RECORD_KIND, buildTopicPinPut(700, 'm_x', true)(hlc(0), MACHINE)!);
    journal.flush();
    const own = path.join(dir, 'state', 'coherence-journal', `${sanitizeMachineId(MACHINE)}.${TOPIC_PIN_RECORD_KIND}.jsonl`);

    // Boot fold reads the bytes once…
    const first = reader.foldPinRecords();
    expect(first.entries).toHaveLength(1);
    expect(first.scannedBytes).toBe(fs.statSync(own).size);
    // …and the incremental re-fold of UNCHANGED bytes is a no-op.
    const second = reader.foldPinRecords({ priorOffsets: first.offsets });
    expect(second.entries).toHaveLength(0);
    expect(second.scannedBytes).toBe(0);

    // Appended bytes (the unpin tombstone) fold incrementally — ONLY the new record.
    journal.emitReplicatedRecord(TOPIC_PIN_RECORD_KIND, buildTopicPinTombstone(700, new Date(BASE + 5000).toISOString())(hlc(5000), MACHINE)!);
    journal.flush();
    const third = reader.foldPinRecords({ priorOffsets: second.offsets });
    expect(third.entries).toHaveLength(1);
    expect((third.entries[0].data as Record<string, unknown>).op).toBe('delete');

    // The stateful view sees the same lifecycle: pin → visible; tombstone → gone.
    const view = mkView();
    view.refresh();
    expect(view.pins().size).toBe(0); // tombstone won by HLC through the real files

    // Full re-fold idempotency (offset reset — e.g. rotation identity change or
    // the explicit re-admit resetFold): same records ⇒ same winners.
    view.resetFold();
    view.refresh();
    expect(view.pins().size).toBe(0);
  });

  it('a file-identity change (rotation) resets the offset safely — the re-scan is idempotent by winner-map semantics', () => {
    journal.emitReplicatedRecord(TOPIC_PIN_RECORD_KIND, buildTopicPinPut(800, 'm_a', true)(hlc(0), MACHINE)!);
    journal.flush();
    const first = reader.foldPinRecords();
    expect(first.entries).toHaveLength(1);
    // Force rotation by flooding past maxFileBytes (8KB) — the current file's
    // identity (inode) changes; the archived bytes must still fold.
    for (let i = 0; i < 120; i++) {
      journal.emitReplicatedRecord(TOPIC_PIN_RECORD_KIND, buildTopicPinPut(801 + i, 'm_b', true)(hlc(1000 + i * 1000), MACHINE)!);
      if (i % 30 === 29) journal.flush(); // rotation is checked per flush
    }
    journal.flush();
    const after = reader.foldPinRecords({ priorOffsets: first.offsets });
    // Every record is reachable exactly through fold semantics: topic 800's
    // original put may re-scan (offset reset on the rotated file) — winner-map
    // dedupe by HLC makes that harmless, never a duplicate winner.
    const view = mkView();
    view.refresh();
    expect(view.pins().get(800)?.preferredMachine).toBe('m_a');
    expect(view.pins().get(801)?.preferredMachine).toBe('m_b');
    expect(after.skippedCorrupt).toBe(0);
  });
});
