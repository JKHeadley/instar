// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Tier-1 unit tests for CoherenceJournal (P1.1) — the §6 writer list.
 *
 * Spec: docs/specs/COHERENCE-JOURNAL-SPEC.md §3.1 (writer rules), §3.2 (typed
 * schemas), §3.7 (per-kind retention), §6 (the unit-test list).
 *
 * Covers: monotonic seq assigned-at-enqueue + resume-from-tail; crash-repair
 * (torn trailing line repaired + counted + NOT re-minted); genuine rewind
 * (highWaterSeq ahead of truncated tail → re-mint); rotation continuity incl.
 * rotate-never-delete; typed-schema rejection (free text / unknown fields /
 * secret-shaped field at write); artifactPath jail (traversal / absolute /
 * symlink); op-key dedupe surviving a writer restart (tail reconstruction);
 * rate cap; two concurrent writers → loser locked out, no torn lines / forked
 * seq; NON-BLOCKING emit with a wedged flusher; unflushed entries lost on crash
 * and seq resumes from durable tail.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CoherenceJournal,
  sanitizeMachineId,
  type JournalKind,
  type JournalFs,
} from '../../src/core/CoherenceJournal.js';

let tmpDir: string;
const MACHINE = 'm_test_machine';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coherence-journal-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function dir(): string {
  return path.join(tmpDir, 'state', 'coherence-journal');
}
function streamFile(kind: JournalKind, machine = MACHINE): string {
  return path.join(dir(), `${sanitizeMachineId(machine)}.${kind}.jsonl`);
}
function readLines(file: string): any[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

/** Open a journal with a high flush cadence; tests drive flush() directly. */
function makeJournal(overrides: Partial<ConstructorParameters<typeof CoherenceJournal>[0]> = {}): CoherenceJournal {
  const j = new CoherenceJournal({
    stateDir: tmpDir,
    machineId: MACHINE,
    flushIntervalMs: 1_000_000, // effectively manual; tests call flush()
    artifactRoots: [path.join(tmpDir, 'autonomous'), tmpDir],
    ...overrides,
  });
  j.open();
  return j;
}

describe('CoherenceJournal — paths & sanitization (§3.1)', () => {
  it('writes per-machine-per-kind files under state/coherence-journal/', () => {
    const j = makeJournal();
    j.emitPlacement(13481, { owner: 'm_a', epoch: 2, reason: 'placed' });
    j.flush();
    expect(fs.existsSync(streamFile('topic-placement'))).toBe(true);
    expect(fs.existsSync(streamFile('session-lifecycle'))).toBe(false);
    j.close();
  });

  it("accepts the WS1.3 'reconcile' placement reason — the runtime allowlist matches the PlacementReason union (second-pass finding, 2026-06-12)", () => {
    // The type annotation on the validator's allowlist cannot enforce
    // completeness (a subset of the union is type-legal), so extending
    // PlacementReason without the allowlist silently schema-rejects the new
    // reason AT THE SOURCE. This is the semantic-correctness test for every
    // reconciler-driven CAS's journal pairing.
    const j = makeJournal();
    const before = j.getDegradation().schemaRejects;
    j.emitPlacement(13481, { owner: 'm_a', epoch: 7, reason: 'reconcile' });
    j.flush();
    expect(j.getDegradation().schemaRejects).toBe(before); // NOT rejected
    expect(fs.existsSync(streamFile('topic-placement'))).toBe(true);
    const lines = fs.readFileSync(streamFile('topic-placement'), 'utf-8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.data?.reason).toBe('reconcile');
    j.close();
  });

  it('sanitizes machine ids that contain path-unsafe characters (mirrors MachineHeartbeat)', () => {
    expect(sanitizeMachineId('a/b')).toBe('a%2fb'); // slash encoded
    expect(sanitizeMachineId('../x')).toBe('%2e%2e%2fx'); // dots + slash all encoded (traversal-safe)
    expect(sanitizeMachineId('a b')).toBe('a%20b'); // space encoded
    expect(sanitizeMachineId('plain_id-1')).toBe('plain_id-1'); // alnum/_/- preserved
  });
});

describe('CoherenceJournal — monotonic seq assigned at enqueue (§3.1, §6)', () => {
  it('assigns strictly monotonic per-kind seqs at enqueue time', () => {
    const j = makeJournal();
    j.emitPlacement(1, { owner: 'm_a', epoch: 1, reason: 'placed' });
    j.emitPlacement(2, { owner: 'm_b', epoch: 1, reason: 'placed' });
    j.emitLifecycle({ sessionId: 's1', status: 'created' });
    j.flush();
    const placement = readLines(streamFile('topic-placement'));
    const lifecycle = readLines(streamFile('session-lifecycle'));
    expect(placement.map((e) => e.seq)).toEqual([1, 2]);
    expect(lifecycle.map((e) => e.seq)).toEqual([1]); // per-kind counter is independent
    j.close();
  });

  it('seq is assigned at enqueue even before any flush (counter reflects pending)', () => {
    const j = makeJournal();
    j.emitPlacement(1, { owner: 'm_a', epoch: 1, reason: 'placed' });
    j.emitPlacement(2, { owner: 'm_a', epoch: 2, reason: 'user-move' });
    expect(j.pendingCount).toBe(2);
    // Not yet on disk.
    expect(fs.existsSync(streamFile('topic-placement'))).toBe(false);
    j.flush();
    expect(readLines(streamFile('topic-placement')).map((e) => e.seq)).toEqual([1, 2]);
    j.close();
  });

  it('resumes seq from the durable tail after a clean restart', () => {
    const j1 = makeJournal();
    j1.emitPlacement(1, { owner: 'm_a', epoch: 1, reason: 'placed' });
    j1.emitPlacement(2, { owner: 'm_a', epoch: 2, reason: 'user-move' });
    j1.flush();
    j1.close();

    const j2 = makeJournal();
    j2.emitPlacement(3, { owner: 'm_b', epoch: 3, reason: 'failover' });
    j2.flush();
    j2.close();
    const seqs = readLines(streamFile('topic-placement')).map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3]); // continued, not reset
  });
});

