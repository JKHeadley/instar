// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
// safe-fs-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Tier-1 unit tests for CoherenceJournalReader (P1.2) — the §3.5 read API.
 *
 * Spec: docs/specs/COHERENCE-JOURNAL-SPEC.md §3.5 (Read API), §3.1 (stream
 * layout). Tests seed real JSONL stream files directly on disk (not via the
 * writer) so the reader is exercised in isolation against the on-disk contract.
 *
 * Covers: merged ordering incl. epoch-order for placement + ts tiebreak; cursor
 * round-trip (page 2 continues exactly, no skip/dup at equal-ts boundaries);
 * (topic,epoch) collapse; traversal-shaped param matches nothing; corrupt line
 * skipped + counted; limit cap; byte-ceiling truncation honesty; placement
 * answer-complete across multiple archives while another kind respects the
 * archive cap; peers/ entries tagged replica.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CoherenceJournalReader,
  InvalidCursorError,
  type ReaderEntry,
} from '../../src/core/CoherenceJournalReader.js';
import type { JournalEntry, JournalKind } from '../../src/core/CoherenceJournal.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coherence-journal-reader-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function journalDir(): string {
  return path.join(tmpDir, 'state', 'coherence-journal');
}
function peersDir(): string {
  return path.join(journalDir(), 'peers');
}

/** Write a stream file (current or archive) with the given entries as JSONL. */
function writeStream(
  scope: 'own' | 'peers',
  machine: string,
  kind: JournalKind,
  entries: JournalEntry[],
  archiveStamp?: number,
): string {
  const dir = scope === 'own' ? journalDir() : peersDir();
  fs.mkdirSync(dir, { recursive: true });
  const suffix = archiveStamp !== undefined ? `.${archiveStamp}` : '';
  const file = path.join(dir, `${machine}.${kind}${suffix}.jsonl`);
  const body = entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
  fs.writeFileSync(file, body, 'utf-8');
  return file;
}

/** Append a raw line (e.g. a corrupt one) to an existing file. */
function appendRaw(file: string, raw: string): void {
  fs.appendFileSync(file, raw + '\n', 'utf-8');
}

function placement(seq: number, topic: number, epoch: number, ts: string, machine = 'm1'): JournalEntry {
  return { seq, ts, machine, kind: 'topic-placement', topic, data: { owner: machine, epoch, reason: 'placed' } };
}
function lifecycle(seq: number, sessionId: string, status: string, ts: string, machine = 'm1', topic?: number): JournalEntry {
  return {
    seq,
    ts,
    machine,
    kind: 'session-lifecycle',
    ...(topic !== undefined ? { topic } : {}),
    data: { sessionId, status },
  };
}

function reader(opts: { byteCeiling?: number; archiveCap?: number; now?: () => Date } = {}): CoherenceJournalReader {
  return new CoherenceJournalReader({ stateDir: tmpDir, ...opts });
}

