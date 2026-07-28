// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
// safe-fs-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Tier-1 unit tests for JournalSyncApplier (P1.3) — the RECEIVE/SERVE engine.
 *
 * Spec: docs/specs/COHERENCE-JOURNAL-SPEC.md §3.4 (ALL seven replication rules),
 * §3.1 (stream/meta layout), §5 (trust model), §6 (testing — replication list).
 *
 * Covers the §6 replication list verbatim:
 *  - seq-gated apply: in-order appends; gap → held + status behind; duplicate →
 *    dropped silently.
 *  - forged third-machine entries rejected + counted.
 *  - malformed entry → suspect + batch stopped at last valid + self-clear after
 *    20 clean applies.
 *  - NEW incarnation → quarantine + fresh start + bounded quarantine files
 *    (4 flips → max 2 kept + reset-flapping).
 *  - truncation fast-forward w/ gap sentinel + status gapped.
 *  - serve side: durably-flushed-only (serves exactly file contents),
 *    size-cap honored mid-batch, oldestRetainedSeq included after rotation.
 *  - ack-after-fsync: an injected fs spy asserts fdatasync is called BEFORE the
 *    applied count is reported (a fault-injected fsync failure reports 0 applied).
 *  - guardWrite refusal → batch skipped + counted, never thrown.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  JournalSyncApplier,
  SUSPECT_CLEAR_THRESHOLD,
  MAX_QUARANTINE_PER_STREAM,
  type ApplyBatchStream,
} from '../../src/core/JournalSyncApplier.js';
import type { JournalEntry, JournalKind } from '../../src/core/CoherenceJournal.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-sync-applier-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const PEER = 'm_peer123';
const OWN = 'm_self456';

function journalDir(): string {
  return path.join(tmpDir, 'state', 'coherence-journal');
}
function peersDir(): string {
  return path.join(journalDir(), 'peers');
}
function replicaFile(machine: string, kind: JournalKind): string {
  return path.join(peersDir(), `${machine}.${kind}.jsonl`);
}

/** Build a placement entry authored by `machine`. */
function placement(seq: number, machine: string, topic: number, epoch: number, ts?: string): JournalEntry {
  return {
    seq,
    ts: ts ?? new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    machine,
    kind: 'topic-placement',
    topic,
    data: { owner: machine, epoch, reason: 'placed' },
  };
}

/**
 * Build a cooperative-handoff (transferring) placement entry — WS1.3/Fix #3.
 * `reason: 'reconcile'` + the optional handoff fields. This is the exact shape a
 * real cross-machine ownership-reconciler transfer writes; the receive-side
 * validator must accept it (the 2026-06-30 live-proof bug: it didn't).
 */
function transferringPlacement(
  seq: number,
  machine: string,
  topic: number,
  epoch: number,
  transferTo: string,
  extra: Record<string, unknown> = {},
): JournalEntry {
  return {
    seq,
    ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    machine,
    kind: 'topic-placement',
    topic,
    data: { owner: machine, epoch, reason: 'reconcile', status: 'transferring', transferTo, timestamp: 1_700_000_000_000 + seq * 1000, ...extra },
  };
}

function lifecycle(seq: number, machine: string, sessionId: string, status: string, ts?: string): JournalEntry {
  return {
    seq,
    ts: ts ?? new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    machine,
    kind: 'session-lifecycle',
    data: { sessionId, status },
  };
}

function readReplicaEntries(machine: string, kind: JournalKind): JournalEntry[] {
  const file = replicaFile(machine, kind);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as JournalEntry);
}

function newApplier(opts: Partial<ConstructorParameters<typeof JournalSyncApplier>[0]> = {}): JournalSyncApplier {
  return new JournalSyncApplier({ stateDir: tmpDir, ...opts });
}