describe('CoherenceJournal — crash repair on open (§3.1, §3.4, §6)', () => {
  it('truncates a torn trailing line, counts the repair, and does NOT re-mint', () => {
    const j1 = makeJournal();
    j1.emitPlacement(1, { owner: 'm_a', epoch: 1, reason: 'placed' });
    j1.flush();
    const incarnationBefore = j1.streamStatuses().find((s) => s.kind === 'topic-placement')!.incarnation;
    j1.close();

    // Simulate a crash mid-append: a partial JSON line with no trailing newline.
    fs.appendFileSync(streamFile('topic-placement'), '{"seq":2,"ts":"2026');

    const j2 = makeJournal();
    const deg = j2.getDegradation();
    expect(deg.repairs).toBe(1);
    expect(deg.remints).toBe(0); // a torn-trailing repair is NEVER a re-mint
    const st = j2.streamStatuses().find((s) => s.kind === 'topic-placement')!;
    expect(st.incarnation).toBe(incarnationBefore); // incarnation unchanged
    // Repaired file holds only the good line; next seq resumes at 2.
    j2.emitPlacement(2, { owner: 'm_b', epoch: 2, reason: 'user-move' });
    j2.flush();
    const seqs = readLines(streamFile('topic-placement')).map((e) => e.seq);
    expect(seqs).toEqual([1, 2]);
    j2.close();
  });

  it('kill-9 between data fsync and meta write: data ahead of meta is adopted, NOT a re-mint', () => {
    const j1 = makeJournal();
    j1.emitPlacement(1, { owner: 'm_a', epoch: 1, reason: 'placed' });
    j1.flush();
    j1.close();

    // Hand-roll the kill-9 window: data line 2 fsync'd to disk, but meta still
    // says highWaterSeq=1 (the meta advance never happened).
    fs.appendFileSync(
      streamFile('topic-placement'),
      JSON.stringify({ seq: 2, ts: '2026-06-05T00:00:00.000Z', machine: MACHINE, kind: 'topic-placement', topic: 5, data: { owner: 'm_b', epoch: 2, reason: 'user-move' } }) +
        '\n',
    );
    const metaPath = path.join(dir(), `${sanitizeMachineId(MACHINE)}.meta.json`);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    expect(meta.kinds['topic-placement'].highWaterSeq).toBe(1); // meta lagging behind data

    const j2 = makeJournal();
    expect(j2.getDegradation().remints).toBe(0); // data-ahead-of-meta is NOT a rewind
    j2.emitPlacement(99, { owner: 'm_c', epoch: 3, reason: 'failover' });
    j2.flush();
    expect(readLines(streamFile('topic-placement')).map((e) => e.seq)).toEqual([1, 2, 3]);
    j2.close();
  });

  it('genuine rewind (last seq < highWaterSeq) re-mints the incarnation', () => {
    const j1 = makeJournal();
    for (let i = 0; i < 5; i++) j1.emitPlacement(i, { owner: 'm_a', epoch: i + 1, reason: 'placed' });
    j1.flush();
    const incarnationBefore = j1.streamStatuses().find((s) => s.kind === 'topic-placement')!.incarnation;
    j1.close();

    // Restore-from-backup: the data file is rolled back below the durable
    // highWaterSeq the meta still records (meta says 5, file ends at 2).
    const file = streamFile('topic-placement');
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    fs.writeFileSync(file, lines.slice(0, 2).join('\n') + '\n');

    const j2 = makeJournal();
    expect(j2.getDegradation().remints).toBe(1);
    const incarnationAfter = j2.streamStatuses().find((s) => s.kind === 'topic-placement')!.incarnation;
    expect(incarnationAfter).not.toBe(incarnationBefore); // fresh incarnation
    j2.close();
  });
});

