// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
// safe-fs-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Tier-1 unit tests for PoolActivityView (P4.1) —
 * POOL-WIDE-PARALLEL-WORK-SPEC §2/§3.
 *
 * Covers: the discriminated union (local rows enriched, remote rows with
 * NAMED null absences); per-instance running derivation then any-active
 * aggregation (a later terminal for session B never masks a still-running
 * session A); both kinds feeding one topic; possibleOverlap on every
 * machine pair (local↔remote AND remote↔remote) with the recentMove
 * annotation from the placement stream; the pool honesty header.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildPoolActivityView } from '../../src/core/PoolActivityView.js';
import { CoherenceJournalReader } from '../../src/core/CoherenceJournalReader.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-view-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function writeReplica(machine: string, kind: string, entries: Array<{ seq: number; ts: string; topic: number; data: Record<string, unknown> }>): void {
  const dir = path.join(tmpDir, 'state', 'coherence-journal', 'peers');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${machine}.${kind}.jsonl`),
    entries.map((e) => JSON.stringify({ seq: e.seq, ts: e.ts, machine, kind, topic: e.topic, data: e.data })).join('\n') + '\n',
  );
}

function reader(): CoherenceJournalReader {
  return new CoherenceJournalReader({ stateDir: tmpDir });
}

const LOCAL = [{ topicId: 42, focus: 'building P4', tags: ['p4'], refCount: 3, updatedAt: Date.now(), nickname: 'sweep', running: true }];

describe('buildPoolActivityView (§2/§3)', () => {
  it('discriminated union: local rows enriched (machineId/staleness 0/intentVisibility); remote rows carry NAMED null absences', () => {
    writeReplica('m_mini', 'session-lifecycle', [
      { seq: 1, ts: '2026-06-06T00:00:01.000Z', topic: 99, data: { sessionId: 'sess-1', status: 'created' } },
    ]);
    const { rows, pool } = buildPoolActivityView({ ownMachineId: 'm_laptop', local: LOCAL, reader: reader() });
    const local = rows.find((r) => r.kind === 'local')!;
    expect(local).toMatchObject({ topicId: '42', machineId: 'm_laptop', stalenessMs: 0, intentVisibility: 'local', focus: 'building P4' });
    const remote = rows.find((r) => r.kind === 'remote')!;
    expect(remote).toMatchObject({ topicId: '99', machineId: 'm_mini', running: true, focus: null, nickname: null, intentVisibility: 'machine-local' });
    expect(pool).toMatchObject({ selfMachineId: 'm_laptop', replicasRead: 1, boundHit: false });
  });

  it('per-instance aggregation: a later terminal for session B never masks still-running session A', () => {
    writeReplica('m_mini', 'session-lifecycle', [
      { seq: 1, ts: '2026-06-06T00:00:01.000Z', topic: 7, data: { sessionId: 'A', status: 'created' } },
      { seq: 2, ts: '2026-06-06T00:00:02.000Z', topic: 7, data: { sessionId: 'B', status: 'created' } },
      { seq: 3, ts: '2026-06-06T00:00:03.000Z', topic: 7, data: { sessionId: 'B', status: 'completed' } },
    ]);
    const { rows } = buildPoolActivityView({ ownMachineId: 'm_laptop', local: [], reader: reader() });
    expect(rows).toHaveLength(1);
    expect(rows[0].running).toBe(true); // A still active despite B's later terminal
  });

  it('a fully-terminal topic reads running:false; autonomous runs feed the same aggregation + artifactsKnown', () => {
    writeReplica('m_mini', 'session-lifecycle', [
      { seq: 1, ts: '2026-06-06T00:00:01.000Z', topic: 8, data: { sessionId: 'A', status: 'created' } },
      { seq: 2, ts: '2026-06-06T00:00:02.000Z', topic: 8, data: { sessionId: 'A', status: 'completed' } },
    ]);
    writeReplica('m_mini', 'autonomous-run', [
      { seq: 1, ts: '2026-06-06T00:00:03.000Z', topic: 8, data: { runId: 'r1', action: 'started', artifactPaths: ['/x.md'] } },
    ]);
    const { rows } = buildPoolActivityView({ ownMachineId: 'm_laptop', local: [], reader: reader() });
    const row = rows[0];
    expect(row.running).toBe(true); // the run instance is active even though the session ended
    expect((row as { artifactsKnown?: boolean }).artifactsKnown).toBe(true);
    expect((row as { lastEventKind?: string }).lastEventKind).toBe('run-started');
  });

  it('possibleOverlap pairs local↔remote AND remote↔remote; recentMove annotates a fresh placement epoch change', () => {
    // Topic 42 running locally AND on the mini → local↔remote pair.
    writeReplica('m_mini', 'session-lifecycle', [
      { seq: 1, ts: '2026-06-06T00:00:01.000Z', topic: 42, data: { sessionId: 's', status: 'created' } },
    ]);
    // Topic 50 running on TWO remote machines → remote↔remote pair.
    writeReplica('m_two', 'session-lifecycle', [
      { seq: 1, ts: '2026-06-06T00:00:01.000Z', topic: 50, data: { sessionId: 'x', status: 'created' } },
    ]);
    writeReplica('m_three', 'session-lifecycle', [
      { seq: 1, ts: '2026-06-06T00:00:01.000Z', topic: 50, data: { sessionId: 'y', status: 'created' } },
    ]);
    // A FRESH placement change for 42 → recentMove annotation.
    const dirOwn = path.join(tmpDir, 'state', 'coherence-journal');
    fs.mkdirSync(dirOwn, { recursive: true });
    fs.writeFileSync(
      path.join(dirOwn, 'm_laptop.topic-placement.jsonl'),
      JSON.stringify({ seq: 1, ts: new Date().toISOString(), machine: 'm_laptop', kind: 'topic-placement', topic: 42, data: { owner: 'm_laptop', epoch: 5, reason: 'user-move' } }) + '\n',
    );
    const { rows } = buildPoolActivityView({ ownMachineId: 'm_laptop', local: LOCAL, reader: reader() });
    const local42 = rows.find((r) => r.kind === 'local' && r.topicId === '42')!;
    expect(local42.possibleOverlap).toEqual(['m_mini']);
    expect(local42.recentMove).toBe(true); // the settling window, not a wolf-cry
    const two50 = rows.find((r) => r.machineId === 'm_two')!;
    expect(two50.possibleOverlap).toEqual(['m_three']); // remote↔remote caught
    expect(two50.recentMove).toBeUndefined(); // no fresh placement for 50
  });

  it('no replicas → local rows only, honest pool header', () => {
    const { rows, pool } = buildPoolActivityView({ ownMachineId: 'm_laptop', local: LOCAL, reader: reader() });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('local');
    expect(pool.replicasRead).toBe(0);
  });
});
