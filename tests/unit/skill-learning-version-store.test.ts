/**
 * VersionStore — Tier 1 (Testing Integrity Standard).
 *
 * Spec: docs/specs/skill-learning-sentinel.md §3.5 step 5 and the "Multi-machine posture" rules:
 * per-machine append-only files, `(epoch, at)` ordering across machines, `void`/`superseded`
 * tombstones folded at read time, the equal-epoch split-brain, and the post-sync epoch
 * reconciliation (deviation (t)) — including an LLM-merged canonical whose hash matches no row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { VersionStore, compareVersionRows } from '../../src/monitoring/skillLearning/VersionStore.js';

const NAME = 'ci-health-report';

describe('VersionStore', () => {
  let stateDir: string;
  let a: VersionStore;
  let b: VersionStore;
  let t: number;
  const now = () => t;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-'));
    t = Date.parse('2026-11-06T10:00:00.000Z');
    a = new VersionStore({ stateDir, machineId: 'm_alpha', now });
    b = new VersionStore({ stateDir, machineId: 'm_beta', now });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/skill-learning-version-store.test.ts' });
  });

  const row = (over: Partial<Parameters<VersionStore['append']>[1]> = {}) => ({
    version: 1, fileHash: 'f1', bodyHash: 'b1', epoch: 1, fence: 'git' as const, op: 'create' as const, state: 'active' as const, ...over,
  });

  it('writes one file per machine under versions/<name>/ and fsyncs every row', () => {
    const fsync = vi.spyOn(fs, 'fsyncSync');
    a.append(NAME, row());
    b.append(NAME, row({ version: 2, fileHash: 'f2', epoch: 2 }));
    expect(fs.existsSync(path.join(stateDir, 'skill-learning/versions', NAME, 'm_alpha.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'skill-learning/versions', NAME, 'm_beta.jsonl'))).toBe(true);
    expect(fsync).toHaveBeenCalledTimes(2);
    fsync.mockRestore();
  });

  it('orders rows across machines by (epoch, at): a later wall-clock at a LOWER epoch still loses', () => {
    t += 1000; b.append(NAME, row({ version: 2, fileHash: 'late-low-epoch', epoch: 1 }));
    t -= 500; a.append(NAME, row({ version: 1, fileHash: 'early-high-epoch', epoch: 2 }));
    const rows = a.rows(NAME);
    expect(rows.map((r) => r.fileHash)).toEqual(['late-low-epoch', 'early-high-epoch']);
    expect(a.lastRow(NAME)?.fileHash).toBe('early-high-epoch');
    expect(b.expectedPrevHash(NAME)).toBe('early-high-epoch'); // the same answer on every machine
    // Inside one epoch, `at` orders.
    expect(compareVersionRows({ epoch: 3, at: '2026-01-01T00:00:00.000Z', txId: 'a' }, { epoch: 3, at: '2026-01-01T00:00:01.000Z', txId: 'b' })).toBeLessThan(0);
  });

  it('nextVersion counts every non-void row from every machine', () => {
    expect(a.nextVersion(NAME)).toBe(1);
    a.append(NAME, row());
    b.append(NAME, row({ version: 2, fileHash: 'f2', epoch: 2 }));
    expect(a.nextVersion(NAME)).toBe(3);
  });

  it('a void tombstone (from any machine) hides the row from lastRow and nextVersion; a superseded one only from lastRow', () => {
    const r1 = a.append(NAME, row());
    const r2 = a.append(NAME, row({ version: 2, fileHash: 'f2', epoch: 2 }));
    expect(a.lastRow(NAME)?.txId).toBe(r2.txId);
    b.markVoid(NAME, r2.txId, 'never replaced');
    expect(a.lastRow(NAME)?.txId).toBe(r1.txId);
    expect(a.nextVersion(NAME)).toBe(2);
    expect(a.rowByTxId(NAME, r2.txId)?.void).toBe(true);
    a.markSuperseded(NAME, r1.txId);
    expect(a.lastRow(NAME)).toBeNull();
    expect(a.nextVersion(NAME)).toBe(2); // superseded rows still count toward the version number
  });

  it('splitBrain: two machines whose latest live rows share the max epoch with DIFFERENT bodies; identical bodies are benign', () => {
    a.append(NAME, row({ epoch: 5, fileHash: 'A' }));
    b.append(NAME, row({ version: 2, epoch: 5, fileHash: 'B' }));
    const split = a.splitBrain(NAME);
    expect(split.split).toBe(true);
    if (split.split) { expect(split.epoch).toBe(5); expect(split.candidates.map((c) => c.fileHash).sort()).toEqual(['A', 'B']); }
    expect(a.reconcileAfterSync(NAME, 'A').kind).toBe('split-brain');
    // The benign double-apply: same hash at the same epoch.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs2-'));
    try {
      const a2 = new VersionStore({ stateDir: dir2, machineId: 'm_alpha', now });
      const b2 = new VersionStore({ stateDir: dir2, machineId: 'm_beta', now });
      a2.append(NAME, row({ epoch: 5, fileHash: 'A' }));
      b2.append(NAME, row({ version: 2, epoch: 5, fileHash: 'A' }));
      expect(a2.splitBrain(NAME).split).toBe(false);
    } finally {
      SafeFsExecutor.safeRmSync(dir2, { recursive: true, force: true, operation: 'tests/unit/skill-learning-version-store.test.ts' });
    }
    // A lower epoch on the other machine is not a split.
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs3-'));
    try {
      const a3 = new VersionStore({ stateDir: dir3, machineId: 'm_alpha', now });
      const b3 = new VersionStore({ stateDir: dir3, machineId: 'm_beta', now });
      a3.append(NAME, row({ epoch: 5, fileHash: 'A' }));
      b3.append(NAME, row({ version: 2, epoch: 4, fileHash: 'B' }));
      expect(a3.splitBrain(NAME).split).toBe(false);
    } finally {
      SafeFsExecutor.safeRmSync(dir3, { recursive: true, force: true, operation: 'tests/unit/skill-learning-version-store.test.ts' });
    }
  });

  it('reconcileAfterSync: in-sync when the on-disk hash is the winner; superseded tombstones a lower-epoch loser on disk', () => {
    expect(a.reconcileAfterSync(NAME, 'x').kind).toBe('no-rows');
    const loserRow = b.append(NAME, row({ epoch: 3, fileHash: 'loser' }));
    t += 1000;
    const winnerRow = a.append(NAME, row({ version: 2, epoch: 4, fileHash: 'winner' }));
    expect(a.reconcileAfterSync(NAME, 'winner')).toMatchObject({ kind: 'in-sync', winner: { txId: winnerRow.txId } });
    // The merge put the LOSER's body on disk: the higher epoch wins; the loser's rows are superseded.
    const out = a.reconcileAfterSync(NAME, 'loser');
    expect(out.kind).toBe('superseded');
    if (out.kind === 'superseded') { expect(out.loser.txId).toBe(loserRow.txId); expect(out.winner.txId).toBe(winnerRow.txId); expect(out.tombstoned).toBe(1); }
    expect(b.rowByTxId(NAME, loserRow.txId)?.superseded).toBe(true);
    expect(b.lastRow(NAME)?.txId).toBe(winnerRow.txId); // the next holder never reads the loser's hash as an edit
    expect(b.reconcileAfterSync(NAME, 'loser').kind).toBe('unknown-hash'); // once superseded, that hash is no row's
  });

  it('reconcileAfterSync: an LLM-merged canonical matches no row → unknown-hash (the caller locks operator-owned)', () => {
    a.append(NAME, row({ epoch: 2, fileHash: 'ours' }));
    b.append(NAME, row({ version: 2, epoch: 1, fileHash: 'theirs' }));
    const out = a.reconcileAfterSync(NAME, 'sha-of-a-merged-body');
    expect(out.kind).toBe('unknown-hash');
    if (out.kind === 'unknown-hash') expect(out.winner.fileHash).toBe('ours');
    expect(a.reconcileAfterSync(NAME, null).kind).toBe('unknown-hash'); // missing on disk is not any row either
  });

  it('ignores a torn tail line, non-row JSON and rows missing required fields; refuses an invalid name', () => {
    a.append(NAME, row());
    fs.appendFileSync(a.ownFile(NAME), '{"kind":"version","txId":"x"}\n{"not":"a row"}\n{"kind":"version","txId":"torn", "fileHa');
    expect(a.rows(NAME)).toHaveLength(1);
    expect(() => a.append('Bad Name!', row())).toThrow(/invalid skill name/);
  });
});