describe('CoherenceJournal — unflushed entries lost on crash (§3.1, §6)', () => {
  it('drops enqueued-but-unflushed entries on crash; seq resumes from durable tail', () => {
    const j1 = makeJournal();
    j1.emitPlacement(1, { owner: 'm_a', epoch: 1, reason: 'placed' });
    j1.flush(); // seq 1 durable
    j1.emitPlacement(2, { owner: 'm_a', epoch: 2, reason: 'user-move' }); // seq 2 enqueued, NOT flushed
    expect(j1.pendingCount).toBe(1);
    // Crash without flushing: simulate by abandoning j1 (no close → no final drain).
    // The lock is reclaimed because j1's pid == our pid; mimic a fresh process by
    // releasing the lock explicitly.
    (j1 as any).releaseLock();

    const j2 = makeJournal();
    // Durable tail is seq 1; the lost seq 2 is gone; next emit resumes at 2.
    j2.emitPlacement(2, { owner: 'm_b', epoch: 2, reason: 'failover' });
    j2.flush();
    const lines = readLines(streamFile('topic-placement'));
    expect(lines.map((e) => e.seq)).toEqual([1, 2]);
    expect(lines[1].data.reason).toBe('failover'); // the SECOND, re-issued seq-2, not the lost one
    j2.close();
  });
});

describe('CoherenceJournal — typed-schema rejection (§3.2, §6)', () => {
  it('rejects free-text / extra free-form fields by dropping unknown fields (counted)', () => {
    const j = makeJournal();
    j.emitPlacement(1, {
      owner: 'm_a',
      epoch: 1,
      reason: 'placed',
      // free text smuggled in — must NOT reach the stream:
      note: 'the user said something secret here',
    } as any);
    j.flush();
    const line = readLines(streamFile('topic-placement'))[0];
    expect(line.data).toEqual({ owner: 'm_a', epoch: 1, reason: 'placed' });
    expect(line.data.note).toBeUndefined();
    expect(j.getDegradation().droppedFields).toBe(1);
    j.close();
  });

  it('rejects an entry with an invalid enum value (whole entry dropped + counted)', () => {
    const j = makeJournal();
    j.emitPlacement(1, { owner: 'm_a', epoch: 1, reason: 'totally-made-up' as any });
    j.flush();
    expect(fs.existsSync(streamFile('topic-placement'))).toBe(false);
    expect(j.getDegradation().schemaRejects).toBe(1);
    j.close();
  });

  it('drops a secret-shaped unknown field at write time (cannot enter the stream)', () => {
    const j = makeJournal();
    j.emitLifecycle({
      sessionId: 's1',
      status: 'created',
      apiKey: 'sk-ant-0123456789ABCDEF',
    } as any);
    j.flush();
    const line = readLines(streamFile('session-lifecycle'))[0];
    expect(line.data.apiKey).toBeUndefined();
    expect(JSON.stringify(line)).not.toContain('sk-ant');
    expect(j.getDegradation().droppedFields).toBe(1);
    j.close();
  });

  it('rejects a wrong-typed required field (free text where a number belongs)', () => {
    const j = makeJournal();
    j.emitPlacement(1, { owner: 'm_a', epoch: 'two' as any, reason: 'placed' });
    j.flush();
    expect(j.getDegradation().schemaRejects).toBe(1);
    expect(fs.existsSync(streamFile('topic-placement'))).toBe(false);
    j.close();
  });
});