describe('CoherenceJournalReader (P1.2 §3.5)', () => {
  it('merges topic-placement by (epoch, ts) across machines — newest first', () => {
    // Two machines, interleaved epochs. Epoch order must win over wall-clock.
    writeStream('own', 'm1', 'topic-placement', [
      placement(1, 99, 1, '2026-06-05T10:00:00.000Z', 'm1'),
      placement(2, 99, 3, '2026-06-05T10:00:02.000Z', 'm1'),
    ]);
    writeStream('peers', 'm2', 'topic-placement', [
      // epoch 2 happened on m2 but with a SKEWED earlier ts than m1's epoch 1.
      placement(1, 99, 2, '2026-06-05T09:59:59.000Z', 'm2'),
    ]);
    const res = reader().query({ topic: 99, kind: 'topic-placement' });
    const epochs = res.entries.map((e) => (e.data as { epoch: number }).epoch);
    // Newest-first by epoch: 3, 2, 1.
    expect(epochs).toEqual([3, 2, 1]);
  });

  it('orders non-placement kinds by (ts, machineId, seq) with explicit tiebreak', () => {
    const ts = '2026-06-05T12:00:00.000Z'; // identical ts → machineId then seq tiebreak
    writeStream('own', 'm1', 'session-lifecycle', [
      lifecycle(5, 's-b', 'created', ts, 'm1'),
      lifecycle(6, 's-a', 'created', ts, 'm1'),
    ]);
    writeStream('peers', 'm0', 'session-lifecycle', [lifecycle(9, 's-z', 'created', ts, 'm0')]);
    const res = reader().query({ kind: 'session-lifecycle' });
    // ascending key = (ts, machineId, seq): m0/9, m1/5, m1/6 → newest-first reverses.
    expect(res.entries.map((e) => `${e.machine}:${e.seq}`)).toEqual(['m1:6', 'm1:5', 'm0:9']);
  });

  it('cursor round-trips: page 2 continues exactly with no skip/dup at equal-ts boundaries', () => {
    const ts = '2026-06-05T08:00:00.000Z'; // ALL equal ts → composite key disambiguates
    const entries: JournalEntry[] = [];
    for (let seq = 1; seq <= 6; seq++) entries.push(lifecycle(seq, `s${seq}`, 'created', ts, 'm1'));
    writeStream('own', 'm1', 'session-lifecycle', entries);

    const r = reader();
    const page1 = r.query({ kind: 'session-lifecycle', limit: 3 });
    expect(page1.entries.map((e) => e.seq)).toEqual([6, 5, 4]); // newest-first
    const last = page1.entries[page1.entries.length - 1];
    const cursor = r.cursorFor(last as ReaderEntry, false);

    const page2 = r.query({ kind: 'session-lifecycle', limit: 3, cursor });
    expect(page2.entries.map((e) => e.seq)).toEqual([3, 2, 1]); // exact continuation
    // No overlap, no gap.
    const all = [...page1.entries, ...page2.entries].map((e) => e.seq);
    expect(new Set(all).size).toBe(6);
    expect(all).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it('placement cursor round-trips on the (epoch, ts) key', () => {
    const entries: JournalEntry[] = [];
    for (let e = 1; e <= 5; e++) {
      entries.push(placement(e, 42, e, `2026-06-05T0${e}:00:00.000Z`, 'm1'));
    }
    writeStream('own', 'm1', 'topic-placement', entries);
    const r = reader();
    const p1 = r.query({ topic: 42, kind: 'topic-placement', limit: 2 });
    expect(p1.entries.map((x) => (x.data as { epoch: number }).epoch)).toEqual([5, 4]);
    const cursor = r.cursorFor(p1.entries[p1.entries.length - 1] as ReaderEntry, true);
    const p2 = r.query({ topic: 42, kind: 'topic-placement', limit: 2, cursor });
    expect(p2.entries.map((x) => (x.data as { epoch: number }).epoch)).toEqual([3, 2]);
  });

  it('collapses topic-placement entries sharing (topic, epoch) to first-seen', () => {
    // A dedupe-miss simulated: own + replica both carry topic 7 epoch 4.
    writeStream('own', 'm1', 'topic-placement', [placement(1, 7, 4, '2026-06-05T10:00:00.000Z', 'm1')]);
    writeStream('peers', 'm2', 'topic-placement', [placement(1, 7, 4, '2026-06-05T10:00:01.000Z', 'm2')]);
    const res = reader().query({ topic: 7, kind: 'topic-placement' });
    expect(res.entries).toHaveLength(1);
  });

  it('a traversal-shaped machine/kind param matches nothing (never builds a path)', () => {
    writeStream('own', 'm1', 'topic-placement', [placement(1, 1, 1, '2026-06-05T10:00:00.000Z', 'm1')]);
    const res = reader().query({ machine: '../../etc/passwd', kind: 'topic-placement' });
    expect(res.entries).toHaveLength(0);
    // And a traversal-shaped kind matches no enumerated stream either.
    const res2 = reader().query({ kind: '../secrets' });
    expect(res2.entries).toHaveLength(0);
    expect(Object.keys(res2.streams)).toHaveLength(0);
  });

  it('skips and counts corrupt interior lines', () => {
    const file = writeStream('own', 'm1', 'session-lifecycle', [
      lifecycle(1, 's1', 'created', '2026-06-05T10:00:00.000Z', 'm1'),
    ]);
    appendRaw(file, '{ this is not valid json');
    appendRaw(file, JSON.stringify(lifecycle(2, 's2', 'completed', '2026-06-05T10:00:01.000Z', 'm1')));
    const res = reader().query({ kind: 'session-lifecycle' });
    expect(res.entries.map((e) => e.seq).sort()).toEqual([1, 2]);
    expect(res.skippedCorrupt).toBe(1);
  });

  it('caps limit at 500', () => {
    const entries: JournalEntry[] = [];
    for (let i = 1; i <= 600; i++) entries.push(lifecycle(i, `s${i}`, 'created', `2026-06-05T10:00:00.${String(i).padStart(3, '0')}Z`, 'm1'));
    writeStream('own', 'm1', 'session-lifecycle', entries);
    const res = reader().query({ kind: 'session-lifecycle', limit: 9999 });
    expect(res.entries.length).toBe(500);
  });

  it('honours the byte ceiling and reports truncated:true', () => {
    // Many entries; a tiny byte ceiling forces a partial reverse-tail read.
    const entries: JournalEntry[] = [];
    for (let i = 1; i <= 200; i++) entries.push(lifecycle(i, `session-id-${i}`, 'created', `2026-06-05T10:00:00.${String(i).padStart(3, '0')}Z`, 'm1'));
    writeStream('own', 'm1', 'session-lifecycle', entries);
    const res = reader({ byteCeiling: 512 }).query({ kind: 'session-lifecycle', limit: 500 });
    expect(res.truncated).toBe(true);
    expect(res.entries.length).toBeLessThan(200);
    // What we DID return is the newest tail (highest seqs).
    expect(res.entries[0].seq).toBe(200);
  });

  it('placement is answer-complete across multiple archives; another kind respects the archive cap', () => {
    // topic-placement: current + 3 archives, all tiny, all for topic 5.
    // archiveCap is 1, but placement must scan ALL archives newest-first.
    writeStream('own', 'm1', 'topic-placement', [placement(7, 5, 7, '2026-06-05T10:00:07.000Z', 'm1')]);
    writeStream('own', 'm1', 'topic-placement', [placement(1, 5, 1, '2026-06-05T10:00:01.000Z', 'm1')], 1000);
    writeStream('own', 'm1', 'topic-placement', [placement(3, 5, 3, '2026-06-05T10:00:03.000Z', 'm1')], 2000);
    writeStream('own', 'm1', 'topic-placement', [placement(5, 5, 5, '2026-06-05T10:00:05.000Z', 'm1')], 3000);

    const res = reader({ archiveCap: 1 }).query({ topic: 5, kind: 'topic-placement', limit: 100 });
    // All four epochs reachable despite archiveCap=1 (answer-complete exemption).
    expect(res.entries.map((e) => (e.data as { epoch: number }).epoch)).toEqual([7, 5, 3, 1]);

    // session-lifecycle: current + 3 archives. archiveCap=1 must STOP early →
    // truncated:true and NOT every archive is read.
    writeStream('own', 'm1', 'session-lifecycle', [lifecycle(40, 's-cur', 'created', '2026-06-05T11:00:40.000Z', 'm1')]);
    writeStream('own', 'm1', 'session-lifecycle', [lifecycle(10, 's-a1', 'created', '2026-06-05T11:00:10.000Z', 'm1')], 1000);
    writeStream('own', 'm1', 'session-lifecycle', [lifecycle(20, 's-a2', 'created', '2026-06-05T11:00:20.000Z', 'm1')], 2000);
    writeStream('own', 'm1', 'session-lifecycle', [lifecycle(30, 's-a3', 'created', '2026-06-05T11:00:30.000Z', 'm1')], 3000);

    const lc = reader({ archiveCap: 1 }).query({ kind: 'session-lifecycle', limit: 100 });
    expect(lc.truncated).toBe(true);
    // Current + exactly one archive (newest, stamp 3000 → seq 30) read; older skipped.
    const seqs = lc.entries.map((e) => e.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([30, 40]);
  });

  it('tags peer entries source=replica with a recvTs; own entries source=own', () => {
    writeStream('own', 'm1', 'topic-placement', [placement(1, 3, 1, '2026-06-05T10:00:00.000Z', 'm1')]);
    writeStream('peers', 'm2', 'topic-placement', [placement(1, 3, 2, '2026-06-05T10:00:01.000Z', 'm2')]);
    const res = reader().query({ topic: 3, kind: 'topic-placement' });
    const own = res.entries.find((e) => e.machine === 'm1');
    const replica = res.entries.find((e) => e.machine === 'm2');
    expect(own?.source).toBe('own');
    expect(own?.recvTs).toBeUndefined();
    expect(replica?.source).toBe('replica');
    expect(typeof replica?.recvTs).toBe('string');
  });

  it('streams map reports per-stream status current + lastSeq/lastTs + stalenessMs', () => {
    const now = new Date('2026-06-05T10:00:10.000Z');
    writeStream('own', 'm1', 'topic-placement', [
      placement(1, 1, 1, '2026-06-05T10:00:00.000Z', 'm1'),
      placement(2, 1, 2, '2026-06-05T10:00:05.000Z', 'm1'),
    ]);
    writeStream('peers', 'm2', 'session-lifecycle', [lifecycle(9, 's', 'created', '2026-06-05T10:00:00.000Z', 'm2')]);
    const res = reader({ now: () => now }).query({});
    const own = res.streams['m1.topic-placement'];
    expect(own).toMatchObject({ source: 'own', status: 'current', lastSeq: 2 });
    expect(own.lastTs).toBe('2026-06-05T10:00:05.000Z');
    expect(own.stalenessMs).toBe(5000);
    const peer = res.streams['m2.session-lifecycle'];
    expect(peer).toMatchObject({ source: 'replica', status: 'current', lastSeq: 9 });
  });

  it('reads incarnation from a stream set meta sidecar when present', () => {
    writeStream('own', 'm1', 'topic-placement', [placement(1, 1, 1, '2026-06-05T10:00:00.000Z', 'm1')]);
    fs.writeFileSync(
      path.join(journalDir(), 'm1.meta.json'),
      JSON.stringify({ incarnation: 'abc123', kinds: {} }),
      'utf-8',
    );
    const res = reader().query({});
    expect(res.streams['m1.topic-placement'].incarnation).toBe('abc123');
  });

  it('rejects a malformed cursor with InvalidCursorError, never a crash', () => {
    writeStream('own', 'm1', 'session-lifecycle', [lifecycle(1, 's', 'created', '2026-06-05T10:00:00.000Z', 'm1')]);
    expect(() => reader().query({ kind: 'session-lifecycle', cursor: 'not-base64-$$$' })).toThrow(InvalidCursorError);
    // A cursor without the placement epoch key, used on a placement query, is a key mismatch.
    const nonPlacementCursor = Buffer.from(JSON.stringify({ ts: 'x', machineId: 'm1', seq: 1 }), 'utf-8').toString('base64url');
    expect(() => reader().query({ kind: 'topic-placement', cursor: nonPlacementCursor })).toThrow(InvalidCursorError);
  });

  it('returns an empty merged view when no streams exist', () => {
    const res = reader().query({});
    expect(res.entries).toHaveLength(0);
    expect(Object.keys(res.streams)).toHaveLength(0);
    expect(res.skippedCorrupt).toBe(0);
    expect(res.truncated).toBe(false);
  });
});
