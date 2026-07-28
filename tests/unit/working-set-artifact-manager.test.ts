/**
 * WorkingSetArtifactManager — Tier-1 unit tests (spec: intelligent-working-set-lazy-sync.md).
 * Durable own-origin rows: (topic,relPath,producer) upsert, state lifecycle, getReadyRows
 * nomination filter, owner-only tombstone (+ emit seam), 30d GC, atomic persistence.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  WorkingSetArtifactManager,
  DEFAULT_RECORD_TTL_MS,
  type WorkingSetArtifactReplicationEmitter,
  type WorkingSetArtifactLocalRow,
} from '../../src/core/WorkingSetArtifactManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let dir: string;
let clock: number;
const iso = () => new Date(clock).toISOString();
const mk = () => new WorkingSetArtifactManager(dir, iso);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-artifact-mgr-'));
  clock = Date.parse('2026-07-05T00:00:00.000Z');
});
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/working-set-artifact-manager.test.ts' }); });

describe('record — (topic,relPath,producer) upsert', () => {
  it('records a new row (default pendingHash) and reads it back durably', () => {
    const m = mk();
    m.record({ topicId: 42, relPath: '.instar/reports/x.md', producerMachineId: 'm-A' });
    // a fresh instance reads the persisted catalog
    const rows = mk().getRowsForTopic(42);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ topicId: 42, relPath: '.instar/reports/x.md', producerMachineId: 'm-A', state: 'pendingHash' });
  });
  it('re-record of the SAME triple UPSERTS (no duplicate), preserving recordedAt', () => {
    const m = mk();
    m.record({ topicId: 42, relPath: '.instar/x.md', producerMachineId: 'm-A' });
    const firstRecordedAt = m.getRowsForTopic(42)[0].recordedAt;
    clock += 60_000;
    m.record({ topicId: 42, relPath: '.instar/x.md', producerMachineId: 'm-A', state: 'ready', contentHash: 'abc' });
    const rows = m.getRowsForTopic(42);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('ready');
    expect(rows[0].contentHash).toBe('abc');
    expect(rows[0].recordedAt).toBe(firstRecordedAt); // GC anchor preserved
  });
  it('a DIFFERENT producer of the same path coexists (divergent producers)', () => {
    const m = mk();
    m.record({ topicId: 42, relPath: '.instar/x.md', producerMachineId: 'm-A' });
    m.record({ topicId: 42, relPath: '.instar/x.md', producerMachineId: 'm-B' });
    expect(m.getRowsForTopic(42)).toHaveLength(2);
  });
});

describe('getReadyRows — the fetch-nomination filter', () => {
  it('returns ONLY ready rows (pendingHash / tooLarge / secretFlagged excluded)', () => {
    const m = mk();
    m.record({ topicId: 1, relPath: '.instar/a.md', producerMachineId: 'm-A', state: 'ready', contentHash: 'aa' });
    m.record({ topicId: 1, relPath: '.instar/b.md', producerMachineId: 'm-A', state: 'pendingHash' });
    m.record({ topicId: 1, relPath: '.instar/c.md', producerMachineId: 'm-A', state: 'secretFlagged' });
    const ready = m.getReadyRows(1);
    expect(ready.map((r) => r.relPath)).toEqual(['.instar/a.md']);
  });
  it('setState transitions pendingHash → ready', () => {
    const m = mk();
    m.record({ topicId: 1, relPath: '.instar/a.md', producerMachineId: 'm-A' });
    expect(m.getReadyRows(1)).toHaveLength(0);
    expect(m.setState(1, '.instar/a.md', 'm-A', 'ready', 'deadbeef')).toBe(true);
    expect(m.getReadyRows(1)).toHaveLength(1);
    expect(m.setState(1, '.instar/missing.md', 'm-A', 'ready')).toBe(false);
  });
});

describe('tombstone — owner-only remove + emit seam', () => {
  it('removes the row and fires emitDelete', () => {
    const emitted: unknown[] = [];
    const emitter: WorkingSetArtifactReplicationEmitter = {
      emitPut: () => {},
      emitDelete: (d) => emitted.push(d),
    };
    const m = mk();
    m.setReplicationEmitter(emitter);
    m.record({ topicId: 7, relPath: '.instar/x.md', producerMachineId: 'm-A' });
    expect(m.tombstone(7, '.instar/x.md', 'm-A')).toBe(true);
    expect(m.getRowsForTopic(7)).toHaveLength(0);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ topicId: 7, relPath: '.instar/x.md', producerMachineId: 'm-A' });
  });
  it('tombstone of an absent row is a no-op (false)', () => {
    expect(mk().tombstone(7, '.instar/nope.md', 'm-A')).toBe(false);
  });
});

describe('record — emit seam (put)', () => {
  it('fires emitPut on record + setState', () => {
    const puts: WorkingSetArtifactLocalRow[] = [];
    const m = mk();
    m.setReplicationEmitter({ emitPut: (r) => puts.push(r), emitDelete: () => {} });
    m.record({ topicId: 3, relPath: '.instar/x.md', producerMachineId: 'm-A' });
    m.setState(3, '.instar/x.md', 'm-A', 'ready', 'aa');
    expect(puts).toHaveLength(2);
    expect(puts[1].state).toBe('ready');
  });
});

describe('gc — record TTL purge', () => {
  it('purges rows older than the TTL, keeps fresh ones', () => {
    const m = mk();
    m.record({ topicId: 9, relPath: '.instar/old.md', producerMachineId: 'm-A' }); // recordedAt = clock
    clock += DEFAULT_RECORD_TTL_MS + 60_000; // 30d + 1min later
    m.record({ topicId: 9, relPath: '.instar/new.md', producerMachineId: 'm-A' }); // recordedAt = later
    const purged = m.gc(DEFAULT_RECORD_TTL_MS, clock);
    expect(purged).toBe(1);
    expect(m.getRowsForTopic(9).map((r) => r.relPath)).toEqual(['.instar/new.md']);
  });
});

describe('persistence — corrupt/missing catalog', () => {
  it('missing catalog reads as empty', () => {
    expect(mk().getAllRows()).toEqual([]);
  });
  it('corrupt catalog reads as empty (fail clean, never throw)', () => {
    fs.mkdirSync(path.join(dir, 'working-set'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'working-set', 'artifacts.json'), '{ not json', 'utf-8');
    expect(mk().getAllRows()).toEqual([]);
  });
});