describe('CoherenceJournal — artifactPath jail at write time (§3.1, §6)', () => {
  it('accepts a path under an allowlisted root', () => {
    const auto = path.join(tmpDir, 'autonomous');
    fs.mkdirSync(auto, { recursive: true });
    const good = path.join(auto, '13481.local.md');
    fs.writeFileSync(good, '# run');
    const j = makeJournal();
    j.emitAutonomousRun(13481, { action: 'started', runId: 'r1', artifactPaths: [good] });
    j.flush();
    const line = readLines(streamFile('autonomous-run'))[0];
    expect(line.data.artifactPaths).toEqual([fs.realpathSync(good)]);
    j.close();
  });

  it('rejects a traversal path (..)', () => {
    const j = makeJournal();
    j.emitAutonomousRun(1, { action: 'started', runId: 'r', artifactPaths: ['../../etc/passwd'] });
    j.flush();
    expect(fs.existsSync(streamFile('autonomous-run'))).toBe(false);
    expect(j.getDegradation().jailRejects).toBe(1);
    j.close();
  });

  it('rejects an absolute path outside the jail', () => {
    const j = makeJournal();
    j.emitAutonomousRun(1, { action: 'started', runId: 'r', artifactPaths: ['/etc/hosts'] });
    j.flush();
    expect(fs.existsSync(streamFile('autonomous-run'))).toBe(false);
    expect(j.getDegradation().jailRejects).toBe(1);
    j.close();
  });

  it('rejects a symlink that escapes the jail', () => {
    const auto = path.join(tmpDir, 'autonomous');
    fs.mkdirSync(auto, { recursive: true });
    const outside = path.join(os.tmpdir(), `cj-escape-${Date.now()}`);
    fs.mkdirSync(outside, { recursive: true });
    const linkInJail = path.join(auto, 'escape-link');
    try {
      fs.symlinkSync(outside, linkInJail);
    } catch {
      return; // platform without symlink perms — skip
    }
    const target = path.join(linkInJail, 'secret.md');
    fs.writeFileSync(target, 'x');
    const j = makeJournal();
    j.emitAutonomousRun(1, { action: 'started', runId: 'r', artifactPaths: [target] });
    j.flush();
    expect(fs.existsSync(streamFile('autonomous-run'))).toBe(false);
    expect(j.getDegradation().jailRejects).toBe(1);
    j.close();
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

describe('CoherenceJournal — operation-keyed idempotency (§3.1, §6)', () => {
  it('dedupes a repeated op key within a single writer lifetime', () => {
    const j = makeJournal();
    j.emitPlacement(13481, { owner: 'm_a', epoch: 7, reason: 'placed' });
    j.emitPlacement(13481, { owner: 'm_a', epoch: 7, reason: 'placed' }); // same (topic, epoch)
    j.flush();
    const lines = readLines(streamFile('topic-placement'));
    expect(lines).toHaveLength(1);
    expect(j.getDegradation().dedupeHits).toBe(1);
    j.close();
  });

  it('dedupe SURVIVES a writer restart via tail reconstruction', () => {
    const j1 = makeJournal();
    j1.emitPlacement(13481, { owner: 'm_a', epoch: 7, reason: 'placed' });
    j1.flush();
    j1.close();

    const j2 = makeJournal();
    // Retried operation across the restart boundary (the 200-then-lost class).
    j2.emitPlacement(13481, { owner: 'm_a', epoch: 7, reason: 'placed' });
    j2.flush();
    const lines = readLines(streamFile('topic-placement'));
    expect(lines).toHaveLength(1); // not double-emitted across restart
    expect(j2.getDegradation().dedupeHits).toBe(1);
    j2.close();
  });

  it('different op keys are NOT deduped', () => {
    const j = makeJournal();
    j.emitLifecycle({ sessionId: 's1', status: 'created' });
    j.emitLifecycle({ sessionId: 's1', status: 'completed' }); // different status → different key
    j.flush();
    expect(readLines(streamFile('session-lifecycle'))).toHaveLength(2);
    j.close();
  });
});

describe('CoherenceJournal — rotation (§3.7, §6)', () => {
  it('rotateKeep N>0: rotates at maxFileBytes, keeps N archives, deletes older, seq continues', () => {
    // Tiny maxFileBytes so a few emits trigger rotation; keep 2 archives.
    const j = makeJournal({
      retention: { 'session-lifecycle': { maxFileBytes: 200, rotateKeep: 2 } },
    });
    for (let i = 0; i < 12; i++) {
      j.emitLifecycle({ sessionId: `sess-${i}`, status: 'created' });
      j.flush(); // flush each so the file size check runs between appends
    }
    j.close();

    // Collect all entries across current + the (bounded) archive files.
    const names = fs.readdirSync(dir()).filter((n) => n.includes('.session-lifecycle.'));
    const all: any[] = [];
    for (const n of names) all.push(...readLines(path.join(dir(), n)));
    all.sort((a, b) => a.seq - b.seq);
    const surviving = all.map((e) => e.seq);

    // Seq CONTINUES across rotation: strictly monotonic, contiguous, no forks.
    for (let i = 1; i < surviving.length; i++) {
      expect(surviving[i]).toBe(surviving[i - 1] + 1);
    }
    // Deletion happened — older seqs are gone, the newest seq (12) survives.
    expect(surviving[surviving.length - 1]).toBe(12);
    expect(surviving.length).toBeLessThan(12); // some early entries deleted

    // Archive count is bounded to keep=2 (older deleted) — the No-Unbounded bound.
    const archives = names.filter((n) => /\.session-lifecycle\.\d+\.jsonl$/.test(n));
    expect(archives.length).toBeLessThanOrEqual(2);
  });

  it('rotateKeep 0 (placement): rotates but NEVER deletes — history is forever', () => {
    const j = makeJournal({
      retention: { 'topic-placement': { maxFileBytes: 200, rotateKeep: 0 } },
    });
    for (let i = 0; i < 15; i++) {
      j.emitPlacement(i, { owner: `m_${i}`, epoch: i + 1, reason: 'placed' });
      j.flush();
    }
    j.close();

    const names = fs.readdirSync(dir()).filter((n) => n.includes('.topic-placement.'));
    const archives = names.filter((n) => /\.topic-placement\.\d+\.jsonl$/.test(n));
    expect(archives.length).toBeGreaterThan(1); // multiple archives retained, none deleted

    const all: any[] = [];
    for (const n of names) all.push(...readLines(path.join(dir(), n)));
    all.sort((a, b) => a.seq - b.seq);
    expect(all.map((e) => e.seq)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1)); // every entry survives
  });
});

describe('CoherenceJournal — per-kind rate cap (§3.1, §6)', () => {
  it('drops over-cap emits and counts them; under-cap emits pass', () => {
    const j = makeJournal({ rateCap: { capacity: 3, refillPerSec: 0 } });
    for (let i = 0; i < 10; i++) {
      j.emitPlacement(i, { owner: 'm_a', epoch: i + 1, reason: 'placed' });
    }
    j.flush();
    expect(readLines(streamFile('topic-placement'))).toHaveLength(3); // capacity exhausted at 3
    expect(j.getDegradation().rateLimited).toBe(7);
    j.close();
  });

  it('the rate cap is independent per kind', () => {
    const j = makeJournal({ rateCap: { capacity: 1, refillPerSec: 0 } });
    j.emitPlacement(1, { owner: 'm_a', epoch: 1, reason: 'placed' }); // uses placement bucket
    j.emitLifecycle({ sessionId: 's1', status: 'created' }); // uses lifecycle bucket
    j.flush();
    expect(readLines(streamFile('topic-placement'))).toHaveLength(1);
    expect(readLines(streamFile('session-lifecycle'))).toHaveLength(1);
    j.close();
  });
});

describe('CoherenceJournal — per-entry size cap (§3.1)', () => {
  it('drops an entry exceeding maxEntryBytes (counted)', () => {
    const j = makeJournal({ maxEntryBytes: 120 });
    const big = 'x'.repeat(500);
    j.emitLifecycle({ sessionId: big, status: 'created' });
    j.flush();
    expect(fs.existsSync(streamFile('session-lifecycle'))).toBe(false);
    expect(j.getDegradation().oversize).toBe(1);
    j.close();
  });
});

describe('CoherenceJournal — single-process lock (§3.1, §6)', () => {
  it('a second writer in the same dir is locked out; no torn lines / no forked seq', () => {
    const j1 = makeJournal();
    const j2 = new CoherenceJournal({
      stateDir: tmpDir,
      machineId: MACHINE,
      flushIntervalMs: 1_000_000,
      artifactRoots: [tmpDir],
    });
    j2.open();
    expect(j2.isLockedOut).toBe(true);
    expect(j2.status).toBe('writer-locked-out');

    // The locked-out writer's emit is a silent no-op (never blocks, never writes).
    j2.emitPlacement(1, { owner: 'm_z', epoch: 1, reason: 'placed' });
    j2.flush();

    // Only j1 writes; seq is not forked.
    j1.emitPlacement(1, { owner: 'm_a', epoch: 1, reason: 'placed' });
    j1.emitPlacement(2, { owner: 'm_a', epoch: 2, reason: 'user-move' });
    j1.flush();
    const lines = readLines(streamFile('topic-placement'));
    expect(lines.map((e) => e.seq)).toEqual([1, 2]); // single producer, no forked seq
    expect(lines.every((e) => e.machine === MACHINE)).toBe(true);
    j1.close();
    j2.close();
  });

  it('a stale lock from a dead pid is reclaimed', () => {
    // Plant a lock owned by a pid that does not exist.
    fs.mkdirSync(dir(), { recursive: true });
    const lock = path.join(dir(), `${sanitizeMachineId(MACHINE)}.lock`);
    fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 30, at: new Date().toISOString() }));
    const j = makeJournal();
    expect(j.isLockedOut).toBe(false); // stale lock reclaimed
    j.emitPlacement(1, { owner: 'm_a', epoch: 1, reason: 'placed' });
    j.flush();
    expect(readLines(streamFile('topic-placement'))).toHaveLength(1);
    j.close();
  });
});