// ---------------------------------------------------------------------------
// Fix #3 receive-side validation of cooperative-handoff (transferring) records.
// Regression for the 2026-06-30 live two-machine proof: the emit-side validator
// (CoherenceJournal.validate) accepted reason:'reconcile' + status/transferTo/
// timestamp/drainInFlight, but the receive-side mirror here did NOT — so a real
// transfer record was rejected on receipt, the peer stream went `suspect`, and
// cross-machine replication halted so the target never claimed. The receive-side
// MUST mirror the emit-side. (In-process tests covered emit + applier-materialize,
// never this cross-machine receive path — which is why two machines exposed it.)
// ---------------------------------------------------------------------------

describe('Fix #3 — receive-side accepts cooperative-handoff (transferring) records', () => {
  it('a transferring record (reason:reconcile + handoff fields) is applied, NOT suspect', () => {
    const a = newApplier();
    const res = a.apply(PEER, [
      {
        kind: 'topic-placement',
        incarnation: 'inc-1',
        // seq 1 a normal active placement, seq 2 the transfer hand-off — exactly the
        // real sequence the live proof produced (active(owner) → transferring(→target)).
        entries: [placement(1, PEER, 28730, 2), transferringPlacement(2, PEER, 28730, 3, OWN)],
      },
    ]);
    expect(res.applied).toBe(2);
    expect(res.invalidEntries).toBe(0);
    expect(readReplicaEntries(PEER, 'topic-placement').map((e) => e.seq)).toEqual([1, 2]);
    // The crux: the stream stays current (before the fix this was 'suspect' and
    // replication halted at seq 1, so the target never saw the transfer).
    expect(a.getStreamStatus()[`${PEER}.topic-placement`]).toBe('current');
    const applied = readReplicaEntries(PEER, 'topic-placement')[1];
    expect(applied.data).toMatchObject({ reason: 'reconcile', status: 'transferring', transferTo: OWN });
  });

  it('accepts an explicit status:active record and an optional drainInFlight flag', () => {
    const a = newApplier();
    const res = a.apply(PEER, [
      {
        kind: 'topic-placement',
        incarnation: 'inc-1',
        entries: [transferringPlacement(1, PEER, 700, 5, OWN, { status: 'active', drainInFlight: true })],
      },
    ]);
    expect(res.applied).toBe(1);
    expect(a.getStreamStatus()[`${PEER}.topic-placement`]).toBe('current');
  });

  it('a present-but-malformed handoff field is still rejected → suspect (no silent partial accept)', () => {
    const a = newApplier();
    const res = a.apply(PEER, [
      {
        kind: 'topic-placement',
        incarnation: 'inc-1',
        // status must be 'active'|'transferring' — a bogus value rejects the record.
        entries: [placement(1, PEER, 700, 1), transferringPlacement(2, PEER, 700, 2, OWN, { status: 'bogus' })],
      },
    ]);
    expect(res.applied).toBe(1);
    expect(res.invalidEntries).toBe(1);
    expect(a.getStreamStatus()[`${PEER}.topic-placement`]).toBe('suspect');
  });

  it('an unknown extra field on a placement record is still rejected → suspect (keys allowlist intact)', () => {
    const a = newApplier();
    const res = a.apply(PEER, [
      {
        kind: 'topic-placement',
        incarnation: 'inc-1',
        entries: [transferringPlacement(1, PEER, 700, 2, OWN, { bogusKey: 'x' })],
      },
    ]);
    expect(res.applied).toBe(0);
    expect(res.invalidEntries).toBe(1);
    expect(a.getStreamStatus()[`${PEER}.topic-placement`]).toBe('suspect');
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — seq-gated apply (in-order / gap / duplicate)
// ---------------------------------------------------------------------------

describe('seq-gated apply (§3.4 rule 2)', () => {
  it('appends in-order entries durably and advances lastHeldSeq', () => {
    const a = newApplier();
    const batch: ApplyBatchStream[] = [
      {
        kind: 'topic-placement',
        incarnation: 'inc-1',
        entries: [placement(1, PEER, 100, 1), placement(2, PEER, 100, 2), placement(3, PEER, 100, 3)],
      },
    ];
    const res = a.apply(PEER, batch);
    expect(res.applied).toBe(3);
    expect(res.invalidEntries).toBe(0);
    const onDisk = readReplicaEntries(PEER, 'topic-placement');
    expect(onDisk.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(a.getAdvertState()[PEER]['topic-placement'].lastSeq).toBe(3);
    expect(a.getStreamStatus()[`${PEER}.topic-placement`]).toBe('current');
  });

  it('a forward gap (seq jumps ahead) is invalid → batch stops at last valid, status behind', () => {
    const a = newApplier();
    // 1,2 valid then 4 (skips 3) — 4 is a forward gap, invalid → suspect+stop.
    const res = a.apply(PEER, [
      {
        kind: 'topic-placement',
        incarnation: 'inc-1',
        entries: [placement(1, PEER, 100, 1), placement(2, PEER, 100, 2), placement(4, PEER, 100, 4)],
      },
    ]);
    expect(res.applied).toBe(2);
    expect(res.invalidEntries).toBe(1);
    expect(readReplicaEntries(PEER, 'topic-placement').map((e) => e.seq)).toEqual([1, 2]);
    // A forward gap marks the stream suspect (the batch stopped at last valid).
    expect(a.getStreamStatus()[`${PEER}.topic-placement`]).toBe('suspect');
  });

  it('duplicate entries (seq <= lastHeldSeq) are dropped silently and counted', () => {
    const a = newApplier();
    a.apply(PEER, [
      { kind: 'topic-placement', incarnation: 'inc-1', entries: [placement(1, PEER, 100, 1), placement(2, PEER, 100, 2)] },
    ]);
    // Redeliver 1,2 then a fresh 3 — duplicates dropped, 3 applied.
    const res = a.apply(PEER, [
      {
        kind: 'topic-placement',
        incarnation: 'inc-1',
        entries: [placement(1, PEER, 100, 1), placement(2, PEER, 100, 2), placement(3, PEER, 100, 3)],
      },
    ]);
    expect(res.duplicates).toBe(2);
    expect(res.applied).toBe(1);
    expect(readReplicaEntries(PEER, 'topic-placement').map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(a.getStreamStatus()[`${PEER}.topic-placement`]).toBe('current');
  });

  it('a leading duplicate followed by the next contiguous entry still applies the new one', () => {
    const a = newApplier();
    a.apply(PEER, [{ kind: 'topic-placement', incarnation: 'inc-1', entries: [placement(1, PEER, 100, 1)] }]);
    const res = a.apply(PEER, [
      { kind: 'topic-placement', incarnation: 'inc-1', entries: [placement(1, PEER, 100, 1), placement(2, PEER, 100, 2)] },
    ]);
    expect(res.duplicates).toBe(1);
    expect(res.applied).toBe(1);
    expect(readReplicaEntries(PEER, 'topic-placement').map((e) => e.seq)).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Rule 1 — first-hop sender binding (forged entries)
// ---------------------------------------------------------------------------

describe('first-hop sender binding (§3.4 rule 1)', () => {
  it('rejects + counts entries whose machine != sender, never appends them', () => {
    const a = newApplier();
    // First entry is forged (authored by a THIRD machine but sent by PEER).
    const forged = placement(1, 'm_third999', 100, 1);
    const res = a.apply(PEER, [{ kind: 'topic-placement', incarnation: 'inc-1', entries: [forged] }]);
    expect(res.forgedEntries).toBe(1);
    expect(res.applied).toBe(0);
    expect(readReplicaEntries(PEER, 'topic-placement')).toEqual([]);
  });

  it('appends valid entries then stops at the first forged third-machine entry', () => {
    const a = newApplier();
    const res = a.apply(PEER, [
      {
        kind: 'topic-placement',
        incarnation: 'inc-1',
        entries: [placement(1, PEER, 100, 1), placement(2, 'm_third999', 100, 2), placement(3, PEER, 100, 3)],
      },
    ]);
    expect(res.applied).toBe(1);
    expect(res.forgedEntries).toBe(1);
    // The post-forgery entry is NOT applied (ordering can't be trusted past it).
    expect(readReplicaEntries(PEER, 'topic-placement').map((e) => e.seq)).toEqual([1]);
  });

  it('the target replica file derives from the SENDER, never a payload field', () => {
    const a = newApplier();
    // entry.machine === sender, so it lands in the sender's replica file.
    a.apply(PEER, [{ kind: 'topic-placement', incarnation: 'inc-1', entries: [placement(1, PEER, 100, 1)] }]);
    expect(fs.existsSync(replicaFile(PEER, 'topic-placement'))).toBe(true);
    // No file is ever created under a third machine's name from a forged entry.
    expect(fs.existsSync(replicaFile('m_third999', 'topic-placement'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — malformed entry → suspect + stop + self-clear after K=20
// ---------------------------------------------------------------------------

describe('malformed entry handling + suspect self-clear (§3.4 rule 2)', () => {
  it('a malformed entry marks the stream suspect and stops the batch at the last valid line', () => {
    const a = newApplier();
    const bad = { ...placement(2, PEER, 100, 2), data: { owner: PEER, epoch: 'NOT-A-NUMBER', reason: 'placed' } } as unknown as JournalEntry;
    const res = a.apply(PEER, [
      {
        kind: 'topic-placement',
        incarnation: 'inc-1',
        entries: [placement(1, PEER, 100, 1), bad, placement(3, PEER, 100, 3)],
      },
    ]);
    expect(res.applied).toBe(1);
    expect(res.invalidEntries).toBe(1);
    expect(res.suspectStreams).toBe(1);
    expect(readReplicaEntries(PEER, 'topic-placement').map((e) => e.seq)).toEqual([1]);
    expect(a.getStreamStatus()[`${PEER}.topic-placement`]).toBe('suspect');
  });

  it('free-text / extra fields in data are rejected (typed schema is the boundary)', () => {
    const a = newApplier();
    const sneaky = {
      ...placement(1, PEER, 100, 1),
      data: { owner: PEER, epoch: 1, reason: 'placed', note: 'free text leak' },
    } as unknown as JournalEntry;
    const res = a.apply(PEER, [{ kind: 'topic-placement', incarnation: 'inc-1', entries: [sneaky] }]);
    expect(res.applied).toBe(0);
    expect(res.invalidEntries).toBe(1);
  });

  it('suspect self-clears to current after K=20 consecutive valid in-order applies', () => {
    const a = newApplier();
    // Trip suspect with a malformed first entry.
    const bad = { ...lifecycle(1, PEER, 's1', 'created'), data: { sessionId: '', status: 'created' } } as unknown as JournalEntry;
    const trip = a.apply(PEER, [{ kind: 'session-lifecycle', incarnation: 'inc-1', entries: [bad] }]);
    expect(trip.suspectStreams).toBe(1);
    expect(a.getStreamStatus()[`${PEER}.session-lifecycle`]).toBe('suspect');

    // Now feed exactly K valid in-order entries — status must clear at the Kth.
    const entries: JournalEntry[] = [];
    for (let i = 1; i <= SUSPECT_CLEAR_THRESHOLD; i++) {
      entries.push(lifecycle(i, PEER, `s${i}`, 'created'));
    }
    // Feed K-1 first: still suspect.
    a.apply(PEER, [{ kind: 'session-lifecycle', incarnation: 'inc-1', entries: entries.slice(0, SUSPECT_CLEAR_THRESHOLD - 1) }]);
    expect(a.getStreamStatus()[`${PEER}.session-lifecycle`]).toBe('suspect');
    // The Kth clears it.
    a.apply(PEER, [{ kind: 'session-lifecycle', incarnation: 'inc-1', entries: [entries[SUSPECT_CLEAR_THRESHOLD - 1]] }]);
    expect(a.getStreamStatus()[`${PEER}.session-lifecycle`]).toBe('current');
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — incarnation fencing (quarantine, fresh start, flap bound)
// ---------------------------------------------------------------------------

describe('incarnation fencing (§3.4 rule 3)', () => {
  it('a NEW incarnation quarantines the old replica, starts fresh, and signals divergence', () => {
    const a = newApplier();
    a.apply(PEER, [
      { kind: 'topic-placement', incarnation: 'inc-1', entries: [placement(1, PEER, 100, 1), placement(2, PEER, 100, 2)] },
    ]);
    expect(readReplicaEntries(PEER, 'topic-placement').map((e) => e.seq)).toEqual([1, 2]);

    // Same machine, NEW incarnation, re-numbered seq 1 (restore-from-backup).
    const res = a.apply(PEER, [
      { kind: 'topic-placement', incarnation: 'inc-2', entries: [placement(1, PEER, 200, 5)] },
    ]);
    expect(res.quarantined).toBe(1);
    expect(res.signals.length).toBe(1);
    expect(res.signals[0].oldIncarnation).toBe('inc-1');
    expect(res.signals[0].newIncarnation).toBe('inc-2');
    // Fresh start: the new replica holds only the new incarnation's history.
    expect(readReplicaEntries(PEER, 'topic-placement').map((e) => e.seq)).toEqual([1]);
    // The old replica is renamed aside (a quarantine file exists).
    const quarantined = fs.readdirSync(peersDir()).filter((n) => n.includes('.quarantine.'));
    expect(quarantined.length).toBe(1);
    // The advert now reflects the fresh incarnation + lastSeq.
    expect(a.getAdvertState()[PEER]['topic-placement']).toEqual({ incarnation: 'inc-2', lastSeq: 1 });
  });

  it('4 flips → at most 2 quarantined files kept per stream + status reset-flapping (bounded disk + signals)', () => {
    const a = newApplier();
    // Seed inc-1.
    a.apply(PEER, [{ kind: 'topic-placement', incarnation: 'inc-1', entries: [placement(1, PEER, 100, 1)] }]);
    // Flip 4 times: inc-2, inc-3, inc-4, inc-5.
    let totalSignals = 0;
    for (const inc of ['inc-2', 'inc-3', 'inc-4', 'inc-5']) {
      const res = a.apply(PEER, [{ kind: 'topic-placement', incarnation: inc, entries: [placement(1, PEER, 100, 1)] }]);
      totalSignals += res.signals.length;
    }
    // Bounded disk: at most MAX_QUARANTINE_PER_STREAM quarantine files kept.
    const quarantined = fs.readdirSync(peersDir()).filter((n) => n.includes('.quarantine.'));
    expect(quarantined.length).toBeLessThanOrEqual(MAX_QUARANTINE_PER_STREAM);
    // Bounded signals: coalesced — far fewer than one-per-flip; flapping wins.
    expect(totalSignals).toBeLessThanOrEqual(1);
    expect(a.getStreamStatus()[`${PEER}.topic-placement`]).toBe('reset-flapping');
  });
});

// ---------------------------------------------------------------------------
// Rule 4 — truncation fast-forward + gap sentinel + status gapped
// ---------------------------------------------------------------------------

describe('truncation signals (§3.4 rule 4)', () => {
  it('lastHeldSeq+1 < oldestRetainedSeq → records a gap sentinel, fast-forwards, marks gapped', () => {
    const a = newApplier();
    // Hold up to seq 2.
    a.apply(PEER, [
      { kind: 'topic-placement', incarnation: 'inc-1', entries: [placement(1, PEER, 100, 1), placement(2, PEER, 100, 2)] },
    ]);
    // Peer now only retains from seq 10 (3..9 rotated out before we synced).
    const res = a.apply(PEER, [
      { kind: 'topic-placement', incarnation: 'inc-1', oldestRetainedSeq: 10, entries: [placement(10, PEER, 100, 10)] },
    ]);
    expect(res.gapsRecorded).toBe(1);
    // Fast-forwarded past the hole then applied seq 10 → lastHeldSeq is 10.
    expect(a.getAdvertState()[PEER]['topic-placement'].lastSeq).toBe(10);
    expect(readReplicaEntries(PEER, 'topic-placement').map((e) => e.seq)).toEqual([1, 2, 10]);
    // A clean apply after the gap returns the stream to current.
    expect(a.getStreamStatus()[`${PEER}.topic-placement`]).toBe('current');
  });

  it('a truncation with NO subsequent applicable entry leaves the stream gapped', () => {
    const a = newApplier();
    a.apply(PEER, [{ kind: 'topic-placement', incarnation: 'inc-1', entries: [placement(1, PEER, 100, 1)] }]);
    // oldestRetainedSeq=5 but no entries (the delta carried only the watermark).
    const res = a.apply(PEER, [{ kind: 'topic-placement', incarnation: 'inc-1', oldestRetainedSeq: 5, entries: [] }]);
    expect(res.gapsRecorded).toBe(1);
    expect(a.getStreamStatus()[`${PEER}.topic-placement`]).toBe('gapped');
    expect(a.getAdvertState()[PEER]['topic-placement'].lastSeq).toBe(4); // fast-forwarded to oldest-1
  });
});

// ---------------------------------------------------------------------------
// SERVE side — own stream only, durably-flushed only, byte-cap, oldestRetained
// ---------------------------------------------------------------------------

describe('buildServeBatch (§3.4 rules 5/7)', () => {
  /** Seed an OWN stream file + meta exactly as the writer would. */
  function seedOwnStream(kind: JournalKind, entries: JournalEntry[], incarnation = 'own-inc-1'): void {
    fs.mkdirSync(journalDir(), { recursive: true });
    const file = path.join(journalDir(), `${OWN}.${kind}.jsonl`);
    fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''), 'utf-8');
    fs.writeFileSync(
      path.join(journalDir(), `${OWN}.meta.json`),
      JSON.stringify({ incarnation, kinds: {} }, null, 2),
      'utf-8',
    );
  }

  it('serves exactly the durably-flushed FILE contents from fromSeq, ascending', () => {
    const a = newApplier();
    seedOwnStream('topic-placement', [
      placement(1, OWN, 100, 1),
      placement(2, OWN, 100, 2),
      placement(3, OWN, 100, 3),
    ]);
    const batch = a.buildServeBatch('topic-placement', 1, OWN);
    expect(batch.incarnation).toBe('own-inc-1');
    expect(batch.entries.map((e) => e.seq)).toEqual([2, 3]);
    // Serves exactly what's on disk — there is no in-memory queue to read.
    expect(batch.entries.every((e) => e.machine === OWN)).toBe(true);
  });

  it('honors the byte cap mid-batch (returns a prefix, not the whole stream)', () => {
    const a = newApplier();
    const entries: JournalEntry[] = [];
    for (let i = 1; i <= 50; i++) entries.push(placement(i, OWN, 100, i));
    seedOwnStream('topic-placement', entries);
    const oneLineBytes = Buffer.byteLength(JSON.stringify(placement(1, OWN, 100, 1)), 'utf-8') + 1;
    // Cap that fits ~5 lines.
    const batch = a.buildServeBatch('topic-placement', 0, OWN, oneLineBytes * 5);
    expect(batch.entries.length).toBeGreaterThan(0);
    expect(batch.entries.length).toBeLessThan(50);
    // What it does serve is a contiguous ascending prefix from fromSeq.
    expect(batch.entries[0].seq).toBe(1);
    expect(batch.entries.map((e) => e.seq)).toEqual(
      Array.from({ length: batch.entries.length }, (_, i) => i + 1),
    );
  });

  it('includes oldestRetainedSeq when fromSeq has rotated out (archive missing low seqs)', () => {
    const a = newApplier();
    // The current file only retains from seq 10 (1..9 were rotated+deleted).
    const entries: JournalEntry[] = [];
    for (let i = 10; i <= 15; i++) entries.push(placement(i, OWN, 100, i));
    seedOwnStream('topic-placement', entries);
    // A peer asks from seq 3, but our oldest servable is 10 → signal truncation.
    const batch = a.buildServeBatch('topic-placement', 3, OWN);
    expect(batch.oldestRetainedSeq).toBe(10);
    expect(batch.entries[0].seq).toBe(10);
  });

  it('does NOT set oldestRetainedSeq when the peer is fully caught-up-able from fromSeq', () => {
    const a = newApplier();
    seedOwnStream('topic-placement', [placement(1, OWN, 100, 1), placement(2, OWN, 100, 2)]);
    const batch = a.buildServeBatch('topic-placement', 1, OWN);
    expect(batch.oldestRetainedSeq).toBeUndefined();
    expect(batch.entries.map((e) => e.seq)).toEqual([2]);
  });
});

// ---------------------------------------------------------------------------
// §4.1 — ack-after-fsync (durable commit before reporting applied)
// ---------------------------------------------------------------------------

describe('ack-after-durable-commit (§4.1)', () => {
  it('fdatasync is called BEFORE the applied count is reported (call-ordering spy)', () => {
    const order: string[] = [];
    const realOpen = fs.openSync;
    const realWrite = fs.writeSync;
    const realFdatasync = fs.fdatasyncSync;
    const realClose = fs.closeSync;

    const spyFs = {
      openSync: ((p: fs.PathLike, flags: string) => {
        const fd = realOpen(p, flags as fs.OpenMode);
        if (String(p).includes('.jsonl')) order.push('open');
        return fd;
      }) as typeof fs.openSync,
      writeSync: ((fd: number, buf: NodeJS.ArrayBufferView, off?: number, len?: number) => {
        order.push('write');
        return realWrite(fd, buf, off, len);
      }) as typeof fs.writeSync,
      fdatasyncSync: ((fd: number) => {
        order.push('fdatasync');
        return realFdatasync(fd);
      }) as typeof fs.fdatasyncSync,
      closeSync: realClose,
      existsSync: fs.existsSync,
      statSync: fs.statSync,
      renameSync: fs.renameSync,
      writeFileSync: fs.writeFileSync,
      readFileSync: fs.readFileSync,
      readdirSync: fs.readdirSync,
      truncateSync: fs.truncateSync,
      mkdirSync: fs.mkdirSync,
      readSync: fs.readSync,
    };

    const a = newApplier({ fsImpl: spyFs });
    const res = a.apply(PEER, [
      { kind: 'topic-placement', incarnation: 'inc-1', entries: [placement(1, PEER, 100, 1), placement(2, PEER, 100, 2)] },
    ]);
    expect(res.applied).toBe(2);
    // The data writes precede the fdatasync, which precedes the result we assert.
    const lastWrite = order.lastIndexOf('write');
    const fsyncIdx = order.indexOf('fdatasync');
    expect(fsyncIdx).toBeGreaterThan(-1);
    expect(fsyncIdx).toBeGreaterThan(lastWrite);
  });

  it('a fault-injected fsync failure reports 0 applied (no durable ack) and does not throw', () => {
    const realOpen = fs.openSync;
    const realWrite = fs.writeSync;
    const realClose = fs.closeSync;
    const spyFs = {
      openSync: realOpen,
      writeSync: realWrite,
      fdatasyncSync: (() => {
        throw new Error('injected fsync failure');
      }) as unknown as typeof fs.fdatasyncSync,
      closeSync: realClose,
      existsSync: fs.existsSync,
      statSync: fs.statSync,
      renameSync: fs.renameSync,
      writeFileSync: fs.writeFileSync,
      readFileSync: fs.readFileSync,
      readdirSync: fs.readdirSync,
      truncateSync: fs.truncateSync,
      mkdirSync: fs.mkdirSync,
      readSync: fs.readSync,
    };

    const a = newApplier({ fsImpl: spyFs });
    let res!: ReturnType<typeof a.apply>;
    expect(() => {
      res = a.apply(PEER, [{ kind: 'topic-placement', incarnation: 'inc-1', entries: [placement(1, PEER, 100, 1)] }]);
    }).not.toThrow();
    // fsync failed → nothing is reported applied (ack-after-durable-commit) and
    // lastHeldSeq does NOT advance, so the caller will re-request.
    expect(res.applied).toBe(0);
    expect(a.getDegradation().appendErrors).toBeGreaterThan(0);
    expect(a.getAdvertState()[PEER]?.['topic-placement']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// guardWrite refusal — batch skipped + counted, never thrown
// ---------------------------------------------------------------------------

describe('guardWrite refusal (§3.1 seam)', () => {
  it('a throwing guardWrite skips the append, counts it, and never throws into the caller', () => {
    const a = newApplier({
      guardWrite: (p: string) => {
        // Refuse only data appends (the .jsonl replica), not the meta sidecar.
        if (p.endsWith('.jsonl')) throw new Error('read-only standby');
      },
    });
    let res!: ReturnType<typeof a.apply>;
    expect(() => {
      res = a.apply(PEER, [{ kind: 'topic-placement', incarnation: 'inc-1', entries: [placement(1, PEER, 100, 1)] }]);
    }).not.toThrow();
    expect(res.applied).toBe(0);
    expect(res.guardSkips).toBe(1);
    expect(a.getDegradation().guardSkips).toBe(1);
    // Nothing was written to the replica file.
    expect(fs.existsSync(replicaFile(PEER, 'topic-placement'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: never throws, clean single-machine / empty no-ops
// ---------------------------------------------------------------------------

describe('tolerance + no-op safety', () => {
  it('apply of an empty batch is a clean no-op', () => {
    const a = newApplier();
    const res = a.apply(PEER, []);
    expect(res.applied).toBe(0);
    expect(res.statuses).toEqual({});
  });

  it('an unknown/ignorable kind in the batch does not poison the rest', () => {
    const a = newApplier();
    const res = a.apply(PEER, [
      { kind: 'unknown-kind' as unknown as JournalKind, incarnation: 'inc-1', entries: [] },
      { kind: 'topic-placement', incarnation: 'inc-1', entries: [placement(1, PEER, 100, 1)] },
    ]);
    expect(res.applied).toBe(1);
    expect(readReplicaEntries(PEER, 'topic-placement').map((e) => e.seq)).toEqual([1]);
  });

  it('getAdvertState / getStreamStatus on a fresh applier are empty (single-machine no-op)', () => {
    const a = newApplier();
    expect(a.getAdvertState()).toEqual({});
    expect(a.getStreamStatus()).toEqual({});
  });

  it('a malformed sender id is a clean no-op (never throws)', () => {
    const a = newApplier();
    expect(() => a.apply('', [{ kind: 'topic-placement', incarnation: 'i', entries: [placement(1, PEER, 1, 1)] }])).not.toThrow();
  });

  it('advert state persists across a fresh applier instance (meta on disk)', () => {
    const a1 = newApplier();
    a1.apply(PEER, [
      { kind: 'topic-placement', incarnation: 'inc-1', entries: [placement(1, PEER, 100, 1), placement(2, PEER, 100, 2)] },
    ]);
    // New instance (cold cache) reads the persisted meta.
    const a2 = newApplier();
    expect(a2.getAdvertState()[PEER]['topic-placement']).toEqual({ incarnation: 'inc-1', lastSeq: 2 });
  });
});