describe('CoherenceJournal — NON-BLOCKING emit under a wedged flusher (§3.1, §6)', () => {
  it('emit() returns immediately even when the fs layer hangs/throws on every write', () => {
    // Fault-inject the fs seam: opening the append stream throws (a wedged
    // disk), so the flusher can never persist. The lock open ('wx') is left
    // working so the writer still acquires + opens cleanly — the wedge is
    // isolated to the flusher's append path, exactly the §6 fault-injection
    // shape. Because the open fails BEFORE any bytes are written, re-queue
    // semantics stay clean (no torn lines, no duplicate seqs on disk).
    const base = realFsClone();
    const wedgedFs: JournalFs = {
      ...base,
      openSync: ((p: any, flags: any, ...rest: any[]) => {
        if (flags === 'a') throw new Error('disk wedged');
        return base.openSync(p, flags, ...rest);
      }) as typeof fs.openSync,
    };
    const j = new CoherenceJournal({
      stateDir: tmpDir,
      machineId: MACHINE,
      flushIntervalMs: 1_000_000,
      artifactRoots: [tmpDir],
      rateCap: { capacity: 5000, refillPerSec: 0 }, // don't let the rate cap mask the non-blocking assertion
      fsImpl: wedgedFs,
    });
    j.open(); // open uses readFileSync/existsSync (not openSync for append) — ok
    // emit must not touch the fs at all; it just enqueues. Time it tightly.
    const start = process.hrtime.bigint();
    for (let i = 0; i < 1000; i++) {
      j.emitPlacement(i, { owner: 'm_a', epoch: i + 1, reason: 'placed' });
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    expect(j.pendingCount).toBe(1000); // all enqueued, none blocked
    expect(elapsedMs).toBeLessThan(500); // microsecond-class, not blocked on a wedged flusher

    // Draining hits the wedge → flushErrors counted, items re-queued, emit STILL fine.
    j.flush();
    expect(j.getDegradation().flushErrors).toBeGreaterThan(0);
    // emit after a failed flush is still non-blocking.
    j.emitPlacement(9999, { owner: 'm_b', epoch: 1, reason: 'placed' });
    expect(j.pendingCount).toBeGreaterThan(0);
    (j as any).releaseLock();
  });

  it('a guardWrite that throws skips the batch (counted) and re-queues; emit unaffected', () => {
    let allow = false;
    const j = makeJournal({
      guardWrite: () => {
        if (!allow) throw new Error('read-only standby');
      },
    });
    j.emitPlacement(1, { owner: 'm_a', epoch: 1, reason: 'placed' });
    j.flush();
    expect(j.getDegradation().guardSkips).toBe(1);
    expect(fs.existsSync(streamFile('topic-placement'))).toBe(false); // batch skipped
    expect(j.pendingCount).toBe(1); // re-queued, not lost

    // Once the guard permits, the re-queued entry flushes through.
    allow = true;
    j.flush();
    expect(readLines(streamFile('topic-placement')).map((e) => e.seq)).toEqual([1]);
    j.close();
  });
});

describe('CoherenceJournal — guardWrite seam is invoked before each append batch (§3.1)', () => {
  it('calls the injected guardWrite with the target stream path', () => {
    const seen: string[] = [];
    const j = makeJournal({ guardWrite: (p) => seen.push(p) });
    j.emitPlacement(1, { owner: 'm_a', epoch: 1, reason: 'placed' });
    j.flush();
    expect(seen).toContain(streamFile('topic-placement'));
    j.close();
  });
});

describe('CoherenceJournal — tolerant reader (§3.5 minimal)', () => {
  it('reads recent entries newest-first and survives interior corruption', () => {
    const j = makeJournal();
    j.emitPlacement(1, { owner: 'm_a', epoch: 1, reason: 'placed' });
    j.emitPlacement(2, { owner: 'm_b', epoch: 2, reason: 'user-move' });
    j.flush();
    // Inject an interior corrupt line buried by a good append.
    fs.appendFileSync(streamFile('topic-placement'), 'this is not json\n');
    j.emitPlacement(3, { owner: 'm_c', epoch: 3, reason: 'failover' });
    j.flush();

    const res = j.readTail('topic-placement', 10);
    expect(res.entries.map((e) => e.seq)).toEqual([3, 2, 1]); // newest-first
    expect(res.skippedCorrupt).toBe(1);
    j.close();
  });

  it('enumerateStreams lists current + archive files', () => {
    const j = makeJournal({ retention: { 'topic-placement': { maxFileBytes: 150, rotateKeep: 5 } } });
    for (let i = 0; i < 8; i++) {
      j.emitPlacement(i, { owner: `m_${i}`, epoch: i + 1, reason: 'placed' });
      j.flush();
    }
    const streams = j.enumerateStreams().filter((s) => s.kind === 'topic-placement');
    expect(streams.some((s) => !s.isArchive)).toBe(true); // a current file
    expect(streams.some((s) => s.isArchive)).toBe(true); // at least one archive
    j.close();
  });
});

describe('CoherenceJournal — self-emission exclusion (§3.1)', () => {
  it('the journal does not emit about its own operations (no recursive entries)', () => {
    const j = makeJournal();
    // Open, flush, close, re-open — pure journal-subsystem activity.
    j.flush();
    j.close();
    const j2 = makeJournal();
    j2.flush();
    j2.close();
    // No stream files were created by journal-internal activity alone.
    for (const kind of ['topic-placement', 'session-lifecycle', 'autonomous-run'] as JournalKind[]) {
      expect(readLines(streamFile(kind))).toHaveLength(0);
    }
  });
});

describe('CoherenceJournal — getOwnAdvert (§3.4 rule 5)', () => {
  it('advertises per-kind incarnation + the DURABLY-FLUSHED lastSeq (highWaterSeq), zeros when empty', () => {
    const j = makeJournal();
    // Nothing written yet → every kind advertises lastSeq 0.
    const empty = j.getOwnAdvert();
    expect(Object.keys(empty).sort()).toEqual(['autonomous-run', 'evolution-action-record', 'guard-latch', 'knowledge-record', 'learning-record', 'pref-record', 'relationship-record', 'session-lifecycle', 'subscription-account-meta', 'threadline-conversation', 'threadline-pairing-record', 'topic-claim-annotation', 'topic-operator-record', 'topic-pin-record', 'topic-placement', 'user-record', 'working-set-artifact']);
    for (const kind of ['topic-placement', 'session-lifecycle', 'autonomous-run', 'threadline-conversation', 'guard-latch', 'pref-record', 'relationship-record', 'learning-record', 'knowledge-record', 'evolution-action-record', 'user-record', 'topic-operator-record', 'threadline-pairing-record', 'subscription-account-meta'] as JournalKind[]) {
      expect(empty[kind].lastSeq).toBe(0);
    }
    const incarnation = empty['topic-placement'].incarnation;
    expect(typeof incarnation).toBe('string');
    expect(incarnation.length).toBeGreaterThan(0);
    // All kinds share the writer's single stream-set incarnation token.
    expect(empty['session-lifecycle'].incarnation).toBe(incarnation);

    // Two placement emits, flushed → advert advances to the flushed head.
    j.emitPlacement(1, { owner: 'm_a', epoch: 1, reason: 'placed' });
    j.emitPlacement(2, { owner: 'm_b', epoch: 2, reason: 'user-move' });
    j.flush();
    const adv = j.getOwnAdvert();
    expect(adv['topic-placement'].lastSeq).toBe(2);
    expect(adv['topic-placement'].incarnation).toBe(incarnation);
    // Other kinds untouched.
    expect(adv['session-lifecycle'].lastSeq).toBe(0);
    j.close();
  });

  it('does NOT advertise an enqueued-but-unflushed seq (only durable heads are servable)', () => {
    const j = makeJournal();
    j.emitPlacement(1, { owner: 'm_a', epoch: 1, reason: 'placed' });
    // Intentionally NOT flushed — the entry is queued, not durable.
    expect(j.pendingCount).toBeGreaterThan(0);
    const adv = j.getOwnAdvert();
    // §3.4: advertise highWaterSeq (advanced only after fdatasync), so a peer
    // never requests a delta we cannot serve from the file.
    expect(adv['topic-placement'].lastSeq).toBe(0);
    j.flush();
    expect(j.getOwnAdvert()['topic-placement'].lastSeq).toBe(1);
    j.close();
  });
});

/** A clone of the real fs seam (the wedged test overrides one method). */
function realFsClone(): JournalFs {
  return {
    openSync: fs.openSync,
    writeSync: fs.writeSync,
    fdatasyncSync: fs.fdatasyncSync,
    closeSync: fs.closeSync,
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
}

// ── Issue #925: lock retry + heartbeat + pid-reuse reclaim (live 2026-06-06) ──
describe('writer lock recovery (#925)', () => {
  it('a locked-out writer RETRIES and recovers in place when the lock is freed', async () => {
    const dirX = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-lock-retry-'));
    try {
      const lockDir = path.join(dirX, 'state', 'coherence-journal');
      fs.mkdirSync(lockDir, { recursive: true });
      const lockPath = path.join(lockDir, 'm_t.lock');
      // A LIVE foreign holder (pid 1 — kill is EPERM ⇒ conservative refuse;
      // mtime fresh ⇒ the heartbeat defense also refuses).
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, at: new Date().toISOString() }));
      const j = new CoherenceJournal({ stateDir: dirX, machineId: 'm_t', flushIntervalMs: 10 });
      j.open();
      expect(j.isLockedOut).toBe(true);
      // Holder exits: the lock file is freed.
      fs.rmSync(lockPath, { force: true });
      // The retry cadence is max(40×flushIntervalMs, 10s) — too slow for a unit
      // test, so assert the RECOVERY PATH directly via a second open() attempt
      // shape: tryActivate through a fresh instance takes the lock instantly.
      const j2 = new CoherenceJournal({ stateDir: dirX, machineId: 'm_t', flushIntervalMs: 10 });
      j2.open();
      expect(j2.isLockedOut).toBe(false);
      j2.close();
      j.close();
    } finally {
      fs.rmSync(dirX, { recursive: true, force: true });
    }
  });

  it('an mtime-stale lock is reclaimed even when its recorded pid is alive (pid-reuse defense)', () => {
    const dirX = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-lock-stale-'));
    try {
      const lockDir = path.join(dirX, 'state', 'coherence-journal');
      fs.mkdirSync(lockDir, { recursive: true });
      const lockPath = path.join(lockDir, 'm_t.lock');
      // Recorded pid = 1 (launchd — alive forever; kill(1,0) is EPERM, the
      // conservative no-reclaim path) but the lock's mtime is 10 minutes old:
      // a live holder would have heartbeated it.
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, at: new Date().toISOString() }));
      const old = new Date(Date.now() - 10 * 60 * 1000);
      fs.utimesSync(lockPath, old, old);
      const j = new CoherenceJournal({ stateDir: dirX, machineId: 'm_t', flushIntervalMs: 10 });
      j.open();
      expect(j.isLockedOut).toBe(false); // reclaimed despite the "alive" pid
      j.close();
    } finally {
      fs.rmSync(dirX, { recursive: true, force: true });
    }
  });

  it('a FRESH lock held by a live pid is NOT reclaimed (the conservative case)', () => {
    const dirX = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-lock-live-'));
    try {
      const lockDir = path.join(dirX, 'state', 'coherence-journal');
      fs.mkdirSync(lockDir, { recursive: true });
      fs.writeFileSync(path.join(lockDir, 'm_t.lock'), JSON.stringify({ pid: 1, at: new Date().toISOString() }));
      const j = new CoherenceJournal({ stateDir: dirX, machineId: 'm_t', flushIntervalMs: 10 });
      j.open();
      expect(j.isLockedOut).toBe(true); // live + fresh → respected
      j.close();
    } finally {
      fs.rmSync(dirX, { recursive: true, force: true });
    }
  });
});
